#!/bin/bash
# Mirage Hub Deployment Script
# NOT currently invoked by /api/deploy-brain -- that route now deploys both stacks
# directly via the AWS SDK (see deployCfnStack() in route.ts). Kept as a manual
# equivalent for deploying the brain from a shell instead of the portal.
# Inherits AWS credentials (STS AssumeRole) via environment variables.

set -e # Exit immediately if any command fails

REGION=${1:-"us-west-2"}
WHITELISTED_ARNS=${2:-""}
PREFIX="${MIRAGE_RESOURCE_PREFIX:-mirage-ops}"

echo "==========================================="
echo "Starting Mirage Hub Deployment"
echo "Region: $REGION"
echo "==========================================="

# Resolve absolute paths assuming the script is run from the project root
BRAIN_TEMPLATE="src/templates/hub/monitoring-brain.yaml"
RULES_TEMPLATE="src/templates/hub/service-rules.yaml"

# 1. Deploy the Monitoring Brain (Base Infrastructure)
echo ""
echo "📦 Deploying Base Infrastructure (Lambda, SNS, EventBus)..."
if [ -n "$WHITELISTED_ARNS" ]; then
    echo "Applying Custom Whitelist: $WHITELISTED_ARNS"
    aws cloudformation deploy \
        --template-file "$BRAIN_TEMPLATE" \
        --stack-name "${PREFIX}-monitoring" \
        --capabilities CAPABILITY_NAMED_IAM \
        --region "$REGION" \
        --parameter-overrides ResourcePrefix="$PREFIX" WhitelistedARNs="$WHITELISTED_ARNS"
else
    aws cloudformation deploy \
        --template-file "$BRAIN_TEMPLATE" \
        --stack-name "${PREFIX}-monitoring" \
        --capabilities CAPABILITY_NAMED_IAM \
        --region "$REGION" \
        --parameter-overrides ResourcePrefix="$PREFIX"
fi

# 2. Deploy the Service Rules (depends on the base infrastructure being complete)
echo ""
echo "🛡️ Deploying Service-Specific EventBridge Rules..."
aws cloudformation deploy \
    --template-file "$RULES_TEMPLATE" \
    --stack-name "${PREFIX}-service-rules" \
    --capabilities CAPABILITY_NAMED_IAM \
    --region "$REGION" \
    --parameter-overrides ResourcePrefix="$PREFIX"

echo ""
echo "✅ Hub Deployment Completed Successfully!"
echo "==========================================="
