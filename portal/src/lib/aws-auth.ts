import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';

/**
 * Cross-account auth for the Mirage portal.
 *
 * The portal's ambient identity (the EC2 instance role, or an operator's SSO
 * session in the SSO-fallback mode) cannot assume the spoke/brain roles
 * directly -- those roles trust ONLY the hub service role. So every privileged
 * action chains two hops:
 *
 *   ambient -> <prefix>-hub-service-role -> { spoke-deploy (+ExternalId) | brain-deploy }
 *
 * This module is the single place that (a) performs that chain and (b) builds
 * the <prefix>-* role ARNs, so route code never hardcodes role names again
 * (the old UI bug auto-filled "mirage-spoke-deployment-role").
 *
 * Every hub-infra resource (roles, bus, tables, ...) shares one renameable
 * prefix (default "mirage-ops") instead of a literal brand string, so a
 * deployer can blend this in under any name before standing it up. The
 * prefix itself comes back as a CloudFormation Output of the hub bootstrap
 * stack (hub/hub-bootstrap.yaml) and is synced into .env.local by
 * scripts/sync-env-from-stack.sh -- it is not meant to be hand-typed.
 */

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `${name} is not set. This deploys/destroys cross-account AWS infrastructure, so a ` +
        'missing value fails loudly here instead of silently assuming a default account or ' +
        `role. Run scripts/sync-env-from-stack.sh after deploying hub/hub-bootstrap.yaml, or ` +
        `set ${name} in portal/.env.local yourself.`,
    );
  }
  return v;
}

const RESOURCE_PREFIX = process.env.MIRAGE_RESOURCE_PREFIX || 'mirage-ops';
const HUB_SERVICE_ROLE_NAME = `${RESOURCE_PREFIX}-hub-service-role`;
const SPOKE_DEPLOY_ROLE_NAME = `${RESOURCE_PREFIX}-spoke-deployment-role`;
const BRAIN_DEPLOY_ROLE_NAME = `${RESOURCE_PREFIX}-brain-deployment-role`;
const FORWARDING_ROLE_NAME = `${RESOURCE_PREFIX}-forwarding-role`;

/**
 * The hub account every hub-side deployment lands in. Exposed so the UI can show
 * the real target instead of asking for one it cannot honour: brainDeploy() below
 * takes no account argument. Required -- there is no safe default account ID.
 */
export const hubAccountId = () => requireEnv('MIRAGE_HUB_ACCOUNT_ID');

/** The renameable hub-infra prefix (default "mirage-ops"), for building CFN stack/resource names. */
export const resourcePrefix = () => RESOURCE_PREFIX;

/** Canonical <prefix>-* role ARNs, derived from account IDs (no name drift). */
export const roleArns = {
  hubService: () =>
    process.env.MIRAGE_HUB_SERVICE_ROLE_ARN ||
    `arn:aws:iam::${hubAccountId()}:role/${HUB_SERVICE_ROLE_NAME}`,
  brainDeploy: () => `arn:aws:iam::${hubAccountId()}:role/${BRAIN_DEPLOY_ROLE_NAME}`,
  spokeDeploy: (accountId: string) =>
    `arn:aws:iam::${accountId}:role/${SPOKE_DEPLOY_ROLE_NAME}`,
  forwarding: (accountId: string) =>
    `arn:aws:iam::${accountId}:role/${FORWARDING_ROLE_NAME}`,
};

/** SDK-style temporary credentials (for `new XClient({ credentials })`). */
export interface SdkCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** AWS_* env-style credentials (for passing to a spawned terraform process). */
export interface EnvCredentials {
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_SESSION_TOKEN?: string;
}

function toSdk(creds: {
  AccessKeyId?: string;
  SecretAccessKey?: string;
  SessionToken?: string;
}): SdkCredentials {
  return {
    accessKeyId: creds.AccessKeyId!,
    secretAccessKey: creds.SecretAccessKey!,
    sessionToken: creds.SessionToken,
  };
}

export function toEnv(creds: SdkCredentials): EnvCredentials {
  return {
    AWS_ACCESS_KEY_ID: creds.accessKeyId,
    AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
    AWS_SESSION_TOKEN: creds.sessionToken,
  };
}

/** Hop 1: ambient creds -> hub service role. Exported so callers that run
 *  Terraform can use hub-service creds for the (same-account) S3 backend while a
 *  provider assume_role block hops hub-service -> spoke for resource creation. */
export async function assumeHubServiceRole(region: string): Promise<SdkCredentials> {
  const sts = new STSClient({ region });
  const res = await sts.send(
    new AssumeRoleCommand({
      RoleArn: roleArns.hubService(),
      RoleSessionName: 'MirageHubService',
    })
  );
  if (!res.Credentials) {
    throw new Error('Failed to assume hub service role (no credentials returned).');
  }
  return toSdk(res.Credentials);
}

/**
 * The ExternalId every spoke-deployment-role assume must present. Throws rather than
 * returning empty: the spoke trust policy requires sts:ExternalId, so a missing value
 * cannot produce a working deploy -- it only turns a config error into an opaque 403
 * from STS several minutes later, which reads as an IAM problem instead of a missing
 * variable. Fail here, where the message can name what to set.
 */
export function spokeExternalId(): string {
  const id = process.env.MIRAGE_SPOKE_EXTERNAL_ID;
  if (!id) {
    throw new Error(
      'MIRAGE_SPOKE_EXTERNAL_ID is not set. Spoke deployment roles require sts:ExternalId, ' +
        'so no spoke operation can succeed without it. Set it in the portal env file ' +
        '(.env.local) and restart the service. Note it was renamed from CSC_OPS_EXTERNAL_ID ' +
        '(and before that MIRAGE_EXTERNAL_ID), so an older env file may still use an old name.',
    );
  }
  return id;
}

/**
 * Full chain: ambient -> hub-service-role -> targetRoleArn.
 * Pass `externalId` when the target is a spoke deployment role (its trust
 * policy requires sts:ExternalId). Returns the final temporary credentials.
 */
export async function assumeChain(opts: {
  targetRoleArn: string;
  externalId?: string;
  region?: string;
  sessionName?: string;
}): Promise<SdkCredentials> {
  const region = opts.region || process.env.AWS_REGION || 'us-west-2';

  // Hop 1
  const hubCreds = await assumeHubServiceRole(region);

  // Hop 2, using the hub-service-role credentials.
  const sts = new STSClient({ region, credentials: hubCreds });
  const res = await sts.send(
    new AssumeRoleCommand({
      RoleArn: opts.targetRoleArn,
      RoleSessionName: opts.sessionName || 'MirageChain',
      ExternalId: opts.externalId,
    })
  );
  if (!res.Credentials) {
    throw new Error(`Failed to assume target role ${opts.targetRoleArn} (no credentials).`);
  }
  return toSdk(res.Credentials);
}
