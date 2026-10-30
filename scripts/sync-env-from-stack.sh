#!/usr/bin/env bash
#
# sync-env-from-stack.sh — read hub/hub-bootstrap.yaml's Outputs and write
# portal/.env.local from them. The stack is the single source of config;
# this script is what turns that into the file the portal actually reads,
# so nothing is hand-typed or allowed to drift from what's really deployed.
#
# Usage:
#   bash scripts/sync-env-from-stack.sh [stack-name] [--profile PROFILE] [--region REGION]
#
# Defaults: stack-name=mirage-hub-bootstrap, region from AWS_REGION/AWS_DEFAULT_REGION
# or the CLI's configured default.
set -euo pipefail

STACK_NAME="${1:-mirage-hub-bootstrap}"
shift || true

AWS_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) AWS_ARGS+=(--profile "$2"); shift 2 ;;
    --region)  AWS_ARGS+=(--region "$2");  shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

command -v jq >/dev/null || { echo "jq is required." >&2; exit 1; }

OUTPUTS_JSON=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs' --output json "${AWS_ARGS[@]}")

out() { echo "$OUTPUTS_JSON" | jq -r --arg k "$1" '.[] | select(.OutputKey==$k) | .OutputValue'; }

RESOURCE_PREFIX=$(out ResourcePrefix)
HUB_ACCOUNT_ID=$(out HubAccountId)
REGION=$(out Region)
ORG_ID=$(out OrgId)
HUB_SERVICE_ROLE_ARN=$(out HubServiceRoleArn)
PORTAL_INSTANCE_ROLE_ARN=$(out PortalInstanceRoleArn)
TFSTATE_BUCKET=$(out TfStateBucket)
PORTAL_URL=$(out PortalUrl)
EXTERNAL_ID=$(out ExternalId)

if [[ -z "$RESOURCE_PREFIX" || -z "$HUB_ACCOUNT_ID" ]]; then
  echo "Could not read stack outputs from '$STACK_NAME' -- did it finish deploying?" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../portal/.env.local"

cat > "$ENV_FILE" << ENVEOF
# Written by scripts/sync-env-from-stack.sh from stack '$STACK_NAME'. Re-run that
# script after any change to the stack instead of editing the values below by hand.
MIRAGE_RESOURCE_PREFIX=$RESOURCE_PREFIX
NEXT_PUBLIC_MIRAGE_RESOURCE_PREFIX=$RESOURCE_PREFIX
MIRAGE_HUB_ACCOUNT_ID=$HUB_ACCOUNT_ID
MIRAGE_HUB_SERVICE_ROLE_ARN=$HUB_SERVICE_ROLE_ARN
MIRAGE_ORG_ID=$ORG_ID
MIRAGE_STATE_TABLE=${RESOURCE_PREFIX}-state
MIRAGE_TFSTATE_BUCKET=$TFSTATE_BUCKET
MIRAGE_PORTAL_INSTANCE_ROLE_ARN=$PORTAL_INSTANCE_ROLE_ARN
STORAGE_BACKEND=aws
AWS_REGION=$REGION
AWS_DEFAULT_REGION=$REGION
MIRAGE_SPOKE_EXTERNAL_ID=$EXTERNAL_ID
ENVEOF

echo "Wrote $ENV_FILE"
echo "Hub portal: $PORTAL_URL"
