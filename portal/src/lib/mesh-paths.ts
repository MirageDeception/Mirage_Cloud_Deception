// Attack paths: alerts from one actor, linked in time order. Pure (no I/O) so it can
// be checked on its own.

export type HitInput = {
  id: string;
  ts: string;          // ISO time
  accountId: string;   // account the decoy lives in
  accessKeyId?: string;
  sourceIp?: string;
  userAgent?: string;
};

/** Same IP + same user agent only links hits this close together. */
export const IP_UA_WINDOW_MS = 60 * 60 * 1000;

/**
 * Groups hits into paths. Two hits belong to one actor when they share an access key
 * (a stolen key, or the AssumeRole into another account made with the caller's own
 * key), or share source IP + user agent within an hour (the actor switched identity).
 * Returns groups of 2+ hits, each sorted oldest first, newest group first.
 */
export function linkHits<T extends HitInput>(hits: T[]): T[][] {
  const h = [...hits].sort((a, b) => a.ts.localeCompare(b.ts));
  const parent = h.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < h.length; i++) {
    for (let j = i + 1; j < h.length; j++) {
      const a = h[i], b = h[j];
      const sameKey = !!a.accessKeyId && a.accessKeyId === b.accessKeyId;
      const sameOrigin = !!a.sourceIp && a.sourceIp === b.sourceIp && !!a.userAgent && a.userAgent === b.userAgent
        && Date.parse(b.ts) - Date.parse(a.ts) <= IP_UA_WINDOW_MS;
      if (sameKey || sameOrigin) parent[find(j)] = find(i);
    }
  }
  const groups = new Map<number, T[]>();
  h.forEach((x, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), x]));
  return [...groups.values()].filter(g => g.length > 1).sort((a, b) => b[b.length - 1].ts.localeCompare(a[a.length - 1].ts));
}

/** Canvas node ids, stable across refreshes (by id, not list position). */
export const meshKey = {
  spoke: (account: string) => `s|${account}`,
  scen: (account: string, scenario: string) => `c|${account}|${scenario}`,
  decoy: (account: string, scenario: string, decoy: string) => `d|${account}|${scenario}|${decoy}`,
};
export const meshAncestors = (key: string): string[] => {
  const [kind, a, c] = key.split('|');
  return kind === 'd' ? [meshKey.spoke(a), meshKey.scen(a, c)] : kind === 'c' ? [meshKey.spoke(a)] : [];
};

/** Who touched a decoy (unresolved alerts only): caller ARN + source IP, with how many alerts. */
export type MeshActor = { caller: string; ip?: string; alerts: number };

/** "arn:...:user/alice" -> "alice"; "arn:...:assumed-role/Role/session" -> "Role/session"; root -> "root". */
export const shortCaller = (arn: string) =>
  (arn.split(':').pop() || arn).replace(/^(user|assumed-role|role|federated-user)\//, '') || 'unknown';

/**
 * One identity node per caller + IP across the mesh, linked to each decoy it touched,
 * or to the decoy's nearest visible ancestor (scenario, then spoke) while it is collapsed.
 */
export function meshIdentities(
  spokes: Array<{ accountId: string; scenarios: Array<{ id: string; decoys: Array<{ name: string; actors?: MeshActor[] }> }> }>,
  visible: Set<string>,
) {
  const out = new Map<string, { key: string; caller: string; ip?: string; alerts: number; links: string[]; decoys: string[] }>();
  for (const s of spokes) for (const c of s.scenarios) for (const d of c.decoys) for (const a of d.actors ?? []) {
    const anchor = [meshKey.decoy(s.accountId, c.id, d.name), meshKey.scen(s.accountId, c.id), meshKey.spoke(s.accountId)].find(k => visible.has(k));
    const key = `i|${a.caller}|${a.ip ?? ''}`;
    const e = out.get(key) ?? { key, caller: a.caller, ip: a.ip, alerts: 0, links: [], decoys: [] };
    e.alerts += a.alerts;
    if (anchor && !e.links.includes(anchor)) e.links.push(anchor);
    if (!e.decoys.includes(d.name)) e.decoys.push(d.name);
    out.set(key, e);
  }
  return [...out.values()];
}
