/**
 * GitHub sync for official scenarios. Runs from the Catalog's "Sync now" button and
 * automatically every 24 hours (src/instrumentation.ts) -- both as a normal job, so
 * every run shows on the Queue page and in the bell, and two can never overlap.
 *
 * One run:
 *   1. shallow-clone MIRAGE_SCENARIOS_REPO_URL @ MIRAGE_SCENARIOS_REPO_REF
 *   2. check every scenario with scripts/validate-scenario.py
 *   3. build a NEW release folder: passing scenarios from upstream; for a failing
 *      one, the previous working version is kept (a broken push never replaces a
 *      working scenario, and a broken NEW scenario is simply not added)
 *   4. switch `current` to it in one atomic rename, keep the last 3 releases
 *   5. write sync-status.json (shown in the Catalog)
 * Never runs Terraform, so it cannot touch the provider cache or fill the disk.
 */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { OFFICIAL_CURRENT, officialRoot } from './scenarios';
import { excludeProviderCache } from './tf-render';
import type { Report } from './job-runner';

const execFileAsync = promisify(execFile);

export const REPO_URL =
  process.env.MIRAGE_SCENARIOS_REPO_URL || 'https://github.com/MirageDeception/Mirage_Cloud_Deception.git';
export const REPO_REF = process.env.MIRAGE_SCENARIOS_REPO_REF || 'main';
const OFFICIAL_DIR = path.dirname(OFFICIAL_CURRENT);
const RELEASES_DIR = path.join(OFFICIAL_DIR, 'releases');
const STATUS_FILE = path.join(OFFICIAL_DIR, 'sync-status.json');
const VALIDATOR = path.resolve(process.cwd(), '..', 'scripts', 'validate-scenario.py');
const KEEP_RELEASES = 3;
export const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface SyncStatus {
  repoUrl: string;
  ref: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  result: 'ok' | 'partial' | 'failed' | null;
  commit: string | null;
  release: string | null;
  added: string[];
  changed: string[];
  removed: string[];
  /** Upstream scenarios that failed the checker; the previous version (if any) was kept. */
  rejected: { id: string; errors: string[]; keptPrevious: boolean }[];
  error: string | null;
}

const EMPTY: SyncStatus = {
  repoUrl: REPO_URL, ref: REPO_REF, lastAttemptAt: null, lastSuccessAt: null, result: null,
  commit: null, release: null, added: [], changed: [], removed: [], rejected: [], error: null,
};

export async function readSyncStatus(): Promise<SyncStatus> {
  try {
    return { ...EMPTY, ...JSON.parse(await fs.readFile(STATUS_FILE, 'utf-8')) };
  } catch {
    return { ...EMPTY };
  }
}

async function writeSyncStatus(s: SyncStatus): Promise<void> {
  await fs.mkdir(OFFICIAL_DIR, { recursive: true });
  const tmp = `${STATUS_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(s, null, 2));
  await fs.rename(tmp, STATUS_FILE);
}

/** Content hash of a scenario folder, to tell "changed" from "unchanged". */
async function dirHash(dir: string): Promise<string> {
  const h = crypto.createHash('sha256');
  const walk = async (rel: string) => {
    const entries = (await fs.readdir(path.join(dir, rel), { withFileTypes: true }))
      .filter((e) => e.name !== '.terraform')
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const p = path.join(rel, e.name);
      if (e.isDirectory()) await walk(p);
      else { h.update(p); h.update(await fs.readFile(path.join(dir, p))); }
    }
  };
  await walk('');
  return h.digest('hex');
}

async function scenarioIds(root: string): Promise<string[]> {
  try {
    return (await fs.readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && /^scenario-\d+$/.test(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

async function validate(dirs: string[]): Promise<Map<string, string[]>> {
  if (dirs.length === 0) return new Map();
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('python3', [VALIDATOR, '--json', ...dirs], { maxBuffer: 20 * 1024 * 1024 }));
  } catch (e) {
    // Exit 1 just means some scenario failed; the JSON is still on stdout.
    stdout = (e as { stdout?: string }).stdout ?? '';
    if (!stdout) throw new Error(`scenario checker could not run: ${(e as Error).message}`);
  }
  const out = JSON.parse(stdout) as { results: { id: string; errors: string[] }[] };
  return new Map(out.results.map((r) => [r.id, r.errors]));
}

export async function syncOfficialScenarios(report: Report): Promise<SyncStatus> {
  const status = await readSyncStatus();
  status.repoUrl = REPO_URL;
  status.ref = REPO_REF;
  status.lastAttemptAt = new Date().toISOString();
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'mirage-sync-'));
  try {
    await report(`Fetching ${REPO_URL} (${REPO_REF})`, { phase: 'fetching' });
    const clone = path.join(work, 'repo');
    await execFileAsync('git', ['clone', '-q', '--depth', '1', '--branch', REPO_REF, REPO_URL, clone], {
      timeout: 120_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    const commit = (await execFileAsync('git', ['-C', clone, 'rev-parse', 'HEAD'])).stdout.trim();

    const current = await fs.realpath(OFFICIAL_CURRENT).catch(() => null);
    if (current && commit === status.commit) {
      await report(`Already up to date (${commit.slice(0, 7)})`, { phase: 'done' });
      Object.assign(status, { lastSuccessAt: status.lastAttemptAt, error: null });
      await writeSyncStatus(status);
      return status;
    }

    const upstreamRoot = path.join(clone, 'scenarios');
    const previousRoot = await officialRoot(); // last release, or the bundled scenarios
    const upstream = await scenarioIds(upstreamRoot);
    if (upstream.length === 0) throw new Error(`no scenario-N folders under scenarios/ in ${REPO_URL}@${REPO_REF}`);

    await report(`Checking ${upstream.length} scenarios`, { phase: 'checking' });
    const errors = await validate(upstream.map((id) => path.join(upstreamRoot, id)));

    const release = `${commit.slice(0, 12)}-${Date.now()}`;
    const releaseDir = path.join(RELEASES_DIR, release);
    await fs.mkdir(releaseDir, { recursive: true });
    const previous = new Set(await scenarioIds(previousRoot));
    const added: string[] = [], changed: string[] = [], rejected: SyncStatus['rejected'] = [];

    for (const id of upstream) {
      const errs = errors.get(id) ?? ['missing from checker output'];
      const keptPrevious = errs.length > 0 && previous.has(id);
      if (errs.length > 0) {
        rejected.push({ id, errors: errs, keptPrevious });
        await report(`Rejected ${id}: ${errs[0]}${keptPrevious ? ' (kept previous version)' : ''}`);
        if (!keptPrevious) continue;
      }
      const src = errs.length > 0 ? path.join(previousRoot, id) : path.join(upstreamRoot, id);
      await fs.cp(src, path.join(releaseDir, id), { recursive: true, filter: excludeProviderCache });
      if (!previous.has(id)) added.push(id);
      else if (errs.length === 0 && (await dirHash(src)) !== (await dirHash(path.join(previousRoot, id)))) changed.push(id);
    }
    const removed = [...previous].filter((id) => !upstream.includes(id));

    // Atomic switch: a deploy resolving `current` sees the old release or the new one, never a mix.
    const nextLink = path.join(OFFICIAL_DIR, 'current.next');
    await fs.rm(nextLink, { force: true });
    await fs.symlink(path.join('releases', release), nextLink);
    await fs.rename(nextLink, OFFICIAL_CURRENT);

    // Keep the newest few releases for rollback; never the active one.
    const releases = (await fs.readdir(RELEASES_DIR)).sort(
      (a, b) => Number(b.split('-').pop()) - Number(a.split('-').pop()),
    );
    for (const old of releases.slice(KEEP_RELEASES)) {
      if (old !== release) await fs.rm(path.join(RELEASES_DIR, old), { recursive: true, force: true });
    }

    Object.assign(status, {
      lastSuccessAt: status.lastAttemptAt, result: rejected.length ? 'partial' : 'ok', commit, release,
      added, changed, removed, rejected, error: null,
    });
    await writeSyncStatus(status);
    await report(
      `Synced ${commit.slice(0, 7)}: ${added.length} added, ${changed.length} changed, ${removed.length} removed` +
        (rejected.length ? `, ${rejected.length} rejected` : ''),
      { phase: 'done' },
    );
    return status;
  } catch (e) {
    Object.assign(status, { result: 'failed', error: e instanceof Error ? e.message : String(e) });
    await writeSyncStatus(status);
    throw e;
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}
