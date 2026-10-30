#!/bin/bash
# Mirage hub uninstaller -- the reverse of install.sh. Run it in AWS CloudShell of
# the hub account:
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/MirageDeception/Mirage_Cloud_Deception/main/uninstall.sh)
#
# Order matters, so it is enforced: it refuses to start while any decoy is still
# deployed (remove those in the portal first -- they need the spoke roles and this
# hub to be torn down cleanly). Then it removes the brain, then the hub stack, and
# finally asks before deleting the two things the hub stack keeps on purpose: the
# Terraform state bucket and the disk encryption key.
set -euo pipefail

REPO_URL="${MIRAGE_REPO_URL:-https://github.com/MirageDeception/Mirage_Cloud_Deception.git}"
REPO_REF="${MIRAGE_REPO_REF:-main}"
STACK="${MIRAGE_STACK:-mirage-hub-bootstrap}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || true)}}"

say()  { echo -e "\033[1;36m==>\033[0m $*"; }
fail() { echo -e "\033[1;31mERROR:\033[0m $*" >&2; exit 1; }
ask()  { local a; read -r -p "$1" a < /dev/tty; echo "$a"; }

[[ -n "$REGION" ]] || fail "No AWS region set. Export AWS_REGION (e.g. us-west-2) and retry."
ACCOUNT=$(aws sts get-caller-identity --query Account --output text) || fail "Not signed in to AWS."
OUT=$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" --query 'Stacks[0].Outputs' --output json 2>/dev/null) \
  || fail "No stack $STACK in $ACCOUNT ($REGION) -- nothing to uninstall here."
get() { echo "$OUT" | jq -r --arg k "$1" '.[] | select(.OutputKey==$k) | .OutputValue'; }
PREFIX=$(get ResourcePrefix); BUCKET=$(get TfStateBucket); KMS_KEY=$(get EbsKmsKeyArn)
say "Hub $ACCOUNT ($REGION), stack $STACK, prefix $PREFIX"

# ── 1. Refuse while decoys are deployed ─────────────────────────────────────
# Every deployed scenario keeps a Terraform state with live resources in the
# state bucket; the portal's teardown deletes that state when it finishes.
LIVE=()
for key in $(aws s3api list-objects-v2 --region "$REGION" --bucket "$BUCKET" --prefix accounts/ \
               --query 'Contents[?ends_with(Key, `terraform.tfstate`)].Key' --output text 2>/dev/null); do
  [[ "$key" == "None" ]] && continue
  n=$(aws s3 cp --region "$REGION" "s3://$BUCKET/$key" - | jq '[.resources[]? | select(.mode=="managed")] | length')
  (( n > 0 )) && LIVE+=("$key ($n resources)")
done
if (( ${#LIVE[@]} )); then
  echo "Decoys are still deployed:"; printf '  %s\n' "${LIVE[@]}"
  fail "Remove them in the portal (Catalog -> teardown) first, then re-run."
fi
say "No deployed decoys found."

echo
echo "This deletes, in $ACCOUNT ($REGION):"
echo "  - the monitoring brain ($PREFIX-service-rules, $PREFIX-monitoring) and all stored alerts"
echo "  - the hub stack $STACK: portal host, VPC, hub IAM roles"
[[ "$(ask "Type the account id ($ACCOUNT) to confirm: ")" == "$ACCOUNT" ]] || fail "Cancelled -- nothing was deleted."

# ── 2. Brain ────────────────────────────────────────────────────────────────
WORK=$(mktemp -d)
git clone -q --depth 1 -b "$REPO_REF" "$REPO_URL" "$WORK/mirage" || fail "Could not clone $REPO_URL ($REPO_REF)."
say "Removing the monitoring brain..."
MIRAGE_RESOURCE_PREFIX="$PREFIX" bash "$WORK/mirage/portal/src/scripts/remove-hub.sh" "$REGION" "" \
  || fail "Brain removal failed (see above). Fix that, then re-run -- nothing after it was touched."
rm -rf "$WORK"

# ── 3. Hub stack ────────────────────────────────────────────────────────────
say "Deleting $STACK (a few minutes)..."
aws cloudformation delete-stack --region "$REGION" --stack-name "$STACK"
aws cloudformation wait stack-delete-complete --region "$REGION" --stack-name "$STACK" \
  || fail "$STACK did not delete cleanly -- check its Events tab in the CloudFormation console."
say "$STACK deleted."

# ── 4. What the hub stack keeps on purpose ──────────────────────────────────
echo
if [[ "$(ask "Also delete the Terraform state bucket $BUCKET? [y/N]: ")" =~ ^[Yy]$ ]]; then
  # Versioned bucket: every version and delete marker must go before the bucket can.
  while :; do
    batch=$(aws s3api list-object-versions --region "$REGION" --bucket "$BUCKET" --max-items 1000 --output json \
      | jq -c '{Objects: [(.Versions // [])[], (.DeleteMarkers // [])[] | {Key, VersionId}], Quiet: true}')
    [[ "$(echo "$batch" | jq '.Objects | length')" == 0 ]] && break
    aws s3api delete-objects --region "$REGION" --bucket "$BUCKET" --delete "$batch" >/dev/null
  done
  aws s3api delete-bucket --region "$REGION" --bucket "$BUCKET" && say "Deleted $BUCKET."
fi
if [[ "$(ask "Also schedule the disk encryption key for deletion (7-day wait, cancellable)? [y/N]: ")" =~ ^[Yy]$ ]]; then
  aws kms schedule-key-deletion --region "$REGION" --key-id "$KMS_KEY" --pending-window-in-days 7 >/dev/null \
    && say "Key scheduled for deletion in 7 days."
fi

echo
say "Hub removed. In CloudShell of each SPOKE account (as an admin there), run:"
echo
echo "  (git clone -q --depth 1 -b $REPO_REF $REPO_URL ~/mirage 2>/dev/null || git -C ~/mirage pull -q) && RESOURCE_PREFIX=$PREFIX bash ~/mirage/iam/spoke/offboard-spoke.sh"
echo
echo "Not touched: your CloudTrail trails and any SNS email you confirmed (the subscription went with the brain)."
