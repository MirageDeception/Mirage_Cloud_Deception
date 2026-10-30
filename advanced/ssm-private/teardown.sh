#!/bin/bash
# ==============================================================================
# teardown.sh - Tear down the Mirage portal EC2 host deployed via the
# advanced/ssm-private/ path (ec2/ + iam-hub/service-role/) and revert the
# hub-service-role trust edit. Keeps the brain-deployment-role and any spoke
# roles. Only relevant if you used this hardened path instead of the default
# hub/hub-bootstrap.yaml -- tearing that one down is just
# `aws cloudformation delete-stack`, no script needed.
#
# The EBS CMK has prevent_destroy=true in ec2/main.tf, which BLOCKS
# `terraform destroy`. That guard must be removed by hand (a .tf edit) between
# the apply and destroy steps -- this script pauses and tells you exactly what
# to edit. Nothing here force-deletes the CMK; key deletion is SCHEDULED
# (30-day window, cancellable).
#
# Usage:  AWS_PROFILE=<hub-profile> MIRAGE_RESOURCE_PREFIX=mirage-ops \
#           bash advanced/ssm-private/teardown.sh
# Run from the repo root.
# ==============================================================================
set -euo pipefail

PROFILE="${AWS_PROFILE:?Set AWS_PROFILE to a profile with hub credentials.}"
REGION="${AWS_REGION:-us-west-2}"
PREFIX="${MIRAGE_RESOURCE_PREFIX:-mirage-ops}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EC2_DIR="${ROOT}/ec2"
SR_DIR="${ROOT}/iam-hub/service-role"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
say()  { echo -e "${GREEN}[teardown]${NC} $*"; }
warn() { echo -e "${YELLOW}[teardown]${NC} $*"; }
die()  { echo -e "${RED}[teardown] $*${NC}" >&2; exit 1; }
pause() { echo; read -rp "  Press ENTER when done (or Ctrl-C to abort)... " _; echo; }

command -v terraform >/dev/null || die "terraform not found"
command -v aws >/dev/null || die "aws CLI not found"

ACCT=$(aws sts get-caller-identity --profile "$PROFILE" --query Account --output text)
say "Target account: $ACCT (profile $PROFILE, region $REGION, prefix $PREFIX)"
read -rp "  Is this the hub account you intend to tear down? [y/N] " CONFIRM
[[ "$CONFIRM" == "y" || "$CONFIRM" == "Y" ]] || die "Aborted."

# ---------------------------------------------------------------------------
# STEP 1: Revert the hub-service-role trust edit (back to SSO-users-only).
# ---------------------------------------------------------------------------
say "STEP 1: revert hub-service-role trust (remove portal instance-role + self-mod lock)."
warn "Edit ${SR_DIR}/terraform.tfvars:"
warn "   portal_instance_role_arn = \"\""
warn "   role_admin_arns          = []"
warn "Then this script will apply it. (Leaving them set is harmless once the instance is gone,"
warn " but reverting keeps the trust minimal.)"
pause
( cd "$SR_DIR" && terraform apply -auto-approve )
say "hub-service-role trust reverted. Verifying..."
aws iam get-role --role-name "${PREFIX}-hub-service-role" --profile "$PROFILE" \
  --query 'Role.AssumeRolePolicyDocument.Statement[].Sid' --output json

# ---------------------------------------------------------------------------
# STEP 2: Destroy the ec2 module (KMS prevent_destroy must be removed first).
# ---------------------------------------------------------------------------
say "STEP 2: destroy the ec2 module."
warn "The EBS CMK has lifecycle { prevent_destroy = true } in ${EC2_DIR}/main.tf."
warn "Remove that lifecycle block on resource aws_kms_key.ebs now (delete the 3 lines)."
pause
say "Syncing state after guard removal (no resource change expected)..."
( cd "$EC2_DIR" && terraform apply -auto-approve )
say "Destroying ec2 resources..."
( cd "$EC2_DIR" && terraform destroy -auto-approve )

# ---------------------------------------------------------------------------
# STEP 3: Schedule KMS key deletion (30-day window, cancellable).
# ---------------------------------------------------------------------------
# terraform destroy removes the alias + key resource from state; if the key
# still exists in AWS, make sure a deletion is scheduled. Best-effort: find
# any pending <prefix>-portal-ebs key.
say "STEP 3: ensure the EBS CMK deletion is scheduled (if the key still lingers)."
KEY_ID=$(aws kms list-aliases --profile "$PROFILE" --region "$REGION" \
  --query "Aliases[?AliasName=='alias/${PREFIX}-portal-ebs'].TargetKeyId | [0]" --output text 2>/dev/null || echo "None")
if [[ "$KEY_ID" != "None" && -n "$KEY_ID" ]]; then
  STATE=$(aws kms describe-key --key-id "$KEY_ID" --profile "$PROFILE" --region "$REGION" \
    --query 'KeyMetadata.KeyState' --output text 2>/dev/null || echo "gone")
  if [[ "$STATE" == "Enabled" || "$STATE" == "Disabled" ]]; then
    aws kms schedule-key-deletion --key-id "$KEY_ID" --pending-window-in-days 30 \
      --profile "$PROFILE" --region "$REGION" \
      --query '{Key:KeyId,DeletionDate:DeletionDate}' --output json
  else
    say "CMK state=$STATE (already scheduled/gone) - nothing to do."
  fi
else
  say "No alias/${PREFIX}-portal-ebs found - CMK already removed."
fi

# ---------------------------------------------------------------------------
# STEP 4: Verify clean.
# ---------------------------------------------------------------------------
say "STEP 4: verifying clean slate."
INST=$(aws ec2 describe-instances --profile "$PROFILE" --region "$REGION" \
  --filters "Name=tag:Project,Values=${PREFIX}-platform" "Name=instance-state-name,Values=running,stopped,pending,stopping" \
  --query 'length(Reservations[].Instances[])' --output text)
say "Mirage EC2 instances remaining: ${INST}  (expect 0)"
say "IAM deployment roles (kept):"
for r in "${PREFIX}-hub-service-role" "${PREFIX}-brain-deployment-role" "${PREFIX}-spoke-deployment-role"; do
  aws iam get-role --role-name "$r" --profile "$PROFILE" --query 'Role.RoleName' --output text 2>/dev/null \
    || warn "  $r not found in this account (spoke role lives in the spoke account, not hub -- ok)"
done

say "Teardown complete."
