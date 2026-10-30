import { NextResponse } from 'next/server';
import { assertValidAccountId } from '@/lib/tf-render';
import { findActiveConflict } from '@/lib/jobs';
import { reconcileAccountRules } from '@/lib/rules-sync';

export const dynamic = 'force-dynamic';

/**
 * Re-plan an account's rules from its deployed decoys (the same planner deploy and
 * teardown use). Repairs records written before per-region rules. Nothing is pushed.
 * Body: { accountId, dryRun? } -- dryRun returns the plan without writing anything.
 */
export async function POST(req: Request) {
  try {
    const { accountId, dryRun } = await req.json();
    assertValidAccountId(accountId);
    for (const type of ['deploy-spoke', 'remove-spoke'] as const) {
      const busy = await findActiveConflict(type, accountId);
      if (busy) return NextResponse.json({ error: `A ${type} job is running for this account`, jobId: busy.id }, { status: 409 });
    }
    const result = await reconcileAccountRules(accountId, { dryRun: dryRun !== false });
    return NextResponse.json({ dryRun: dryRun !== false, ...result }, { status: result.failures.length ? 502 : 200 });
  } catch (error) {
    console.error('Error in /api/rules/reconcile:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Internal Server Error' }, { status: 500 });
  }
}
