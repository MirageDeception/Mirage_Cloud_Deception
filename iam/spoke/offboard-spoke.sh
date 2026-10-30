#!/bin/bash
# ==============================================================================
# offboard-spoke.sh - Remove the two Mirage IAM roles from a spoke account (the
# reverse of onboard-spoke.sh). Run it in CloudShell of the SPOKE account, as an
# admin there:
#
#   (git clone -q --depth 1 https://github.com/MirageDeception/Mirage_Cloud_Deception.git ~/mirage 2>/dev/null || git -C ~/mirage pull -q) \
#     && RESOURCE_PREFIX=mirage-ops bash ~/mirage/iam/spoke/offboard-spoke.sh
#
# Remove this account's decoys from the portal FIRST: the deployment role is what
# tears them down, so deleting it early strands them. The script refuses to run
# while a forwarding rule (<prefix>-fwd-*) still exists, since one exists for as
# long as any decoy in this account is deployed.
#
# Deletes by name with the AWS CLI rather than `terraform destroy`, so it works
# even when the onboarding state file was lost (e.g. a CloudShell /tmp wipe).
# ==============================================================================
set -euo pipefail

PREFIX="${RESOURCE_PREFIX:-mirage-ops}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-west-2}}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_ROLE="$PREFIX-spoke-deployment-role"
FWD_ROLE="$PREFIX-forwarding-role"

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
echo "[offboard] Spoke $ACCOUNT, region $REGION, prefix $PREFIX"

RULES=$(aws events list-rules --region "$REGION" --name-prefix "$PREFIX-fwd-" --query 'Rules[].Name' --output text)
if [[ -n "$RULES" && "$RULES" != "None" ]]; then
  echo "ERROR: forwarding rule(s) still exist: $RULES" >&2
  echo "Remove this account's decoys in the portal first, then re-run." >&2
  exit 1
fi

read -r -p "Delete $DEPLOY_ROLE and $FWD_ROLE from $ACCOUNT? [y/N]: " OK < /dev/tty
[[ "$OK" =~ ^[Yy]$ ]] || { echo "Cancelled -- nothing was deleted."; exit 0; }

delete_role() {
  local role=$1 arn p v
  if ! aws iam get-role --role-name "$role" >/dev/null 2>&1; then
    echo "  $role: not found, skipping"; return
  fi
  for arn in $(aws iam list-attached-role-policies --role-name "$role" --query 'AttachedPolicies[].PolicyArn' --output text); do
    aws iam detach-role-policy --role-name "$role" --policy-arn "$arn"
    # Only delete the managed policies this platform created; leave anything else alone.
    if [[ "$arn" == "arn:aws:iam::$ACCOUNT:policy/$PREFIX-"* ]]; then
      for v in $(aws iam list-policy-versions --policy-arn "$arn" --query 'Versions[?!IsDefaultVersion].VersionId' --output text); do
        aws iam delete-policy-version --policy-arn "$arn" --version-id "$v"
      done
      aws iam delete-policy --policy-arn "$arn"
      echo "  deleted policy ${arn##*/}"
    fi
  done
  for p in $(aws iam list-role-policies --role-name "$role" --query 'PolicyNames' --output text); do
    aws iam delete-role-policy --role-name "$role" --policy-name "$p"
  done
  aws iam delete-role --role-name "$role"
  echo "  deleted role $role"
}

delete_role "$DEPLOY_ROLE"
delete_role "$FWD_ROLE"

# Drop onboarding state for this account so a later onboard starts clean.
rm -rf "$ROOT/deployment-role/.state/$ACCOUNT" "$ROOT/forwarding-role/.state/$ACCOUNT"
echo "[offboard] Done. $ACCOUNT no longer trusts the Mirage hub."
