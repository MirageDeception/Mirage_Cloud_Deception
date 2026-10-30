import { STORAGE_BACKEND, getRules, getScenarios, queryScenarios, type RuleRecord, type ScenarioRecord } from '@/lib/db';
import { queryDetections, type DetectionRecord } from '@/lib/detections';

/**
 * Dashboard tile values.
 *
 * `null` means "could not determine", which is deliberately not the same as 0. The
 * portal's read helpers answer a store outage with an empty list, and on a list page
 * that is tolerable -- an empty table looks like an empty table. On a metrics tile a
 * confident 0 reads as a measurement, so an outage would be indistinguishable from a
 * genuinely empty fabric. `errors` carries what to tell the operator.
 */
export interface DashboardMetrics {
  /** Total decoy resources across every live scenario. */
  activeDecoys: number | null;
  /** Spoke accounts that currently hold decoys -- not every spoke ever onboarded. */
  spokeAccounts: number | null;
  /** Detections still awaiting triage (status `active`). */
  activeAlerts: number | null;
  /** The records behind the tiles, reused by the mesh view; null when unreadable. */
  scenarios: ScenarioRecord[] | null;
  detections: DetectionRecord[] | null;
  /** Rule records, for the mesh's "not monitored yet" marker; null when unreadable. */
  rules: RuleRecord[] | null;
  errors: string[];
}

export async function getDashboardMetrics(): Promise<DashboardMetrics> {
  const errors: string[] = [];
  let activeDecoys: number | null = null;
  let spokeAccounts: number | null = null;
  let activeAlerts: number | null = null;
  let scenarios: ScenarioRecord[] | null = null;
  let detections: DetectionRecord[] | null = null;
  let rules: RuleRecord[] | null = null;
  try {
    rules = await getRules();
  } catch {
    rules = null; // the mesh then shows no monitoring marker rather than a wrong one
  }

  // Both decoy and spoke counts come from the same scenario read, so one call.
  //
  // Spoke count is derived from live scenarios rather than getSpokes(): registerSpoke()
  // writes a SPOKE#<id>/META record that nothing ever deletes, so getSpokes() counts
  // every account ever deployed to and would still report 1 after a full teardown.
  // Deriving it here means the number falls on its own when decoys go away.
  try {
    scenarios =
      STORAGE_BACKEND === 'local'
        ? await getScenarios() // flat files ARE the store in local dev, so this is truthful
        : await queryScenarios();
    activeDecoys = scenarios.reduce((sum, s) => sum + (s.decoys?.length ?? 0), 0);
    spokeAccounts = new Set(scenarios.map(s => s.accountId)).size;
  } catch (err) {
    console.warn(
      '[Metrics] scenario read failed:',
      err instanceof Error ? err.message : err,
    );
    errors.push('Deployed-decoy state unavailable - could not reach the mirage-state table.');
  }

  // In local dev there is no alerts table at all, so zero is the honest answer.
  if (STORAGE_BACKEND === 'local') {
    activeAlerts = 0;
    detections = [];
  } else {
    try {
      detections = await queryDetections();
      activeAlerts = detections.filter(d => d.status === 'active').length;
    } catch (err) {
      console.warn(
        '[Metrics] detection read failed:',
        err instanceof Error ? err.message : err,
      );
      errors.push('Alert state unavailable - could not reach the mirage-alerts table.');
    }
  }

  return { activeDecoys, spokeAccounts, activeAlerts, scenarios, detections, rules, errors };
}
