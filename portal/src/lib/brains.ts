import fs from 'fs/promises';
import path from 'path';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  paginateScan,
} from '@aws-sdk/lib-dynamodb';
import { allItems } from './db';

export interface BrainRecord {
  accountId: string;
  region: string;
  globalBusArn: string;
  deployedAt: string;
  status: 'active' | 'removed';
}

// =============================================================================
// Brains live in the SAME single table as rules/scenarios/spokes/history:
//   PK = BRAIN#<accountId>, SK = META
// so the AWS backend is the single source of truth (previously file-only).
// STORAGE_BACKEND=local keeps the flat-file path for pre-brain-deploy use.
// =============================================================================
const STORAGE_BACKEND = process.env.STORAGE_BACKEND || 'aws';
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-west-2';
const STATE_TABLE = process.env.MIRAGE_STATE_TABLE || 'mirage-state';

const ddbClient = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(ddbClient, {
  marshallOptions: { removeUndefinedValues: true },
});

const BRAINS_FILE = path.join(process.cwd(), 'db_brains.json');

// NOTE: there is deliberately NO default/seed brain. A brain only exists after a
// real Deploy Brain (which calls saveBrain with the actual hub account). If no
// brain is registered, getBrains() returns [] and the UI shows "no brain deployed"
// - it must never fabricate one (a hardcoded default previously showed a phantom
// brain in the wrong account and masked the true state).

// ── Local-file helpers (local mode + resilience mirror) ─────────────────────
async function getBrainsFromFile(): Promise<BrainRecord[]> {
  try {
    await fs.access(BRAINS_FILE);
    const data = await fs.readFile(BRAINS_FILE, 'utf-8');
    const parsed = JSON.parse(data || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeBrainsToFile(brains: BrainRecord[]): Promise<void> {
  try {
    await fs.writeFile(BRAINS_FILE, JSON.stringify(brains, null, 2));
  } catch {
    /* best effort mirror */
  }
}

function brainKey(accountId: string) {
  return { PK: `BRAIN#${accountId}`, SK: 'META' };
}

// ── Public API (same signatures as before; backend-aware) ───────────────────
export async function getBrains(): Promise<BrainRecord[]> {
  if (STORAGE_BACKEND === 'local') {
    return getBrainsFromFile();
  }

  try {
    const res = await allItems(paginateScan({ client: docClient }, {
      TableName: STATE_TABLE,
      FilterExpression: 'begins_with(PK, :prefix) AND SK = :meta',
      ExpressionAttributeValues: { ':prefix': 'BRAIN#', ':meta': 'META' },
    }));
    const brains = res.map((item) => ({
      accountId: item.accountId,
      region: item.region || REGION,
      globalBusArn: item.globalBusArn,
      deployedAt: item.deployedAt,
      status: item.status,
    })) as BrainRecord[];
    // Empty is a valid, truthful answer (no brain deployed). Do NOT fabricate one.
    return brains;
  } catch (err) {
    console.warn('[DynamoDB] getBrains failed, falling back to file:', (err as Error).message);
    return getBrainsFromFile();
  }
}

export async function saveBrain(record: BrainRecord): Promise<void> {
  if (STORAGE_BACKEND === 'local') {
    const brains = await getBrainsFromFile();
    const idx = brains.findIndex((b) => b.accountId === record.accountId);
    if (idx >= 0) brains[idx] = record;
    else brains.push(record);
    await writeBrainsToFile(brains);
    return;
  }

  await docClient.send(
    new PutCommand({
      TableName: STATE_TABLE,
      Item: { ...brainKey(record.accountId), ...record },
    })
  );
}

export async function removeBrainRecord(accountId: string): Promise<void> {
  if (STORAGE_BACKEND === 'local') {
    const brains = await getBrainsFromFile();
    const updated = brains.map((b) =>
      b.accountId === accountId ? { ...b, status: 'removed' as const } : b
    );
    await writeBrainsToFile(updated);
    return;
  }

  // Soft-delete: keep the item, flip status to 'removed' (mirrors file behavior).
  try {
    const existing = await docClient.send(
      new GetCommand({ TableName: STATE_TABLE, Key: brainKey(accountId) })
    );
    if (existing.Item) {
      await docClient.send(
        new PutCommand({
          TableName: STATE_TABLE,
          Item: { ...existing.Item, status: 'removed' },
        })
      );
    }
  } catch (err) {
    console.warn('[DynamoDB] removeBrainRecord failed:', (err as Error).message);
  }
}

export async function getActiveBrain(): Promise<BrainRecord | null> {
  const brains = await getBrains();
  return brains.find((b) => b.status === 'active') || null;
}
