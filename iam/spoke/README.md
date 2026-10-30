# Spoke account onboarding

This folder is the complete handover unit for a spoke account. Hand it to the account
owner as-is — it needs nothing else from the wider repo.

```
onboard-spoke.sh      # run this
deployment-role/      # Terraform: <resource_prefix>-spoke-deployment-role
forwarding-role/      # Terraform: <resource_prefix>-forwarding-role
```

## What gets created

Two IAM roles in your account, and nothing else. No decoy resources are created here.
Role names carry a `resource_prefix` (see each module's `variables.tf` for its
default, overridable per module) — it must match the hub's own resource-prefix
setting or the trust/forwarding ARNs below won't line up:

| Role | Assumed by | Purpose |
|---|---|---|
| `<resource_prefix>-spoke-deployment-role` | the hub's `<resource_prefix>-hub-service-role` | runs Terraform to deploy decoy resources |
| `<resource_prefix>-forwarding-role` | EventBridge in your account | `events:PutEvents` to the hub bus — nothing more |

## Prerequisites

- Terraform >= 1.0 and the AWS CLI on `PATH`
- Credentials with role-creation rights **in the target account**, exported into your
  shell (`AWS_PROFILE=...`). The script verifies the caller is actually in the target
  account before it applies anything, so a wrong-account run fails instead of
  creating roles in the wrong place.

## Run it

```bash
AWS_PROFILE=<spoke-admin> ORG_ID=<your-org-id> MIRAGE_SPOKE_EXTERNAL_ID=<hub ExternalId output> \
  bash onboard-spoke.sh <ACCOUNT_ID> [REGION] <HUB_ACCOUNT_ID>

# e.g.
AWS_PROFILE=your-spoke-profile ORG_ID=o-abc1234567 MIRAGE_SPOKE_EXTERNAL_ID=... \
  bash onboard-spoke.sh 222222222222 us-west-2 333333333333
```

`REGION` defaults to `us-west-2`. `HUB_ACCOUNT_ID`, `ORG_ID` and
`MIRAGE_SPOKE_EXTERNAL_ID` have **no default** — the script errors out immediately if
any is missing, rather than silently onboarding against the wrong hub or org. The
easiest path is the command the hub installer prints, run in the spoke's CloudShell:
it has every value filled in, and the script installs Terraform itself.

If the hub was deployed with a non-default `MIRAGE_RESOURCE_PREFIX`, also export
`RESOURCE_PREFIX=<that-prefix>` so both modules here create roles under the same
prefix the hub expects.

State is written per-account to `<module>/.state/<ACCOUNT_ID>/terraform.tfstate`.
**Keep it.** It is what allows a clean re-run or teardown later; without it a re-run
fails `EntityAlreadyExists` and the roles have to be imported or deleted by hand.

## What the deployment role can do

Permissions live in three customer-managed policies
(`<resource_prefix>-spoke-deployment-{control,data,platform}`) rather than one inline policy,
because the full action set exceeds the 10,240-character cap AWS applies to the
aggregate of a role's inline policies. Managed policies are capped per-policy at
6,144 instead. The split is by service domain and has no security meaning — IAM
unions them, and an explicit `Deny` in any one still overrides an `Allow` in another.

Every statement is scoped to this account. Regions are deliberately **not** narrowed —
decoys will expand to whichever regions we choose, and re-issuing this folder for every
new region is not workable. The security boundary is the trust policy: only the hub
service role (or a listed operator ARN) can assume this role at all.

Three scoping exceptions, all forced by AWS rather than chosen:

- **S3** — bucket ARNs have no account field, so the scope relies on the naming
  convention decoy buckets follow (`<prefix>-<ACCOUNT_ID>`). A decoy bucket without
  that suffix will be denied.
- **`Describe`/`Validate`-type actions** — several support no resource-level ARN at
  all (`ec2:Describe*`, `cloudformation:ValidateTemplate`, `ecr:GetAuthorizationToken`,
  `ssm:DescribeParameters`). These use `Resource = "*"`. All are read-only except
  `GetAuthorizationToken`, which mints a registry login token and nothing else.
- **AMI ARNs** — `RunInstances` must authorize the image and its backing snapshot,
  which are owned by Amazon, so those ARNs carry no account segment.

The role is explicitly denied from creating IAM users, minting access keys, modifying
itself or the forwarding role, and rewriting its own permission policies. Those denies
hold regardless of any `Allow`.


## ExternalId

The deployment role's trust policy requires `sts:ExternalId`. Each hub install
generates its own value — the hub stack's `ExternalId` output — and you pass it as
`MIRAGE_SPOKE_EXTERNAL_ID`. The hub installer prints a ready-made onboarding command
with it filled in.

`ExternalId` is not an authenticator: it exists to defeat the confused-deputy problem
and grants nothing on its own. Assuming this role *also* requires being the hub
service role (or a listed operator ARN) **and** passing `aws:PrincipalOrgID`.

## Teardown

Destroy any deployed decoy scenarios through the portal **first** — the deployment
role is what tears them down, so removing it early strands them. Then, as an admin of
the spoke:

```bash
RESOURCE_PREFIX=mirage-ops bash offboard-spoke.sh
```

It refuses while any `<prefix>-fwd-*` forwarding rule remains, then deletes both roles
and the managed policies this platform created. It works by name, so it does not need
the onboarding state file.
