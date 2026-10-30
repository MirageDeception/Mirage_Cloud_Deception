#!/usr/bin/env bash
#
# abuse.sh — Simulate attacker abuse of Scenario 19 (CloudFormation Stack Outputs Lure)
#
# This scenario deploys to us-east-1 specifically (see main.tf's provider block).
# Its lure role's policy grants CloudFormation read actions ONLY (ListStacks,
# DescribeStacks, ListExports, GetTemplate) -- it does NOT grant any ssm:* action,
# even though the scenario also plants two SSM parameters alongside it. That's
# deliberate: the parameters are the next breadcrumb an attacker would chase, not
# something this specific role can reach directly.
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
echo "  SCENARIO 19 — ABUSE CHAIN"
echo "  CloudFormation Stack Outputs Lure"
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
step "2" "Assuming lure role: cfn-audit-readonly-role"
# ---------------------------------------------------------------
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/cfn-audit-readonly-role"
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
step "3" "Enumerating deployed stacks (cloudformation:ListStacks)"
# ---------------------------------------------------------------
attack "cloudformation:ListStacks"
aws cloudformation list-stacks --region "${REGION}" \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE --output table

# ---------------------------------------------------------------
step "4" "Checking cross-stack exports (cloudformation:ListExports)"
# ---------------------------------------------------------------
attack "cloudformation:ListExports"
aws cloudformation list-exports --region "${REGION}" --output json | jq '.Exports'
info "Cross-stack Exports are a classic recon target — they're visible account-wide,"
info "often leaking VPC/subnet/security-group ids shared between stacks."

# ---------------------------------------------------------------
step "5" "Pulling outputs from a live stack (cloudformation:DescribeStacks)"
# ---------------------------------------------------------------
FIRST_STACK=$(aws cloudformation list-stacks --region "${REGION}" \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
  --query "StackSummaries[0].StackName" --output text 2>/dev/null || echo "None")
if [[ "${FIRST_STACK}" != "None" && -n "${FIRST_STACK}" ]]; then
  attack "cloudformation:DescribeStacks → ${FIRST_STACK}"
  aws cloudformation describe-stacks --region "${REGION}" --stack-name "${FIRST_STACK}" \
    --query "Stacks[0].Outputs" --output json

  # ---------------------------------------------------------------
  step "6" "Pulling the full template source (cloudformation:GetTemplate)"
  # ---------------------------------------------------------------
  attack "cloudformation:GetTemplate → ${FIRST_STACK}"
  aws cloudformation get-template --region "${REGION}" --stack-name "${FIRST_STACK}" \
    --query "TemplateBody" --output json | head -c 1000
  echo ""
else
  warn "No CREATE_COMPLETE/UPDATE_COMPLETE stacks found in ${REGION} for this account —"
  warn "DescribeStacks/GetTemplate have nothing to target yet. Deploy the hub brain or any"
  warn "other CloudFormation stack into this region/account to make this step concrete."
fi

# ---------------------------------------------------------------
step "7" "Noting the next breadcrumb: two SSM parameters this role can't reach"
# ---------------------------------------------------------------
warn "/prod/core-infra/endpoints and /prod/core-infra/secrets-ref exist in this account,"
warn "but cfn-audit-readonly-role's policy grants no ssm:* action — reading them needs a"
warn "different, more privileged credential (not attempted here on purpose)."

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
echo "  • CloudTrail: AssumeRole on cfn-audit-readonly-role"
echo "  • CloudTrail: ListStacks / ListExports"
echo "  • CloudTrail: DescribeStacks / GetTemplate (monitored by the hub's CloudFormation rule)"
echo ""
