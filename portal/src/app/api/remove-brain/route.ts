import { NextResponse } from "next/server";
import { exec } from "child_process";
import path from "path";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { removeBrainRecord } from "@/lib/brains";
import { assumeChain, roleArns, toEnv, resourcePrefix } from "@/lib/aws-auth";
import { startJob, type Report, type Checkpoint, type SeedCheckpoints } from "@/lib/job-runner";
import { countStackResources, startStackProgress } from "@/lib/cfn-progress";

const BRAIN_STACK = `${resourcePrefix()}-monitoring`;

/**
 * Tear down the hub architecture. Runs as a tracked job: the removal takes minutes,
 * and previously the only indicator was component-local state in the page, so
 * navigating away destroyed it while the work continued invisibly.
 */
async function executeRemoval(
  input: { accountId: string; region: string },
  report: Report,
  checkpoint: Checkpoint,
  seed: SeedCheckpoints,
): Promise<void> {
  const { accountId, region } = input;

  await seed([{ key: "stack_remove" }]);
  await report("Assuming brain deployment role", { phase: "authenticating" });

  // Chain ambient -> hub-service-role -> brain-deployment-role.
  let chainCreds;
  try {
    chainCreds = await assumeChain({
      targetRoleArn: roleArns.brainDeploy(),
      region,
      sessionName: "MirageHubRemoval",
    });
  } catch (stsError) {
    const msg = stsError instanceof Error ? stsError.message : String(stsError);
    throw new Error(`Failed to assume brain deployment role: ${msg}`);
  }

  const {
    AWS_ACCESS_KEY_ID: AccessKeyId,
    AWS_SECRET_ACCESS_KEY: SecretAccessKey,
    AWS_SESSION_TOKEN: SessionToken,
  } = toEnv(chainCreds);

  // Resource count before deletion is the denominator for the progress bar.
  const cfn = new CloudFormationClient({ region, credentials: chainCreds });
  const total = await countStackResources(cfn, BRAIN_STACK);
  await report(`Stack has ${total} resources to remove`, {
    phase: "removing stack",
    current: 0,
    total,
  });

  const since = new Date();
  const stopProgress = startStackProgress({
    cfn,
    stackName: BRAIN_STACK,
    total,
    since,
    phase: "removing stack",
    report,
  });

  try {
    const scriptPath = path.join(process.cwd(), "src", "scripts", "remove-hub.sh");

    await new Promise<void>((resolve, reject) => {
      const childProc = exec(`bash "${scriptPath}" "${region}" ""`, {
        cwd: process.cwd(),
        env: {
          ...process.env, // inherit PATH so the aws CLI resolves
          AWS_ACCESS_KEY_ID: AccessKeyId,
          AWS_SECRET_ACCESS_KEY: SecretAccessKey,
          AWS_SESSION_TOKEN: SessionToken,
          AWS_DEFAULT_REGION: region,
        },
      });

      // Keep the tail of stderr: remove-hub.sh prints the per-resource
      // CloudFormation failure reasons there, and an exit code alone does not tell
      // the operator which resource blocked the delete.
      let stderrTail = "";

      childProc.stdout?.on("data", d => console.log(`[REMOVE] ${String(d).trim()}`));
      childProc.stderr?.on("data", d => {
        const text = String(d);
        console.error(`[REMOVE ERR] ${text.trim()}`);
        stderrTail = (stderrTail + text).slice(-1500);
      });

      childProc.on("close", code => {
        if (code === 0) return resolve();
        const detail = stderrTail.trim();
        reject(
          new Error(
            detail
              ? `Removal script failed (exit ${code}): ${detail}`
              : `Removal script failed with exit code ${code}`,
          ),
        );
      });
    });
  } finally {
    stopProgress();
  }

  // Do not claim a deletion that did not happen: remove-hub.sh exits 0 when the
  // stack is already absent, which is a correct no-op rather than a removal.
  await report(
    total === 0
      ? "No stack was present - nothing to remove"
      : `Stack deleted (${total} resources)`,
    { phase: "updating registry", current: total, total },
  );

  await checkpoint(
    "stack_remove",
    total === 0 ? "skipped" : "done",
    total === 0 ? "No stack was present" : `${total} resources removed`,
  );

  try {
    await removeBrainRecord(accountId);
  } catch (regErr) {
    // The stack is already gone; a registry write failure must not fail the job.
    console.warn("[Mirage] Failed to remove brain from registry:", regErr);
    await report("Warning: could not update the brain registry (stack is already removed)");
  }
}

export async function POST(request: Request) {
  try {
    const { accountId, region = "us-west-2" } = await request.json();

    if (!accountId) {
      return NextResponse.json({ error: "Missing accountId" }, { status: 400 });
    }

    const started = await startJob(
      {
        type: "remove-brain",
        label: "Remove monitoring brain",
        accountId,
      },
      (report, _setResult, checkpoint, seed) =>
        executeRemoval({ accountId, region }, report, checkpoint, seed),
    );

    if ("conflict" in started) {
      return NextResponse.json(
        {
          error: "A removal is already running for this account.",
          jobId: started.conflict.id,
        },
        { status: 409 },
      );
    }

    return NextResponse.json(
      {
        jobId: started.jobId,
        message: "Removal started. Progress is tracked in the Process Queue.",
      },
      { status: 202 },
    );
  } catch (error) {
    console.error("[Mirage] Removal Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to start removal." },
      { status: 500 },
    );
  }
}
