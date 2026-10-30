/**
 * The automatic 24-hour scenario sync. Started once per server by src/instrumentation.ts.
 *
 * Checks hourly whether a sync is due, so a restart never resets the clock: due means
 * no success in the last 24h. After a FAILED attempt it waits 6h before retrying,
 * so a broken repo produces a failed job every 6h rather than every hour. Each run is a
 * normal job (Queue page + bell); a failure also turns the Catalog's sync line red.
 */
import { createJob, findActiveConflict, runJob } from './jobs';
import { readSyncStatus, syncOfficialScenarios, SYNC_INTERVAL_MS } from './scenario-sync';

const CHECK_EVERY_MS = 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 6 * 60 * 60 * 1000;

export function startAutoSync(): void {
  // Dev hot reload can re-run register(); one timer per process is enough.
  const g = globalThis as { __mirageAutoSync?: boolean };
  if (g.__mirageAutoSync) return;
  g.__mirageAutoSync = true;

  const tick = async () => {
    try {
      const s = await readSyncStatus();
      const now = Date.now();
      const sinceSuccess = now - (s.lastSuccessAt ? Date.parse(s.lastSuccessAt) : 0);
      const sinceAttempt = now - (s.lastAttemptAt ? Date.parse(s.lastAttemptAt) : 0);
      if (sinceSuccess < SYNC_INTERVAL_MS) return;
      if (s.result === 'failed' && sinceAttempt < RETRY_AFTER_FAILURE_MS) return;
      if (await findActiveConflict('sync-scenarios')) return;

      const job = await createJob({ type: 'sync-scenarios', label: 'Automatic scenario sync (every 24h)' });
      await runJob(job.id, async (report, setResult) => {
        await setResult(await syncOfficialScenarios(report));
      });
    } catch (e) {
      // runJob already records sync failures on the job; this is only for the scheduler itself.
      console.error('[scenario auto-sync]', e);
    }
  };

  setTimeout(tick, 60 * 1000).unref();
  setInterval(tick, CHECK_EVERY_MS).unref();
}
