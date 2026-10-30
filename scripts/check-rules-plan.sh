#!/bin/bash
# Self-check for portal/src/lib/rules-plan.ts (per-region rule planning). Run from the repo root.
set -euo pipefail
OUT=$(mktemp -d); trap 'rm -rf "$OUT"' EXIT
(cd portal && npx tsc --outDir "$OUT" --module commonjs --target es2020 --skipLibCheck src/lib/rules-plan.ts)
cat > "$OUT/test.js" <<'JS'
const assert = require('assert');
const P = require('./rules-plan.js');
const A = '111111111111';
const arn = n => `arn:aws:iam::${A}:role/${n}`;
let n = 0; const name = () => `fwd-${++n}`;
const D = (name, category, region, scenarioId = 's1') => ({ name, category, region, scenarioId });
const pat = (source, or) => JSON.stringify({ source, 'detail-type': ['AWS API Call via CloudTrail'], detail: { requestParameters: { $or: or } } }, null, 2);
const conds = r => JSON.parse(r.eventPattern).detail.requestParameters.$or;
const flat = r => conds(r).flatMap(c => Object.values(c).flat()).map(v => typeof v === 'string' ? v : v.suffix).sort();
// apply a plan to a rule list, as rules-sync does
const apply = (rules, plan) => {
  const del = new Set(plan.deletes.map(r => r.ruleName));
  const out = rules.filter(r => !del.has(r.ruleName));
  for (const u of plan.upserts) { const i = out.findIndex(r => r.ruleName === u.ruleName); if (i >= 0) out[i] = u; else out.push(u); }
  return out;
};
const run = (decoys, rules, extra = {}) => P.planRules({ accountId: A, decoys, rules, newRuleName: name, ...extra });

// 1. Fresh account, two regions: one regional rule per region + one identity rule.
let decoys = [D('/prod/a', 'ssm', 'us-west-2'), D('role-a', 'iam', 'us-west-2'), D('bucket-b', 's3', 'us-east-2', 's2'), D('role-b', 'iam', 'us-east-2', 's2')];
let plan = run(decoys, []);
assert.strictEqual(plan.deletes.length, 0);
assert.strictEqual(plan.upserts.length, 3);
const byKey = r => r.kind === 'identity' ? 'identity' : `regional:${r.region}`;
const m = Object.fromEntries(plan.upserts.map(r => [byKey(r), r]));
assert.deepStrictEqual(flat(m['regional:us-west-2']), ['/prod/a']);
assert.deepStrictEqual(flat(m['regional:us-east-2']), ['bucket-b']);
assert.deepStrictEqual(flat(m.identity), [arn('role-a'), arn('role-b')].sort());
assert.strictEqual(m.identity.region, undefined);
assert.deepStrictEqual(JSON.parse(m.identity.eventPattern).source, ['aws.sts']);
plan.upserts.forEach(r => assert.strictEqual(r.status, 'pending'));

// 2. Idempotent: planning again on the result changes nothing.
let rules = apply([], plan);
plan = run(decoys, rules);
assert.deepStrictEqual(plan, { upserts: [], deletes: [] }, 'second run must be a no-op');

// 3. The live situation: one legacy record (no kind/region) holding roles, a us-west-2
//    decoy and two us-east-2 decoys; deployed pattern has only the us-west-2 things.
const legacyDeployed = pat(['aws.sts', 'aws.ssm'], [{ roleArn: [arn('role-a')] }, { name: ['/prod/a'] }]);
const legacy = { accountId: A, ruleName: 'legacy', status: 'update_available', charCount: 0, limitReached: false,
  deployedPattern: legacyDeployed,
  eventPattern: pat(['aws.sts', 'aws.ssm', 'aws.s3'], [{ roleArn: [arn('role-a'), arn('role-b')] }, { name: ['/prod/a'] }, { bucketName: ['bucket-b'] }]) };
plan = run(decoys, [legacy]);
const up = Object.fromEntries(plan.upserts.map(r => [byKey(r), r]));
assert.strictEqual(plan.deletes.length, 0);
assert.strictEqual(up['regional:us-west-2'].ruleName, 'legacy', 'legacy record stays the us-west-2 rule');
assert.deepStrictEqual(flat(up['regional:us-west-2']), ['/prod/a']);
assert.deepStrictEqual(JSON.parse(up['regional:us-west-2'].eventPattern).source, ['aws.ssm']);
assert.strictEqual(up['regional:us-west-2'].status, 'update_available');
assert.strictEqual(up['regional:us-west-2'].deployedPattern, legacyDeployed, 'diff baseline kept');
assert.deepStrictEqual(flat(up['regional:us-east-2']), ['bucket-b']);
assert.deepStrictEqual(flat(up.identity), [arn('role-a'), arn('role-b')].sort());

// 4. Teardown: dropping a role updates the identity rule; dropping the last role deletes it.
rules = apply([legacy], plan).map(r => ({ ...r, status: 'deployed', deployedPattern: r.eventPattern }));
plan = run(decoys.filter(d => d.name !== 'role-b'), rules);
assert.strictEqual(plan.upserts.length, 1);
assert.strictEqual(plan.upserts[0].kind, 'identity');
assert.strictEqual(plan.upserts[0].status, 'update_available');
assert.deepStrictEqual(flat(plan.upserts[0]), [arn('role-a')]);
plan = run(decoys.filter(d => d.category !== 'iam'), rules);
assert.deepStrictEqual(plan.deletes.map(r => r.kind), ['identity']);
assert.strictEqual(plan.upserts.length, 0);
// whole us-east-2 region torn down: its regional rule is deleted, us-west-2 untouched
plan = run(decoys.filter(d => d.region !== 'us-east-2'), rules);
assert.deepStrictEqual(plan.deletes.map(byKey), ['regional:us-east-2']);
assert.deepStrictEqual(plan.upserts.map(byKey), ['identity']);
// back to the deployed pattern -> status returns to deployed
const shrunk = apply(rules, run(decoys.filter(d => d.name !== 'role-b'), rules));
plan = run(decoys, shrunk);
assert.strictEqual(plan.upserts.find(r => r.kind === 'identity').status, 'deployed');

// a stale "update available" on a rule identical to what is live clears without a content change
const stale = { ...shrunk.find(r => r.kind === 'identity'), status: 'update_available' };
stale.deployedPattern = stale.eventPattern;
plan = run(decoys.filter(d => d.name !== 'role-b'), shrunk.map(r => (r.kind === 'identity' ? stale : r)));
assert.deepStrictEqual(plan.upserts.map(r => [r.kind, r.status]), [['identity', 'deployed']]);

// 5. Overflow: many roles split the identity rule; every record fits in us-east-1 form.
const many = Array.from({ length: 60 }, (_, i) => D(`payroll-reporting-readonly-role-${i}`, 'iam', 'us-west-2'));
plan = run(many, []);
assert.ok(plan.upserts.length >= 2, 'identity rule must split');
for (const r of plan.upserts) {
  assert.strictEqual(r.kind, 'identity');
  assert.ok(P.usEast1Variant(r.eventPattern).length <= P.MAX_PATTERN_CHARS, 'us-east-1 form within limit');
  assert.strictEqual(r.charCount, P.usEast1Variant(r.eventPattern).length);
}
assert.strictEqual(plan.upserts.flatMap(flat).length, 60, 'every role placed exactly once');

// 6. Legacy shapes: a bare roleName in an identity record is kept and gets the current shape.
const legacyIdentity = { accountId: A, ruleName: 'li', kind: 'identity', status: 'deployed', charCount: 0, limitReached: false,
  eventPattern: pat(['aws.sts'], [{ roleName: ['role-a'] }]) };
plan = run([D('role-a', 'iam', 'us-west-2')], [legacyIdentity]);
assert.deepStrictEqual(flat(plan.upserts[0]), [arn('role-a'), 'role-a'].sort());

// 7. Individual mode: new regional decoys get a dedicated rule; the shared rule is untouched;
//    roles still go to the shared identity rule.
rules = apply([], run([D('/prod/a', 'ssm', 'us-west-2')], []));
plan = run([D('/prod/a', 'ssm', 'us-west-2'), D('/prod/x', 'ssm', 'us-west-2', 'ind'), D('/prod/y', 'ssm', 'us-west-2', 'ind'), D('role-i', 'iam', 'us-west-2', 'ind')],
  rules, { individualScenarioIds: ['ind'] });
const ded = plan.upserts.filter(r => r.isIndividual);
assert.strictEqual(ded.length, 1);
assert.deepStrictEqual(flat(ded[0]), ['/prod/x', '/prod/y']);
assert.ok(!plan.upserts.some(r => r.ruleName === rules[0].ruleName), 'shared rule untouched');
assert.ok(plan.upserts.some(r => r.kind === 'identity' && !r.isIndividual));

// 8. Identity regions and the us-east-1 form.
assert.strictEqual(P.identityRegions([]).length, 17);
assert.ok(P.identityRegions(['ap-east-1', 'bogus']).includes('ap-east-1'));
assert.ok(!P.identityRegions(['bogus']).includes('bogus'));
assert.deepStrictEqual(P.identityRegions(['us-east-2'], 'us-east-1, eu-west-1'), ['eu-west-1', 'us-east-1', 'us-east-2']);
const idRule = { kind: 'identity', eventPattern: pat(['aws.sts'], [{ roleArn: [arn('role-a'), `arn:aws:iam::${A}:role/team/role-p`] }]) };
const east = JSON.parse(P.patternForRegion(idRule, 'us-east-1'));
assert.deepStrictEqual(east.source, ['aws.sts', 'aws.iam']);
assert.deepStrictEqual(east.detail.requestParameters.$or[1], { roleName: ['role-a', 'role-p'] });
assert.deepStrictEqual(JSON.parse(P.patternForRegion(idRule, 'eu-west-1')).source, ['aws.sts']);
// EventBridge rejects a one-entry $or: a lone condition goes to AWS without it, in every form.
const lone = JSON.parse(P.patternForRegion(idRule, 'eu-west-1'));
assert.deepStrictEqual(lone.detail.requestParameters, { roleArn: [arn('role-a'), `arn:aws:iam::${A}:role/team/role-p`] });
const loneRegional = { region: 'us-east-2', eventPattern: pat(['aws.ssm'], [{ name: ['/prod/a'] }]) };
assert.deepStrictEqual(JSON.parse(P.patternForRegion(loneRegional, 'us-east-2')).detail.requestParameters, { name: ['/prod/a'] });
const loneLegacyId = { kind: 'identity', eventPattern: pat(['aws.sts'], [{ roleName: ['role-a'] }]) };
assert.deepStrictEqual(JSON.parse(P.patternForRegion(loneLegacyId, 'us-east-1')).detail.requestParameters, { roleName: ['role-a'] });
const two = JSON.parse(P.patternForRegion({ eventPattern: pat(['aws.ssm', 'aws.s3'], [{ name: ['/a'] }, { bucketName: ['b'] }]) }, 'us-west-2'));
assert.strictEqual(two.detail.requestParameters.$or.length, 2);
assert.strictEqual(P.ruleRegion({}), 'us-west-2');
assert.strictEqual(P.ruleKind({}), 'regional');

console.log('rules-plan ok');
JS
node "$OUT/test.js"
