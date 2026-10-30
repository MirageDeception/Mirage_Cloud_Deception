export interface Scenario {
  id: string;
  name: string;
  description: string;
  resources?: string;
  comingSoon?: boolean;
  populateSupported?: boolean;
  source?: 'official' | 'custom';
}

export interface Notification {
  id: string;
  type: 'sync' | 'deploy' | 'teardown' | 'rule' | 'force_remove' | 'populate';
  status: 'success' | 'failure' | 'info';
  message: string;
  details?: string;
  timestamp: string;
  read: boolean;
}

/** One scenario-to-rule link from /api/rules (an empty ruleName = no rule watches it). */
export interface InventoryItem { accountId: string; scenarioId: string; ruleName: string; deployedAt: string }

export type Tab = "catalog" | "active" | "rules" | "history";
export type Notify = (type: Notification['type'], status: Notification['status'], message: string, details?: string) => void;

export interface ActiveScenario {
  id: string;
  scenarioId: string;
  scenarioName: string;
  accountId: string;
  deployedAt: string;
  decoys?: Array<{ name: string; category: string }>;
  region?: string;
  tfstateBucket?: string;
  tfstateKey?: string;
}

/**
 * Follow a queued operation to completion and return its structured result.
 *
 * deploy-spoke / remove-spoke return 202 { jobId } and do the work in the
 * background, so the browser polls instead of holding a request open. The job's
 * `result` carries the same shape the synchronous response used to return, which is
 * why the callers below did not need restructuring.
 *
 * A partial failure is a failed job that still has a result, so the result is
 * returned even on failure and the caller renders the per-scenario errors as before.
 */
export interface OperationResult {
  success?: boolean;
  deployed?: string[];
  failed?: { id: string; error: string }[];
  duplicates?: { scenarioId: string; resources: string[] }[];
  populated?: {
    scenarioId: string;
    manifestFound: boolean;
    results: { label: string; status: string; error?: string }[];
  }[];
  message?: string;
}

export async function followJob(jobId: string, timeoutMs = 30 * 60 * 1000): Promise<OperationResult> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise(r => setTimeout(r, 3000));
    const res = await fetch(`/api/jobs/${jobId}`);
    if (!res.ok) continue;
    const { job } = await res.json();
    if (!job) continue;
    if (job.status === 'succeeded') return job.result ?? { success: true };
    if (job.status === 'failed' || job.status === 'interrupted') {
      const err = new Error(job.error || 'Operation failed') as Error & { result?: unknown };
      err.result = job.result;
      throw err;
    }
  }
  throw new Error('Timed out waiting for the operation. Check the Process Queue for its status.');
}

/** Unwrap either a queued (202 + jobId) or a direct synchronous response. */
export async function readOperationResponse(res: Response): Promise<OperationResult> {
  const body = await res.json();
  if (body && typeof body.jobId === 'string') return followJob(body.jobId);
  return body;
}

/** AWS account ids are exactly 12 digits. Deriving role ARNs from anything else
 *  yields well-formed ARNs for an account that does not exist, which surfaces much
 *  later as an opaque STS/IAM denial rather than as the typo it is. */
export const ACCOUNT_ID_RE = /^\d{12}$/;

// NEXT_PUBLIC_* because this runs in the browser -- a server-only env var
// (like MIRAGE_RESOURCE_PREFIX) is not available here. Must be kept equal
// to MIRAGE_RESOURCE_PREFIX; scripts/sync-env-from-stack.sh writes both.
export const PREFIX = process.env.NEXT_PUBLIC_MIRAGE_RESOURCE_PREFIX || "mirage-ops";
