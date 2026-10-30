import { after } from 'next/server';
import type { CheckpointKey, CheckpointStatus } from './jobs';
import {
  createJob,
  runJob,
  findActiveConflict,
  type JobRecord,
  type JobType,
} from './jobs';

/** Marks one checklist step. `manual` means the platform cannot do it for you. */
export type Checkpoint = (
  key: CheckpointKey,
  status: CheckpointStatus,
  detail?: string,
) => Promise<void>;

/** Declares the checklist up front, including steps not yet reached. */
export type SeedCheckpoints = (
  entries: { key: CheckpointKey; status?: CheckpointStatus; detail?: string }[],
) => Promise<void>;

/** Sets the job's structured outcome, readable by a poller. */
export type SetResult = (result: unknown) => Promise<void>;

/** Progress reporter handed to a job's work function. */
export type Report = (
  message: string,
  opts?: { phase?: string; current?: number; total?: number },
) => Promise<void>;

export type StartResult = { jobId: string } | { conflict: JobRecord };

/**
 * Create a job and run `work` after the response has been sent.
 *
 * Uses after() from next/server rather than a dangling promise: a promise left
 * running past the response is not guaranteed to complete, whereas after() is the
 * supported hook for post-response work.
 *
 * Refuses to start when an equivalent job is already in flight for the same
 * target, so two runs cannot race the same CloudFormation stack or Terraform
 * state key.
 */
export async function startJob(
  init: {
    type: JobType;
    label: string;
    accountId?: string;
    scenarioId?: string;
    total?: number;
  },
  work: (
    report: Report,
    setResult: SetResult,
    checkpoint: Checkpoint,
    seed: SeedCheckpoints,
  ) => Promise<void>,
): Promise<StartResult> {
  const conflict = await findActiveConflict(init.type, init.accountId, init.scenarioId);
  if (conflict) return { conflict };

  const job = await createJob(init);
  after(async () => {
    await runJob(job.id, work);
  });
  return { jobId: job.id };
}
