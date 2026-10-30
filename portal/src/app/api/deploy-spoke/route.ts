import { NextResponse } from 'next/server';
import { startJob, type Report, type SetResult, type Checkpoint, type SeedCheckpoints } from '@/lib/job-runner';
import { exec } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import util from 'util';
import { saveScenario, getScenarios, queryScenarios, registerSpoke } from '@/lib/db';
import { appendHistory } from '@/lib/history';
import { assumeHubServiceRole, assumeChain, roleArns, toEnv, EnvCredentials, SdkCredentials, spokeExternalId } from '@/lib/aws-auth';
import { normalizeScenarioDir, tfStateBucket, terraformEnv, excludeProviderCache, assertValidAccountId, assertValidScenarioId, tfstateKey as stateKeyFor } from '@/lib/tf-render';
import { COMING_SOON, scenarioDir, saveSourceSnapshot, deleteStateFiles } from '@/lib/scenarios';
import { assertDiskSpace } from '@/lib/disk';
import { populateScenario } from '@/lib/populate';
import { reconcileAccountRules } from '@/lib/rules-sync';
import { deployErrorMessage } from '@/lib/tf-errors';

const execAsync = util.promisify(exec);

/** One entry of a scenario's decoy_resources output, tagged with its scenario. */
type DecoyOutput = { category: string; resources: string; scenarioId: string };

interface DeploySpokeInput {
  accountId: string;
  region?: string;
  hubBusArn: string;
  forwardingRoleArn: string;
  scenarioIds: string[];
  scenarioNames?: Record<string, string>;
  individualRule?: boolean;
  populateOnDeploy?: boolean;
}

async function executeDeploySpoke(
  input: DeploySpokeInput,
  report: Report,
  setResult: SetResult,
  checkpoint: Checkpoint,
  seed: SeedCheckpoints,
): Promise<void> {
  {
    const { accountId, region: reqRegion, hubBusArn, forwardingRoleArn, scenarioIds, scenarioNames, individualRule, populateOnDeploy } = input;
    // Deploy region (multi-region: chosen per-deploy in the dashboard). Decoys
    // are created in this region; the hub tfstate bucket stays in HUB_REGION.
    const region = (typeof reqRegion === 'string' && /^[a-z]{2}-[a-z]+-\d$/.test(reqRegion)) ? reqRegion : 'us-west-2';

    // Declare the full checklist up front, including the two steps this route
    // deliberately does NOT perform: deploy-spoke never calls PutRule/PutTargets and
    // never touches the forwarding-role trust. Those happen in /api/deploy-rule when
    // the operator pushes the rule, so they are 'manual' rather than missing.
    await seed([
      { key: 'scenario_deploy' },
      { key: 'rule_generate' },
      ...(populateOnDeploy ? [{ key: 'scenario_populate' as const }] : []),
      { key: 'rule_push', status: 'manual' as const,
        detail: 'Push the rule from the Active Rules tab' },
      { key: 'trust_policy_update', status: 'manual' as const,
        detail: 'Applied automatically when the rule is pushed' },
    ]);
    const HUB_REGION = process.env.AWS_REGION || 'us-west-2';

    // Generate a sessionId to group all events from this deployment batch
    const sessionId = Date.now().toString();

    if (!accountId || !hubBusArn || !forwardingRoleArn || !scenarioIds || !Array.isArray(scenarioIds)) {
      throw new Error('Missing required fields');
    }
    assertValidAccountId(accountId);
    scenarioIds.forEach(assertValidScenarioId);
    await assertDiskSpace('deploy');

    // Hard server-side guard for COMING_SOON. Reject rather than silently skip so a
    // stale client selection can't half-deploy.
    const blocked = scenarioIds.filter((s: string) => COMING_SOON.has(s));
    if (blocked.length > 0) {
      throw new Error(`These scenarios are not deployable yet (coming soon): ${blocked.join(', ')}`);
    }

    console.log(`Starting deployment to Spoke Account: ${accountId}`);

    // 1. Terraform uses TWO credential contexts (split intentionally):
    //    - BACKEND (S3 state, HUB account): run terraform with HUB-SERVICE-ROLE
    //      creds. The state bucket is in the hub, so this is a same-account write.
    //    - PROVIDER (decoy resources, SPOKE account): a generated provider
    //      assume_role block hops hub-service -> spoke (+ExternalId). See the
    //      backend.tf.json + provider_override.tf written per scenario below.
    //    So here we only need hub-service creds for the terraform process env.
    const spokeRoleArn = roleArns.spokeDeploy(accountId);
    const externalId = spokeExternalId();
    let credentials: EnvCredentials;
    let hubSdkCredentials: SdkCredentials;
    try {
      const hubCreds = await assumeHubServiceRole('us-west-2');
      hubSdkCredentials = hubCreds;
      credentials = toEnv(hubCreds);
      console.log(`Assumed hub-service-role for terraform backend; provider will assume ${spokeRoleArn}`);
    } catch (stsError) {
      console.error("STS AssumeRole (hub-service) failed:", stsError);
      throw new Error(`Failed to assume hub service role: ${(stsError as Error).message}`);
    }

    // Populate-on-deploy needs direct spoke SDK credentials (the ones above are
    // hub-service creds for the Terraform S3 backend only, not usable for a
    // direct S3/SecretsManager/SSM PutX call in the spoke account).
    let spokeSdkCredentials: SdkCredentials | null = null;
    if (populateOnDeploy) {
      try {
        spokeSdkCredentials = await assumeChain({
          targetRoleArn: spokeRoleArn,
          externalId,
          region,
          sessionName: 'MiragePopulateOnDeploy',
        });
      } catch (stsError) {
        console.error('STS AssumeRole (spoke, for populate-on-deploy) failed:', stsError);
        // Don't fail the deploy over this -- populate is a bonus step.
        spokeSdkCredentials = null;
      }
    }
    const populated: Array<{ scenarioId: string; manifestFound: boolean; results: Awaited<ReturnType<typeof populateScenario>>['results'] }> = [];

    // Rules are planned once, after every scenario, by the shared planner (rules-sync.ts):
    // regional rules per region, the identity rule for roles. Each scenario is saved as soon
    // as it deploys, so a later failure in the batch cannot lose track of live decoys.
    const saveDeployed = (scenarioId: string, resources: Array<{ category: string; resources: string }>) => {
      const decoys = resources.flatMap(r => r.resources.split(',').map(n => n.trim()).filter(Boolean)
        .map(name => ({ name, category: r.category.toLowerCase().trim() })));
      if (decoys.length === 0) return Promise.resolve();
      return saveScenario({
        accountId,
        scenarioId,
        decoys,
        deployedAt: new Date().toISOString(),
        tfstateBucket: tfStateBucket(),
        // Same helper as the backend config, so trackedKeys below always matches.
        tfstateKey: stateKeyFor(accountId, region, scenarioId),
      });
    };

    // 2. Process scenarios
    const deployedScenarios: string[] = [];
    const failedScenarios: { id: string, error: string }[] = [];
    const duplicateWarnings: { scenarioId: string, resources: string[] }[] = [];

    // Load existing scenarios once for collision detection
    const existingScenarios = await getScenarios(accountId);
    const existingResourceKeys = new Set(
      existingScenarios.flatMap(s => s.decoys.map(d => `${d.category}::${d.name}`))
    );
    
    // Shared provider cache for every terraform child below: .terraform/providers
    // becomes a symlink into it instead of a 768 MB per-scenario copy.
    const tfEnv = await terraformEnv();

    // State keys of deployments the portal already tracks. A failed apply on one of these
    // must leave it alone; a failed FIRST deploy is destroyed, or what it created stays in
    // the account with no record, invisible to teardown. null = the store could not be
    // read, so nothing is destroyed automatically.
    const trackedKeys = await queryScenarios(accountId).then(
      list => new Set(list.map(s => s.tfstateKey)),
      () => null,
    );

    for (const scenarioId of scenarioIds) {
      console.log(`Preparing isolated deployment environment for ${scenarioId}...`);

      const templateDir = await scenarioDir(scenarioId);
      const stateDir = path.join(process.cwd(), 'states', accountId, scenarioId);

      await fs.mkdir(stateDir, { recursive: true });
      await fs.cp(templateDir, stateDir, { recursive: true, filter: excludeProviderCache });

      // Normalize the copied template for a multi-region, S3-backed deploy:
      // strip any hardcoded provider, generate provider (assume spoke, chosen
      // region) + backend.tf.json (hub bucket, region-scoped key). Shared helper.
      const { tfstateKey } = await normalizeScenarioDir({ stateDir, accountId, region, scenarioId, spokeRoleArn, externalId });

      // Keep the exact files being applied, so teardown still works after the
      // scenario changes or disappears upstream. Saved BEFORE apply: a half-failed
      // apply leaves resources that need these same files to destroy. Not fatal --
      // without it teardown falls back to the current template, as before.
      try {
        await saveSourceSnapshot({ dir: templateDir, bucket: tfStateBucket(), tfstateKey, credentials: hubSdkCredentials! });
      } catch (snapErr) {
        const msg = snapErr instanceof Error ? snapErr.message : String(snapErr);
        console.warn(`[deploy] could not save the source copy for ${scenarioId}:`, msg);
        await report(`Warning: could not save a copy of ${scenarioId}'s files (${msg}); teardown will use the current version`);
      }

      console.log(`Executing Terraform for ${scenarioId} in ${region}...`);
      let applyStarted = false;
      try {
        await execAsync(`terraform init -reconfigure -input=false`, {
          cwd: stateDir,
          maxBuffer: 10 * 1024 * 1024,
          env: {
            ...process.env,
            ...tfEnv,
            ...credentials,
            AWS_DEFAULT_REGION: HUB_REGION,
            AWS_REGION: HUB_REGION
          }
        });

        applyStarted = true;
        const { stdout } = await execAsync(`terraform apply -auto-approve -input=false -var="account_id=${accountId}"`, {
          cwd: stateDir,
          maxBuffer: 10 * 1024 * 1024,
          env: {
            ...process.env,
            ...tfEnv,
            ...credentials,
            AWS_DEFAULT_REGION: HUB_REGION,
            AWS_REGION: HUB_REGION
          }
        });
        console.log(`Deployed ${scenarioId}:\n`, stdout);

        const { stdout: tfOutput } = await execAsync(`terraform output -json`, {
          cwd: stateDir,
          maxBuffer: 10 * 1024 * 1024,
          env: {
            ...process.env,
            ...tfEnv,
            ...credentials,
            AWS_DEFAULT_REGION: HUB_REGION,
            AWS_REGION: HUB_REGION
          }
        });

        const outputs = JSON.parse(tfOutput);
        
        let scenarioResources: DecoyOutput[] = [];
        if (outputs.decoy_resources && outputs.decoy_resources.value) {
          const decoyResourcesStr = outputs.decoy_resources.value;
          const decoyResources = JSON.parse(decoyResourcesStr);
          for (const d of decoyResources) {
            scenarioResources.push({ ...d, scenarioId });
          }
        }

        // Populate-on-deploy: seed real content into the just-created decoys.
        // A populate failure must never fail an already-successful scenario
        // deploy -- it's a bonus step, isolated in its own try/catch.
        if (populateOnDeploy && spokeSdkCredentials) {
          try {
            const decoysForPopulate = scenarioResources.flatMap((r) =>
              r.resources.split(',').map((name: string) => ({ name: name.trim(), category: r.category.toLowerCase().trim() }))
            );
            const { manifestFound, results } = await populateScenario({
              scenarioId,
              region,
              decoys: decoysForPopulate,
              credentials: spokeSdkCredentials,
            });
            if (manifestFound) {
              populated.push({ scenarioId, manifestFound, results });
              const anyFailed = results.some(r => r.status === 'failed');
              if (anyFailed) {
                await appendHistory({
                  sessionId,
                  type: 'scenario_populate',
                  scenarioId,
                  scenarioName: (scenarioNames && scenarioNames[scenarioId]) || scenarioId,
                  accountId,
                  status: 'failed',
                  error: results.filter(r => r.status === 'failed').map(r => `${r.label}: ${r.error}`).join('; '),
                });
              }
            }
          } catch (populateErr) {
            console.error(`Populate-on-deploy failed for ${scenarioId}:`, populateErr);
            await appendHistory({
              sessionId,
              type: 'scenario_populate',
              scenarioId,
              scenarioName: (scenarioNames && scenarioNames[scenarioId]) || scenarioId,
              accountId,
              status: 'failed',
              error: (populateErr as Error).message,
            });
          }
        }

        // --- Duplicate Resource Check ---
        const duplicatesForScenario: string[] = [];
        const freshResources: DecoyOutput[] = [];
        for (const resource of scenarioResources) {
          const resourceNames = resource.resources.split(',').map((r: string) => r.trim());
          for (const name of resourceNames) {
            const key = `${resource.category.toLowerCase()}::${name}`;
            if (existingResourceKeys.has(key)) {
              duplicatesForScenario.push(`${resource.category}/${name}`);
            } else {
              // Add to fresh set and mark as known for subsequent scenarios in this batch
              existingResourceKeys.add(key);
              if (!freshResources.find(r => r === resource)) {
                freshResources.push(resource);
              }
            }
          }
        }
        if (duplicatesForScenario.length > 0) {
          console.log(`[${scenarioId}] Skipping ${duplicatesForScenario.length} already-registered resources: ${duplicatesForScenario.join(', ')}`);
          duplicateWarnings.push({ scenarioId, resources: duplicatesForScenario });
        }
        // Use only fresh (non-duplicate) resources: a decoy another scenario already owns
        // stays recorded (and watched) under that scenario.
        scenarioResources = freshResources;
        await saveDeployed(scenarioId, scenarioResources);

        deployedScenarios.push(scenarioId);
        // Auto-register spoke on first successful deploy to this account
        if (deployedScenarios.length === 1) {
          await registerSpoke(accountId);
        }
      } catch (deployErr) {
        console.error(`Deployment failed for ${scenarioId}:\n`, (deployErr as { stderr?: string }).stderr || (deployErr as Error).message);
        let error = deployErrorMessage(deployErr as Error, accountId);
        if (applyStarted && trackedKeys && !trackedKeys.has(tfstateKey)) {
          await report(`Removing what the failed ${scenarioId} deploy created`);
          try {
            await execAsync(`terraform destroy -auto-approve -input=false -var="account_id=${accountId}"`, {
              cwd: stateDir,
              maxBuffer: 10 * 1024 * 1024,
              env: { ...process.env, ...tfEnv, ...credentials, AWS_DEFAULT_REGION: HUB_REGION, AWS_REGION: HUB_REGION },
            });
            await deleteStateFiles({ bucket: tfStateBucket(), tfstateKey, credentials: hubSdkCredentials! });
            error += ' Anything this deploy had created was removed again.';
          } catch (cleanErr) {
            const msg = (cleanErr as { stderr?: string }).stderr || (cleanErr as Error).message;
            console.error(`Cleanup after failed deploy of ${scenarioId} failed:\n`, msg);
            error += ` Removing what it had created also failed, so some of it may still be in the account (state: ${tfstateKey}).`;
          }
        }
        failedScenarios.push({ id: scenarioId, error });
        // Log a failed scenario_deploy history event
        await appendHistory({
          sessionId,
          type: 'scenario_deploy',
          scenarioId,
          scenarioName: (scenarioNames && scenarioNames[scenarioId]) || scenarioId,
          accountId,
          status: 'failed',
          error,
        });
      }
    }

    // 3. Plan the rules for everything now deployed in the account. Nothing is pushed:
    //    changes wait in Active Rules for review. A planning failure fails the job --
    //    the decoys are live, and an unwatched decoy must never look like a success.
    let rulesForReview: string[] = [];
    if (deployedScenarios.length > 0) {
      try {
        const planned = await reconcileAccountRules(accountId, {
          individualScenarioIds: individualRule ? deployedScenarios : [],
        });
        rulesForReview = planned.upserts
          .filter(r => r.status !== 'deployed')
          .map(r => (r.kind === 'identity' ? `${r.ruleName} (identity, all regions)` : `${r.ruleName} (${r.region})`));
        await checkpoint('rule_generate', planned.failures.length ? 'failed' : 'done',
          [rulesForReview.length ? `Waiting for review: ${rulesForReview.join(', ')}` : 'No rule changes',
            ...planned.failures].join('; '));
        for (const scenarioId of deployedScenarios) {
          for (const r of planned.upserts) {
            await appendHistory({
              sessionId,
              type: 'rule_generate',
              scenarioId,
              scenarioName: (scenarioNames && scenarioNames[scenarioId]) || scenarioId,
              accountId,
              ruleName: r.ruleName,
              status: 'success',
            });
          }
        }
      } catch (planErr) {
        const msg = planErr instanceof Error ? planErr.message : String(planErr);
        await checkpoint('rule_generate', 'failed', msg);
        throw new Error(`Decoys deployed, but their rules could not be planned (${msg}). They are NOT monitored yet.`);
      }
    } else {
      await checkpoint('rule_generate', 'skipped');
    }

    // Log scenario_deploy success events (done after all processing to keep timeline clean)
    for (const scenarioId of deployedScenarios) {
      await appendHistory({
        sessionId,
        type: 'scenario_deploy',
        scenarioId,
        scenarioName: (scenarioNames && scenarioNames[scenarioId]) || scenarioId,
        accountId,
        status: 'success',
      });
    }

    // Stored before any throw below: a partial failure still has results the UI
    // needs in order to show which scenarios failed and why.
    await checkpoint(
      'scenario_deploy',
      failedScenarios.length > 0 ? 'failed' : 'done',
      `${deployedScenarios.length} deployed, ${failedScenarios.length} failed`,
    );
    if (populateOnDeploy) {
      const popFailures = populated.filter(
        (pp: { results: { status: string }[] }) => pp.results.some(r => r.status === 'failed'),
      ).length;
      await checkpoint('scenario_populate', popFailures > 0 ? 'failed' : 'done',
        popFailures > 0 ? `${popFailures} scenario(s) had seed failures` : undefined);
    }

    await setResult({
      success: failedScenarios.length === 0,
      deployed: deployedScenarios,
      failed: failedScenarios,
      duplicates: duplicateWarnings,
      populated,
      rulesForReview,
      message: `Deployed ${deployedScenarios.length} scenarios successfully.`
        + (rulesForReview.length ? ` Rule changes waiting for review in Active Rules: ${rulesForReview.length}.` : '')
    });

    await report(`Deployed ${deployedScenarios.length} scenario(s)`, { phase: 'done' });

    // Surface partial failure as a failed job. Reporting 'succeeded' when two of
    // three scenarios failed would make the notification actively misleading.
    if (failedScenarios.length > 0) {
      throw new Error(
        `${failedScenarios.length} of ${deployedScenarios.length + failedScenarios.length} scenarios failed: ` +
        failedScenarios.map((f: { id: string; error: string }) => `${f.id} (${f.error})`).join('; ')
      );
    }
  }
}

export async function POST(req: Request) {
  try {
    const input = await req.json();
    const { accountId, hubBusArn, forwardingRoleArn, scenarioIds } = input ?? {};

    if (!accountId || !hubBusArn || !forwardingRoleArn || !scenarioIds || !Array.isArray(scenarioIds)) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }
    try {
      assertValidAccountId(accountId);
      scenarioIds.forEach(assertValidScenarioId);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'Invalid input' }, { status: 400 });
    }

    const blocked = scenarioIds.filter((s: string) => COMING_SOON.has(s));
    if (blocked.length > 0) {
      return NextResponse.json(
        { error: `These scenarios are not deployable yet (coming soon): ${blocked.join(', ')}` },
        { status: 400 }
      );
    }

    // Escape hatch: ?sync=1 keeps the original blocking behaviour.
    if (new URL(req.url).searchParams.get('sync') === '1') {
      let captured: unknown = null;
      await executeDeploySpoke(
        input, async () => {}, async r => { captured = r; }, async () => {}, async () => {},
      );
      return NextResponse.json(captured ?? { success: true });
    }

    // Serialized per account: two deploys against the same account would race the
    // bin-packed EventBridge rule records and the shared scenario state.
    const started = await startJob(
      {
        type: 'deploy-spoke',
        label: `Deploy ${scenarioIds.length} scenario(s)`,
        accountId,
      },
      (report, setResult, checkpoint, seed) =>
        executeDeploySpoke(input, report, setResult, checkpoint, seed),
    );

    if ('conflict' in started) {
      return NextResponse.json(
        { error: 'A scenario deployment is already running for this account.', jobId: started.conflict.id },
        { status: 409 },
      );
    }

    return NextResponse.json(
      { jobId: started.jobId, message: 'Deployment started. Progress is tracked in the Process Queue.' },
      { status: 202 },
    );
  } catch (error) {
    console.error('Error in /api/deploy-spoke:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal Server Error' },
      { status: 500 },
    );
  }
}
