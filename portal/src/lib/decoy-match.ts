/**
 * How a CloudTrail event for a given decoy category is matched by EventBridge.
 *
 * This is the single source of truth for spoke-side rule generation. It used to
 * be a flat `Record<string, string>` duplicated verbatim in deploy-spoke and
 * remove-spoke, which is how the same bug sat wrong in both files for the
 * platform's entire life: every scenario's outputs.tf emits category "iam" for
 * its lure role, that mapped to key `roleName` with source `aws.iam` and a BARE
 * role name, and a real sts:AssumeRole event has source `aws.sts`, key `roleArn`
 * and a FULL ARN. EventBridge matches strings exactly, so the generated pattern
 * was unsatisfiable and AssumeRole -- the primary lure in all 19 scenarios --
 * was never detected once.
 *
 * Three things have to agree per category, not one: the `source`, the
 * requestParameters `key`, and the shape of the `value`. Hence a descriptor
 * rather than a string.
 *
 * A category may need MORE THAN ONE condition, because one resource can appear
 * under different keys depending on the operation. Measured on 2026-10-10: an
 * SNS topic is `topicArn` on GetTopicAttributes and ListSubscriptionsByTopic,
 * but `resourceArn` on ListTagsForResource. A single-key descriptor silently
 * missed the latter.
 */

/**
 * An EventBridge match value.
 *
 * A plain string is an exact, whole-value match -- EventBridge compares the
 * entire string, not a substring.
 *
 * `{ suffix }` matches any value ENDING with that string. Needed where
 * CloudTrail reports a fully-qualified identifier whose tail is the decoy name:
 * an SNS topic arrives as `arn:aws:sns:<region>:<acct>:<name>`, so a suffix of
 * `:<name>` matches it without this module needing to know the region. The
 * leading separator is deliberate -- a bare `<name>` suffix would also match
 * `legacy-<name>`.
 *
 * Verified live before adopting: a suffix condition nested inside
 * detail.requestParameters.$or recorded MatchedEvents=3 against the same three
 * events for which the production exact-match rules recorded 0.
 */
export type MatchValue = string | { suffix: string };

export interface DecoyCondition {
  /** The `detail.requestParameters` key CloudTrail populates. */
  key: string;
  /** Builds the match value for one decoy. */
  value: (name: string, accountId: string) => MatchValue;
}

export interface DecoyMatch {
  /** EventBridge `source` for this category's CloudTrail events. */
  source: string;
  /**
   * Every condition under which this decoy can appear. All of them are emitted;
   * they sit as separate `$or` branches, so matching any one is a hit.
   */
  conditions: DecoyCondition[];
}

/** Single exact-match condition on the bare decoy name. The common case. */
const exact = (key: string): DecoyCondition[] => [{ key, value: (name) => name }];

export const CATEGORY_MATCH: Record<string, DecoyMatch> = {
  // The lure role. CloudTrail's AssumeRole has no `roleName` key at all --
  // it carries `roleArn` (full ARN) plus `roleSessionName`.
  //
  // NOTE: aws.iam operations (GetRole, ListAttachedRolePolicies, ...) DO use
  // `roleName` with the bare name, and are recorded only in us-east-1 because
  // IAM is a global service. Adding that second condition is a separate change;
  // this descriptor now supports it, but nothing here emits it yet.
  iam: {
    source: 'aws.sts',
    conditions: [
      { key: 'roleArn', value: (name, accountId) => `arn:aws:iam::${accountId}:role/${name}` },
    ],
  },
  // Alias: no scenario emits category "sts" today (all 19 emit "iam"), but a
  // hand-written output might. Same descriptor so the two can never diverge.
  sts: {
    source: 'aws.sts',
    conditions: [
      { key: 'roleArn', value: (name, accountId) => `arn:aws:iam::${accountId}:role/${name}` },
    ],
  },

  s3: { source: 'aws.s3', conditions: exact('bucketName') },
  secretsmanager: { source: 'aws.secretsmanager', conditions: exact('secretId') },
  ssm: { source: 'aws.ssm', conditions: exact('name') },
  dynamodb: { source: 'aws.dynamodb', conditions: exact('tableName') },
  kms: { source: 'aws.kms', conditions: exact('keyId') },
  ecr: { source: 'aws.ecr', conditions: exact('repositoryName') },
  lambda: { source: 'aws.lambda', conditions: exact('functionName') },
  cloudformation: { source: 'aws.cloudformation', conditions: exact('stackName') },

  // `logs` was absent from the old map entirely, so scenario-13's decoy fell
  // through to `typeMapping[cat] || cat` and generated a literal "logs" key.
  logs: { source: 'aws.logs', conditions: exact('logGroupName') },

  // SQS: known broken upstream and NOT fixed here. Measured 2026-10-10 -- SQS
  // does not record GetQueueAttributes / ListQueueTags / ReceiveMessage as
  // CloudTrail management events at all. Over 7 days the only SQS events in the
  // account were CreateQueue and DeleteQueue, and those carry `queueName` with
  // the bare name. Detecting someone reading a decoy queue needs SQS data
  // events enabled on the trail; changing this key alone would not help.
  sqs: { source: 'aws.sqs', conditions: exact('queueUrl') },

  // SNS reports the topic under two different keys, and always fully qualified:
  //   GetTopicAttributes / ListSubscriptionsByTopic -> topicArn
  //   ListTagsForResource                           -> resourceArn
  // Both observed in CloudTrail on 2026-10-10. The previous single `topicArn`
  // condition held the bare name, so it matched neither.
  sns: {
    source: 'aws.sns',
    conditions: [
      { key: 'topicArn', value: (name) => ({ suffix: `:${name}` }) },
      { key: 'resourceArn', value: (name) => ({ suffix: `:${name}` }) },
    ],
  },
};

/**
 * Descriptor for a category, with a conservative fallback for anything
 * unrecognised that preserves the old `typeMapping[cat] || cat` behaviour
 * rather than throwing mid-deploy.
 */
export function matchFor(category: string): DecoyMatch {
  const cat = category.toLowerCase().trim();
  return CATEGORY_MATCH[cat] ?? { source: `aws.${cat}`, conditions: exact(cat) };
}

/** Every (key, value) condition to put in the event pattern for this decoy. */
export function matchConditions(
  category: string,
  name: string,
  accountId: string,
): Array<{ key: string; value: MatchValue }> {
  return matchFor(category).conditions.map(c => ({ key: c.key, value: c.value(name, accountId) }));
}

/**
 * Value-equality for match values, so dedup and removal work on `{suffix}`
 * objects as well as strings.
 *
 * Array.includes() compares objects by REFERENCE, so without this a suffix
 * condition would never dedup on insert and never be found on removal -- both
 * silently, which is the same failure shape that left mirage-ops-fwd-...-7dff93
 * alive in EventBridge watching a destroyed decoy.
 */
export function sameMatchValue(a: MatchValue, b: MatchValue): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  return a.suffix === b.suffix;
}

/**
 * The quoted strings to look for when asking "is this decoy named in a
 * serialized pattern?".
 *
 * For an exact condition that is the value itself. For a suffix condition it is
 * the suffix string, because that is what appears quoted in the serialized
 * JSON: {"suffix":":prod-alerts-critical"}. The bare name is always included as
 * a fallback so patterns written before this module shipped still resolve.
 */
export function matchTokens(category: string, name: string, accountId: string): string[] {
  const out = new Set<string>([name]);
  for (const c of matchConditions(category, name, accountId)) {
    out.add(typeof c.value === 'string' ? c.value : c.value.suffix);
  }
  return Array.from(out);
}

/**
 * requestParameters key -> EventBridge source.
 *
 * Replaces `Object.entries(typeMapping).find(([, v]) => v === k)` in
 * remove-spoke, which reverse-mapped by value and so resolved 'roleName' to
 * whichever of `sts`/`iam` came first in insertion order -- silently dropping
 * `aws.iam` from a rule's `source` after any shared-rule teardown. Built from
 * CATEGORY_MATCH so it can never drift out of sync.
 *
 * Every condition contributes, not just the first -- otherwise `resourceArn`
 * would map to nothing and `rebuildSources` would drop `aws.sns` from a shared
 * rule's `source` after a teardown, leaving a rule that matches no event.
 */
export const SOURCE_BY_KEY: Record<string, string> = Object.values(CATEGORY_MATCH).reduce(
  (acc, m) => {
    for (const c of m.conditions) acc[c.key] = m.source;
    return acc;
  },
  {} as Record<string, string>
);

/** Source for a requestParameters key, or undefined if unrecognised. */
export function sourceForKey(key: string): string | undefined {
  return SOURCE_BY_KEY[key];
}
