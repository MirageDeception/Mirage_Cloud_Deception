# SCP guide — hub + spoke guardrails

**Apply this after your proof-of-concept is working, not before.** These are AWS Organizations
Service Control Policies -- they need management-account access to an Organization, which most
people trying Mirage for the first time don't have yet and don't need for a single-account trial.
Come back to this once you're ready to roll Mirage out across real accounts.

Two independent SCPs, `scp/hub-baseline-scp.json` and `scp/spoke-decoy-protection-scp.json`. SCPs
can only **Deny** (never Allow), so each statement is a guardrail Deny that carves out the one
principal that's supposed to still be able to do the thing.

## Why these exist

Mirage's portal host carries a **standing credential** (its instance role can assume the hub
service role, which can reach the spoke deploy/brain roles). Two abuse paths must be closed that
account-level IAM alone can't fully close:

1. **Credential theft via the instance.** An admin with `ec2:ModifyInstanceAttribute` could
   rewrite the instance's UserData and reboot it to run code as root and read the instance-role
   credentials from IMDS; or swap the instance profile onto an instance they control; or
   `iam:PassRole` the role elsewhere.
2. **Decoy tampering.** A spoke account's local admin must not be able to create, alter, or
   delete decoy resources -- only the hub-driven spoke-deployment-role should. Otherwise a decoy
   could be tampered with to evade detection, or fabricated to mislead.

## What each one contains

| File | Attach to | Denies | Carve-out |
|---|---|---|---|
| `scp/hub-baseline-scp.json` | **hub** account/OU | `ModifyInstanceAttribute`, `(Associate/Replace/Disassociate)IamInstanceProfile` on `Project`-tagged resources; `iam:PassRole` of the portal instance role | everyone except `<BREAK_GLASS_ADMIN_ARN>` |
| `scp/spoke-decoy-protection-scp.json` | each **spoke** account/OU | management-plane **mutation** of decoy stacks + lure IAM roles + decoy resources (S3/Secrets/SSM/DynamoDB/SQS/SNS/KMS/ECR/Lambda/SAML) | only the spoke-deployment-role's assumed sessions (+ break-glass) |

**Deliberately NOT denied:** the attacker-facing **data plane** (`s3:GetObject`,
`secretsmanager:GetSecretValue`, `ssm:GetParameter`, `dynamodb:GetItem`/`Scan`, etc.). Touching a
decoy *is* the detection signal, so those reads must stay reachable by any principal. Both SCPs
only block **management-plane mutation**.

## Before attaching — replace placeholders

Both files use the same placeholder convention:

- `<HUB_ACCOUNT_ID>` / `<SPOKE_ACCOUNT_ID>` -- the real account IDs.
- `<RESOURCE_PREFIX>` -- must match the `ResourcePrefix` you deployed `hub/hub-bootstrap.yaml`
  with (default `mirage-ops`). If you have multiple spokes, the
  `assumed-role/<prefix>-spoke-deployment-role/*` ARN pattern is per-account; either duplicate the
  statement per spoke OU, or broaden to `arn:aws:sts::*:assumed-role/<prefix>-spoke-deployment-role/*`
  if org-wide matching is acceptable.
- `<BREAK_GLASS_ADMIN_ARN>` -- the one principal allowed to override. **You must supply this** --
  use a full role ARN, not a user. This is the same ARN you'd pass as `BreakGlassAdminArns` to
  `hub/hub-bootstrap.yaml`.

## How to test after attaching

1. **Instance protection (hub):** as a normal admin (not break-glass), run
   `aws ec2 modify-instance-attribute --instance-id <portal id> --no-source-dest-check` → expect
   `AccessDenied`. As break-glass → succeeds.
2. **PassRole (hub):** as a normal admin, attempt to launch an instance passing the portal
   instance role → `AccessDenied`.
3. **Decoy mutation (spoke):** as the spoke's local admin, try
   `aws cloudformation delete-stack --stack-name <a decoy stack>` → `AccessDenied`. Then run the
   same through the hub → spoke-deployment-role chain (i.e. via the portal) → succeeds.
4. **Data plane still open (spoke):** confirm `aws s3api get-object` on a decoy bucket still
   works for an arbitrary principal -- this is the tripwire; it must NOT be denied.

## Caveats

- SCPs affect member accounts only, never the Organization's management account. Make sure the
  hub/spoke accounts are actually in an OU the SCP is attached to.
- `aws:PrincipalArn` with `assumed-role/.../*` matches any session name of that role. The
  ExternalId required by the spoke trust policy isn't visible to SCP conditions, so the SCP can't
  itself enforce the hub+ExternalId chain -- that's already enforced by the spoke role's trust
  policy (see `iam/spoke/deployment-role/main.tf`). The SCP is the second layer, not the first.
- Tag dependency: `ProtectPortalInstanceFromCredTheft` scopes by
  `aws:ResourceTag/Project = <prefix>-platform` -- `hub/hub-bootstrap.yaml` already tags the
  instance that way. Drop the tag condition if you'd rather protect every instance in the hub
  account regardless of tag.
