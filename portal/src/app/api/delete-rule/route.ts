import { NextResponse } from 'next/server';
import { queryRules, deleteRule } from '@/lib/db';
import { assertValidAccountId } from '@/lib/tf-render';
import { accountDecoys, deleteRuleEverywhere, ruleRegions, spokeCredentials, withAccountLock } from '@/lib/rules-sync';

/**
 * Delete one rule: in AWS in every region it lives in (from the record), then the record.
 * If any region fails, the record is kept so the delete can be retried. No trust edit:
 * the forwarding role trusts every <prefix>-fwd-* rule of the account.
 */
export async function POST(req: Request) {
  try {
    const { accountId, ruleName } = await req.json();
    if (!accountId || !ruleName) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }
    assertValidAccountId(accountId);

    return await withAccountLock(accountId, async () => {
      const rule = (await queryRules(accountId)).find(r => r.ruleName === ruleName);
      if (!rule) return NextResponse.json({ error: 'Rule not found' }, { status: 404 });

      const pushed = rule.status !== 'pending' || !!rule.deployedPattern || Object.keys(rule.regionStatus ?? {}).length > 0;
      if (pushed) {
        const { regions } = await accountDecoys(accountId);
        const credentials = await spokeCredentials(accountId, 'MirageRuleDeletion');
        const failed = await deleteRuleEverywhere(rule, ruleRegions(rule, regions), credentials);
        if (failed.length) {
          return NextResponse.json({ error: `Could not delete ${ruleName} in: ${failed.join('; ')}. The record is kept; retry.` }, { status: 502 });
        }
      }
      await deleteRule(accountId, ruleName);
      return NextResponse.json({ success: true, message: `Rule ${ruleName} deleted.` });
    });
  } catch (error) {
    console.error('Error in /api/delete-rule:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Internal Server Error' }, { status: 500 });
  }
}
