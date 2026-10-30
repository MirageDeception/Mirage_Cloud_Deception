import { NextResponse } from "next/server";
import { assumeChain, roleArns, resourcePrefix } from "@/lib/aws-auth";
import {
  CloudFormationClient,
  DescribeStacksCommand,
  CreateStackCommand,
  UpdateStackCommand,
  DeleteStackCommand,
  DescribeStackEventsCommand,
  waitUntilStackCreateComplete,
  waitUntilStackUpdateComplete,
  waitUntilStackDeleteComplete,
} from "@aws-sdk/client-cloudformation";
import { SNSClient, SubscribeCommand } from "@aws-sdk/client-sns";
import fs from "fs";
import path from "path";
import { saveBrain } from "@/lib/brains";
import { startJob, type Report, type Checkpoint, type SeedCheckpoints } from "@/lib/job-runner";
import { countTemplateResources, startStackProgress } from "@/lib/cfn-progress";

const BRAIN_STACK = `${resourcePrefix()}-monitoring`;
const RULES_STACK = `${resourcePrefix()}-service-rules`;

// Helper function to deploy a CloudFormation stack cleanly with live polling.
//
// `parameters` are the params we have an explicit value for this run.
// `updatableParamKeys` is the FULL set of template parameter keys that may be
// omitted from `parameters` when their source env var is unset. On an UPDATE,
// any such key NOT present in `parameters` is sent as { UsePreviousValue: true }
// so an unset env var never resets a deployed value to the template default
// (CloudFormation has no implicit "keep current" — an omitted param on update
// reverts to the template Default). On CREATE, UsePreviousValue is invalid, so
// omitted keys fall through to the template default (correct for a fresh stack).
async function deployCfnStack(
  cfnClient: CloudFormationClient,
  stackName: string,
  templateBody: string,
  parameters?: Array<{ ParameterKey: string; ParameterValue: string }>,
  updatableParamKeys?: string[]
) {
  let stackStatus: string | undefined;

  try {
    const desc = await cfnClient.send(new DescribeStacksCommand({ StackName: stackName }));
    stackStatus = desc.Stacks?.[0]?.StackStatus;
  } catch (err) {
    if (!(err as Error).message?.includes("does not exist") && (err as Error).name !== "ValidationError") {
      throw err;
    }
  }

  // If stack previously failed in creation/rollback, delete it cleanly so it can be re-created
  if (stackStatus === "ROLLBACK_COMPLETE" || stackStatus === "CREATE_FAILED") {
    console.log(`[Mirage] Stack ${stackName} is in ${stackStatus}. Deleting before re-creation...`);
    await cfnClient.send(new DeleteStackCommand({ StackName: stackName }));
    await waitUntilStackDeleteComplete(
      { client: cfnClient, maxWaitTime: 300, minDelay: 5 },
      { StackName: stackName }
    );
    stackStatus = undefined;
  }

  if (!stackStatus || stackStatus === "DELETE_COMPLETE") {
    console.log(`[Mirage] Creating stack ${stackName}...`);
    // CREATE: only send params we have values for; omitted keys use the template
    // default. UsePreviousValue is invalid on create, so it is not used here.
    await cfnClient.send(
      new CreateStackCommand({
        StackName: stackName,
        TemplateBody: templateBody,
        Capabilities: ["CAPABILITY_NAMED_IAM"],
        Parameters: parameters && parameters.length > 0 ? parameters : undefined,
      })
    );

    console.log(`[Mirage] Waiting for ${stackName} CREATE_COMPLETE...`);
    try {
      await waitUntilStackCreateComplete(
        { client: cfnClient, maxWaitTime: 900, minDelay: 5 },
        { StackName: stackName }
      );
      console.log(`[Mirage] Stack ${stackName} created successfully!`);
    } catch (waitErr) {
      try {
        const events = await cfnClient.send(new DescribeStackEventsCommand({ StackName: stackName }));
        const failedEvents = events.StackEvents?.filter(
          (e) => e.ResourceStatus?.includes("FAILED") || (e.ResourceStatusReason && !e.ResourceStatusReason.includes("User Initiated"))
        );
        const reason = failedEvents?.[0]?.ResourceStatusReason || (waitErr as Error).message;
        throw new Error(`Stack ${stackName} creation failed: ${reason}`);
      } catch (subErr) {
        throw new Error((subErr as Error).message || (waitErr as Error).message);
      }
    }
  } else {
    console.log(`[Mirage] Updating stack ${stackName} (current status: ${stackStatus})...`);
    try {
      // UPDATE: send explicit values, and for every updatable key we did NOT
      // supply a value for this run, send { UsePreviousValue: true } so a missing
      // env var keeps the currently-deployed value instead of resetting it to the
      // template default. (Guards the silent-detection-loss bug where an unset
      // MIRAGE_ORG_ID would blank OrgId and drop the event-bus PutEvents policy.)
      const suppliedKeys = new Set((parameters ?? []).map((p) => p.ParameterKey));
      const updateParams: Array<
        | { ParameterKey: string; ParameterValue: string }
        | { ParameterKey: string; UsePreviousValue: true }
      > = [
        ...(parameters ?? []),
        ...(updatableParamKeys ?? [])
          .filter((k) => !suppliedKeys.has(k))
          .map((k) => ({ ParameterKey: k, UsePreviousValue: true as const })),
      ];
      await cfnClient.send(
        new UpdateStackCommand({
          StackName: stackName,
          TemplateBody: templateBody,
          Capabilities: ["CAPABILITY_NAMED_IAM"],
          Parameters: updateParams.length > 0 ? updateParams : undefined,
        })
      );

      console.log(`[Mirage] Waiting for ${stackName} UPDATE_COMPLETE...`);
      await waitUntilStackUpdateComplete(
        { client: cfnClient, maxWaitTime: 900, minDelay: 5 },
        { StackName: stackName }
      );
      console.log(`[Mirage] Stack ${stackName} updated successfully!`);
    } catch (updateErr) {
      if ((updateErr as Error).message?.includes("No updates are to be performed")) {
        console.log(`[Mirage] Stack ${stackName} is already up to date.`);
      } else {
        try {
          const events = await cfnClient.send(new DescribeStackEventsCommand({ StackName: stackName }));
          const failedEvents = events.StackEvents?.filter(
            (e) => e.ResourceStatus?.includes("FAILED") || (e.ResourceStatusReason && !e.ResourceStatusReason.includes("User Initiated"))
          );
          const reason = failedEvents?.[0]?.ResourceStatusReason || (updateErr as Error).message;
          throw new Error(`Stack ${stackName} update failed: ${reason}`);
        } catch (subErr) {
          throw new Error((subErr as Error).message || (updateErr as Error).message);
        }
      }
    }
  }
}

/**
 * Deploy the hub brain. Runs as a tracked job: two CloudFormation stacks with
 * waiters up to 900s each, which previously blocked the HTTP request while the only
 * progress indicator was component-local state that navigation destroyed.
 *
 * Progress is a real percentage, counted from stack events across both stacks.
 */
async function executeDeploy(
  input: {
    accountId: string;
    region: string;
    whitelistedArns: string;
    email: string;
    webhookUrl: string;
  },
  report: Report,
  checkpoint: Checkpoint,
  seed: SeedCheckpoints,
): Promise<void> {
  const { accountId, region, whitelistedArns, email, webhookUrl } = input;

  await seed([{ key: "stack_deploy" }]);
  await report("Assuming brain deployment role", { phase: "authenticating" });

  // 1. Chain ambient creds -> hub-service-role -> brain-deployment-role.
  //    (The brain role trusts only the hub service role, so a single direct
  //    assume from SSO/instance creds would fail.) No ExternalId on this leg.
  let credentials;
  try {
    credentials = await assumeChain({
      targetRoleArn: roleArns.brainDeploy(),
      region,
      sessionName: "MirageHubDeployment",
    });
  } catch (stsError) {
    const msg = stsError instanceof Error ? stsError.message : String(stsError);
    throw new Error(`Failed to assume brain deployment role: ${msg}`);
  }

  const cfnClient = new CloudFormationClient({ region, credentials });

  // 2. Deploy Base Infrastructure (Monitoring Brain: SNS, Lambda, EventBus,
  //    DynamoDB mirage-state, tfstate S3 bucket, audit-logs S3 bucket).
  const brainTemplatePath = path.join(process.cwd(), "src", "templates", "hub", "monitoring-brain.yaml");
  const brainTemplate = fs.readFileSync(brainTemplatePath, "utf-8");
  const rulesTemplatePath = path.join(process.cwd(), "src", "templates", "hub", "service-rules.yaml");
  const rulesTemplate = fs.readFileSync(rulesTemplatePath, "utf-8");

  const brainTotal = countTemplateResources(brainTemplate);
  const rulesTotal = countTemplateResources(rulesTemplate);
  const grandTotal = brainTotal + rulesTotal;

  // Optional infra params (auto-named/skipped if unset). PortalInstanceRoleArn
  // grants the box PutObject on the audit bucket; ResourcePrefix must match
  // hub/hub-bootstrap.yaml's or the brain-deployment-role's IAM scoping won't
  // reach anything this stack creates. Sourced from the deployed infra (env).
  const brainParams = [
    { ParameterKey: "ResourcePrefix", ParameterValue: resourcePrefix() },
    ...(whitelistedArns && whitelistedArns.trim() !== ""
      ? [{ ParameterKey: "WhitelistedARNs", ParameterValue: whitelistedArns.trim() }]
      : []),
    ...(process.env.MIRAGE_ALERT_LABEL
      ? [{ ParameterKey: "AlertLabel", ParameterValue: process.env.MIRAGE_ALERT_LABEL }]
      : []),
    ...(process.env.MIRAGE_PORTAL_INSTANCE_ROLE_ARN
      ? [{ ParameterKey: "PortalInstanceRoleArn", ParameterValue: process.env.MIRAGE_PORTAL_INSTANCE_ROLE_ARN }]
      : []),
    // Org id enables cross-account PutEvents on the hub bus (all spokes can
    // forward). Without it the bus has no resource policy and spoke forwards
    // fail. Sourced from MIRAGE_ORG_ID.
    ...(process.env.MIRAGE_ORG_ID
      ? [{ ParameterKey: "OrgId", ParameterValue: process.env.MIRAGE_ORG_ID }]
      : []),
  ];

  // Full set of monitoring-brain params that are conditionally supplied from
  // env. On an UPDATE, any of these NOT in brainParams this run is sent as
  // UsePreviousValue (see deployCfnStack) so a missing env var never resets a
  // deployed value to the template default. WhitelistedARNs/ResourcePrefix have
  // real template defaults and are included so they are preserved on update too.
  const brainUpdatableParamKeys = [
    "ResourcePrefix",
    "WhitelistedARNs",
    "AlertLabel",
    "PortalInstanceRoleArn",
    "OrgId",
  ];

  await report(`Deploying ${BRAIN_STACK} (${brainTotal} resources)`, {
    phase: "deploying monitoring brain",
    current: 0,
    total: grandTotal,
  });

  let stopProgress = startStackProgress({
    cfn: cfnClient,
    stackName: BRAIN_STACK,
    total: brainTotal,
    grandTotal,
    since: new Date(),
    phase: "deploying monitoring brain",
    report,
  });
  try {
    await deployCfnStack(
      cfnClient,
      BRAIN_STACK,
      brainTemplate,
      brainParams.length ? brainParams : undefined,
      brainUpdatableParamKeys
    );
  } finally {
    stopProgress();
  }
  await report(`${BRAIN_STACK} complete`, { current: brainTotal, total: grandTotal });

  // 3. Deploy Service Rules (depends on brain stack exports)
  await report(`Deploying ${RULES_STACK} (${rulesTotal} resources)`, {
    phase: "deploying service rules",
  });

  stopProgress = startStackProgress({
    cfn: cfnClient,
    stackName: RULES_STACK,
    total: rulesTotal,
    offset: brainTotal,
    grandTotal,
    since: new Date(),
    phase: "deploying service rules",
    report,
  });
  try {
    await deployCfnStack(
      cfnClient,
      RULES_STACK,
      rulesTemplate,
      [{ ParameterKey: "ResourcePrefix", ParameterValue: resourcePrefix() }],
      ["ResourcePrefix"]
    );
  } finally {
    stopProgress();
  }
  await report(`${RULES_STACK} complete`, { current: grandTotal, total: grandTotal });
  await checkpoint("stack_deploy", "done", `${BRAIN_STACK} + ${RULES_STACK} (${grandTotal} resources)`);

  // 4. Handle Optional SNS Subscriptions (Email / Webhook)
  if ((email && email.trim() !== "") || (webhookUrl && webhookUrl.trim() !== "")) {
    await report("Configuring SNS subscriptions", { phase: "subscriptions" });

    const describeRes = await cfnClient.send(new DescribeStacksCommand({ StackName: BRAIN_STACK }));
    const snsOutput = describeRes.Stacks?.[0]?.Outputs?.find(o => o.OutputKey === "SNSTopicArn");

    if (snsOutput && snsOutput.OutputValue) {
      const snsClient = new SNSClient({ region, credentials });
      const topicArn = snsOutput.OutputValue;

      if (email && email.trim() !== "") {
        await snsClient.send(new SubscribeCommand({
          TopicArn: topicArn,
          Protocol: "email",
          Endpoint: email.trim(),
        }));
        await report(`Subscribed ${email.trim()} — it must be confirmed from the email AWS sends`);
      }

      if (webhookUrl && webhookUrl.trim() !== "") {
        const protocol = webhookUrl.startsWith("https") ? "https" : "http";
        await snsClient.send(new SubscribeCommand({
          TopicArn: topicArn,
          Protocol: protocol,
          Endpoint: webhookUrl.trim(),
        }));
        await report(`Subscribed webhook ${webhookUrl.trim()}`);
      }
    }
  }

  // Record deployed brain in the persistent Brain registry
  try {
    await saveBrain({
      accountId,
      region,
      globalBusArn: `arn:aws:events:${region}:${accountId}:event-bus/${resourcePrefix()}-event-bus`,
      deployedAt: new Date().toISOString(),
      status: 'active'
    });
  } catch (regErr) {
    // The stacks are deployed; a registry write failure must not fail the job.
    console.warn("[Mirage] Failed to record deployed brain in registry:", regErr);
    await report("Warning: stacks deployed but the brain registry could not be updated");
  }
}

export async function POST(request: Request) {
  try {
    const { accountId, region = "us-west-2", whitelistedArns = "", email = "", webhookUrl = "" } =
      await request.json();

    if (!accountId) {
      return NextResponse.json({ error: "Missing accountId" }, { status: 400 });
    }

    const input = { accountId, region, whitelistedArns, email, webhookUrl };

    // Escape hatch: ?sync=1 keeps the original blocking behaviour, so a problem in
    // the job path never leaves the platform undeployable.
    const sync = new URL(request.url).searchParams.get("sync") === "1";
    if (sync) {
      const noop: Report = async () => {};
      await executeDeploy(input, noop, async () => {}, async () => {});
      return NextResponse.json(
        { message: "Hub brain deployed (synchronous mode)." },
        { status: 200 },
      );
    }

    const started = await startJob(
      {
        type: "deploy-brain",
        label: "Deploy monitoring brain",
        accountId,
      },
      (report, _setResult, checkpoint, seed) => executeDeploy(input, report, checkpoint, seed),
    );

    if ("conflict" in started) {
      return NextResponse.json(
        {
          error: "A brain deployment is already running for this account.",
          jobId: started.conflict.id,
        },
        { status: 409 },
      );
    }

    return NextResponse.json(
      {
        jobId: started.jobId,
        message: "Deployment started. Progress is tracked in the Process Queue.",
      },
      { status: 202 },
    );
  } catch (error) {
    console.error("[Mirage] Deployment Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to start deployment." },
      { status: 500 },
    );
  }
}
