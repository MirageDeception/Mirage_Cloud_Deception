/**
 * Applies rules-plan.ts to AWS and the store: reconcile an account's rule records with
 * its deployed decoys, push a rule to its region(s), delete a rule everywhere, and keep
 * the spoke forwarding role's trust in the one form every region needs.
 * See "Forwarding rules" in docs/ARCHITECTURE.md.
 */
import {
  EventBridgeClient, PutRuleCommand, PutTargetsCommand, RemoveTargetsCommand, DeleteRuleCommand,
} from '@aws-sdk/client-eventbridge';
import { IAMClient, GetRoleCommand, UpdateAssumeRolePolicyCommand } from '@aws-sdk/client-iam';
import {
  STORAGE_BACKEND, getScenarios, queryScenarios, queryRules, saveRuleState, deleteRule, nextRuleName,
  type RuleRecord, type ScenarioRecord,
} from '@/lib/db';
import { assumeChain, resourcePrefix, roleArns, spokeExternalId, type SdkCredentials } from '@/lib/aws-auth';
import {
  planRules, identityRegions, patternForRegion, ruleKind, ruleRegion, parsePattern, LEGACY_REGION,
  type PlanDecoy, type RegionPush,
} from '@/lib/rules-plan';

const TARGET_ID = 'V2CentralBus';

// One process serves the portal, so an in-memory chain per account is enough to keep a
// deploy, a teardown and a push from interleaving their rule writes.
const locks = new Map<string, Promise<unknown>>();
export function withAccountLock<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(accountId) ?? Promise.resolve()).catch(() => {}).then(fn);
  locks.set(accountId, run);
  return run;
}

const scenarioRegion = (s: ScenarioRecord) => s.tfstateKey?.split('/')[2] || LEGACY_REGION;

/** Every deployed decoy of an account, with the region it lives in. Throws if the store is unreachable. */
export async function accountDecoys(accountId: string): Promise<{ decoys: PlanDecoy[]; regions: string[] }> {
  const scenarios = STORAGE_BACKEND === 'local' ? await getScenarios(accountId) : await queryScenarios(accountId);
  const decoys = scenarios.flatMap(s =>
    s.decoys.map(d => ({ name: d.name, category: d.category, region: scenarioRegion(s), scenarioId: s.scenarioId })));
  return { decoys, regions: [...new Set(scenarios.map(scenarioRegion))] };
}

/** Regions a record lives in, or will be pushed to. */
export function ruleRegions(rule: RuleRecord, deployedRegions: string[]): string[] {
  if (ruleKind(rule) !== 'identity') return [ruleRegion(rule)];
  const all = identityRegions(deployedRegions, process.env.MIRAGE_IDENTITY_REGIONS);
  return [...new Set([...all, ...Object.keys(rule.regionStatus ?? {})])].sort();
}

export const spokeCredentials = (accountId: string, sessionName: string) =>
  assumeChain({ targetRoleArn: roleArns.spokeDeploy(accountId), externalId: spokeExternalId(), region: 'us-west-2', sessionName });

async function eachRegion<T>(regions: string[], fn: (region: string) => Promise<T>): Promise<Array<[string, T]>> {
  const out: Array<[string, T]> = [];
  for (let i = 0; i < regions.length; i += 4) {
    out.push(...await Promise.all(regions.slice(i, i + 4).map(async r => [r, await fn(r)] as [string, T])));
  }
  return out;
}
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const notFound = (e: unknown) => (e as { name?: string })?.name === 'ResourceNotFoundException';

/** Delete a rule in every given region. Returns "region: error" for each failure; not-found counts as done. */
export async function deleteRuleEverywhere(rule: RuleRecord, regions: string[], credentials: SdkCredentials): Promise<string[]> {
  const results = await eachRegion(regions, async region => {
    const eb = new EventBridgeClient({ region, credentials });
    try {
      await eb.send(new RemoveTargetsCommand({ Rule: rule.ruleName, Ids: [TARGET_ID] })).catch(e => { if (!notFound(e)) throw e; });
      await eb.send(new DeleteRuleCommand({ Name: rule.ruleName })).catch(e => { if (!notFound(e)) throw e; });
      return null;
    } catch (e) {
      return `${region}: ${errMsg(e)}`;
    }
  });
  return results.map(([, f]) => f).filter((f): f is string => !!f);
}

/**
 * Put every EventBridge statement of the forwarding role's trust in one fixed form:
 * this account's <prefix>-fwd-* rules, in any region. Replaces the old per-rule
 * ArnEquals list, which pinned forwarding to the rules pushed so far, broke every
 * other rule after a re-onboard, and grows past IAM's trust size limit with one
 * identity rule per region. Other statements are left alone.
 */
export async function ensureForwardingTrust(accountId: string, credentials: SdkCredentials): Promise<'updated' | 'unchanged'> {
  const iam = new IAMClient({ region: 'us-east-1', credentials });
  const roleName = roleArns.forwarding(accountId).split('/').pop()!;
  const role = await iam.send(new GetRoleCommand({ RoleName: roleName }));
  const doc = JSON.parse(decodeURIComponent(role.Role?.AssumeRolePolicyDocument ?? '{}'));
  const before = JSON.stringify(doc);
  const condition = {
    StringEquals: { 'aws:SourceAccount': accountId },
    ArnLike: { 'aws:SourceArn': `arn:aws:events:*:${accountId}:rule/${resourcePrefix()}-fwd-*` },
  };
  const isEvents = (st: { Principal?: { Service?: string | string[] } }) =>
    [st.Principal?.Service].flat().includes('events.amazonaws.com');
  doc.Version ??= '2012-10-17';
  doc.Statement = Array.isArray(doc.Statement) ? doc.Statement : doc.Statement ? [doc.Statement] : [];
  const ours = doc.Statement.filter(isEvents);
  if (ours.length === 0) {
    doc.Statement.push({ Sid: 'TrustEventBridgeForwardingRulesOnly', Effect: 'Allow', Principal: { Service: 'events.amazonaws.com' }, Action: 'sts:AssumeRole', Condition: condition });
  } else {
    for (const st of ours) st.Condition = condition;
  }
  if (JSON.stringify(doc) === before) return 'unchanged';
  await iam.send(new UpdateAssumeRolePolicyCommand({ RoleName: roleName, PolicyDocument: JSON.stringify(doc) }));
  return 'updated';
}

/** Push a rule to each region; the result per region. Never throws for one region's failure. */
export async function pushRule(
  rule: RuleRecord,
  regions: string[],
  opts: { hubBusArn: string; forwardingRoleArn: string; credentials: SdkCredentials },
): Promise<Record<string, RegionPush>> {
  const at = new Date().toISOString();
  const results = await eachRegion(regions, async (region): Promise<RegionPush> => {
    const eb = new EventBridgeClient({ region, credentials: opts.credentials });
    try {
      await eb.send(new PutRuleCommand({
        Name: rule.ruleName,
        EventPattern: patternForRegion(rule, region),
        State: 'ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS',
      }));
      // PutTargets reports a rejected target in the response, not as an error.
      const res = await eb.send(new PutTargetsCommand({
        Rule: rule.ruleName,
        Targets: [{ Id: TARGET_ID, Arn: opts.hubBusArn, RoleArn: opts.forwardingRoleArn }],
      }));
      if (res.FailedEntryCount) {
        const f = res.FailedEntries?.[0];
        return { status: 'failed', error: `target rejected: ${f?.ErrorCode ?? ''} ${f?.ErrorMessage ?? ''}`.trim(), at };
      }
      return { status: 'deployed', at };
    } catch (e) {
      return { status: 'failed', error: errMsg(e), at };
    }
  });
  return Object.fromEntries(results);
}

const pushedBefore = (r: RuleRecord) =>
  r.status !== 'pending' || !!r.deployedPattern || Object.keys(r.regionStatus ?? {}).length > 0;

export interface ReconcileResult {
  upserts: Array<{ ruleName: string; kind: string; region?: string; status: string; values: number; charCount: number }>;
  deletes: Array<{ ruleName: string; kind: string; region?: string }>;
  failures: string[];
}

/**
 * Bring an account's rule records in line with its deployed decoys (rules-plan.ts),
 * then delete rules left with nothing to watch -- in AWS, in every region they live in.
 * A rule whose AWS delete fails keeps its record, so the next run retries it.
 */
export async function reconcileAccountRules(
  accountId: string,
  opts: { individualScenarioIds?: string[]; dryRun?: boolean; credentials?: SdkCredentials } = {},
): Promise<ReconcileResult> {
  return withAccountLock(accountId, async () => {
    const { decoys, regions } = await accountDecoys(accountId);
    const rules = await queryRules(accountId);
    const plan = planRules({
      accountId, decoys, rules, newRuleName: () => nextRuleName(accountId),
      individualScenarioIds: opts.individualScenarioIds,
    });
    const result: ReconcileResult = {
      upserts: plan.upserts.map(r => ({
        ruleName: r.ruleName, kind: ruleKind(r), region: ruleKind(r) === 'regional' ? ruleRegion(r) : undefined,
        status: r.status, values: parsePattern(r.eventPattern).conditions.flatMap(c => Object.values(c).flat()).length,
        charCount: r.charCount,
      })),
      deletes: plan.deletes.map(r => ({ ruleName: r.ruleName, kind: ruleKind(r), region: ruleKind(r) === 'regional' ? ruleRegion(r) : undefined })),
      failures: [],
    };
    if (opts.dryRun) return result;

    for (const r of plan.upserts) await saveRuleState(r);
    let credentials = opts.credentials;
    for (const r of plan.deletes) {
      if (pushedBefore(r)) {
        credentials ??= await spokeCredentials(accountId, 'MirageRuleCleanup');
        const failed = await deleteRuleEverywhere(r, ruleRegions(r, regions), credentials);
        if (failed.length) {
          result.failures.push(`${r.ruleName}: could not delete in ${failed.join('; ')}`);
          continue;
        }
      }
      await deleteRule(accountId, r.ruleName);
    }
    return result;
  });
}
