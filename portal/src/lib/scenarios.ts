/**
 * Where scenario files come from, and the saved copy each deploy keeps.
 *
 * Two sources, both outside the code checkout so a code update never touches them:
 *   official -- <data>/scenarios/official/current, a symlink to the release GitHub
 *               sync last activated. Until the first sync it falls back to the
 *               scenarios/ folder bundled with the code (MIRAGE_SCENARIOS_DIR).
 *   custom   -- <data>/scenarios/custom/custom-<name>, private to this install.
 *
 * Saved copy: every deploy uploads the exact scenario files it applied next to the
 * scenario's Terraform state, and teardown restores from that copy. Teardown used
 * to re-copy the CURRENT template, so a scenario changed or removed upstream after
 * it was deployed could become impossible to destroy.
 */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import type { SdkCredentials } from './aws-auth';

const execFileAsync = promisify(execFile);

// Not deployable yet: scenario 5 (EC2 bastion) and 6 (Lambda + Secrets bundle) need
// spoke-role permissions deliberately left out to keep the role minimal. Re-enable here,
// and in the spoke deployment-role IAM, when they are ready.
export const COMING_SOON = new Set<string>(['scenario-5', 'scenario-6']);

export const DATA_DIR = process.env.MIRAGE_DATA_DIR || path.resolve(process.cwd(), '..', 'data');
export const BUNDLED_SCENARIOS_DIR =
  process.env.MIRAGE_SCENARIOS_DIR || path.resolve(process.cwd(), '..', 'scenarios');
export const OFFICIAL_CURRENT = path.join(DATA_DIR, 'scenarios', 'official', 'current');
export const CUSTOM_DIR = path.join(DATA_DIR, 'scenarios', 'custom');

export type ScenarioSource = 'official' | 'custom';

export const isCustomId = (id: string) => id.startsWith('custom-');

/**
 * The official root, resolved ONCE per call: callers that copy a scenario get one
 * consistent release even if a sync swaps `current` while they work.
 */
export async function officialRoot(): Promise<string> {
  try {
    return await fs.realpath(OFFICIAL_CURRENT);
  } catch {
    return BUNDLED_SCENARIOS_DIR;
  }
}

/** Absolute path to a scenario's files in whichever source it belongs to. */
export async function scenarioDir(scenarioId: string): Promise<string> {
  return isCustomId(scenarioId)
    ? path.join(CUSTOM_DIR, scenarioId)
    : path.join(await officialRoot(), scenarioId);
}

/** Scenario folders in both sources (official first). Missing sources are just empty. */
export async function listScenarioDirs(): Promise<{ id: string; dir: string; source: ScenarioSource }[]> {
  const read = async (root: string, re: RegExp, source: ScenarioSource) => {
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory() && re.test(e.name))
        .map((e) => ({ id: e.name, dir: path.join(root, e.name), source }));
    } catch {
      return [];
    }
  };
  const official = (await read(await officialRoot(), /^scenario-\d+$/, 'official')).sort(
    (a, b) => Number(a.id.split('-')[1]) - Number(b.id.split('-')[1]),
  );
  const custom = (await read(CUSTOM_DIR, /^custom-[a-z0-9-]+$/, 'custom')).sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  return [...official, ...custom];
}

// ── Saved copy of what was deployed ─────────────────────────────────────────

/** Sits next to the scenario's state: accounts/<acct>/<region>/<id>/scenario-source.tar.gz */
export const sourceSnapshotKey = (tfstateKey: string) =>
  tfstateKey.replace(/terraform\.tfstate$/, 'scenario-source.tar.gz');

const s3 = (credentials: SdkCredentials) =>
  new S3Client({ region: process.env.AWS_REGION || 'us-west-2', credentials });

/** Tar the scenario folder (never its provider cache) and upload it. Throws on failure. */
export async function saveSourceSnapshot(opts: {
  dir: string; bucket: string; tfstateKey: string; credentials: SdkCredentials;
}): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mirage-snap-'));
  try {
    const file = path.join(tmp, 'src.tar.gz');
    await execFileAsync('tar', ['-czf', file, '--exclude=.terraform', '-C', opts.dir, '.']);
    await s3(opts.credentials).send(new PutObjectCommand({
      Bucket: opts.bucket,
      Key: sourceSnapshotKey(opts.tfstateKey),
      Body: await fs.readFile(file),
    }));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

/** Unpack the saved copy into destDir. Returns false when none was saved (deployed before this existed). */
export async function restoreSourceSnapshot(opts: {
  destDir: string; bucket: string; tfstateKey: string; credentials: SdkCredentials;
}): Promise<boolean> {
  let body: Uint8Array;
  try {
    const res = await s3(opts.credentials).send(new GetObjectCommand({
      Bucket: opts.bucket,
      Key: sourceSnapshotKey(opts.tfstateKey),
    }));
    body = await res.Body!.transformToByteArray();
  } catch (e) {
    if ((e as { name?: string })?.name === 'NoSuchKey') return false;
    throw e;
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mirage-snap-'));
  try {
    const file = path.join(tmp, 'src.tar.gz');
    await fs.writeFile(file, body);
    await fs.mkdir(opts.destDir, { recursive: true });
    await execFileAsync('tar', ['-xzf', file, '-C', opts.destDir]);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
  return true;
}

/** Delete a deployment's state object and its saved copy, once nothing is left in it. */
export async function deleteStateFiles(opts: {
  bucket: string; tfstateKey: string; credentials: SdkCredentials;
}): Promise<void> {
  await s3(opts.credentials).send(new DeleteObjectCommand({ Bucket: opts.bucket, Key: opts.tfstateKey }));
  await deleteSourceSnapshot(opts);
}

export async function deleteSourceSnapshot(opts: {
  bucket: string; tfstateKey: string; credentials: SdkCredentials;
}): Promise<void> {
  await s3(opts.credentials).send(new DeleteObjectCommand({
    Bucket: opts.bucket,
    Key: sourceSnapshotKey(opts.tfstateKey),
  }));
}
