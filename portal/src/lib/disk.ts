/**
 * Keeps Terraform from filling the portal host's disk -- the failure that once broke
 * teardowns with "no space left on device".
 *
 *  - assertDiskSpace(): deploy/teardown refuse to start below a free-space floor, with a
 *    clear job error, instead of dying halfway through a terraform run.
 *  - cleanWorkingDirs(): every 6 h, removes states/<acct>/<scenario> working dirs untouched
 *    for 7 days (disposable: teardown restores the exact files from S3), and deletes any
 *    REAL provider copy inside one -- with the shared plugin cache a working dir only holds
 *    a symlink, so a real copy means the cache was missed (~768 MB each).
 */
import fs from 'fs/promises';
import path from 'path';
import { listJobs } from './jobs';

const GB = 1024 ** 3;
const STATES_DIR = path.join(process.cwd(), 'states');
const STALE_MS = 7 * 24 * 60 * 60 * 1000;
const CLEAN_EVERY_MS = 6 * 60 * 60 * 1000;

export const minFreeGb = () => Number(process.env.MIRAGE_MIN_FREE_DISK_GB || 2);

export async function freeBytes(dir = process.cwd()): Promise<number> {
  const s = await fs.statfs(dir);
  return s.bavail * s.bsize;
}

export async function assertDiskSpace(action: string, minGb = minFreeGb()): Promise<void> {
  const free = await freeBytes();
  if (free < minGb * GB) {
    throw new Error(
      `Not enough free disk to ${action}: ${(free / GB).toFixed(1)} GB free, ${minGb} GB needed. ` +
      `Free space on the portal host (old Terraform working dirs live in portal/states/), then retry.`,
    );
  }
}

/** Provider dirs under .terraform/providers that are real directories, not cache symlinks. */
async function realProviderCopies(workDir: string): Promise<string[]> {
  const root = path.join(workDir, '.terraform', 'providers');
  const found: string[] = [];
  const walk = async (dir: string, depth: number) => {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      // registry/namespace/name/version/<platform> -- the platform dir holds the binary.
      if (depth === 4 && e.isDirectory()) found.push(p);
      else if (e.isDirectory()) await walk(p, depth + 1);
    }
  };
  await walk(root, 0);
  return found;
}

export async function cleanWorkingDirs(): Promise<{ removed: string[]; providerCopies: string[] }> {
  const removed: string[] = [];
  const providerCopies: string[] = [];
  // Never race a running deploy/teardown over its working dir.
  if ((await listJobs()).some((j) => j.status === 'queued' || j.status === 'running')) {
    return { removed, providerCopies };
  }
  let accounts: string[] = [];
  try { accounts = await fs.readdir(STATES_DIR); } catch { return { removed, providerCopies }; }
  for (const acct of accounts) {
    let scenarios: string[] = [];
    try { scenarios = await fs.readdir(path.join(STATES_DIR, acct)); } catch { continue; }
    for (const sid of scenarios) {
      const dir = path.join(STATES_DIR, acct, sid);
      const stat = await fs.stat(dir).catch(() => null);
      if (!stat?.isDirectory()) continue;
      if (Date.now() - stat.mtimeMs > STALE_MS) {
        await fs.rm(dir, { recursive: true, force: true });
        removed.push(`${acct}/${sid}`);
        continue;
      }
      const copies = await realProviderCopies(dir);
      if (copies.length) {
        await fs.rm(path.join(dir, '.terraform'), { recursive: true, force: true });
        providerCopies.push(`${acct}/${sid}`);
      }
    }
  }
  return { removed, providerCopies };
}

export function startDiskHygiene(): void {
  const g = globalThis as { __mirageDiskHygiene?: boolean };
  if (g.__mirageDiskHygiene) return;
  g.__mirageDiskHygiene = true;
  const tick = async () => {
    try {
      const { removed, providerCopies } = await cleanWorkingDirs();
      if (removed.length) console.log(`[disk] removed stale working dirs: ${removed.join(', ')}`);
      if (providerCopies.length) {
        console.warn(`[disk] removed full provider copies (plugin cache was missed) in: ${providerCopies.join(', ')}`);
      }
    } catch (e) {
      console.error('[disk] working-dir cleanup failed:', e);
    }
  };
  setTimeout(tick, 2 * 60 * 1000).unref();
  setInterval(tick, CLEAN_EVERY_MS).unref();
}
