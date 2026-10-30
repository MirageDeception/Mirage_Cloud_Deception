terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 5.0" }
  }
  # Local state: this is a single-operator, opt-in advanced module with no
  # pre-existing state bucket to point a backend at. State lives in
  # terraform.tfstate next to the config.
}

provider "aws" {
  region = var.hub_region
}

# Apply in the Hub account.
# aws configure --profile hub  OR  export AWS_PROFILE=hub

resource "aws_iam_role" "this" {
  name        = "${var.resource_prefix}-brain-deployment-role"
  description = "Deploys hub monitoring CloudFormation stacks (${var.resource_prefix}-monitoring, ${var.resource_prefix}-detect-rules)"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowOperator"
      Effect    = "Allow"
      Principal = { AWS = var.trusted_principal_arns }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = {
    Project   = "${var.resource_prefix}-platform"
    ManagedBy = "terraform"
  }
}

resource "aws_iam_role_policy" "this" {
  name = "${var.resource_prefix}-brain-deployment-policy"
  role = aws_iam_role.this.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [

      # ── CloudFormation ──────────────────────────────────────────────────────
      # Scoped to the two hub stacks only
      {
        Sid    = "CloudFormationStacks"
        Effect = "Allow"
        Action = [
          "cloudformation:CreateStack",
          "cloudformation:UpdateStack",
          "cloudformation:DeleteStack",
          "cloudformation:DescribeStacks",
          "cloudformation:DescribeStackEvents",
          "cloudformation:DescribeStackResources",
          "cloudformation:GetTemplate",
          "cloudformation:ListStacks",
          "cloudformation:ListStackResources",
          # aws cloudformation deploy works through change sets, not direct
          # Create/UpdateStack. These four are required and stay scoped to the
          # two hub stack ARNs below.
          "cloudformation:CreateChangeSet",
          "cloudformation:DeleteChangeSet",
          "cloudformation:DescribeChangeSet",
          "cloudformation:ExecuteChangeSet"
        ]
        Resource = [
          "arn:aws:cloudformation:${var.hub_region}:${var.hub_account_id}:stack/${var.resource_prefix}-monitoring/*",
          # The portal deploys the Tier-2 rules stack as ${var.resource_prefix}-service-rules;
          # ${var.resource_prefix}-detect-rules is the older CLI name (kept for back-compat).
          "arn:aws:cloudformation:${var.hub_region}:${var.hub_account_id}:stack/${var.resource_prefix}-service-rules/*",
          "arn:aws:cloudformation:${var.hub_region}:${var.hub_account_id}:stack/${var.resource_prefix}-detect-rules/*"
        ]
      },
      # ValidateTemplate and GetTemplateSummary have no resource-level scope in
      # IAM. GetTemplateSummary is called by `aws cloudformation deploy` to
      # reconcile template parameters.
      {
        Sid    = "CloudFormationValidate"
        Effect = "Allow"
        Action = [
          "cloudformation:ValidateTemplate",
          "cloudformation:GetTemplateSummary"
        ]
        Resource = "*"
      },

      # ── IAM — hub platform roles only (${var.resource_prefix}-*) ──────────────
      # Creates: ${var.resource_prefix}-lambda-role, ${var.resource_prefix}-invoke-role
      {
        Sid    = "IAMHubPlatformRoles"
        Effect = "Allow"
        Action = [
          "iam:CreateRole",
          "iam:DeleteRole",
          "iam:GetRole",
          "iam:UpdateRole",
          "iam:PutRolePolicy",
          "iam:DeleteRolePolicy",
          "iam:GetRolePolicy",
          "iam:ListRolePolicies",
          "iam:ListAttachedRolePolicies",
          "iam:AttachRolePolicy",
          "iam:DetachRolePolicy",
          "iam:TagRole",
          "iam:UntagRole"
        ]
        Resource = "arn:aws:iam::${var.hub_account_id}:role/${var.resource_prefix}-*"
      },
      # PassRole only to Lambda and EventBridge — prevents lateral movement
      {
        Sid      = "IAMPassRole"
        Effect   = "Allow"
        Action   = "iam:PassRole"
        Resource = "arn:aws:iam::${var.hub_account_id}:role/${var.resource_prefix}-*"
        Condition = {
          StringEquals = {
            "iam:PassedToService" = [
              "lambda.amazonaws.com",
              "events.amazonaws.com"
            ]
          }
        }
      },

      # ── Lambda — ${var.resource_prefix}-event-processor only ──────────────────
      {
        Sid    = "Lambda"
        Effect = "Allow"
        Action = [
          "lambda:CreateFunction",
          "lambda:UpdateFunctionCode",
          "lambda:UpdateFunctionConfiguration",
          "lambda:GetFunction",
          "lambda:GetFunctionConfiguration",
          "lambda:DeleteFunction",
          "lambda:AddPermission",
          "lambda:RemovePermission",
          "lambda:ListVersionsByFunction",
          "lambda:TagResource",
          "lambda:UntagResource"
        ]
        Resource = "arn:aws:lambda:${var.hub_region}:${var.hub_account_id}:function:${var.resource_prefix}-*"
      },

      # ── SNS — ${var.resource_prefix}-alerts only ──────────────────────────────
      {
        Sid    = "SNS"
        Effect = "Allow"
        Action = [
          "sns:CreateTopic",
          "sns:DeleteTopic",
          "sns:Subscribe",
          "sns:Unsubscribe",
          "sns:GetTopicAttributes",
          "sns:SetTopicAttributes",
          "sns:ListSubscriptionsByTopic",
          "sns:AddPermission",
          "sns:RemovePermission",
          "sns:TagResource",
          "sns:UntagResource"
        ]
        Resource = "arn:aws:sns:${var.hub_region}:${var.hub_account_id}:${var.resource_prefix}-*"
      },

      # ── EventBridge bus — ${var.resource_prefix}-event-bus ────────────────────
      {
        Sid    = "EventBridgeBus"
        Effect = "Allow"
        Action = [
          "events:CreateEventBus",
          "events:DeleteEventBus",
          "events:DescribeEventBus",
          "events:PutPermission",
          "events:RemovePermission",
          "events:ListEventBuses",
          "events:TagResource",
          "events:UntagResource"
        ]
        Resource = "arn:aws:events:${var.hub_region}:${var.hub_account_id}:event-bus/${var.resource_prefix}-*"
      },
      # EventBridge rules live under the custom bus — ARN includes bus name
      {
        Sid    = "EventBridgeRules"
        Effect = "Allow"
        Action = [
          "events:PutRule",
          "events:DeleteRule",
          "events:DescribeRule",
          "events:EnableRule",
          "events:DisableRule",
          "events:PutTargets",
          "events:RemoveTargets",
          "events:ListRules",
          "events:ListTargetsByRule",
          "events:TagResource",
          "events:UntagResource"
        ]
        Resource = "arn:aws:events:${var.hub_region}:${var.hub_account_id}:rule/${var.resource_prefix}-event-bus/${var.resource_prefix}-*"
      },

      # ── CloudWatch Logs — Lambda log group only ──────────────────────────────
      {
        Sid    = "CloudWatchLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:DeleteLogGroup",
          "logs:PutRetentionPolicy",
          "logs:DescribeLogGroups",
          "logs:TagLogGroup",
          "logs:TagResource"
        ]
        Resource = [
          "arn:aws:logs:${var.hub_region}:${var.hub_account_id}:log-group:/aws/lambda/${var.resource_prefix}-*",
          "arn:aws:logs:${var.hub_region}:${var.hub_account_id}:log-group:/aws/lambda/${var.resource_prefix}-*:*"
        ]
      },

      # ── DynamoDB — the two brain tables ─────────────────────────────────────
      # ${var.resource_prefix}-state = portal control plane. ${var.resource_prefix}-alerts = decoy-access
      # detections (append-only forensic record, TTL 1 year, Retain on delete).
      {
        Sid    = "DynamoDBMirageState"
        Effect = "Allow"
        Action = [
          "dynamodb:CreateTable",
          "dynamodb:DeleteTable",
          "dynamodb:DescribeTable",
          "dynamodb:UpdateTable",
          "dynamodb:DescribeContinuousBackups",
          "dynamodb:UpdateContinuousBackups",
          "dynamodb:DescribeTimeToLive",
          "dynamodb:UpdateTimeToLive",
          "dynamodb:ListTagsOfResource",
          "dynamodb:TagResource",
          "dynamodb:UntagResource"
        ]
        Resource = [
          "arn:aws:dynamodb:${var.hub_region}:${var.hub_account_id}:table/${var.resource_prefix}-state",
          "arn:aws:dynamodb:${var.hub_region}:${var.hub_account_id}:table/${var.resource_prefix}-alerts"
        ]
      },

      # ── S3 — the two brain buckets (tfstate + host audit logs) ───────────────
      # CFN manages bucket config; scoped to the mirage-* bucket names.
      {
        Sid    = "S3BrainBuckets"
        Effect = "Allow"
        Action = [
          "s3:CreateBucket",
          "s3:DeleteBucket",
          "s3:PutBucketPolicy",
          "s3:GetBucketPolicy",
          "s3:DeleteBucketPolicy",
          "s3:PutBucketVersioning",
          "s3:GetBucketVersioning",
          "s3:PutEncryptionConfiguration",
          "s3:GetEncryptionConfiguration",
          "s3:PutBucketPublicAccessBlock",
          "s3:GetBucketPublicAccessBlock",
          "s3:PutLifecycleConfiguration",
          "s3:GetLifecycleConfiguration",
          "s3:PutBucketTagging",
          "s3:GetBucketTagging",
          "s3:GetBucketLocation",
          "s3:ListBucket",
          # remove-hub.sh's empty_bucket lists every version and delete marker before the
          # stack can drop a versioned bucket. Without this the hub teardown fails with
          # AccessDenied on ListBucketVersions and the stack lands in DELETE_FAILED.
          "s3:ListBucketVersions"
        ]
        Resource = [
          "arn:aws:s3:::${var.resource_prefix}-tfstate-${var.hub_account_id}-${var.hub_region}-v2",
          "arn:aws:s3:::${var.resource_prefix}-audit-logs-${var.hub_account_id}-${var.hub_region}"
        ]
      },
      {
        # Object-level actions need OBJECT ARNs. The statement above lists bucket ARNs with
        # no /* entries, so putting these deletes there would parse fine and never match --
        # which is the trap this separate statement exists to avoid.
        Sid    = "S3BrainBucketObjects"
        Effect = "Allow"
        Action = [
          "s3:DeleteObject",
          "s3:DeleteObjectVersion",
          "s3:GetObjectVersion"
        ]
        Resource = [
          "arn:aws:s3:::${var.resource_prefix}-tfstate-${var.hub_account_id}-${var.hub_region}-v2/*",
          "arn:aws:s3:::${var.resource_prefix}-audit-logs-${var.hub_account_id}-${var.hub_region}/*"
        ]
      }
    ]
  })
}
