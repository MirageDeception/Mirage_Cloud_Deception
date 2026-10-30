#!/bin/bash
# Walks the finance ledger lure. Run in the SPOKE account as a non-root user
# (root cannot assume roles). Each step should raise an alert.
set -euo pipefail

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

echo "[1] Assume the ledger export role (alert: AssumeRole)"
CREDS=$(aws sts assume-role --role-arn "arn:aws:iam::${ACCOUNT_ID}:role/finance-ledger-export-role" \
  --role-session-name ledger-export --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text)
export AWS_ACCESS_KEY_ID=$(echo "$CREDS" | cut -f1)
export AWS_SECRET_ACCESS_KEY=$(echo "$CREDS" | cut -f2)
export AWS_SESSION_TOKEN=$(echo "$CREDS" | cut -f3)

echo "[2] Read the ledger API key as that role (alert: GetParameter)"
aws ssm get-parameter --name /prod/finance/ledger-export-api-key --query Parameter.Name --output text
