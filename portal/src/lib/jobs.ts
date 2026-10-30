import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

// =============================================================================
// JOBS — server-side tracking for long-running operations
//
// Why file-backed and not DynamoDB: mirage-state is CREATED BY the brain stack,
// so storing jobs there would make the brain deploy -- the very operation we most
// need to track -- untrackable before the table exists. Files have no bootstrap
// dependency. This mirrors the db_*.json convention already used for local state.
//
// One file per job, not one shared file: two concurrent updates to a single JSON
// document would clobber each other.
//
// Scope note: the default directory is per-portal-instance. :3000 is the shared
// portal both operators use for real work, so its queue is the shared one; a
// per-operator dev portal keeps its own, which is correct since dev portals run
// STORAGE_BACKEND=local and should not drive shared AWS work.
// =============================================================================

const JOBS_DIR = process.env.MIRAGE_JOBS_DIR || path.join(process.cwd(), 'jobs');

/** Jobs older than this are pruned on list, so the directory cannot grow forever. */
const RETAIN_MS = 7 * 24 * 60 * 60 * 1000;

export const JOB_TYPES = [
  'noop',
  'deploy-brain',
  'remove-brain',
  'deploy-spoke',
  'remove-spoke',
  'sync-scenarios',
  'restore-custom',
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'interrupted',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const TERMINAL_STATUSES: readonly JobStatus[] = ['succeeded', 'failed', 'interrupted'];

/**
 * Checkpoint keys deliberately reuse lib/history.ts's HistoryEventType vocabulary.
 * Both are views of the same events -- history is the durable per-account audit in
 * DynamoDB, a job is the live operational view -- so they must not drift into two
 * different names for the same thing.
 */
export type CheckpointKey =
  | 'scenario_deploy'
  | 'rule_generate'
  | 'rule_push'
  | 'trust_policy_update'
  | 'scenario_populate'
  | 'scenario_teardown'
  | 'rule_teardown'
  | 'trust_policy_teardown'
  | 'stack_deploy'
  | 'stack_remove';

/** `manual` means the platform cannot do this step for you -- it is not a failure. */
export type CheckpointStatus = 'pending' | 'done' | 'failed' | 'manual' | 'skipped';

export interface JobCheckpoint {
  key: CheckpointKey;
  label: string;
  status: CheckpointStatus;
  detail?: string;
  at?: string;
}

export const CHECKPOINT_LABELS: Record<CheckpointKey, string> = {
  scenario_deploy: 'Decoy resources deployed',
  rule_generate: 'Detection rule generated',
  rule_push: 'Rule pushed to EventBridge',
  trust_policy_update: 'Forwarding-role trust updated',
  scenario_populate: 'Decoy content seeded',
  scenario_teardown: 'Decoy resources destroyed',
  rule_teardown: 'Detection rule removed',
  trust_policy_teardown: 'Forwarding-role trust cleaned up',
  stack_deploy: 'CloudFormation stacks deployed',
  stack_remove: 'CloudFormation stack removed',
};

export interface JobStep {
  at: string;
  message: string;
}

export interface JobRecord {
  id: string;
  type: JobType;
  label: string;
  status: JobStatus;
  phase: string;
  /** total = 0 means indeterminate; the UI shows a moving bar rather than a % */
  progress: { current: number; total: number };
  steps: JobStep[];
  /** Ordered checklist of the real steps this operation performs. */
  checkpoints: JobCheckpoint[];
  accountId?: string;
  scenarioId?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  /** Owning process. Used to detect jobs orphaned by a service restart. */
  pid: number;
  /**
   * Structured outcome, set by the work function. Lets a caller poll the job and
   * then read the same shape the synchronous response used to return (e.g. the
   * per-scenario deployed/failed lists), so UI code does not have to be rewritten.
   * Stored on failure too, because a partial failure still has results worth showing.
   */
  result?: unknown;
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(JOBS_DIR, { recursive: true });
}

const jobPath = (id: string) => path.join(JOBS_DIR, `${id}.json`);

/** Write via temp file + rename so a reader never observes a half-written job. */
async function writeJob(job: JobRecord): Promise<void> {
  await ensureDir();
  const target = jobPath(job.id);
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(job, null, 2));
  await fs.rename(tmp, target);
}

export async function getJob(id: string): Promise<JobRecord | null> {
  try {
    return JSON.parse(await fs.readFile(jobPath(id), 'utf-8')) as JobRecord;
  } catch {
    return null;
  }
}

export async function createJob(init: {
  type: JobType;
  label: string;
  accountId?: string;
  scenarioId?: string;
  total?: number;
}): Promise<JobRecord> {
  const now = new Date().toISOString();
  const job: JobRecord = {
    id: crypto.randomUUID(),
    type: init.type,
    label: init.label,
    status: 'queued',
    phase: 'queued',
    progress: { current: 0, total: init.total ?? 0 },
    steps: [{ at: now, message: 'Queued' }],
    checkpoints: [],
    accountId: init.accountId,
    scenarioId: init.scenarioId,
    createdAt: now,
    pid: process.pid,
  };
  await writeJob(job);
  return job;
}

/**
 * Merge a partial update into a job. Read-modify-write: two writers racing the
 * same job would drop one update, which is acceptable because a job is only ever
 * advanced by the single task that owns it.
 */
export async function updateJob(id: string, patch: Partial<JobRecord>): Promise<JobRecord | null> {
  const job = await getJob(id);
  if (!job) return null;

  const next: JobRecord = { ...job, ...patch };
  if (patch.status === 'running' && !job.startedAt) next.startedAt = new Date().toISOString();
  if (patch.status && TERMINAL_STATUSES.includes(patch.status) && !job.finishedAt) {
    next.finishedAt = new Date().toISOString();
  }
  await writeJob(next);
  return next;
}

/** Append a phase-log line, optionally moving the phase and progress with it. */
export async function appendStep(
  id: string,
  message: string,
  opts?: { phase?: string; current?: number; total?: number },
): Promise<JobRecord | null> {
  const job = await getJob(id);
  if (!job) return null;

  const next: JobRecord = {
    ...job,
    steps: [...job.steps, { at: new Date().toISOString(), message }],
    phase: opts?.phase ?? job.phase,
    progress: {
      current: opts?.current ?? job.progress.current,
      total: opts?.total ?? job.progress.total,
    },
  };
  await writeJob(next);
  return next;
}

/**
 * Declare the checklist up front so the UI shows every expected step, including the
 * ones not reached yet. Without seeding, a checklist would appear to grow out of
 * nowhere and you could not tell a step that failed from one never attempted.
 */
export async function seedCheckpoints(
  id: string,
  entries: { key: CheckpointKey; status?: CheckpointStatus; detail?: string }[],
): Promise<void> {
  const job = await getJob(id);
  if (!job) return;
  const checkpoints: JobCheckpoint[] = entries.map(e => ({
    key: e.key,
    label: CHECKPOINT_LABELS[e.key],
    status: e.status ?? 'pending',
    detail: e.detail,
  }));
  await writeJob({ ...job, checkpoints });
}

/** Upsert one checkpoint by key, preserving checklist order. */
export async function setCheckpoint(
  id: string,
  key: CheckpointKey,
  status: CheckpointStatus,
  detail?: string,
): Promise<void> {
  const job = await getJob(id);
  if (!job) return;
  const at = new Date().toISOString();
  const existing = job.checkpoints.findIndex(c => c.key === key);
  const entry: JobCheckpoint = { key, label: CHECKPOINT_LABELS[key], status, detail, at };
  const checkpoints = [...job.checkpoints];
  if (existing >= 0) checkpoints[existing] = { ...checkpoints[existing], ...entry };
  else checkpoints.push(entry);
  await writeJob({ ...job, checkpoints });
}

/** True if a pid is still alive. signal 0 tests existence without signalling. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A service restart kills in-flight work but leaves the job file saying 'running'
 * forever. Mark those 'interrupted' so the UI tells the truth instead of showing
 * a job that will never finish -- or worse, implying success.
 */
export async function reconcileOrphans(jobs: JobRecord[]): Promise<JobRecord[]> {
  const out: JobRecord[] = [];
  for (const job of jobs) {
    const stale = (job.status === 'running' || job.status === 'queued') && !pidAlive(job.pid);
    if (!stale) {
      out.push(job);
      continue;
    }
    const fixed = await updateJob(job.id, {
      status: 'interrupted',
      phase: 'interrupted',
      error:
        'The portal service restarted while this job was running, so it was abandoned. ' +
        'Terraform jobs may have left a stale S3 state lock that has to be cleared before retrying.',
    });
    out.push(fixed ?? job);
  }
  return out;
}

/** Newest first. Prunes anything past the retention window as a side effect. */
export async function listJobs(filter?: { status?: JobStatus; type?: JobType }): Promise<JobRecord[]> {
  try {
    await ensureDir();
    const names = (await fs.readdir(JOBS_DIR)).filter(n => n.endsWith('.json'));

    const jobs: JobRecord[] = [];
    const cutoff = Date.now() - RETAIN_MS;
    for (const name of names) {
      try {
        const job = JSON.parse(await fs.readFile(path.join(JOBS_DIR, name), 'utf-8')) as JobRecord;
        if (new Date(job.createdAt).getTime() < cutoff) {
          await fs.unlink(path.join(JOBS_DIR, name)).catch(() => {});
          continue;
        }
        jobs.push(job);
      } catch {
        // A half-written or corrupt file should not take the whole queue down.
      }
    }

    let out = await reconcileOrphans(jobs);
    if (filter?.status) out = out.filter(j => j.status === filter.status);
    if (filter?.type) out = out.filter(j => j.type === filter.type);
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch (err) {
    console.warn('[Jobs] listJobs failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Refuse a second job for the same target while one is in flight. Two runs
 * against the same account+scenario would race the same Terraform S3 state key.
 * Returns the conflicting job, or null when it is safe to proceed.
 */
export async function findActiveConflict(
  type: JobType,
  accountId?: string,
  scenarioId?: string,
): Promise<JobRecord | null> {
  const active = (await listJobs()).filter(
    j => j.status === 'queued' || j.status === 'running',
  );
  return (
    active.find(
      j => j.type === type && j.accountId === accountId && j.scenarioId === scenarioId,
    ) ?? null
  );
}

/** Wrap a unit of work so a job is always moved out of 'running', even on throw. */
export async function runJob(
  id: string,
  work: (
    report: (message: string, opts?: { phase?: string; current?: number; total?: number }) => Promise<void>,
    setResult: (result: unknown) => Promise<void>,
    checkpoint: (key: CheckpointKey, status: CheckpointStatus, detail?: string) => Promise<void>,
    seed: (entries: { key: CheckpointKey; status?: CheckpointStatus; detail?: string }[]) => Promise<void>,
  ) => Promise<void>,
): Promise<void> {
  await updateJob(id, { status: 'running', phase: 'starting', pid: process.pid });
  const report = async (
    message: string,
    opts?: { phase?: string; current?: number; total?: number },
  ) => {
    await appendStep(id, message, opts);
  };

  const setResult = async (result: unknown) => {
    await updateJob(id, { result });
  };

  try {
    await work(
      report,
      setResult,
      (key, status, detail) => setCheckpoint(id, key, status, detail),
      entries => seedCheckpoints(id, entries),
    );
    const job = await getJob(id);
    await updateJob(id, {
      status: 'succeeded',
      phase: 'done',
      progress: { current: job?.progress.total || 1, total: job?.progress.total || 1 },
    });
    await appendStep(id, 'Completed successfully');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failing = await getJob(id);
    if (failing) {
      // Mark the step that was in flight as failed; leave manual/skipped alone.
      const idx = failing.checkpoints.findIndex(c => c.status === 'pending');
      if (idx >= 0) {
        await setCheckpoint(id, failing.checkpoints[idx].key, 'failed', message);
      }
    }
    await updateJob(id, { status: 'failed', phase: 'failed', error: message });
    await appendStep(id, `Failed: ${message}`);
  }
}
