// Runs once when the portal server starts (Next.js instrumentation hook).
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;

  // A new or rebuilt host gets its custom scenarios back from the S3 backup. In the
  // background (start-up must not wait on S3). A failure becomes a failed job, so it
  // shows on the Queue page and in the bell instead of only in the server log.
  void (async () => {
    const { restoreMissingCustomScenarios } = await import('./lib/custom-scenarios');
    try {
      const ids = await restoreMissingCustomScenarios();
      if (ids.length) console.log(`[custom scenarios] restored from backup: ${ids.join(', ')}`);
    } catch (e) {
      console.error('[custom scenarios] restore from backup failed:', e);
      const { createJob, runJob } = await import('./lib/jobs');
      const job = await createJob({ type: 'restore-custom', label: 'Restore custom scenarios from S3 backup' });
      await runJob(job.id, async () => { throw e; });
    }
  })();

  // Every 6h: drop stale Terraform working dirs and any full provider copy.
  const { startDiskHygiene } = await import('./lib/disk');
  startDiskHygiene();

  // MIRAGE_SCENARIO_AUTOSYNC=0 turns the 24h GitHub sync off; "Sync now" still works.
  if (process.env.MIRAGE_SCENARIO_AUTOSYNC === '0') return;
  const { startAutoSync } = await import('./lib/scenario-autosync');
  startAutoSync();
}
