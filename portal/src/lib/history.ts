import fs from 'fs/promises';
import path from 'path';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, paginateQuery } from '@aws-sdk/lib-dynamodb';
import { allItems } from './db';

// =============================================================================
// STORAGE BACKEND CONFIGURATION
// =============================================================================
export const STORAGE_BACKEND = process.env.STORAGE_BACKEND || 'aws';

const HISTORY_FILE = path.join(process.cwd(), 'db_history.json');
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-west-2';
const STATE_TABLE = process.env.MIRAGE_STATE_TABLE || 'mirage-state';

const ddbClient = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(ddbClient, {
  marshallOptions: { removeUndefinedValues: true },
});

export type HistoryEventType =
  | 'scenario_deploy'
  | 'rule_generate'
  | 'rule_push'
  | 'trust_policy_update'
  | 'scenario_teardown'
  | 'rule_teardown'
  | 'trust_policy_teardown'
  | 'scenario_populate';

export type HistoryEventStatus = 'success' | 'failed';

export interface HistoryEvent {
  id: string;
  timestamp: string;
  sessionId: string;
  type: HistoryEventType;
  scenarioId: string;
  scenarioName: string;
  accountId: string;
  ruleName?: string;
  status: HistoryEventStatus;
  error?: string;
}

// =============================================================================
// LOCAL FILE HELPERS
// =============================================================================

async function ensureHistoryFile() {
  try { await fs.access(HISTORY_FILE); } catch { await fs.writeFile(HISTORY_FILE, '[]'); }
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Returns all history events sorted newest first.
 * Reads from DynamoDB (last 30 days of HISTORY# partitions) with local file fallback.
 */
export async function getHistory(): Promise<HistoryEvent[]> {
  if (STORAGE_BACKEND !== 'local') {
    try {
      const events: HistoryEvent[] = [];
      const today = new Date();

      // Query the last 30 days of date partitions
      for (let i = 0; i < 30; i++) {
        const d = new Date(today);
        d.setUTCDate(d.getUTCDate() - i);
        const dateKey = d.toISOString().slice(0, 10);

        const res = await allItems(paginateQuery({ client: docClient }, {
          TableName: STATE_TABLE,
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: { ':pk': `HISTORY#${dateKey}` },
        }));
        for (const item of res) {
          events.push({
            id: item.id,
            timestamp: item.timestamp,
            sessionId: item.sessionId,
            type: item.type,
            scenarioId: item.scenarioId,
            scenarioName: item.scenarioName,
            accountId: item.accountId,
            ruleName: item.ruleName,
            status: item.status,
            error: item.error,
          });
        }
      }

      return events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    } catch (err) {
      console.warn('[DynamoDB] getHistory failed, falling back to local file:', (err as Error).message);
    }
  }

  // Local fallback
  await ensureHistoryFile();
  try {
    const events: HistoryEvent[] = JSON.parse(await fs.readFile(HISTORY_FILE, 'utf-8'));
    return events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  } catch {
    return [];
  }
}

/**
 * Appends a history event.
 * Writes to DynamoDB (HISTORY#{date} partition) and mirrors to local db_history.json.
 */
export async function appendHistory(event: Omit<HistoryEvent, 'id' | 'timestamp'>): Promise<void> {
  const timestamp = new Date().toISOString();
  const id = `${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
  const dateKey = timestamp.slice(0, 10); // YYYY-MM-DD

  const newEvent: HistoryEvent = { ...event, id, timestamp };

  // 1. Always mirror to local file for instant UI response and offline resilience
  try {
    await ensureHistoryFile();
    let events: HistoryEvent[] = [];
    try { events = JSON.parse(await fs.readFile(HISTORY_FILE, 'utf-8')); } catch { events = []; }
    events.push(newEvent);
    if (events.length > 500) events = events.slice(events.length - 500);
    await fs.writeFile(HISTORY_FILE, JSON.stringify(events, null, 2));
  } catch (fileErr) {
    console.error('[History] Failed to write local history cache:', fileErr);
  }

  // 2. Write to DynamoDB HISTORY# partition (non-blocking — won't crash portal on failure)
  if (STORAGE_BACKEND !== 'local') {
    try {
      await docClient.send(new PutCommand({
        TableName: STATE_TABLE,
        Item: {
          PK: `HISTORY#${dateKey}`,
          SK: `EVENT#${timestamp}-${id}`,
          id,
          timestamp,
          sessionId: event.sessionId,
          type: event.type,
          scenarioId: event.scenarioId,
          scenarioName: event.scenarioName,
          accountId: event.accountId,
          ruleName: event.ruleName,
          status: event.status,
          error: event.error,
        },
      }));
    } catch (ddbErr) {
      console.warn('[DynamoDB] appendHistory write failed (non-blocking):', (ddbErr as Error).message);
    }
  }
}
