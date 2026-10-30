/**
 * Terraform file generation for scenario deploys (shared by deploy-spoke and
 * remove-spoke). Splits the two credential contexts:
 *   - backend "s3": the HUB tfstate bucket (same-account write via hub-service creds)
 *   - provider "aws": assume_role into the SPOKE account, in the chosen region
 * Scenario templates are inconsistent (some hardcode a provider/region), so we
 * strip any existing provider "aws" block and generate an authoritative one.
 */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { hubAccountId, resourcePrefix } from './aws-auth';

const HUB_REGION = process.env.AWS_REGION || 'us-west-2';

// A function, not a top-level const: hubAccountId() throws if
// MIRAGE_HUB_ACCOUNT_ID is unset (no fallback account id here -- a wrong
// default would silently point deploys at the wrong account's bucket), and a
// top-level const would run that throw at MODULE LOAD time. Next.js imports
// every route module to collect page data at build time, with no .env.local
// present yet, so that crashed the build itself rather than just a request.
// A function defers the check to when a deploy/teardown actually runs.
export function tfStateBucket(): string {
  return (
    process.env.MIRAGE_TFSTATE_BUCKET ||
    `${resourcePrefix()}-tfstate-${hubAccountId()}-${HUB_REGION}`
  );
}

/**
 * Both deploy-spoke and remove-spoke interpolate accountId/scenarioId into a shell
 * command (`terraform apply -var="account_id=${accountId}"`) and into a filesystem
 * path (`states/<accountId>/<scenarioId>`). Validate BOTH before either happens --
 * an unvalidated accountId can break out of the quoted -var argument (shell
 * injection) or traverse out of statesDir (path traversal). region already gets
 * this treatment inline in deploy-spoke; these give accountId/scenarioId the same.
 */
const ACCOUNT_ID_RE = /^\d{12}$/;
export function assertValidAccountId(accountId: unknown): string {
  if (typeof accountId !== 'string' || !ACCOUNT_ID_RE.test(accountId)) {
    throw new Error(`Invalid AWS account id ${JSON.stringify(accountId)} (must be exactly 12 digits).`);
  }
  return accountId;
}

// Official scenarios are scenario-N; private ones are custom-<name> (lib/scenarios.ts).
const SCENARIO_ID_RE = /^(scenario-\d+|custom-[a-z0-9][a-z0-9-]{0,47})$/;
export function assertValidScenarioId(scenarioId: unknown): string {
  if (typeof scenarioId !== 'string' || !SCENARIO_ID_RE.test(scenarioId)) {
    throw new Error(`Invalid scenario id ${JSON.stringify(scenarioId)} (must look like "scenario-N" or "custom-<name>").`);
  }
  return scenarioId;
}

/**
 * Shared provider plugin cache: ONE copy of each provider on disk, and every
 * scenario working dir gets a SYMLINK into it
 * (`.terraform/providers/registry.terraform.io/hashicorp/aws/6.66.0/<platform>`
 * -> cache) instead of its own 768 MB copy. Measured: a working dir drops from
 * 768 MB to 8 KB.
 *
 * Two things make the cache actually hit, and both are easy to break:
 *
 *  1. The copied `.terraform.lock.hcl` is the ONLY provider version pin --
 *     no scenario declares `required_providers` (verified across all 19), so
 *     without the lock the `>= 5.0` constraint that normalizeScenarioDir
 *     writes resolves to whatever is newest, misses the cache, and silently
 *     drifts the provider version. So it must keep being copied; see
 *     excludeProviderCache.
 *  2. The lock needs an `h1:` hash for the RUNNING platform. Terraform will
 *     not trust a cached package it cannot verify against the lock -- it
 *     quietly re-downloads instead of failing, so a missing hash shows up as
 *     "slow and fills the disk", not as an error. The scenario locks carry
 *     both linux_amd64 and darwin_arm64; regenerate with
 *     `terraform providers lock -platform=linux_amd64 -platform=darwin_arm64`
 *     after any provider version bump.
 *
 * Concurrency: HashiCorp documents the cache as not concurrency-safe, which
 * applies to concurrent *writes* (two inits populating the same provider).
 * Pre-warm it once (scripts/warm-tf-cache.sh) and every deploy-time init is
 * read-only; 6 parallel inits against a warm cache were verified clean, with
 * no lock rewrite. Cold + concurrent is the case to avoid.
 *
 * Terraform does not create this directory and silently ignores the setting
 * when it is missing, so terraformEnv() creates it.
 */
export const TF_PLUGIN_CACHE_DIR =
  process.env.TF_PLUGIN_CACHE_DIR ||
  process.env.MIRAGE_TF_PLUGIN_CACHE_DIR ||
  path.join(os.homedir(), '.terraform.d', 'plugin-cache');

let cacheEnsured = false;

/**
 * Env additions for every `terraform` child process. Spread this into the
 * `env:` of the exec call -- the portal runs under systemd and will not read a
 * shell profile, so exporting the variable anywhere else has no effect.
 * Degrades to {} (per-deploy download, same as before) rather than failing the
 * deploy if the cache dir cannot be created.
 */
export async function terraformEnv(): Promise<Record<string, string>> {
  if (!cacheEnsured) {
    try {
      await fs.mkdir(TF_PLUGIN_CACHE_DIR, { recursive: true });
      cacheEnsured = true;
    } catch (e) {
      console.warn(
        `[tf] plugin cache unusable at ${TF_PLUGIN_CACHE_DIR}; terraform will download providers per deploy:`,
        e
      );
      return {};
    }
  }
  // Custom uploads may use a provider their lock file does not pin for this
  // platform; without this Terraform skips the cache and downloads a full copy
  // into every working dir. The cached package was checksum-verified when it
  // was first downloaded from the registry.
  return { TF_PLUGIN_CACHE_DIR, TF_PLUGIN_CACHE_MAY_BREAK_DEPENDENCY_LOCK_FILE: 'true' };
}

/**
 * `fs.cp` filter: never copy a provider cache into a working dir. A 768 MB
 * `.terraform/` appears in a scenario template dir the moment anyone runs
 * `terraform init` there by hand, and both deploy and teardown would then
 * duplicate it per scenario per account. Returning false for the directory
 * stops the recursion.
 *
 * `.terraform.lock.hcl` is deliberately NOT excluded -- it is the version pin
 * (see TF_PLUGIN_CACHE_DIR). It is a small text file.
 */
export function excludeProviderCache(src: string): boolean {
  return path.basename(src) !== '.terraform';
}

/** tfstate S3 key, region-scoped (same scenario can deploy to N regions/account). */
export function tfstateKey(accountId: string, region: string, scenarioId: string): string {
  return `accounts/${accountId}/${region}/${scenarioId}/terraform.tfstate`;
}

/** Remove any top-level `provider "aws" { ... }` block (brace-counted). */
export function stripAwsProvider(src: string): string {
  const lines = src.split(/(?<=\n)/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*provider\s+"aws"\s*\{/.test(lines[i])) {
      let depth = 0;
      while (i < lines.length) {
        depth += (lines[i].match(/\{/g) || []).length - (lines[i].match(/\}/g) || []).length;
        i++;
        if (depth <= 0) break;
      }
      i--; // outer loop will ++
      continue;
    }
    out.push(lines[i]);
  }
  return out.join('');
}

/**
 * Normalize a copied scenario working dir for a multi-region, S3-backed deploy:
 *  1) strip any hardcoded provider "aws" from main.tf
 *  2) write mirage_provider.tf (required_providers + assume_role spoke, region)
 *  3) write backend.tf.json (hub S3 bucket, region-scoped key, native lock)
 */
export async function normalizeScenarioDir(opts: {
  stateDir: string;
  accountId: string;
  region: string;
  scenarioId: string;
  spokeRoleArn: string;
  externalId?: string;
}): Promise<{ tfstateKey: string }> {
  const { stateDir, accountId, region, scenarioId, spokeRoleArn, externalId } = opts;

  const mainTfPath = path.join(stateDir, 'main.tf');
  try {
    const mainSrc = await fs.readFile(mainTfPath, 'utf-8');
    await fs.writeFile(mainTfPath, stripAwsProvider(mainSrc));
  } catch {
    /* main.tf may be named differently; the provider file still applies */
  }

  await fs.writeFile(
    path.join(stateDir, 'mirage_provider.tf'),
    `terraform {\n  required_providers {\n    aws = {\n      source  = "hashicorp/aws"\n      version = ">= 5.0"\n    }\n  }\n}\n\n` +
      `provider "aws" {\n  region = "${region}"\n  assume_role {\n    role_arn    = "${spokeRoleArn}"\n` +
      (externalId ? `    external_id = "${externalId}"\n` : '') +
      `  }\n}\n`
  );

  const key = tfstateKey(accountId, region, scenarioId);
  await fs.writeFile(
    path.join(stateDir, 'backend.tf.json'),
    JSON.stringify(
      {
        terraform: {
          backend: {
            s3: {
              bucket: tfStateBucket(),
              key,
              region: HUB_REGION,
              encrypt: true,
              use_lockfile: true,
            },
          },
        },
      },
      null,
      2
    )
  );

  return { tfstateKey: key };
}
