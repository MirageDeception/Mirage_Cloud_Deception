#!/bin/bash
# Walks the attack path so you can watch each step alert. Run it in the SPOKE
# account as a non-root user (root cannot assume roles).
set -euo pipefail

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/example-config-readonly-role"

echo "[1] Assuming the lure role (alert: AssumeRole)"
CREDS=$(aws sts assume-role --role-arn "$ROLE_ARN" --role-session-name recon \
  --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text)
export AWS_ACCESS_KEY_ID=$(echo "$CREDS" | cut -f1)
export AWS_SECRET_ACCESS_KEY=$(echo "$CREDS" | cut -f2)
export AWS_SESSION_TOKEN=$(echo "$CREDS" | cut -f3)

echo "[2] Reading the decoy secret (alert: GetSecretValue)"
aws secretsmanager get-secret-value --secret-id prod/example-service/api-credentials --query Name --output text
