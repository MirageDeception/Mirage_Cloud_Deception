#!/bin/bash
# Manual fallback: grant org-scoped PutEvents on the hub event bus so spoke
# forwarding rules can deliver events cross-account. Deploy Brain already does
# this automatically (monitoring-brain.yaml's V2GlobalEventBusPolicy, applied
# whenever MIRAGE_ORG_ID is set) -- use this only to re-apply/inspect it by
# hand, e.g. while debugging why forwarding isn't working.
#
# Usage: MIRAGE_ORG_ID=o-xxxx AWS_PROFILE=<hub-profile> bash scripts/add-bus-permission.sh \
#          [resource-prefix] [region]
set -euo pipefail

: "${MIRAGE_ORG_ID:?Set MIRAGE_ORG_ID (o-xxxx) -- there is no default, this grants PutEvents org-wide.}"
: "${AWS_PROFILE:?Set AWS_PROFILE to a profile with hub credentials.}"

RESOURCE_PREFIX="${1:-${MIRAGE_RESOURCE_PREFIX:-mirage-ops}}"
REGION="${2:-${AWS_REGION:-us-west-2}}"
BUS_NAME="${RESOURCE_PREFIX}-event-bus"

aws events put-permission \
  --region "$REGION" \
  --event-bus-name "$BUS_NAME" \
  --statement-id AllowOrgSpokesPutEvents \
  --action events:PutEvents \
  --principal '*' \
  --condition "{\"Type\":\"StringEquals\",\"Key\":\"aws:PrincipalOrgID\",\"Value\":\"${MIRAGE_ORG_ID}\"}"

echo "[ok] permission added; current bus policy:"
aws events describe-event-bus --name "$BUS_NAME" --region "$REGION" --query 'Policy' --output text
