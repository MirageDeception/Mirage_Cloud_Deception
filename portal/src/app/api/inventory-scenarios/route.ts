import { NextResponse } from 'next/server';
import { getScenarios } from '@/lib/db';

export async function GET() {
  try {
    const scenarios = await getScenarios();
    const unique = scenarios.map(s => ({
      id: `${s.accountId}-${s.scenarioId}`,
      scenarioId: s.scenarioId,
      scenarioName: s.scenarioId,
      accountId: s.accountId,
      deployedAt: s.deployedAt,
      decoys: s.decoys,
      // Remote-state location + region (parsed from the key) so teardown can
      // target the right S3 state and provider region.
      tfstateBucket: s.tfstateBucket,
      tfstateKey: s.tfstateKey,
      region: s.tfstateKey ? (s.tfstateKey.split('/')[2] || undefined) : undefined,
    }));
    return NextResponse.json(unique);
  } catch {
    return NextResponse.json({ error: 'Failed to load inventory' }, { status: 500 });
  }
}
