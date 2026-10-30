#!/bin/bash
# Self-check for portal/src/lib/mesh-paths.ts (attack-path linking). Run from the repo root.
set -euo pipefail
OUT=$(mktemp -d); trap 'rm -rf "$OUT"' EXIT
(cd portal && npx tsc --outDir "$OUT" --module commonjs --target es2020 src/lib/mesh-paths.ts)
cat > "$OUT/test.js" <<'JS'
const assert = require('assert');
const { linkHits, meshIdentities, shortCaller } = require('./mesh-paths.js');
const H = (id, ts, acct, key, ip, ua) => ({ id, ts: `2026-10-28T${ts}:00Z`, accountId: acct, accessKeyId: key, sourceIp: ip, userAgent: ua });
// key K1 used in A and for the AssumeRole into B; then a new key K2 in B from the same IP + tool
const g = linkHits([
  H('b2', '10:20', 'B', 'K2', '1.1.1.1', 'cli'),
  H('a1', '10:00', 'A', 'K1', '1.1.1.1', 'cli'),
  H('b1', '10:10', 'B', 'K1', '1.1.1.1', 'cli'),
  H('x1', '10:05', 'A', 'K9', '9.9.9.9', 'boto'), // unrelated, alone -> dropped
  H('c1', '13:00', 'A', 'K3', '1.1.1.1', 'cli'),  // same IP + tool but over an hour later -> separate
  H('c2', '13:30', 'A', 'K3', '2.2.2.2', 'sdk'),  // same key as c1 -> pair
]);
assert.deepStrictEqual(g.map(x => x.map(y => y.id)), [['c1', 'c2'], ['a1', 'b1', 'b2']]);
assert.deepStrictEqual(linkHits([H('p', '10:00', 'A'), H('q', '10:01', 'A')]), []); // no identity -> never linked
// identities: one node per caller + IP, linked to the decoy, or its nearest visible ancestor
const alice = 'arn:aws:iam::111:user/alice';
const mesh = [{ accountId: '111', scenarios: [
  { id: 's1', decoys: [{ name: 'd1', actors: [{ caller: alice, ip: '1.1.1.1', alerts: 2 }] }, { name: 'd2', actors: [{ caller: alice, ip: '1.1.1.1', alerts: 1 }, { caller: alice, ip: '2.2.2.2', alerts: 1 }] }] },
  { id: 's2', decoys: [{ name: 'd3' }] }] }];
let ids = meshIdentities(mesh, new Set(['s|111', 'c|111|s1', 'd|111|s1|d1', 'd|111|s1|d2']));
assert.strictEqual(ids.length, 2, 'same caller from two IPs = two identities');
assert.deepStrictEqual(ids[0], { key: `i|${alice}|1.1.1.1`, caller: alice, ip: '1.1.1.1', alerts: 3, links: ['d|111|s1|d1', 'd|111|s1|d2'], decoys: ['d1', 'd2'] });
ids = meshIdentities(mesh, new Set(['s|111', 'c|111|s1'])); // scenario collapsed -> both link to it once
assert.deepStrictEqual(ids[0].links, ['c|111|s1']);
assert.deepStrictEqual(meshIdentities(mesh, new Set(['s|111']))[0].links, ['s|111']);
assert.strictEqual(shortCaller(alice), 'alice');
assert.strictEqual(shortCaller('arn:aws:sts::111:assumed-role/Admin/sess'), 'Admin/sess');
assert.strictEqual(shortCaller('arn:aws:iam::111:root'), 'root');
console.log('mesh-paths ok');
JS
node "$OUT/test.js"
