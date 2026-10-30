import fs from 'fs/promises';
import path from 'path';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { resourcePrefix } from './aws-auth';
import type { RuleKind, RegionPush } from './rules-plan';
import {
  DynamoDBDocumentClient,
  PutCommand,
  DeleteCommand,
  GetCommand,
  paginateQuery,
  paginateScan,
  type NativeAttributeValue,
} from '@aws-sdk/lib-dynamodb';

/** One DynamoDB item, as the document client returns it. */
export type Item = Record<string, NativeAttributeValue>;

/** Every item across pages: DynamoDB ends each Query/Scan response at 1 MB, and history
 *  shares this table, so a single read eventually stops returning rules or scenarios. */
export async function allItems(pages: AsyncIterable<{ Items?: Item[] }>): Promise<Item[]> {
  const items: Item[] = [];
  for await (const page of pages) items.push(...(page.Items ?? []));
  return items;
}

// =============================================================================
// STORAGE BACKEND CONFIGURATION
// 'aws'   -> Uses Amazon DynamoDB (single table: mirage-state)
// 'local' -> Uses local flat files (db_rules.json & db_scenarios.json)
// =============================================================================
export const STORAGE_BACKEND = process.env.STORAGE_BACKEND || 'aws';

const SCENARIOS_FILE = path.join(process.cwd(), 'db_scenarios.json');
const RULES_FILE = path.join(process.cwd(), 'db_rules.json');

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-west-2';
const STATE_TABLE = process.env.MIRAGE_STATE_TABLE || 'mirage-state';

const ddbClient = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(ddbClient, {
  marshallOptions: { removeUndefinedValues: true },
});

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

export interface RuleRecord {
  accountId: string;
  ruleName: string;
  eventPattern: string;
  deployedPattern?: string; // snapshot at last successful push — used for diff
  status: 'pending' | 'deployed' | 'update_available' | 'failed' | 'deleted';
  charCount: number;
  limitReached: boolean;
  isIndividual?: boolean;
  /** Missing on records written before per-region rules: read as regional. */
  kind?: RuleKind;
  /** Regional rules only. Missing = us-west-2, where every older rule was pushed. */
  region?: string;
  /** Identity rules only: result of the last push in each region. */
  regionStatus?: Record<string, RegionPush>;
  updatedAt?: string;
  version?: 0 | 1; // 0 = live, 1 = previous
}

export interface ScenarioRecord {
  accountId: string;
  scenarioId: string;
  decoys: Array<{ name: string; category: string }>;
  deployedAt: string;
  version?: 0 | 1; // 0 = live, 1 = previous
  // Terraform remote-state location (S3 backend). Lets teardown/audit find the
  // state and (future) the rendered-tf snapshot for uniquely-named deploys.
  tfstateBucket?: string;
  tfstateKey?: string;    // accounts/<accountId>/<scenarioId>/terraform.tfstate
  renderedTfKey?: string; // accounts/<accountId>/<scenarioId>/rendered/  (future)
}

// =============================================================================
// KEY HELPERS
// =============================================================================

const ruleKey = (accountId: string, ruleName: string, version: 0 | 1 = 0) => ({
  PK: `ACCT#${accountId}`,
  SK: `RULE#${ruleName}#v${version}`,
});

const scenarioKey = (accountId: string, scenarioId: string, version: 0 | 1 = 0) => ({
  PK: `ACCT#${accountId}`,
  SK: `SCENARIO#${scenarioId}#v${version}`,
});

// =============================================================================
// LOCAL FILE HELPERS
// =============================================================================

async function ensureLocalFiles() {
  try { await fs.access(RULES_FILE); } catch { await fs.writeFile(RULES_FILE, '[]'); }
  try { await fs.access(SCENARIOS_FILE); } catch { await fs.writeFile(SCENARIOS_FILE, '[]'); }
}

async function readLocalRules(): Promise<RuleRecord[]> {
  await ensureLocalFiles();
  try { return JSON.parse(await fs.readFile(RULES_FILE, 'utf-8')); } catch { return []; }
}

async function writeLocalRules(rules: RuleRecord[]): Promise<void> {
  await fs.writeFile(RULES_FILE, JSON.stringify(rules, null, 2));
}

async function readLocalScenarios(): Promise<ScenarioRecord[]> {
  await ensureLocalFiles();
  try { return JSON.parse(await fs.readFile(SCENARIOS_FILE, 'utf-8')); } catch { return []; }
}

async function writeLocalScenarios(scenarios: ScenarioRecord[]): Promise<void> {
  await fs.writeFile(SCENARIOS_FILE, JSON.stringify(scenarios, null, 2));
}

// =============================================================================
// ITEM MAPPERS
// =============================================================================

function itemToRule(item: Item): RuleRecord {
  return {
    accountId: item.accountId,
    ruleName: item.ruleName,
    eventPattern: item.eventPattern || '',
    deployedPattern: item.deployedPattern,
    status: item.status || 'pending',
    charCount: item.charCount || 0,
    limitReached: item.limitReached ?? false,
    isIndividual: item.isIndividual ?? false,
    kind: item.kind,
    region: item.region,
    regionStatus: item.regionStatus,
    updatedAt: item.updatedAt,
    version: item.version ?? 0,
  };
}

function itemToScenario(item: Item): ScenarioRecord {
  return {
    accountId: item.accountId,
    scenarioId: item.scenarioId,
    decoys: item.decoys || [],
    deployedAt: item.deployedAt || '',
    version: item.version ?? 0,
    tfstateBucket: item.tfstateBucket,
    tfstateKey: item.tfstateKey,
  };
}

// =============================================================================
// RULES
// =============================================================================

export async function getRules(accountId?: string): Promise<RuleRecord[]> {
  if (STORAGE_BACKEND === 'local') {
    const rules = await readLocalRules();
    if (accountId && accountId !== 'all') return rules.filter(r => r.accountId === accountId);
    return rules;
  }

  try {
    let items: Item[] = [];
    if (accountId && accountId !== 'all') {
      const res = await allItems(paginateQuery({ client: docClient }, {
        TableName: STATE_TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        FilterExpression: '#v = :v0',
        ExpressionAttributeNames: { '#v': 'version' },
        ExpressionAttributeValues: {
          ':pk': `ACCT#${accountId}`,
          ':prefix': 'RULE#',
          ':v0': 0,
        },
      }));
      items = res;
    } else {
      const res = await allItems(paginateScan({ client: docClient }, {
        TableName: STATE_TABLE,
        FilterExpression: 'begins_with(SK, :prefix) AND #v = :v0',
        ExpressionAttributeNames: { '#v': 'version' },
        ExpressionAttributeValues: { ':prefix': 'RULE#', ':v0': 0 },
      }));
      items = res;
    }
    return items.map(itemToRule);
  } catch (err) {
    console.warn('[DynamoDB] getRules failed, falling back to local:', (err as Error).message);
    const rules = await readLocalRules();
    if (accountId && accountId !== 'all') return rules.filter(r => r.accountId === accountId);
    return rules;
  }
}

/**
 * The DynamoDB read behind getRules(), without the fallback to the local mirror.
 * Rule planning must not run on a stale copy: it can delete rules.
 */
export async function queryRules(accountId: string): Promise<RuleRecord[]> {
  if (STORAGE_BACKEND === 'local') return getRules(accountId);
  const res = await allItems(paginateQuery({ client: docClient }, {
    TableName: STATE_TABLE,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    FilterExpression: '#v = :v0',
    ExpressionAttributeNames: { '#v': 'version' },
    ExpressionAttributeValues: { ':pk': `ACCT#${accountId}`, ':prefix': 'RULE#', ':v0': 0 },
  }));
  return res.map(itemToRule);
}

export function nextRuleName(accountId: string): string {
  const uniqueId = Math.random().toString(16).substring(2, 8);
  // <prefix>-fwd-<account>-<id>: matches the spoke deployment role's IAM scope
  // (rule/<prefix>-fwd-*, see iam/spoke/deployment-role/main.tf) and the
  // documented forwarding-rule convention. The old Event_forward_* name never
  // matched that scope, so PutRule was always denied.
  return `${resourcePrefix()}-fwd-${accountId}-${uniqueId}`;
}

export async function saveRuleState(rule: RuleRecord): Promise<void> {
  // Always mirror to local file
  try {
    const rules = await readLocalRules();
    const idx = rules.findIndex(r => r.accountId === rule.accountId && r.ruleName === rule.ruleName);
    if (idx >= 0) rules[idx] = rule; else rules.push(rule);
    await writeLocalRules(rules);
  } catch (err) {
    console.warn('[Cache] Failed to mirror rule locally:', err);
  }

  if (STORAGE_BACKEND === 'local') return;

  try {
    const now = new Date().toISOString();

    // Promote existing v0 → v1 before writing new v0
    const existing = await docClient.send(new GetCommand({
      TableName: STATE_TABLE,
      Key: ruleKey(rule.accountId, rule.ruleName, 0),
    }));
    if (existing.Item) {
      await docClient.send(new PutCommand({
        TableName: STATE_TABLE,
        Item: { ...existing.Item, ...ruleKey(rule.accountId, rule.ruleName, 1), version: 1 },
      }));
    }

    // Write new v0
    await docClient.send(new PutCommand({
      TableName: STATE_TABLE,
      Item: {
        ...ruleKey(rule.accountId, rule.ruleName, 0),
        accountId: rule.accountId,
        ruleName: rule.ruleName,
        eventPattern: rule.eventPattern,
        deployedPattern: rule.deployedPattern,
        status: rule.status,
        charCount: rule.charCount,
        limitReached: rule.limitReached,
        isIndividual: rule.isIndividual ?? false,
        kind: rule.kind,
        region: rule.region,
        regionStatus: rule.regionStatus,
        updatedAt: now,
        version: 0,
      },
    }));
  } catch (err) {
    // Rethrown: a rule record that silently failed to save is a decoy nobody watches.
    console.error(`[DynamoDB] saveRuleState failed for ${rule.ruleName}:`, err);
    throw err;
  }
}

export async function deleteRule(accountId: string, ruleName: string): Promise<void> {
  // Mirror removal in local file
  try {
    const rules = await readLocalRules();
    await writeLocalRules(rules.filter(r => !(r.accountId === accountId && r.ruleName === ruleName)));
  } catch (err) {
    console.warn('[Cache] Failed to remove rule from local mirror:', err);
  }

  if (STORAGE_BACKEND === 'local') return;

  try {
    await docClient.send(new DeleteCommand({ TableName: STATE_TABLE, Key: ruleKey(accountId, ruleName, 0) }));
    await docClient.send(new DeleteCommand({ TableName: STATE_TABLE, Key: ruleKey(accountId, ruleName, 1) }));
  } catch (err) {
    console.error(`[DynamoDB] deleteRule failed for ${ruleName}:`, err);
    throw err;
  }
}

// =============================================================================
// SCENARIOS
// =============================================================================

/**
 * The DynamoDB read behind getScenarios(), without the fallback.
 *
 * Exported for callers that must distinguish "no scenarios are deployed" from "the
 * store could not be reached". On a metrics tile those are very different answers and
 * getScenarios() cannot express the second, because its catch block returns a local
 * file. Everything else should keep using getScenarios() and its soft-fail.
 */
export async function queryScenarios(accountId?: string): Promise<ScenarioRecord[]> {
  let items: Item[] = [];
  if (accountId && accountId !== 'all') {
    const res = await allItems(paginateQuery({ client: docClient }, {
      TableName: STATE_TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      FilterExpression: '#v = :v0',
      ExpressionAttributeNames: { '#v': 'version' },
      ExpressionAttributeValues: {
        ':pk': `ACCT#${accountId}`,
        ':prefix': 'SCENARIO#',
        ':v0': 0,
      },
    }));
    items = res;
  } else {
    const res = await allItems(paginateScan({ client: docClient }, {
      TableName: STATE_TABLE,
      FilterExpression: 'begins_with(SK, :prefix) AND #v = :v0',
      ExpressionAttributeNames: { '#v': 'version' },
      ExpressionAttributeValues: { ':prefix': 'SCENARIO#', ':v0': 0 },
    }));
    items = res;
  }
  return items.map(itemToScenario);
}

export async function getScenarios(accountId?: string): Promise<ScenarioRecord[]> {
  if (STORAGE_BACKEND === 'local') {
    const scenarios = await readLocalScenarios();
    if (accountId && accountId !== 'all') return scenarios.filter(s => s.accountId === accountId);
    return scenarios;
  }

  try {
    return await queryScenarios(accountId);
  } catch (err) {
    console.warn('[DynamoDB] getScenarios failed, falling back to local:', (err as Error).message);
    const scenarios = await readLocalScenarios();
    if (accountId && accountId !== 'all') return scenarios.filter(s => s.accountId === accountId);
    return scenarios;
  }
}

export async function getScenario(accountId: string, scenarioId: string): Promise<ScenarioRecord | null> {
  if (STORAGE_BACKEND === 'local') {
    const scenarios = await readLocalScenarios();
    return scenarios.find(s => s.accountId === accountId && s.scenarioId === scenarioId) ?? null;
  }

  try {
    const res = await docClient.send(new GetCommand({
      TableName: STATE_TABLE,
      Key: scenarioKey(accountId, scenarioId, 0),
    }));
    return res.Item ? itemToScenario(res.Item) : null;
  } catch (err) {
    console.warn('[DynamoDB] getScenario failed:', (err as Error).message);
    return null;
  }
}

export async function saveScenario(record: ScenarioRecord): Promise<void> {
  // Mirror to local file
  try {
    const scenarios = await readLocalScenarios();
    const idx = scenarios.findIndex(s => s.accountId === record.accountId && s.scenarioId === record.scenarioId);
    const updated = { ...record, version: 0 as const };
    if (idx >= 0) scenarios[idx] = updated; else scenarios.push(updated);
    await writeLocalScenarios(scenarios);
  } catch (err) {
    console.warn('[Cache] Failed to mirror scenario locally:', err);
  }

  if (STORAGE_BACKEND === 'local') return;

  try {
    // Promote existing v0 → v1
    const existing = await docClient.send(new GetCommand({
      TableName: STATE_TABLE,
      Key: scenarioKey(record.accountId, record.scenarioId, 0),
    }));
    if (existing.Item) {
      await docClient.send(new PutCommand({
        TableName: STATE_TABLE,
        Item: { ...existing.Item, ...scenarioKey(record.accountId, record.scenarioId, 1), version: 1 },
      }));
    }

    // Write new v0. tfstate* fields persist the remote-state location; undefined
    // values are stripped by the docClient's removeUndefinedValues marshal option.
    await docClient.send(new PutCommand({
      TableName: STATE_TABLE,
      Item: {
        ...scenarioKey(record.accountId, record.scenarioId, 0),
        accountId: record.accountId,
        scenarioId: record.scenarioId,
        decoys: record.decoys,
        deployedAt: record.deployedAt,
        version: 0,
        tfstateBucket: record.tfstateBucket,
        tfstateKey: record.tfstateKey,
        renderedTfKey: record.renderedTfKey,
      },
    }));
  } catch (err) {
    console.error(`[DynamoDB] saveScenario failed for ${record.scenarioId}:`, err);
  }
}

export async function deleteScenario(accountId: string, scenarioId: string): Promise<void> {
  // Mirror in local file
  try {
    const scenarios = await readLocalScenarios();
    await writeLocalScenarios(scenarios.filter(s => !(s.accountId === accountId && s.scenarioId === scenarioId)));
  } catch (err) {
    console.warn('[Cache] Failed to remove scenario from local mirror:', err);
  }

  if (STORAGE_BACKEND === 'local') return;

  try {
    await docClient.send(new DeleteCommand({ TableName: STATE_TABLE, Key: scenarioKey(accountId, scenarioId, 0) }));
    await docClient.send(new DeleteCommand({ TableName: STATE_TABLE, Key: scenarioKey(accountId, scenarioId, 1) }));
  } catch (err) {
    console.error(`[DynamoDB] deleteScenario failed for ${scenarioId}:`, err);
  }
}

/**
 * Returns decoy names already deployed in this account that collide with the candidate list.
 */
export async function checkDecoyCollision(accountId: string, names: string[]): Promise<string[]> {
  const scenarios = await getScenarios(accountId);
  const deployed = new Set(scenarios.flatMap(s => s.decoys.map(d => d.name)));
  return names.filter(n => deployed.has(n));
}

// =============================================================================
// SPOKES (auto-registered on first deploy)
// =============================================================================

export async function registerSpoke(
  accountId: string,
  alias?: string,
  region: string = REGION,
): Promise<void> {
  if (STORAGE_BACKEND === 'local') return;

  try {
    await docClient.send(new PutCommand({
      TableName: STATE_TABLE,
      ConditionExpression: 'attribute_not_exists(PK)', // idempotent — don't overwrite existing
      Item: {
        PK: `SPOKE#${accountId}`,
        SK: 'META',
        accountId,
        alias: alias || accountId,
        region,
        registeredAt: new Date().toISOString(),
      },
    }));
  } catch (err) {
    if ((err as Error).name !== 'ConditionalCheckFailedException') {
      console.warn('[DynamoDB] registerSpoke failed:', (err as Error).message);
    }
  }
}

const querySpokes = () => allItems(paginateScan({ client: docClient }, {
  TableName: STATE_TABLE,
  FilterExpression: 'begins_with(PK, :prefix) AND SK = :meta',
  ExpressionAttributeValues: { ':prefix': 'SPOKE#', ':meta': 'META' },
}));

/** Every account ever deployed to: registerSpoke() never deletes its record. Throws on failure. */
export async function querySpokeIds(): Promise<string[]> {
  return (await querySpokes()).map((item) => item.accountId);
}

export async function getSpokes(): Promise<Array<{ accountId: string; alias?: string; region: string }>> {
  if (STORAGE_BACKEND === 'local') return [];

  try {
    const res = await querySpokes();
    return res.map((item) => ({
      accountId: item.accountId,
      alias: item.alias,
      region: item.region || REGION,
    }));
  } catch (err) {
    console.warn('[DynamoDB] getSpokes failed:', (err as Error).message);
    return [];
  }
}
