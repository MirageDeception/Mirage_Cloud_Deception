#!/bin/bash
# ==============================================================================
# onboard-spoke.sh - Bootstrap the two IAM roles a new spoke account needs so the
# Deception Orchestrator portal can deploy decoys + forward detections to the hub.
#
# Creates, in the TARGET spoke account (actual names depend on the resource_prefix
# variable — see RESOURCE_PREFIX below — and are printed at the end of this script):
#   - <resource_prefix>-spoke-deployment-role  (portal assumes this to run Terraform)
#   - <resource_prefix>-forwarding-role        (EventBridge assumes this to PutEvents to hub)
#
# Nothing is hardcoded to a single spoke: the spoke account id is passed in, the hub
# account id is REQUIRED (arg 3 or $HUB_ACCOUNT_ID — no default, the script errors out
# if neither is given), and the org id and ExternalId are REQUIRED too (env vars
# ORG_ID and MIRAGE_SPOKE_EXTERNAL_ID — no defaults; both are hub stack outputs).
# Each spoke gets its own Terraform state file so accounts never collide.
#
# SELF-CONTAINED: this script and the two Terraform modules it applies live in the
# same directory on purpose. That whole directory is the handover unit — hand it to a
# spoke account owner and they need nothing else from this repo. Keep the layout:
#
#   <this dir>/
#     onboard-spoke.sh      <- you are here
#     deployment-role/
#     forwarding-role/
#
# PREREQUISITES:
#   - Admin (or role-creation) credentials for the TARGET spoke account, exported
#     into the shell (AWS_PROFILE=... or AWS_ACCESS_KEY_ID/.. set). The script
#     verifies the caller is actually in the target account before applying.
#   - The AWS CLI on PATH. Terraform is installed into a temp dir if missing, so
#     this runs as-is in AWS CloudShell (whose 1 GB home is too small for the AWS
#     provider -- provider downloads and .terraform also go to the temp dir).
#   - The hub bus must already grant this spoke PutEvents. The brain template's
#     org-scoped V2GlobalEventBusPolicy covers any account in OrgId automatically;
#     if OrgId was not set at brain-deploy time, run add-bus-permission.sh
#     style put-permission for this account first.
#
# Export ORG_ID and MIRAGE_SPOKE_EXTERNAL_ID (the hub stack's OrgId and ExternalId
# outputs) before running this script. The hub installer prints a ready-made command.
#
# USAGE:
#   AWS_PROFILE=<spoke-admin> ORG_ID=<your-org-id> MIRAGE_SPOKE_EXTERNAL_ID=<id> bash onboard-spoke.sh \
#     <SPOKE_ACCOUNT_ID> [REGION] <HUB_ACCOUNT_ID>
#   e.g.  AWS_PROFILE=your-spoke-profile ORG_ID=o-abc1234567 bash onboard-spoke.sh \
#     222222222222 us-west-2 333333333333
#
#   HUB_ACCOUNT_ID has no default any more — pass it as arg 3, or export it as an
#   env var (HUB_ACCOUNT_ID=333333333333 bash onboard-spoke.sh 222222222222). The
#   script errors out immediately if neither is given, rather than silently
#   onboarding against some other hub account. ORG_ID works the same way but is
#   env-var only (there is no positional arg for it, to avoid breaking the existing
#   <SPOKE_ACCOUNT_ID> [REGION] [HUB_ACCOUNT_ID] calling convention).
#
#   RESOURCE_PREFIX is optional and only needed if the hub was deployed with a
#   non-default resource prefix (see the portal's resource prefix env var). Export
#   it to thread the same prefix through both modules here:
#     RESOURCE_PREFIX=<your-prefix> HUB_ACCOUNT_ID=... ORG_ID=... bash onboard-spoke.sh <ACCOUNT_ID>
#
# STATE: written to <module>/.state/<SPOKE_ACCOUNT_ID>/terraform.tfstate next to this
# script, and gitignored. Keep it — it is what lets you re-run or destroy cleanly
# later. If the roles already exist in the target account but that state is missing,
# the apply fails EntityAlreadyExists; import the roles or delete them first.
# ==============================================================================
set -euo pipefail

SPOKE_ACCOUNT_ID="${1:-}"
REGION="${2:-us-west-2}"
HUB_ACCOUNT_ID="${3:-${HUB_ACCOUNT_ID:-}}"
ORG_ID="${ORG_ID:-}"
RESOURCE_PREFIX="${RESOURCE_PREFIX:-}"
# Modules are siblings of this script, so the delivery folder works wherever it is
# unpacked. Do not reintroduce a repo-relative path here.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! "$SPOKE_ACCOUNT_ID" =~ ^[0-9]{12}$ ]]; then
  echo "ERROR: first arg must be a 12-digit spoke account id" >&2
  echo "Usage: AWS_PROFILE=<spoke-admin> bash onboard-spoke.sh <SPOKE_ACCOUNT_ID> [REGION] <HUB_ACCOUNT_ID>" >&2
  exit 1
fi

if [[ -z "$HUB_ACCOUNT_ID" ]]; then
  echo "ERROR: hub account id is required — there is no default any more." >&2
  echo "Pass it as arg 3, or export HUB_ACCOUNT_ID." >&2
  echo "Usage: AWS_PROFILE=<spoke-admin> bash onboard-spoke.sh <SPOKE_ACCOUNT_ID> [REGION] <HUB_ACCOUNT_ID>" >&2
  exit 1
fi

if [[ ! "$HUB_ACCOUNT_ID" =~ ^[0-9]{12}$ ]]; then
  echo "ERROR: hub account id must be a 12-digit account id (got: $HUB_ACCOUNT_ID)" >&2
  exit 1
fi

if [[ -z "$ORG_ID" ]]; then
  echo "ERROR: org id is required — deployment-role's org_id variable has no default." >&2
  echo "Export ORG_ID (e.g. ORG_ID=o-abc1234567) and retry." >&2
  exit 1
fi

if [[ -z "${MIRAGE_SPOKE_EXTERNAL_ID:-}" ]]; then
  echo "ERROR: MIRAGE_SPOKE_EXTERNAL_ID is required — use the hub stack's ExternalId output." >&2
  exit 1
fi

# CloudShell has no Terraform and only a 1 GB home; keep binary, providers and
# .terraform under a temp dir. Module files and state stay next to this script.
WORK_TMP="${MIRAGE_TMP:-/tmp/mirage-onboard}"
export TF_PLUGIN_CACHE_DIR="${TF_PLUGIN_CACHE_DIR:-$WORK_TMP/plugin-cache}"
mkdir -p "$TF_PLUGIN_CACHE_DIR" "$WORK_TMP/bin"
export PATH="$WORK_TMP/bin:$PATH"
if ! command -v terraform >/dev/null; then
  ARCH=$(uname -m); [[ "$ARCH" == "aarch64" ]] && ARCH=arm64 || ARCH=amd64
  echo "[onboard] Installing Terraform 1.10.5 ($ARCH) into $WORK_TMP/bin"
  curl -fsSL "https://releases.hashicorp.com/terraform/1.10.5/terraform_1.10.5_linux_${ARCH}.zip" -o "$WORK_TMP/tf.zip"
  unzip -oq "$WORK_TMP/tf.zip" -d "$WORK_TMP/bin" && rm "$WORK_TMP/tf.zip"
fi

# Guard: refuse to apply unless the ambient creds are actually in the target
# account (prevents creating the spoke roles in the wrong account).
CALLER_ACCT="$(aws sts get-caller-identity --query Account --output text)"
if [[ "$CALLER_ACCT" != "$SPOKE_ACCOUNT_ID" ]]; then
  echo "ERROR: current credentials are for account $CALLER_ACCT, not target $SPOKE_ACCOUNT_ID." >&2
  echo "Export admin creds for the target spoke (AWS_PROFILE=...) and retry." >&2
  exit 1
fi

echo "[onboard] Target spoke: $SPOKE_ACCOUNT_ID  hub: $HUB_ACCOUNT_ID  region: $REGION"

for MODULE in deployment-role forwarding-role; do
  DIR="$ROOT/$MODULE"
  if [[ ! -d "$DIR" ]]; then
    echo "ERROR: expected the Terraform module at $DIR but it is not there." >&2
    echo "onboard-spoke.sh must sit alongside deployment-role/ and forwarding-role/." >&2
    exit 1
  fi
  # Per-account state FILE so multiple spokes never share/overwrite local state.
  # These modules use the default local backend (no backend block), so state
  # isolation is done with the -state flag, NOT -backend-config.
  STATE_DIR="$DIR/.state/$SPOKE_ACCOUNT_ID"
  mkdir -p "$STATE_DIR"
  STATE_FILE="$STATE_DIR/terraform.tfstate"
  echo ""
  echo "=== [$MODULE] init + apply for $SPOKE_ACCOUNT_ID (state: $STATE_FILE) ==="
  export TF_DATA_DIR="$WORK_TMP/tf-data/$MODULE"
  terraform -chdir="$DIR" init -input=false >/dev/null

  # account_id, hub_account_id, and region are passed explicitly — no defaults
  # relied upon so there is no silent "wrong account" footgun. Per-account -state
  # keeps each spoke's state separate on disk.
  EXTRA_VARS=(
    -var="hub_account_id=$HUB_ACCOUNT_ID"
  )
  if [[ -n "$RESOURCE_PREFIX" ]]; then
    EXTRA_VARS+=(-var="resource_prefix=$RESOURCE_PREFIX")
  fi
  if [[ "$MODULE" == "deployment-role" ]]; then
    # org_id and external_id only exist on this module.
    EXTRA_VARS+=(-var="org_id=$ORG_ID" -var="external_id=$MIRAGE_SPOKE_EXTERNAL_ID")
  fi
  terraform -chdir="$DIR" apply -auto-approve -input=false \
    -state="$STATE_FILE" \
    -var="account_id=$SPOKE_ACCOUNT_ID" \
    -var="region=$REGION" \
    "${EXTRA_VARS[@]}"
done

echo ""
echo "[onboard] Done. Roles in $SPOKE_ACCOUNT_ID:"
# Read the actual created ARNs back from each module's state rather than guessing
# at the name — the resource_prefix variable means the name is not fixed.
for MODULE in deployment-role forwarding-role; do
  echo "  $(TF_DATA_DIR="$WORK_TMP/tf-data/$MODULE" terraform -chdir="$ROOT/$MODULE" output -state="$ROOT/$MODULE/.state/$SPOKE_ACCOUNT_ID/terraform.tfstate" -raw role_arn)"
done
echo "[onboard] Now add the spoke in the dashboard (enter account id $SPOKE_ACCOUNT_ID) and deploy scenarios."
