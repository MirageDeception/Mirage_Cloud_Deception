import { NextResponse } from 'next/server';
import { getRules, getScenarios } from '@/lib/db';
import { matchTokens } from '@/lib/decoy-match';

// A decoy appears in a pattern as the value deploy-spoke inserted -- for `iam` that is
// the full role ARN, not the bare name. Testing the bare name misses those completely,
// which is why a scenario whose decoys are all roles (scenario-15) resolved to no rule
// and dropped out of the Deployed Scenarios count: 15 shown of 16 deployed. The bare
// name is kept as a fallback for patterns written before decoy-match.ts shipped.
const decoyInPattern = (
  pattern: string,
  accountId: string,
  d: { name: string; category: string },
) => matchTokens(d.category, d.name, accountId).some(t => pattern.includes(`"${t}"`));

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const accountId = url.searchParams.get('accountId') || undefined;

    const [rules, scenarios] = await Promise.all([getRules(accountId), getScenarios(accountId)]);

    // Derive a flat inventory-style list for backward compatibility with UI components
    // that filter by ruleName. For each scenario, find rules whose eventPattern mentions
    // at least one of its decoy names.
    const inventory = scenarios.flatMap(s => {
      const matchingRuleNames = rules
        .filter(r => s.decoys.some(d => decoyInPattern(r.eventPattern, s.accountId, d)))
        .map(r => r.ruleName);
      if (matchingRuleNames.length === 0) {
        return [{ accountId: s.accountId, scenarioId: s.scenarioId, ruleName: '' as string, deployedAt: s.deployedAt }];
      }
      return matchingRuleNames.map(ruleName => ({
        accountId: s.accountId,
        scenarioId: s.scenarioId,
        ruleName,
        deployedAt: s.deployedAt,
      }));
    });

    return NextResponse.json({ rules, scenarios, inventory });
  } catch (error) {
    console.error("Error fetching rules:", error);
    return NextResponse.json({ error: 'Failed to fetch rules' }, { status: 500 });
  }
}
