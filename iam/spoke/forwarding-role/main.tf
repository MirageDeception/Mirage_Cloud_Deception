terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 5.0" }
  }
}

provider "aws" {
  region = var.region
}

# Apply in Spoke account (222222222222)
#
# NOTE: This Terraform is now the ONLY definition of the role. The old
# CloudFormation copy (pipeline/spoke/forwarding-rule.yaml) was deleted with the
# pipeline/ directory, so there is no name conflict to work around any more.
# Onboard a spoke with scripts/onboard-spoke.sh <ACCOUNT_ID>, which applies this
# module. The portal's deploy-rule API keeps the trust below in exactly this form
# (rules-sync.ts ensureForwardingTrust) -- it no longer lists each rule ARN.

resource "aws_iam_role" "this" {
  name        = "${var.resource_prefix}-forwarding-role"
  description = "Assumed by EventBridge forwarding rules to PutEvents onto the hub event bus"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "TrustEventBridgeForwardingRulesOnly"
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        # Locks to this spoke account — prevents cross-account confused deputy
        StringEquals = { "aws:SourceAccount" = var.account_id }
        # Locks to this account's forwarding rules only, in ANY region: regional rules
        # live where their decoys are, and the identity rule (role decoys) lives in every
        # region, because AssumeRole is recorded in the region of the STS endpoint used.
        ArnLike = {
          "aws:SourceArn" = "arn:aws:events:*:${var.account_id}:rule/${var.resource_prefix}-fwd-*"
        }
      }
    }]
  })

  tags = {
    Project   = "${var.resource_prefix}-platform"
    ManagedBy = "terraform"
  }
}

resource "aws_iam_role_policy" "this" {
  name = "${var.resource_prefix}-forwarding-policy"
  role = aws_iam_role.this.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "PutEventsToHubBusOnly"
      Effect = "Allow"
      Action = "events:PutEvents"
      # Single resource — the hub custom bus, nothing else
      Resource = "arn:aws:events:${var.hub_region}:${var.hub_account_id}:event-bus/${var.resource_prefix}-event-bus"
    }]
  })
}
