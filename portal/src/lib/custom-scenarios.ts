/**
 * Private (custom) scenarios: users upload their own Terraform as a zip.
 *
 * Upload flow (POST /api/custom-scenarios): unpack into a temp folder named after the
 * scenario id -> write details.md from the form -> supply the provider lock file if it is
 * missing -> run the checker in --strict mode -> return the resource list + any errors
 * ("check"), or, when clean, move it into <data>/scenarios/custom/<id> and back it up to
 * S3 ("save"). Nothing is saved unless the checker passes.
 *
 * Uploads are untrusted: size and file-count limits, no paths that escape the folder, no
 * symlinks. The --strict checker then blocks anything that runs code on this host.
 *
 * Backup: accounts/_custom-scenarios/<id>.tar.gz in the hub state bucket. Under
 * accounts/ because that is the only prefix the portal's roles may write -- no IAM change.
 * On server start, any backed-up scenario missing locally is restored (new/rebuilt host).
 */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { CUSTOM_DIR, BUNDLED_SCENARIOS_DIR } from './scenarios';
import { tfStateBucket } from './tf-render';

const execFileAsync = promisify(execFile);

const MAX_ZIP_BYTES = 5 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 300;
const BACKUP_PREFIX = 'accounts/_custom-scenarios/';
const VALIDATOR = path.resolve(process.cwd(), '..', 'scripts', 'validate-scenario.py');
const REGION = process.env.AWS_REGION || 'us-west-2';
const backupEnabled = () => process.env.STORAGE_BACKEND !== 'local';
// The portal's own identity (instance role) can write accounts/* -- no hop needed.
const s3 = () => new S3Client({ region: REGION });

export interface CheckResult {
  id: string;
  ok: boolean;
  errors: string[];
  warnings: string[];
  resources: string[];
}

/** "Payroll DB lure" -> "custom-payroll-db-lure". Throws if nothing usable is left. */
export function customIdFromName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  if (slug.length < 2) throw new Error('Name must contain at least 2 letters or digits.');
  return `custom-${slug}`;
}

async function unpack(zip: Buffer, dest: string): Promise<void> {
  if (zip.length > MAX_ZIP_BYTES) throw new Error(`Zip is larger than ${MAX_ZIP_BYTES / 1024 / 1024} MB.`);
  const zipFile = path.join(path.dirname(dest), 'upload.zip');
  await fs.writeFile(zipFile, zip);

  // Inspect before extracting: entry names and total size.
  const { stdout } = await execFileAsync('unzip', ['-Z1', zipFile]).catch(() => {
    throw new Error('Not a valid zip file.');
  });
  const names = stdout.split('\n').filter(Boolean);
  if (names.length > MAX_FILES) throw new Error(`Zip has more than ${MAX_FILES} entries.`);
  for (const n of names) {
    if (n.startsWith('/') || n.split('/').includes('..')) throw new Error(`Unsafe path in zip: ${n}`);
  }
  const sizes = (await execFileAsync('unzip', ['-Zt', zipFile])).stdout;
  const total = Number(/(\d+) bytes uncompressed/.exec(sizes)?.[1] ?? 0);
  if (total > MAX_UNPACKED_BYTES) throw new Error(`Zip unpacks to more than ${MAX_UNPACKED_BYTES / 1024 / 1024} MB.`);

  await fs.mkdir(dest, { recursive: true });
  await execFileAsync('unzip', ['-q', zipFile, '-d', dest]);
  await fs.rm(zipFile, { force: true });

  // Symlinks could point anywhere on this host; refuse them outright.
  const { stdout: links } = await execFileAsync('find', [dest, '-type', 'l']);
  if (links.trim()) throw new Error('Zip contains symbolic links, which are not allowed.');

  // A zip of a folder has one top-level directory: use its contents.
  const top = (await fs.readdir(dest)).filter((n) => n !== '__MACOSX' && !n.startsWith('.'));
  if (top.length === 1 && (await fs.stat(path.join(dest, top[0]))).isDirectory()) {
    const inner = path.join(dest, top[0]);
    for (const n of await fs.readdir(inner)) await fs.rename(path.join(inner, n), path.join(dest, n));
    await fs.rm(inner, { recursive: true, force: true });
  }
  await fs.rm(path.join(dest, '__MACOSX'), { recursive: true, force: true });
  // Never keep a provider cache or real state from someone's laptop.
  await execFileAsync('find', [dest, '-name', '.terraform', '-prune', '-exec', 'rm', '-rf', '{}', '+']);
  await execFileAsync('find', [dest, '-name', '*.tfstate', '-not', '-path', '*/fake-data/*', '-delete']);
}

async function runChecker(dir: string): Promise<Omit<CheckResult, 'id'>> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('python3', [VALIDATOR, '--strict', '--json', dir]));
  } catch (e) {
    stdout = (e as { stdout?: string }).stdout ?? '';
    if (!stdout) throw new Error(`scenario checker could not run: ${(e as Error).message}`);
  }
  const r = JSON.parse(stdout).results[0];
  return { ok: r.errors.length === 0, errors: r.errors, warnings: r.warnings, resources: r.resources };
}

/**
 * Unpack + check. Returns the temp folder (caller saves or discards it) and the result.
 * details.md is always written from the form so every custom scenario shows the same way.
 */
export async function prepareUpload(opts: { name: string; description: string; zip: Buffer }) {
  const id = customIdFromName(opts.name);
  const description = opts.description.trim();
  if (!description) throw new Error('Description is required.');
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'mirage-upload-'));
  const dir = path.join(work, id);
  try {
    await unpack(opts.zip, dir);
    await fs.writeFile(path.join(dir, 'details.md'), `# ${opts.name.trim()}\n\nDescription: ${description}\n`);
    // The lock file pins the AWS provider so deploys reuse the shared plugin cache.
    const lock = path.join(dir, '.terraform.lock.hcl');
    await fs.access(lock).catch(() =>
      fs.copyFile(path.join(BUNDLED_SCENARIOS_DIR, '_template', '.terraform.lock.hcl'), lock));
    // A manifest must name its own scenario; fix the id rather than reject for it.
    const manifest = path.join(dir, 'populate-manifest.json');
    try {
      const m = JSON.parse(await fs.readFile(manifest, 'utf-8'));
      m.scenarioId = id;
      await fs.writeFile(manifest, JSON.stringify(m, null, 2));
    } catch { /* no manifest, or not JSON -- the checker reports the latter */ }

    const check = await runChecker(dir);
    if (check.ok) {
      await fs.appendFile(path.join(dir, 'details.md'),
        `\n**Resources Deployed:**\n${check.resources.map((r) => `- \`${r}\``).join('\n')}\n`);
    }
    return { work, dir, result: { id, ...check } as CheckResult };
  } catch (e) {
    await fs.rm(work, { recursive: true, force: true });
    throw e;
  }
}

export async function customExists(id: string): Promise<boolean> {
  return fs.access(path.join(CUSTOM_DIR, id)).then(() => true, () => false);
}

/** Move a checked upload into place (replacing an existing one only if asked), then back it up. */
export async function saveUpload(prepared: { work: string; dir: string; result: CheckResult }, replace: boolean) {
  const { id } = prepared.result;
  const target = path.join(CUSTOM_DIR, id);
  try {
    if (!prepared.result.ok) throw new Error('Scenario failed the checks; nothing was saved.');
    if ((await customExists(id)) && !replace) throw new Error(`${id} already exists.`);
    await fs.mkdir(CUSTOM_DIR, { recursive: true });
    const old = `${target}.old-${Date.now()}`;
    if (await customExists(id)) await fs.rename(target, old);
    await fs.rename(prepared.dir, target).catch(async () => {
      // Different filesystem (temp dir on another volume): copy instead of rename.
      await fs.cp(prepared.dir, target, { recursive: true });
    });
    await fs.rm(old, { recursive: true, force: true });
  } finally {
    await fs.rm(prepared.work, { recursive: true, force: true });
  }
  return backupCustom(id);
}

/** Returns a warning string when the backup did not happen, so the caller can show it. */
export async function backupCustom(id: string): Promise<string | null> {
  if (!backupEnabled()) return 'Not backed up to S3 (portal runs in local mode).';
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mirage-cbak-'));
  try {
    const file = path.join(tmp, `${id}.tar.gz`);
    await execFileAsync('tar', ['-czf', file, '-C', path.join(CUSTOM_DIR, id), '.']);
    await s3().send(new PutObjectCommand({
      Bucket: tfStateBucket(), Key: `${BACKUP_PREFIX}${id}.tar.gz`, Body: await fs.readFile(file),
    }));
    return null;
  } catch (e) {
    return `Saved on this server, but the S3 backup failed: ${(e as Error).message}`;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

/** Deployed anywhere = some scenario state for this id still holds resources. */
export async function deployedIn(id: string): Promise<string[]> {
  if (!backupEnabled()) return [];
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await s3().send(new ListObjectsV2Command({ Bucket: tfStateBucket(), Prefix: 'accounts/', ContinuationToken: token }));
    for (const o of page.Contents ?? []) {
      if (o.Key && o.Key.endsWith(`/${id}/terraform.tfstate`)) keys.push(o.Key);
    }
    token = page.NextContinuationToken;
  } while (token);
  const live: string[] = [];
  for (const key of keys) {
    const res = await s3().send(new GetObjectCommand({ Bucket: tfStateBucket(), Key: key }));
    const state = JSON.parse(await res.Body!.transformToString());
    if ((state.resources ?? []).some((r: { mode?: string }) => r.mode === 'managed')) live.push(key.split('/')[1]);
  }
  return live;
}

export async function deleteCustom(id: string): Promise<void> {
  const accounts = await deployedIn(id);
  if (accounts.length) {
    throw new Error(`${id} is still deployed in ${accounts.join(', ')}. Tear it down first.`);
  }
  await fs.rm(path.join(CUSTOM_DIR, id), { recursive: true, force: true });
  if (backupEnabled()) {
    await s3().send(new DeleteObjectCommand({ Bucket: tfStateBucket(), Key: `${BACKUP_PREFIX}${id}.tar.gz` }));
  }
}

/** On server start: bring back any backed-up custom scenario missing on this host. */
export async function restoreMissingCustomScenarios(): Promise<string[]> {
  if (!backupEnabled()) return [];
  const restored: string[] = [];
  const page = await s3().send(new ListObjectsV2Command({ Bucket: tfStateBucket(), Prefix: BACKUP_PREFIX }));
  for (const o of page.Contents ?? []) {
    const id = path.basename(o.Key ?? '', '.tar.gz');
    if (!/^custom-[a-z0-9-]+$/.test(id) || (await customExists(id))) continue;
    const res = await s3().send(new GetObjectCommand({ Bucket: tfStateBucket(), Key: o.Key! }));
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mirage-crest-'));
    try {
      const file = path.join(tmp, 'b.tar.gz');
      await fs.writeFile(file, await res.Body!.transformToByteArray());
      await fs.mkdir(path.join(CUSTOM_DIR, id), { recursive: true });
      await execFileAsync('tar', ['-xzf', file, '-C', path.join(CUSTOM_DIR, id)]);
      restored.push(id);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }
  return restored;
}
