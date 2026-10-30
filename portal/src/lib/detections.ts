import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  UpdateCommand,
  paginateQuery,
} from '@aws-sdk/lib-dynamodb';
import { resourcePrefix } from './aws-auth';
import { querySpokeIds, queryScenarios } from './db';

// =============================================================================
// ACTIVE ALERTS (decoy-access detections)
//
// Detections are written ONLY by the hub brain Lambda (<prefix>-event-processor)
// into the dedicated `<prefix>-alerts` table -- kept separate from the
// `<prefix>-state` control-plane table so forensic data has its own blast radius.
// The portal reads them and advances their triage status; it never creates or
// deletes one (its IAM grant has no PutItem/DeleteItem).
//
// There is no local-file mirror, unlike lib/history.ts: nothing in the portal
// writes a detection, so under STORAGE_BACKEND=local there is nothing to mirror
// and the feed is empty by design.
// =============================================================================

const STORAGE_BACKEND = process.env.STORAGE_BACKEND || 'aws';
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-west-2';
// Must match monitoring-brain.yaml's MirageAlertsTable (TableName: `${ResourcePrefix}-alerts`).
const ALERTS_TABLE = process.env.MIRAGE_ALERTS_TABLE || `${resourcePrefix()}-alerts`;

// The newest this many alerts are returned. Honeypot volume is low by design (every hit
// is an incident), so this guards against a runaway payload.
const MAX_DETECTIONS = 500;

const ddbClient = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(ddbClient, {
  marshallOptions: { removeUndefinedValues: true },
});

export const DETECTION_STATUSES = ['active', 'in_progress', 'resolved'] as const;
export type DetectionStatus = (typeof DETECTION_STATUSES)[number];

export interface DetectionRecord {
  pk: string; // DETECTION#<accountId>  -- round-tripped so the UI can PATCH a row
  sk: string; // ALERT#<eventTime>-<eventID>
  id: string; // CloudTrail eventID (already a UUID)
  timestamp: string;
  accountId: string;
  awsRegion?: string;
  sourceIp?: string;
  resourceName: string; // the decoy that was touched
  resourceType?: string;
  source?: string; // e.g. aws.s3
  eventName: string;
  callerArn: string; // who did it
  actionStatus?: string; // SUCCESS | FAILED
  errorCode?: string;
  errorMessage?: string;
  rawDetail?: string; // full CloudTrail detail, JSON string
  status: DetectionStatus;
  updatedAt?: string;
  statusHistory?: StatusChange[]; // oldest first; empty until someone changes the status
}

export interface StatusChange { status: DetectionStatus; at: string }

/** Shape as stored by the brain Lambda. Every field is optional on read: an item
 *  written by an older Lambda version must still render rather than crash. */
interface RawAlertItem {
  PK?: string;
  SK?: string;
  id?: string;
  timestamp?: string;
  accountId?: string;
  awsRegion?: string;
  sourceIp?: string;
  resourceName?: string;
  resourceType?: string;
  source?: string;
  eventName?: string;
  callerArn?: string;
  actionStatus?: string;
  errorCode?: string;
  errorMessage?: string;
  rawDetail?: string;
  status?: DetectionStatus;
  updatedAt?: string;
  statusHistory?: StatusChange[];
}

function itemToDetection(item: RawAlertItem): DetectionRecord {
  return {
    pk: item.PK || '',
    sk: item.SK || '',
    id: item.id || '',
    timestamp: item.timestamp || '',
    accountId: item.accountId || '',
    awsRegion: item.awsRegion,
    sourceIp: item.sourceIp,
    resourceName: item.resourceName || 'Unknown',
    resourceType: item.resourceType,
    source: item.source,
    eventName: item.eventName || 'Unknown',
    callerArn: item.callerArn || '',
    actionStatus: item.actionStatus,
    errorCode: item.errorCode,
    errorMessage: item.errorMessage,
    rawDetail: item.rawDetail,
    status: item.status || 'active',
    updatedAt: item.updatedAt,
    statusHistory: item.statusHistory,
  };
}

/** Newest first. SK embeds an ISO timestamp, so lexical desc == chronological desc. */
const bySkDesc = (a: DetectionRecord, b: DetectionRecord) => b.sk.localeCompare(a.sk);

/** One account's alerts, newest first, reading pages until there are enough. */
async function newestFor(accountId: string): Promise<RawAlertItem[]> {
  const items: RawAlertItem[] = [];
  for await (const page of paginateQuery({ client: docClient }, {
    TableName: ALERTS_TABLE,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': `DETECTION#${accountId}` },
    ScanIndexForward: false, // newest first, straight from the index
  })) {
    items.push(...((page.Items ?? []) as RawAlertItem[]));
    if (items.length >= MAX_DETECTIONS) break;
  }
  return items;
}

/**
 * Returns detections newest-first, scoped to one spoke account when given.
 * Soft-fails to [] so the dashboard degrades to an empty feed rather than an
 * error page.
 */
/**
 * The DynamoDB read behind getDetections(), without the fallback. Same reasoning as
 * queryScenarios() in lib/db.ts: a metrics tile has to be able to say "unknown"
 * rather than report zero alerts when it could not reach the table.
 */
export async function queryDetections(accountId?: string): Promise<DetectionRecord[]> {
  // Not a table scan: a scan reads in storage order, oldest first within an account, so it
  // would show the oldest 500 and never a new alert. Alerts only come from accounts that had
  // decoys; live scenarios also cover a spoke whose registerSpoke() write failed.
  const accounts = accountId && accountId !== 'all'
    ? [accountId]
    : [...new Set([...await querySpokeIds(), ...(await queryScenarios()).map(s => s.accountId)])];
  const items = (await Promise.all(accounts.map(newestFor))).flat();
  return items.map(itemToDetection).sort(bySkDesc).slice(0, MAX_DETECTIONS);
}

export async function getDetections(accountId?: string): Promise<DetectionRecord[]> {
  if (STORAGE_BACKEND === 'local') return [];

  try {
    return await queryDetections(accountId);
  } catch (err) {
    console.warn(
      '[DynamoDB] getDetections failed:',
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

/**
 * Advances an alert's triage status in place. Throws on failure -- unlike the
 * read path, a mutation must not fail silently or the analyst sees a status
 * change that was never persisted.
 */
export async function updateDetectionStatus(
  pk: string,
  sk: string,
  status: DetectionStatus,
): Promise<void> {
  if (STORAGE_BACKEND === 'local') {
    throw new Error(
      'Alert status updates require STORAGE_BACKEND=aws (detections live only in DynamoDB).',
    );
  }
  if (!DETECTION_STATUSES.includes(status)) {
    throw new Error(`Invalid detection status: ${status}`);
  }

  const now = new Date().toISOString();
  // attribute_exists(PK) is load-bearing: UpdateItem upserts by default, so
  // without it a bogus key would silently create a phantom alert row.
  await docClient.send(new UpdateCommand({
    TableName: ALERTS_TABLE,
    Key: { PK: pk, SK: sk },
    // statusHistory feeds the Timeline tab; list_append keeps every change, oldest first.
    UpdateExpression: 'SET #s = :s, updatedAt = :u, statusHistory = list_append(if_not_exists(statusHistory, :none), :change)',
    ConditionExpression: 'attribute_exists(PK)',
    ExpressionAttributeNames: { '#s': 'status' }, // 'status' is a DynamoDB reserved word
    ExpressionAttributeValues: { ':s': status, ':u': now, ':none': [], ':change': [{ status, at: now }] },
  }));
}
