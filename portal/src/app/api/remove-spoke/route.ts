import { NextResponse } from 'next/server';
import { startJob, type Report, type SetResult, type Checkpoint, type SeedCheckpoints } from '@/lib/job-runner';
import { exec } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { deleteScenario } from '@/lib/db';
import util from 'util';
import { appendHistory } from '@/lib/history';
import { assumeChain, assumeHubServiceRole, roleArns, toEnv, spokeExternalId, type SdkCredentials } from '@/lib/aws-auth';
import { normalizeScenarioDir, terraformEnv, excludeProviderCache, tfStateBucket, assertValidAccountId, assertValidScenarioId } from '@/lib/tf-render';
import { scenarioDir, restoreSourceSnapshot, deleteStateFiles } from '@/lib/scenarios';
import { assertDiskSpace } from '@/lib/disk';
import { reconcileAccountRules } from '@/lib/rules-sync';

const execAsync = util.promisify(exec);

interface RemoveSpokeInput {
  scenarios: {
    accountId: string;
    scenarioId: string;
    scenarioName?: string;
    region?: string;
    tfstateKey?: string;
  }[];
  forwardingRoleArn?: string; // accepted from older clients, no longer used
}

async function executeRemoveSpoke(
  input: RemoveSpokeInput,
  report: Report,
  setResult: SetResult,
  checkpoint: Checkpoint,
  seed: SeedCheckpoints,
): Promise<void> {
  {
    const { scenarios } = input;
    // Lower floor than deploy: a teardown re-uses the plugin cache and should
    // still be possible when space is getting tight.
    await assertDiskSpace('tear down', 1);

    // Order matters and is reflected here: destroy the decoys FIRST, only then
    // remove the rule and trust entries. The reverse order leaves a live decoy with
    // nothing watching it if the destroy fails.
    // No trust step: the forwarding role trusts every <prefix>-fwd-* rule of the account
    // (rules-sync.ts ensureForwardingTrust), so removing a rule needs no trust edit.
    await seed([
      { key: 'scenario_teardown' },
      { key: 'rule_teardown' },
    ]);

    if (!scenarios || !Array.isArray(scenarios)) {
      throw new Error('Missing required fields or incorrect format');
    }
    for (const s of scenarios) {
      assertValidAccountId(s.accountId);
      assertValidScenarioId(s.scenarioId);
    }

    console.log(`Starting bulk teardown of ${scenarios.length} scenarios...`);

    // Per-scenario outcomes. A batch reports what actually happened to each scenario
    // rather than one aggregate success, so one bad destroy cannot silently stand in
    // for the whole selection.
    const teardownFailures: Array<{ id: string; error: string }> = [];
    // Rule-level problems are tracked separately from destroy failures: the decoys may be
    // gone (scenario success) while the rule bookkeeping is wrong, and conflating the two
    // would report a scenario as not destroyed when it was.
    const ruleIssues: string[] = [];
    const teardownTotal = scenarios.length;
    let teardownDone = 0;

    // Group scenarios by account so we assume the spoke role once per account
    // (the role ARN is derived from accountId, not client-supplied).
    const acctGroups: Record<string, typeof scenarios> = {};
    for (const s of scenarios) {
      if (!s.accountId) {
        console.warn(`Missing accountId for scenario ${s.scenarioId}, skipping.`);
        continue;
      }
      if (!acctGroups[s.accountId]) acctGroups[s.accountId] = [];
      acctGroups[s.accountId].push(s);
    }

    for (const groupAccountId of Object.keys(acctGroups)) {
      console.log(`Assuming spoke role for teardown in account ${groupAccountId}`);

      let sdkCredentials;   // spoke creds - for EventBridge/IAM cleanup in the spoke
      let tfCredentials;    // hub-service creds - for the terraform S3 backend (hub, same-account)
      let hubSdkCredentials: SdkCredentials; // same, SDK form - for the hub state bucket's objects
      const spokeRoleArn = roleArns.spokeDeploy(groupAccountId);
      const externalId = spokeExternalId();
      try {
        const chainCreds = await assumeChain({
          targetRoleArn: spokeRoleArn,
          externalId: spokeExternalId(),
          region: 'us-west-2',
          sessionName: 'MirageSpokeRemoval',
        });
        sdkCredentials = chainCreds;
        hubSdkCredentials = await assumeHubServiceRole('us-west-2');
        tfCredentials = toEnv(hubSdkCredentials);
        console.log(`Assumed spoke role (cleanup) + hub-service (tf backend) for ${groupAccountId}`);
      } catch (stsError) {
        console.error(`STS AssumeRole chain failed for ${groupAccountId}:`, stsError);
        throw new Error(`Failed to assume roles: ${(stsError as Error).message}`);
      }


      for (const scenario of acctGroups[groupAccountId]) {
        console.log(`Starting cleanup and teardown for ${scenario.scenarioId} in account ${scenario.accountId}...`);

        await report(`Destroying ${scenario.scenarioId}`, {
          phase: 'destroying decoys',
          current: teardownDone + teardownFailures.length,
          total: teardownTotal,
        });

        // ORDER IS LOAD-BEARING: destroy the decoys BEFORE removing their
        // detection rules. The reverse order (rules first) leaves a LIVE decoy
        // with no rule watching it whenever destroy fails, and the portal has
        // already forgotten it exists -- an unmonitored decoy is worse than none.
        // The destroy catch below `continue`s, so a failure never reaches step 2
        // for that scenario while still letting the rest of the batch proceed.
        // 1. Terraform Destroy (against the REMOTE S3 state, not local disk).
        console.log(`Executing Terraform Destroy for ${scenario.scenarioId}...`);
        const stateDir = path.join(process.cwd(), 'states', scenario.accountId, scenario.scenarioId);
        try {
          // Region: use the scenario's stored region (from its tfstateKey
          // accounts/<acct>/<region>/<scenario>/...), or an explicit scenario.region,
          // else default. Must match the deploy region so the S3 state key resolves.
          const keyRegion = typeof scenario.tfstateKey === 'string'
            ? (scenario.tfstateKey.split('/')[2] || '')
            : '';
          const region = scenario.region || keyRegion || 'us-west-2';
          const hubRegion = process.env.AWS_REGION || 'us-west-2';

          // Rehydrate the working dir from the exact files that were deployed (saved
          // to S3 at deploy time), so a scenario changed or removed upstream since
          // is still destroyable. Deploys from before that copy existed fall back to
          // the current template -- and say so, instead of guessing silently.
          const tfKey = typeof scenario.tfstateKey === 'string'
            ? scenario.tfstateKey
            : `accounts/${scenario.accountId}/${region}/${scenario.scenarioId}/terraform.tfstate`;
          await fs.rm(stateDir, { recursive: true, force: true });
          const restored = await restoreSourceSnapshot({
            destDir: stateDir, bucket: tfStateBucket(), tfstateKey: tfKey, credentials: hubSdkCredentials!,
          });
          if (!restored) {
            const templateDir = await scenarioDir(scenario.scenarioId);
            try {
              await fs.access(path.join(templateDir, 'main.tf'));
            } catch {
              throw new Error(
                `No saved copy of ${scenario.scenarioId} and its files are no longer available ` +
                `(${templateDir}) -- cannot run terraform destroy. Restore the scenario folder, then retry.`,
              );
            }
            await report(`No saved copy of ${scenario.scenarioId}; tearing down with its current files`);
            await fs.mkdir(stateDir, { recursive: true });
            await fs.cp(templateDir, stateDir, { recursive: true, filter: excludeProviderCache });
          }
          await normalizeScenarioDir({
            stateDir, accountId: scenario.accountId, region,
            scenarioId: scenario.scenarioId, spokeRoleArn, externalId,
          });
          const tfEnv = await terraformEnv();
          await execAsync(`terraform init -reconfigure -input=false`, {
            cwd: stateDir, maxBuffer: 10 * 1024 * 1024,
            env: { ...process.env, ...tfEnv, ...tfCredentials, AWS_DEFAULT_REGION: hubRegion, AWS_REGION: hubRegion },
          });

          const { stdout } = await execAsync(`terraform destroy -auto-approve -input=false -var="account_id=${scenario.accountId}"`, {
            cwd: stateDir,
            maxBuffer: 10 * 1024 * 1024,
            env: {
              ...process.env,
              ...tfEnv,
              ...tfCredentials,
              AWS_DEFAULT_REGION: 'us-west-2',
              AWS_REGION: 'us-west-2'
            }
          });
          console.log(`Successfully destroyed ${scenario.scenarioId}:\n`, stdout);
          await appendHistory({
            sessionId: Date.now().toString(),
            type: 'scenario_teardown',
            scenarioId: scenario.scenarioId,
            scenarioName: scenario.scenarioId,
            accountId: scenario.accountId,
            status: 'success',
          });

          // Reclaim the working dir. The real state lives in the hub S3 backend,
          // so this dir is disposable -- it is a copied template plus a provider
          // symlink. Nothing cleaned it up before: this route inlines destroy and
          // never invokes src/scripts/remove-spoke.sh, whose `rm -rf` was the only
          // cleanup in the codebase and is therefore dead code. `states/` is
          // gitignored, so it filled the box's disk invisibly and broke two
          // teardowns with "no space left on device".
          // Only on success -- a failed teardown keeps its dir for debugging.
          try {
            await fs.rm(stateDir, { recursive: true, force: true });
          } catch (rmErr) {
            console.warn(`Could not remove working dir ${stateDir}:`, rmErr);
          }
        } catch (destroyErr) {
          console.error(`Teardown failed for ${scenario.scenarioId}:\n`, (destroyErr as { stderr?: string }).stderr || (destroyErr as Error).message);
          await appendHistory({
            sessionId: Date.now().toString(),
            type: 'scenario_teardown',
            scenarioId: scenario.scenarioId,
            scenarioName: scenario.scenarioId,
            accountId: scenario.accountId,
            status: 'failed',
            error: (destroyErr as Error).message
          });
          // Carry on with the rest of the batch. Throwing here would strand every
          // remaining scenario in this account, which is how a 6-scenario teardown
          // used to stop at the first problem.
          teardownFailures.push({
            id: scenario.scenarioId,
            error: destroyErr instanceof Error ? destroyErr.message : String(destroyErr),
          });
          await report(`Failed: ${scenario.scenarioId}`, {
            phase: 'destroying decoys',
            current: teardownDone + teardownFailures.length,
            total: teardownTotal,
          });
          continue;
        }

        teardownDone += 1;
        await report(`Destroyed ${scenario.scenarioId}`, {
          phase: 'destroying decoys',
          current: teardownDone + teardownFailures.length,
          total: teardownTotal,
        });

        // `terraform destroy` empties a state file but never deletes it -- it rewrites it with
        // `"resources": []`, about 181 bytes. Those shells accumulate one per deploy/destroy
        // cycle (plus a new version each time) and are what left the tfstate bucket non-empty,
        // blocking the hub stack delete with "You must delete all versions in the bucket".
        //
        // Best-effort by design: the decoys are already gone by this point, so failing the
        // teardown over a leftover 181-byte object would report a successful destroy as a
        // failure. hub-service creds have s3:DeleteObject on the bucket's accounts/* prefix.
        // (This used the SPOKE creds before, which cannot reach the hub bucket at all, so
        // every delete failed into the warning below and the shells piled up.)
        const deleteStateObject = async () => {
          if (!scenario.tfstateKey) return;
          await deleteStateFiles({ bucket: tfStateBucket(), tfstateKey: scenario.tfstateKey, credentials: hubSdkCredentials! });
        };
        try {
          await deleteStateObject();
        } catch (stateErr) {
          const msg = stateErr instanceof Error ? stateErr.message : String(stateErr);
          console.warn(`[teardown] could not delete the emptied state / saved copy for ${scenario.scenarioId}:`, msg);
          await report(`Warning: ${scenario.scenarioId} destroyed, but its leftover state files could not be deleted (${msg})`);
        }

        // 2. Rules -- ONLY after destroy succeeded. Drop the scenario record, then let the
        //    shared planner (rules-sync.ts) shrink the rules that watched it (left for review)
        //    and delete, in every region they live in, the ones left with nothing to watch.
        //    If the scenario store cannot be read the planner throws and no rule is deleted.
        try {
          await deleteScenario(scenario.accountId, scenario.scenarioId);
          const planned = await reconcileAccountRules(scenario.accountId, { credentials: sdkCredentials });
          ruleIssues.push(...planned.failures);
          for (const r of planned.deletes) {
            const failed = planned.failures.some(f => f.startsWith(`${r.ruleName}:`));
            await appendHistory({
              sessionId: Date.now().toString(),
              type: 'rule_teardown',
              scenarioId: scenario.scenarioId,
              scenarioName: scenario.scenarioId,
              accountId: scenario.accountId,
              ruleName: r.ruleName,
              status: failed ? 'failed' : 'success',
              ...(failed ? { error: planned.failures.find(f => f.startsWith(`${r.ruleName}:`)) } : {}),
            });
          }
        } catch (ruleErr) {
          // Decoys are already destroyed: what is left is stale rule bookkeeping, reported
          // as a failed job rather than hidden.
          const msg = ruleErr instanceof Error ? ruleErr.message : String(ruleErr);
          console.error(`Rule cleanup failed for ${scenario.scenarioId}:`, ruleErr);
          ruleIssues.push(`${scenario.scenarioId}: rule cleanup failed (${msg})`);
        }

      }
    }

    await checkpoint(
      'scenario_teardown',
      teardownFailures.length > 0 ? 'failed' : 'done',
      `${teardownDone} destroyed, ${teardownFailures.length} failed`,
    );
    // Rule and trust cleanup only ran for the scenarios that actually destroyed, so
    // report them as skipped when nothing did.
    await checkpoint(
      'rule_teardown',
      ruleIssues.length > 0 ? 'failed' : teardownDone > 0 ? 'done' : 'skipped',
      ruleIssues.length > 0 ? ruleIssues.join('; ') : undefined,
    );

    await setResult({
      success: teardownFailures.length === 0,
      message:
        teardownFailures.length === 0
          ? `Tore down ${teardownDone} scenario(s) successfully.`
          : `${teardownDone} of ${teardownTotal} torn down; ${teardownFailures.length} failed.`,
      destroyed: teardownDone,
      failed: teardownFailures,
    });

    await report(
      teardownFailures.length === 0
        ? `Tore down ${teardownDone} scenario(s)`
        : `Tore down ${teardownDone} of ${teardownTotal}; ${teardownFailures.length} failed`,
      { phase: 'done', current: teardownTotal, total: teardownTotal },
    );

    // Surface partial failure as a failed job, matching deploy-spoke. Reporting
    // 'succeeded' when two of six scenarios are still deployed would make the
    // notification actively misleading.
    // Rule bookkeeping that could not be cleaned fails the job even when every destroy
    // succeeded -- a stale or unsatisfiable rule is the failure mode this change exists for.
    if (teardownFailures.length === 0 && ruleIssues.length > 0) {
      throw new Error(`Decoys destroyed, but rule cleanup failed: ${ruleIssues.join('; ')}`);
    }

    if (teardownFailures.length > 0) {
      throw new Error(
        `${teardownFailures.length} of ${teardownTotal} scenarios failed to tear down: ` +
        teardownFailures.map(f => `${f.id} (${f.error})`).join('; ')
      );
    }
  }
}

export async function POST(req: Request) {
  try {
    const input = await req.json();
    const { scenarios } = input ?? {};

    if (!scenarios || !Array.isArray(scenarios) || scenarios.length === 0) {
      return NextResponse.json({ error: 'Missing required fields or incorrect format' }, { status: 400 });
    }
    try {
      for (const s of scenarios) {
        assertValidAccountId(s?.accountId);
        assertValidScenarioId(s?.scenarioId);
      }
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'Invalid input' }, { status: 400 });
    }

    if (new URL(req.url).searchParams.get('sync') === '1') {
      let captured: unknown = null;
      await executeRemoveSpoke(
        input, async () => {}, async r => { captured = r; }, async () => {}, async () => {},
      );
      return NextResponse.json(captured ?? { success: true });
    }

    const accountId = scenarios[0]?.accountId;
    const started = await startJob(
      {
        type: 'remove-spoke',
        label: `Tear down ${scenarios.length} scenario(s)`,
        accountId,
      },
      (report, setResult, checkpoint, seed) =>
        executeRemoveSpoke(input, report, setResult, checkpoint, seed),
    );

    if ('conflict' in started) {
      return NextResponse.json(
        { error: 'A teardown is already running for this account.', jobId: started.conflict.id },
        { status: 409 },
      );
    }

    return NextResponse.json(
      { jobId: started.jobId, message: 'Teardown started. Progress is tracked in the Process Queue.' },
      { status: 202 },
    );
  } catch (error) {
    console.error('Error in /api/remove-spoke:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal Server Error' },
      { status: 500 },
    );
  }
}
