/**
 * Which forwarding rules an account needs, as a pure function of its deployed decoys
 * and its current rule records. Deploy, teardown and the repair endpoint all call
 * planRules, so the three can never disagree. No I/O here: see rules-sync.ts.
 *
 * Two kinds of rule ("Forwarding rules" in docs/ARCHITECTURE.md):
 *   regional -- the non-role decoys of one region, pushed to that region.
 *   identity -- every role decoy in the account, pushed to every identity region.
 *               A role is global: AssumeRole is recorded in the region of the STS
 *               endpoint the caller used, IAM calls only in us-east-1. Verified live
 *               2026-10-28.
 */
import { matchConditions, sameMatchValue, sourceForKey, type MatchValue } from './decoy-match';

export type RuleKind = 'regional' | 'identity';
export type RuleStatus = 'pending' | 'deployed' | 'update_available' | 'failed' | 'deleted';
export type RegionPush = { status: 'deployed' | 'failed'; error?: string; at: string };

/** The fields of a rule record the planner reads and writes (db.ts RuleRecord). */
export interface PlanRule {
  accountId: string;
  ruleName: string;
  eventPattern: string;
  deployedPattern?: string;
  status: RuleStatus;
  charCount: number;
  limitReached: boolean;
  isIndividual?: boolean;
  kind?: RuleKind;
  region?: string;
  regionStatus?: Record<string, RegionPush>;
  updatedAt?: string;
  version?: 0 | 1;
}

export interface PlanDecoy { name: string; category: string; region: string; scenarioId: string }

/** AWS quota "Event pattern size" is 2048 (L-664C5505); 2000 leaves headroom. */
export const MAX_PATTERN_CHARS = 2000;
/** Every rule pushed before rules had a region was pushed here. */
export const LEGACY_REGION = 'us-west-2';
/** The regions AWS enables by default. Opt-in regions come from deploys or the env. */
export const DEFAULT_IDENTITY_REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'ca-central-1', 'sa-east-1',
  'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-north-1',
  'ap-south-1', 'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3', 'ap-southeast-1', 'ap-southeast-2',
];
const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/;

export const kindOf = (category: string): RuleKind =>
  ['iam', 'sts'].includes(category.toLowerCase().trim()) ? 'identity' : 'regional';
export const ruleKind = (r: Pick<PlanRule, 'kind'>): RuleKind => r.kind ?? 'regional';
export const ruleRegion = (r: Pick<PlanRule, 'region'>): string => r.region ?? LEGACY_REGION;

/** Regions the identity rule lives in: the defaults (or the override), plus every deployed region. */
export function identityRegions(deployedRegions: string[], override?: string): string[] {
  const base = override?.trim()
    ? override.split(',').map(s => s.trim()).filter(s => REGION_RE.test(s))
    : DEFAULT_IDENTITY_REGIONS;
  return [...new Set([...base, ...deployedRegions.filter(r => REGION_RE.test(r))])].sort();
}

type Cond = Record<string, MatchValue[]>;
type Parsed = { source: string[]; conditions: Cond[] };

export function parsePattern(pattern: string): Parsed {
  try {
    const p = JSON.parse(pattern);
    return { source: Array.isArray(p.source) ? [...p.source] : [], conditions: p.detail?.requestParameters?.$or ?? [] };
  } catch {
    return { source: [], conditions: [] };
  }
}

const toPattern = (p: Parsed) => ({
  source: p.source,
  'detail-type': ['AWS API Call via CloudTrail'],
  detail: { requestParameters: { $or: p.conditions } },
});
// EventBridge rejects an $or with a single entry, so what AWS gets has a lone condition written directly.
const awsJson = (p: Parsed) => JSON.stringify(p.conditions.length === 1
  ? { ...toPattern(p), detail: { requestParameters: p.conditions[0] } }
  : toPattern(p));
const compact = (pattern: string) => {
  const p = parsePattern(pattern);
  return p.conditions.length ? JSON.stringify(toPattern(p)) : '';
};

// Keys written before decoy-match.ts shipped (bare roleName) still need a source.
const LEGACY_KEY_SOURCE: Record<string, string> = { roleName: 'aws.sts' };

/** Sources from the condition keys, keeping the existing order so review diffs stay small. */
function rebuildSources(previous: string[], conditions: Cond[]): string[] {
  const wanted = new Set<string>();
  for (const c of conditions) for (const k of Object.keys(c)) {
    const s = sourceForKey(k) ?? LEGACY_KEY_SOURCE[k];
    if (s) wanted.add(s);
  }
  return [...previous.filter(s => wanted.has(s)), ...[...wanted].filter(s => !previous.includes(s))];
}

function addCondition(conditions: Cond[], key: string, value: MatchValue) {
  const existing = conditions.find(c => c[key] !== undefined);
  if (!existing) conditions.push({ [key]: [value] });
  else if (!existing[key].some(v => sameMatchValue(v, value))) existing[key].push(value);
}

/** Every value a stored pattern may hold for a decoy: current shapes plus the bare name (legacy). */
const decoyValues = (d: PlanDecoy, accountId: string): MatchValue[] =>
  [...matchConditions(d.category, d.name, accountId).map(c => c.value), d.name];

/**
 * The us-east-1 form of an identity pattern: also catch IAM calls on the roles
 * (GetRole, ListAttachedRolePolicies, ...), which use the bare roleName and are
 * recorded only in us-east-1.
 */
export function usEast1Variant(pattern: string): string {
  const p = parsePattern(pattern);
  const arns = p.conditions.flatMap(c => (c.roleArn ?? []).filter((v): v is string => typeof v === 'string'));
  const names = arns.map(a => a.split(':role/')[1]?.split('/').pop()).filter((n): n is string => !!n);
  if (names.length === 0) return awsJson(p);
  const conditions = [...p.conditions.map(c => ({ ...c })), { roleName: [...new Set(names)] }];
  return awsJson({ source: [...new Set([...p.source, 'aws.iam'])], conditions });
}

/** The pattern a record pushes to one region. */
export const patternForRegion = (rule: PlanRule, region: string): string =>
  ruleKind(rule) === 'identity' && region === 'us-east-1'
    ? usEast1Variant(rule.eventPattern)
    : awsJson(parsePattern(rule.eventPattern));

/** Size AWS will see for the largest region this record is pushed to. */
const measure = (kind: RuleKind, p: Parsed) => {
  const s = JSON.stringify(toPattern(p));
  return kind === 'identity' ? usEast1Variant(s).length : s.length;
};

export interface PlanInput {
  accountId: string;
  decoys: PlanDecoy[];
  rules: PlanRule[];
  newRuleName: () => string;
  /** Scenarios deployed in individual mode: their new regional decoys get dedicated rules. */
  individualScenarioIds?: string[];
}
export interface PlanOutput { upserts: PlanRule[]; deletes: PlanRule[] }

type Work = { rule: PlanRule; before: string; parsed: Parsed; covered: Set<PlanDecoy>; full: boolean; isNew: boolean; owner?: string };
const cloneParsed = (p: Parsed): Parsed => ({
  source: [...p.source],
  conditions: p.conditions.map(c => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, [...v]]))),
});

export function planRules(input: PlanInput): PlanOutput {
  const { accountId, decoys, newRuleName } = input;
  const individual = new Set(input.individualScenarioIds ?? []);
  const groupOf = (kind: RuleKind, region: string) => (kind === 'identity' ? 'identity' : `regional:${region}`);
  const decoyGroup = (d: PlanDecoy) => groupOf(kindOf(d.category), d.region);
  const ruleGroup = (r: PlanRule) => groupOf(ruleKind(r), ruleRegion(r));

  // 1. Strip every value whose decoy is no longer wanted in this rule's group.
  const work: Work[] = input.rules.map(r => {
    const original = parsePattern(r.eventPattern);
    const wanted = decoys.filter(d => decoyGroup(d) === ruleGroup(r));
    const covered = new Set<PlanDecoy>();
    const conditions: Cond[] = [];
    for (const cond of original.conditions) {
      const kept: Cond = {};
      for (const [key, vals] of Object.entries(cond)) {
        if (!Array.isArray(vals)) continue;
        const keep = vals.filter(v => {
          const owner = wanted.find(d => decoyValues(d, accountId).some(w => sameMatchValue(v, w)));
          if (owner) covered.add(owner);
          return !!owner;
        });
        if (keep.length) kept[key] = keep;
      }
      if (Object.keys(kept).length) conditions.push(kept);
    }
    // A decoy found only under a legacy shape also gets its current shape, or it is not really watched.
    for (const d of covered) for (const c of matchConditions(d.category, d.name, accountId)) addCondition(conditions, c.key, c.value);
    return { rule: r, before: compact(r.eventPattern), parsed: { source: original.source, conditions }, covered, full: false, isNew: false };
  });
  const coveredAll = new Set<PlanDecoy>(work.flatMap(w => [...w.covered]));

  // 2. Place every decoy no rule covers yet: first rule of its group with room, else a new one.
  //    Individual mode: a scenario's regional decoys share one dedicated rule (or more on overflow).
  const place = (d: PlanDecoy) => {
    const kind = kindOf(d.category);
    const group = decoyGroup(d);
    const owner = kind === 'regional' && individual.has(d.scenarioId) ? d.scenarioId : undefined;
    const conds = matchConditions(d.category, d.name, accountId);
    const tryAdd = (w: Work) => {
      const trial = cloneParsed(w.parsed);
      for (const c of conds) addCondition(trial.conditions, c.key, c.value);
      trial.source = rebuildSources(trial.source, trial.conditions);
      if (measure(kind, trial) > MAX_PATTERN_CHARS) { w.full = true; return false; }
      w.parsed = trial;
      return true;
    };
    const candidates = work.filter(w =>
      ruleGroup(w.rule) === group && !w.full && (owner ? w.isNew && w.owner === owner : !w.rule.isIndividual));
    for (const w of candidates) if (tryAdd(w)) return;
    const rule: PlanRule = {
      accountId, ruleName: newRuleName(), eventPattern: '', status: 'pending', charCount: 0, limitReached: false,
      isIndividual: !!owner, kind, ...(kind === 'regional' ? { region: d.region } : {}),
    };
    const w: Work = { rule, before: '', parsed: { source: [], conditions: [] }, covered: new Set(), full: false, isNew: true, owner };
    work.push(w);
    if (!tryAdd(w)) throw new Error(`decoy ${d.name} alone exceeds ${MAX_PATTERN_CHARS} characters`);
  };
  for (const d of decoys) if (!coveredAll.has(d)) place(d);

  // 3. Turn the working set into writes.
  const upserts: PlanRule[] = [], deletes: PlanRule[] = [];
  for (const w of work) {
    if (w.parsed.conditions.length === 0) { if (!w.isNew) deletes.push(w.rule); continue; }
    const kind = ruleKind(w.rule);
    w.parsed.source = rebuildSources(w.parsed.source, w.parsed.conditions);
    const after = JSON.stringify(toPattern(w.parsed));
    const live = !!w.rule.deployedPattern && compact(w.rule.deployedPattern) === after;
    // Unchanged, already carrying kind/region, and not flagged as differing from what is live: nothing to write.
    const typed = w.rule.kind !== undefined && (kind === 'identity' || w.rule.region !== undefined);
    if (after === w.before && typed && !(live && w.rule.status === 'update_available')) continue;
    let status: RuleStatus = w.rule.status;
    if (live) status = 'deployed';
    else if (after !== w.before && status === 'deployed') status = 'update_available';
    upserts.push({
      ...w.rule,
      kind,
      ...(kind === 'regional' ? { region: ruleRegion(w.rule) } : {}),
      eventPattern: JSON.stringify(toPattern(w.parsed), null, 2),
      status,
      charCount: measure(kind, w.parsed),
      limitReached: w.full,
    });
  }
  return { upserts, deletes };
}
