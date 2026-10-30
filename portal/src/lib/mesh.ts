import fs from 'fs/promises';
import path from 'path';
import type { RuleRecord, ScenarioRecord } from '@/lib/db';
import { matchTokens } from '@/lib/decoy-match';
import { kindOf, ruleKind, ruleRegion } from '@/lib/rules-plan';
import type { DetectionRecord } from '@/lib/detections';
import { isCustomId, scenarioDir } from '@/lib/scenarios';
import type { MeshHit, MeshSpoke } from '@/components/GlobalMesh';
import { linkHits, meshKey, type MeshActor } from '@/lib/mesh-paths';


const TYPE_LABEL: Record<string, string> = {
  iam: 'IAM', s3: 'S3', secretsmanager: 'Secrets', ssm: 'SSM', dynamodb: 'DynamoDB', kms: 'KMS',
  ecr: 'ECR', lambda: 'Lambda', cloudformation: 'CFN', logs: 'Logs', sqs: 'SQS', sns: 'SNS',
};

/**
 * The brain Lambda records the touched resource by name, with two shapes that are
 * longer than the decoy name: S3 adds "/<key>", and a Secrets Manager ARN carries a
 * "-xxxxxx" suffix (see get_resource_name in monitoring-brain.yaml).
 */
export function hitsDecoy(resourceName: string, decoyName: string, category: string): boolean {
  if (resourceName === decoyName) return true;
  if (category === 's3') return resourceName.startsWith(decoyName + '/');
  if (category === 'secretsmanager') return /^-[A-Za-z0-9]{6}$/.test(resourceName.slice(decoyName.length)) && resourceName.startsWith(decoyName);
  return false;
}

// tfstateKey is accounts/<account>/<region>/<scenario>/terraform.tfstate
const regionOf = (s: ScenarioRecord) => s.tfstateKey?.split('/')[2];

async function scenarioName(id: string): Promise<string> {
  try {
    const first = (await fs.readFile(path.join(await scenarioDir(id), 'details.md'), 'utf-8')).split('\n')[0];
    const name = first.replace(/^#\s*/, '').trim();
    return name ? name.charAt(0).toUpperCase() + name.slice(1) : id;
  } catch {
    return id; // template removed since deploy -- the id still identifies it
  }
}

/**
 * Is a decoy watched by what is live in AWS (a rule's deployedPattern), in the right place?
 * Roles need the identity rule deployed in every region; a role still only in an old
 * regional rule is watched in that one region ('partial').
 */
function watchState(accountId: string, region: string, d: { name: string; category: string }, rules: RuleRecord[]): 'yes' | 'partial' | 'no' {
  const live = (r: RuleRecord) => !!r.deployedPattern && matchTokens(d.category, d.name, accountId).some(t => r.deployedPattern!.includes(`"${t}"`));
  const mine = rules.filter(r => r.accountId === accountId && live(r));
  if (kindOf(d.category) === 'regional') return mine.some(r => ruleKind(r) === 'regional' && ruleRegion(r) === region) ? 'yes' : 'no';
  if (mine.some(r => ruleKind(r) === 'identity' && r.status !== 'failed')) return 'yes';
  return mine.length ? 'partial' : 'no';
}

export async function buildMesh(scenarios: ScenarioRecord[], detections: DetectionRecord[], rules?: RuleRecord[] | null): Promise<{ spokes: MeshSpoke[]; paths: MeshHit[][] }> {
  // A decoy is alerted while it has an alert nobody has resolved yet, however old.
  const open = detections.filter(d => d.status !== 'resolved');
  const names = new Map(await Promise.all(
    [...new Set(scenarios.map(s => s.scenarioId))].map(async id => [id, await scenarioName(id)] as const)));

  const byAccount = new Map<string, ScenarioRecord[]>();
  for (const s of scenarios) byAccount.set(s.accountId, [...(byAccount.get(s.accountId) ?? []), s]);

  const spokes: MeshSpoke[] = [...byAccount.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([accountId, recs]) => ({
    accountId,
    region: [...new Set(recs.map(regionOf).filter(Boolean))].join(', ') || '—',
    scenarios: recs.sort((a, b) => a.scenarioId.localeCompare(b.scenarioId, undefined, { numeric: true })).map(r => ({
      id: r.scenarioId,
      name: names.get(r.scenarioId) ?? r.scenarioId,
      custom: isCustomId(r.scenarioId),
      decoys: r.decoys.map(d => {
        const hits = open.filter(a => a.accountId === accountId && hitsDecoy(a.resourceName, d.name, d.category));
        return {
          name: d.name,
          category: d.category,
          watch: rules ? watchState(accountId, regionOf(r) ?? 'us-west-2', d, rules) : undefined,
          type: TYPE_LABEL[d.category] ?? d.category.toUpperCase(),
          alerted: hits.length > 0,
          alerts: hits.length,
          lastSeen: hits.map(h => h.timestamp).sort().at(-1),
          actors: actorsOf(hits),
        };
      }),
    })),
  }));
  return { spokes, paths: linkHits(detections.map(d => toHit(d, spokes))) };
}

function actorsOf(hits: DetectionRecord[]): MeshActor[] {
  const m = new Map<string, MeshActor>();
  for (const h of hits) {
    const caller = h.callerArn || 'unknown', k = `${caller}|${h.sourceIp ?? ''}`;
    const e = m.get(k) ?? { caller, ip: h.sourceIp, alerts: 0 };
    e.alerts++;
    m.set(k, e);
  }
  return [...m.values()];
}

/** An alert as a path step, with the canvas node of the decoy it hit (if still deployed). */
function toHit(d: DetectionRecord, spokes: MeshSpoke[]): MeshHit {
  let ident: { accessKeyId?: string } = {}, userAgent: string | undefined;
  try {
    const raw = JSON.parse(d.rawDetail ?? ''); // truncated details don't parse -- link by IP only
    ident = raw.userIdentity ?? {};
    userAgent = raw.userAgent;
  } catch { /* keep defaults */ }
  let node: string | undefined;
  spokes.forEach(s => {
    if (s.accountId !== d.accountId) return;
    s.scenarios.forEach(c => c.decoys.forEach(x => {
      if (!node && hitsDecoy(d.resourceName, x.name, x.category ?? '')) node = meshKey.decoy(s.accountId, c.id, x.name);
    }));
  });
  return {
    id: d.id, ts: d.timestamp, accountId: d.accountId, eventName: d.eventName, resourceName: d.resourceName,
    caller: d.callerArn, sourceIp: d.sourceIp, userAgent, accessKeyId: ident.accessKeyId, node,
    resolved: d.status === 'resolved',
  };
}
