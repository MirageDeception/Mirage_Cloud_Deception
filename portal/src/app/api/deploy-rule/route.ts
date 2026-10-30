import { NextResponse } from 'next/server';
import { queryRules, saveRuleState, getScenarios } from '@/lib/db';
import { appendHistory } from '@/lib/history';
import { assertValidAccountId } from '@/lib/tf-render';
import { MAX_PATTERN_CHARS, parsePattern, patternForRegion, ruleKind, ruleRegion } from '@/lib/rules-plan';
import {
  accountDecoys, ensureForwardingTrust, pushRule, ruleRegions, spokeCredentials, withAccountLock,
} from '@/lib/rules-sync';

/**
 * Push one rule record to AWS: its own region (regional) or every identity region
 * (identity). The region always comes from the record, never from the browser -- the
 * catalog's Deploy Region dropdown used to decide it, which could send a rule to the
 * wrong region. Before pushing, the forwarding role's trust is put in its one fixed
 * form (any region); if that fails nothing is pushed.
 *
 * Body: { accountId, ruleName, hubBusArn, forwardingRoleArn, eventPattern?, sessionId?, retryFailed? }
 *   eventPattern -- the operator's edited pattern (editor); omitted = push the stored one.
 *   retryFailed  -- identity rules: push again only to the regions that failed last time.
 */
const hasRoles = (pattern?: string) =>
  !!pattern && parsePattern(pattern).conditions.some(c => 'roleArn' in c || 'roleName' in c);

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const { accountId, ruleName, hubBusArn, forwardingRoleArn, eventPattern, sessionId, retryFailed } = body as {
    accountId?: string; ruleName?: string; hubBusArn?: string; forwardingRoleArn?: string;
    eventPattern?: string; sessionId?: string; retryFailed?: boolean;
  };
  if (!accountId || !ruleName || !hubBusArn || !forwardingRoleArn) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }
  try {
    assertValidAccountId(accountId);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Invalid account' }, { status: 400 });
  }

  try {
    return await withAccountLock(accountId, async () => {
      const rules = await queryRules(accountId);
      const rule = rules.find(r => r.ruleName === ruleName);
      if (!rule) return NextResponse.json({ error: `Rule ${ruleName} not found` }, { status: 404 });
      const kind = ruleKind(rule);

      if (typeof eventPattern === 'string' && eventPattern.trim()) {
        if (parsePattern(eventPattern).conditions.length === 0) {
          return NextResponse.json({ error: 'The pattern is not valid JSON or has no conditions' }, { status: 400 });
        }
        rule.eventPattern = eventPattern;
      }
      const size = patternForRegion(rule, kind === 'identity' ? 'us-east-1' : ruleRegion(rule)).length;
      if (size > MAX_PATTERN_CHARS) {
        return NextResponse.json({ error: `Pattern is ${size} characters; the limit is ${MAX_PATTERN_CHARS}` }, { status: 400 });
      }

      // Order guard: a regional push that drops role conditions must wait for the identity
      // rule, or the roles go unwatched in between.
      if (kind === 'regional' && hasRoles(rule.deployedPattern) && !hasRoles(rule.eventPattern)) {
        const identity = rules.filter(r => ruleKind(r) === 'identity');
        if (identity.length === 0 || identity.some(r => r.status !== 'deployed')) {
          return NextResponse.json({
            error: 'Push the identity rule first: this update moves role decoys out of this rule, '
              + 'and they are only watched once the identity rule is deployed in every region.',
          }, { status: 409 });
        }
      }

      const { regions: deployedRegions } = await accountDecoys(accountId);
      const regions = kind === 'identity' && retryFailed
        ? Object.entries(rule.regionStatus ?? {}).filter(([, s]) => s.status === 'failed').map(([r]) => r)
        : ruleRegions(rule, deployedRegions);
      if (regions.length === 0) return NextResponse.json({ error: 'No regions to push to' }, { status: 400 });

      const credentials = await spokeCredentials(accountId, 'MirageRuleDeployment');
      let trust: 'updated' | 'unchanged';
      try {
        trust = await ensureForwardingTrust(accountId, credentials);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return NextResponse.json({ error: `Nothing pushed: could not set the forwarding role's trust (${msg})` }, { status: 502 });
      }

      if (trust === 'updated') {
        await appendHistory({
          sessionId: sessionId || Date.now().toString(),
          type: 'trust_policy_update',
          scenarioId: 'all',
          scenarioName: 'Forwarding role trust: any-region forwarding rules',
          accountId,
          ruleName,
          status: 'success',
        });
      }

      const results = await pushRule(rule, regions, { hubBusArn, forwardingRoleArn, credentials });
      const failed = Object.entries(results).filter(([, r]) => r.status === 'failed');

      if (kind === 'identity') {
        rule.regionStatus = retryFailed ? { ...rule.regionStatus, ...results } : results;
        const allOk = Object.values(rule.regionStatus).every(r => r.status === 'deployed');
        rule.status = allOk ? 'deployed' : 'failed';
        if (allOk) rule.deployedPattern = rule.eventPattern;
      } else {
        rule.status = failed.length ? 'failed' : 'deployed';
        if (!failed.length) rule.deployedPattern = rule.eventPattern;
      }
      rule.charCount = size;
      await saveRuleState(rule);

      const scenarios = await getScenarios(accountId);
      for (const scenarioId of scenarios.length ? [...new Set(scenarios.map(s => s.scenarioId))] : ['unknown']) {
        await appendHistory({
          sessionId: sessionId || Date.now().toString(),
          type: 'rule_push',
          scenarioId,
          scenarioName: scenarioId,
          accountId,
          ruleName,
          status: rule.status === 'deployed' ? 'success' : 'failed',
          ...(failed.length ? { error: failed.map(([r, s]) => `${r}: ${s.error}`).join('; ') } : {}),
        });
      }

      const summary = { ruleName, kind, regions: results, trust, status: rule.status };
      if (rule.status !== 'deployed') {
        return NextResponse.json({
          ...summary,
          error: `Push failed in ${failed.length} of ${regions.length} region(s): `
            + failed.map(([r, s]) => `${r} (${s.error})`).join('; '),
        }, { status: 502 });
      }
      return NextResponse.json({ ...summary, success: true, message: `Pushed ${ruleName} to ${regions.length} region(s).` });
    });
  } catch (error) {
    console.error('Error in /api/deploy-rule:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Internal Server Error' }, { status: 500 });
  }
}
