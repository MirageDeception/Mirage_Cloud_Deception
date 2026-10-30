/**
 * Populate: writes real seed content into already-deployed decoy resources so an
 * attacker calling GetObject / GetSecretValue / GetParameter / Scan /
 * ReceiveMessage / GetLogEvents has something real to read. An empty decoy is
 * worse than no decoy: the monitored API call never fires, so the lure looks
 * like detection failure rather than like a honeypot that was never taken.
 *
 * Supported: S3 objects, Secrets Manager secrets, SSM parameters, DynamoDB
 * items, SQS messages, CloudWatch Logs events.
 *
 * Deliberately NOT supported, so nobody wastes time looking for the manifest:
 *   - sns   (scenario-12)  Publish is transient -- SNS stores no readable body,
 *                          so there is nothing for an attacker to retrieve. The
 *                          lure is the topic + its subscriber list.
 *   - kms   (scenario-14)  Decrypt needs attacker-supplied ciphertext; a key has
 *                          no seedable content.
 *   - ecr   (scenario-5)   Needs a real `docker push`. No SDK call seeds a layer.
 *                          (Scenario-5 is an ECR repository lure with an optional
 *                          IAM instance-profile attachment point -- it is not an
 *                          EC2 scenario. Scenario-4 is the one EC2/bastion scenario.)
 *   - lambda (6, 7, 17)    Secrets live in environment variables, set inline in
 *                          HCL at apply time.
 *   - 15, 16, 19           Self-seed via HCL heredocs in their own main.tf.
 *
 * Driven by a per-scenario manifest (scenarios/scenario-N/populate-manifest.json)
 * that never stores literal AWS resource names -- names are resolved at
 * populate-time from ScenarioRecord.decoys[], which deploy-spoke already
 * populates from the real `terraform output`. This keeps the manifest robust
 * to a future per-deployment resource-name randomization phase.
 */
import fs from 'fs/promises';
import path from 'path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { SecretsManagerClient, PutSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm';
import { DynamoDBClient, PutItemCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { SQSClient, SendMessageCommand, GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import {
  CloudWatchLogsClient,
  CreateLogStreamCommand,
  PutLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { scenarioDir } from '@/lib/scenarios';
import type { SdkCredentials } from '@/lib/aws-auth';

export type PopulateSdkOperation =
  | 's3:PutObject'
  | 'secretsmanager:PutSecretValue'
  | 'ssm:PutParameter'
  | 'dynamodb:PutItem'
  | 'sqs:SendMessage'
  | 'logs:PutLogEvents'
  | 'none';

export interface PopulateManifestSeed {
  label: string;
  category: string;
  sdkOperation: PopulateSdkOperation;
  fakeDataFile: string | null;
  format?: 'json' | 'yaml' | 'text';
  // s3
  s3Key?: string;
  contentType?: string;
  // ssm
  ssmType?: 'String' | 'SecureString' | 'StringList';
  ssmTier?: 'Standard' | 'Advanced' | 'Intelligent-Tiering';
  // dynamodb / sqs: cap how many array entries get written. Omitted = all.
  maxItems?: number;
  // sqs: REQUIRED by SQS itself for any queue whose name ends in `.fifo`
  // (SendMessage fails with "The request must contain the parameter
  // MessageGroupId"), ignored for standard queues. scenario-11's two queues are
  // both FIFO, so this is not a hypothetical.
  messageGroupId?: string;
  // disambiguates multiple resources sharing a category -- a short, non-literal
  // substring of the real resource name, NOT the full name itself
  matchContains?: string;
}

export interface PopulateManifest {
  scenarioId: string;
  version: number;
  seeds: PopulateManifestSeed[];
}

export interface PopulateResult {
  label: string;
  category: string;
  status: 'success' | 'skipped' | 'failed';
  resourceName?: string;
  /** Records/messages/log events written. Only set for the multi-record ops. */
  seededCount?: number;
  error?: string;
}

/** Reads scenarios/scenario-N/populate-manifest.json. Returns null if the scenario doesn't support populate. */
export async function loadManifest(scenarioId: string): Promise<PopulateManifest | null> {
  const manifestPath = path.join(await scenarioDir(scenarioId), 'populate-manifest.json');
  try {
    const raw = await fs.readFile(manifestPath, 'utf-8');
    return JSON.parse(raw) as PopulateManifest;
  } catch {
    return null;
  }
}

/**
 * Resolves the real deployed resource name for a manifest seed from the
 * scenario's decoys[] (captured at deploy time from real `terraform output`).
 * `matchContains` disambiguates multiple resources sharing a category.
 */
export function resolveResourceName(
  decoys: Array<{ name: string; category: string }>,
  category: string,
  matchContains?: string
): string | undefined {
  const candidates = decoys.filter(d => d.category.toLowerCase() === category.toLowerCase());
  if (!matchContains) return candidates[0]?.name;
  return candidates.find(d => d.name.includes(matchContains))?.name;
}

/**
 * Marks seeded content as EXPIRED so IR can distinguish a lure from a real
 * breach (project-wide invariant). Field/text names must read as plausible
 * ops metadata -- never reference "mirage", "decoy", "deception", "honeypot",
 * or "lure". This is the one place in the populate flow where a naming leak
 * would actually reach an attacker, since this content is returned verbatim
 * by GetSecretValue/GetObject/GetParameter.
 */
export function injectExpiredMarker(raw: string, format: 'json' | 'yaml' | 'text' | undefined): string {
  if (format === 'json') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        parsed.status = 'EXPIRED';
        return JSON.stringify(parsed, null, 2);
      }
    } catch {
      // fall through to text handling if the file isn't valid JSON
    }
  }
  return `# status: EXPIRED (rotated out, do not use)\n${raw}`;
}

/**
 * Parses a fake-data file that must be a JSON ARRAY of records (DynamoDB items,
 * SQS message bodies) and applies the EXPIRED marker PER RECORD.
 *
 * `injectExpiredMarker` must NOT be used for these: it rejects arrays and falls
 * through to prefixing a `# status: EXPIRED` comment line, which would make the
 * payload invalid JSON. An SQS consumer or a DynamoDB PutItem would then fail,
 * or -- worse for S3-style paths -- succeed while storing a corrupt body.
 *
 * The marker is a plain `status` attribute because that is what the rest of the
 * seed content already looks like; it must read as ordinary ops metadata and
 * must never say "mirage", "decoy", "deception", "honeypot" or "lure", since an
 * attacker reads this content verbatim.
 */
export function parseRecordArray(raw: string, label: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${label}: fake-data is not valid JSON (${msg})`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${label}: fake-data must be a JSON array of records, got ${typeof parsed}`);
  }
  return parsed;
}

/** Adds a DynamoDB-AttributeValue EXPIRED marker to an item map. */
export function markExpiredDynamoItem(
  item: Record<string, AttributeValue>
): Record<string, AttributeValue> {
  return { ...item, status: { S: 'EXPIRED' } };
}

/** Adds a plain EXPIRED marker to an SQS message body object. */
export function markExpiredMessageBody(body: unknown): string {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    return JSON.stringify({ ...(body as Record<string, unknown>), status: 'EXPIRED' }, null, 2);
  }
  return JSON.stringify(body);
}

export interface LogSeedFile {
  streams: Record<string, Array<{ timestamp_offset: number; message: string }>>;
}

/**
 * CloudWatch Logs rejects an event whose timestamp is more than 14 days in the
 * past or 2 hours in the future (InvalidParameterException), and the seed files
 * carry only RELATIVE `timestamp_offset` values -- so absolute timestamps have
 * to be computed at populate time. We anchor the LAST event at ~5 minutes ago so
 * the whole stream lands inside the accepted window and reads as a service that
 * was running until moments before the attacker found it.
 *
 * The dates inside the log MESSAGES are left exactly as authored; only the event
 * timestamps are anchored. Mismatched text dates are normal in real log archives
 * and are not worth rewriting.
 *
 * Returned events are sorted ascending, which PutLogEvents requires within a
 * batch.
 */
export function buildLogEvents(
  entries: Array<{ timestamp_offset: number; message: string }>,
  now: number = Date.now()
): Array<{ timestamp: number; message: string }> {
  if (entries.length === 0) return [];
  const maxOffset = Math.max(...entries.map(e => e.timestamp_offset || 0));
  const anchor = now - 5 * 60 * 1000 - maxOffset;
  return entries
    .map(e => ({ timestamp: anchor + (e.timestamp_offset || 0), message: e.message }))
    .sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * PutLogEvents caps a batch at 10,000 events and 1 MiB (each event costing its
 * UTF-8 byte length + 26 bytes of overhead). Exceeding either returns
 * InvalidParameterException, so batches are built to both limits rather than to
 * the count alone.
 */
export function chunkLogEvents(
  events: Array<{ timestamp: number; message: string }>
): Array<Array<{ timestamp: number; message: string }>> {
  const MAX_EVENTS = 10000;
  const MAX_BYTES = 1048576 - 2048; // headroom
  const batches: Array<Array<{ timestamp: number; message: string }>> = [];
  let batch: Array<{ timestamp: number; message: string }> = [];
  let bytes = 0;
  for (const ev of events) {
    const cost = Buffer.byteLength(ev.message, 'utf-8') + 26;
    if (batch.length >= MAX_EVENTS || (batch.length > 0 && bytes + cost > MAX_BYTES)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(ev);
    bytes += cost;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

export interface PopulateScenarioOpts {
  scenarioId: string;
  region: string;
  decoys: Array<{ name: string; category: string }>;
  credentials: SdkCredentials;
}

export async function populateScenario(opts: PopulateScenarioOpts): Promise<{
  manifestFound: boolean;
  results: PopulateResult[];
}> {
  const { scenarioId, region, decoys, credentials } = opts;
  const manifest = await loadManifest(scenarioId);
  if (!manifest) {
    return { manifestFound: false, results: [] };
  }

  const s3Client = new S3Client({ region, credentials });
  const secretsClient = new SecretsManagerClient({ region, credentials });
  const ssmClient = new SSMClient({ region, credentials });
  const dynamoClient = new DynamoDBClient({ region, credentials });
  const sqsClient = new SQSClient({ region, credentials });
  const logsClient = new CloudWatchLogsClient({ region, credentials });

  const results: PopulateResult[] = [];

  for (const seed of manifest.seeds) {
    if (seed.sdkOperation === 'none' || !seed.fakeDataFile) {
      results.push({ label: seed.label, category: seed.category, status: 'skipped' });
      continue;
    }

    const resourceName = resolveResourceName(decoys, seed.category, seed.matchContains);
    if (!resourceName) {
      results.push({
        label: seed.label,
        category: seed.category,
        status: 'failed',
        error: 'No matching deployed decoy found for this seed',
      });
      continue;
    }

    let seededCount: number | undefined;
    try {
      const fakeDataPath = path.join(await scenarioDir(scenarioId), 'fake-data', seed.fakeDataFile);
      const raw = await fs.readFile(fakeDataPath, 'utf-8');

      if (seed.sdkOperation === 's3:PutObject') {
        await s3Client.send(new PutObjectCommand({
          Bucket: resourceName,
          Key: seed.s3Key || seed.fakeDataFile,
          Body: injectExpiredMarker(raw, seed.format),
          ContentType: seed.contentType,
        }));
      } else if (seed.sdkOperation === 'secretsmanager:PutSecretValue') {
        await secretsClient.send(new PutSecretValueCommand({
          SecretId: resourceName,
          SecretString: injectExpiredMarker(raw, seed.format),
        }));
      } else if (seed.sdkOperation === 'ssm:PutParameter') {
        await ssmClient.send(new PutParameterCommand({
          Name: resourceName,
          Value: injectExpiredMarker(raw, seed.format),
          Type: seed.ssmType || 'String',
          Tier: seed.ssmTier,
          Overwrite: true,
        }));
      } else if (seed.sdkOperation === 'dynamodb:PutItem') {
        // Items are authored in DynamoDB AttributeValue shape ({"S": ...},
        // {"N": ...}), so the low-level DynamoDBClient is required here --
        // DynamoDBDocumentClient would try to marshal them a second time and
        // store nested {"M": {"S": ...}} garbage.
        const items = parseRecordArray(raw, seed.label);
        const slice = seed.maxItems ? items.slice(0, seed.maxItems) : items;
        for (const item of slice) {
          await dynamoClient.send(new PutItemCommand({
            TableName: resourceName,
            Item: markExpiredDynamoItem(item as Record<string, AttributeValue>),
          }));
        }
        seededCount = slice.length;
      } else if (seed.sdkOperation === 'sqs:SendMessage') {
        // decoys[] carries the queue NAME; SendMessage needs the URL.
        const { QueueUrl } = await sqsClient.send(new GetQueueUrlCommand({ QueueName: resourceName }));
        if (!QueueUrl) throw new Error(`could not resolve a queue URL for ${resourceName}`);
        const isFifo = resourceName.endsWith('.fifo');
        const bodies = parseRecordArray(raw, seed.label);
        const slice = seed.maxItems ? bodies.slice(0, seed.maxItems) : bodies;
        for (const body of slice) {
          await sqsClient.send(new SendMessageCommand({
            QueueUrl,
            MessageBody: markExpiredMessageBody(body),
            // A FIFO queue rejects SendMessage without a MessageGroupId. These
            // queues set content_based_deduplication, so MessageDeduplicationId
            // is not required -- but that also means re-running populate inside
            // the 5-minute dedup window silently drops identical bodies rather
            // than erroring, so a second run can legitimately seed 0 messages.
            ...(isFifo ? { MessageGroupId: seed.messageGroupId || 'default' } : {}),
          }));
        }
        seededCount = slice.length;
      } else if (seed.sdkOperation === 'logs:PutLogEvents') {
        const parsed = JSON.parse(raw) as LogSeedFile;
        if (!parsed?.streams || typeof parsed.streams !== 'object') {
          throw new Error(`${seed.label}: expected a { "streams": { "<name>": [...] } } object`);
        }
        let total = 0;
        for (const [streamName, entries] of Object.entries(parsed.streams)) {
          try {
            await logsClient.send(new CreateLogStreamCommand({
              logGroupName: resourceName,
              logStreamName: streamName,
            }));
          } catch (err) {
            // Re-populating an already-seeded group is a normal, idempotent
            // operation; only a genuinely different failure should abort.
            if ((err as { name?: string })?.name !== 'ResourceAlreadyExistsException') throw err;
          }
          const events = buildLogEvents(entries);
          if (events.length === 0) continue;
          // A log line cannot carry a `status` field, so the EXPIRED marker is a
          // leading event phrased as the kind of rotation notice that really does
          // appear in service logs.
          events.unshift({
            timestamp: events[0].timestamp - 1000,
            message:
              'WARN  [CredentialRotation] Credentials referenced in subsequent entries ' +
              'were rotated out of service; status=EXPIRED',
          });
          for (const batch of chunkLogEvents(events)) {
            await logsClient.send(new PutLogEventsCommand({
              logGroupName: resourceName,
              logStreamName: streamName,
              logEvents: batch,
            }));
          }
          total += events.length;
        }
        seededCount = total;
      }

      results.push({
        label: seed.label,
        category: seed.category,
        status: 'success',
        resourceName,
        ...(seededCount !== undefined ? { seededCount } : {}),
      });
    } catch (err) {
      results.push({
        label: seed.label,
        category: seed.category,
        status: 'failed',
        resourceName,
        error: (err as Error).message,
      });
    }
  }

  return { manifestFound: true, results };
}
