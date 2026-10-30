import { NextResponse } from 'next/server';
import { startJob } from '@/lib/job-runner';
import { findActiveConflict } from '@/lib/jobs';
import { readSyncStatus, syncOfficialScenarios, SYNC_INTERVAL_MS } from '@/lib/scenario-sync';

export const dynamic = 'force-dynamic';

/** Status for the Catalog: last result, and `stale` when no sync has succeeded for 2 intervals. */
export async function GET() {
  const status = await readSyncStatus();
  const running = await findActiveConflict('sync-scenarios');
  const last = status.lastSuccessAt ? Date.parse(status.lastSuccessAt) : 0;
  return NextResponse.json({
    ...status,
    runningJobId: running?.id ?? null,
    autoSync: process.env.MIRAGE_SCENARIO_AUTOSYNC !== '0',
    stale: Date.now() - last > 2 * SYNC_INTERVAL_MS,
  });
}

/** "Sync now". Runs as a job; refuses while another sync is in flight. */
export async function POST() {
  const started = await startJob(
    { type: 'sync-scenarios', label: 'Sync official scenarios from GitHub' },
    async (report, setResult) => {
      await setResult(await syncOfficialScenarios(report));
    },
  );
  if ('conflict' in started) {
    return NextResponse.json(
      { error: 'A scenario sync is already running.', jobId: started.conflict.id },
      { status: 409 },
    );
  }
  return NextResponse.json({ jobId: started.jobId }, { status: 202 });
}
