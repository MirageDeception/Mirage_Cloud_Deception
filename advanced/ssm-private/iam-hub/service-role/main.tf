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
#
# This role's only purpose: let the named IDC SSO users jump into spoke
# deployment roles across any account in the organization.
# No permissions of its own beyond sts:AssumeRole.
#
# Trust pattern: Principal = account root + aws:PrincipalArn condition.
# Using the session ARN directly as Principal drops the email suffix and
# would allow the entire permission set — this is the correct alternative.

resource "aws_iam_role" "this" {
  name        = "${var.resource_prefix}-hub-service-role"
  description = "Jump role - assumes ${var.resource_prefix}-spoke-deployment-role in any org account"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [{
        Sid    = "AllowNamedSSOSessionsOnly"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${var.hub_account_id}:root"
        }
        Action = "sts:AssumeRole"
        Condition = {
          StringEquals = {
            "aws:userId" = var.allowed_sso_user_ids
          }
        }
      }],
      # Machine principal: the EC2 portal instance role. Lets the dashboard
      # operate without interactive SSO. Scoped to the org; add a SourceVpce
      # condition here once the dedicated VPC + STS endpoint exist so the
      # assumed credentials are only usable from on-box.
      var.portal_instance_role_arn != "" ? [{
        Sid    = "AllowPortalInstanceRole"
        Effect = "Allow"
        Principal = {
          AWS = var.portal_instance_role_arn
        }
        Action = "sts:AssumeRole"
        # aws:PrincipalOrgID always; add aws:SourceVpce when the STS interface
        # endpoint id is provided so the assumed creds are only usable on-box
        # (from inside the hub VPC). Exfiltrated creds are useless off-box.
        Condition = merge(
          {
            StringEquals = merge(
              { "aws:PrincipalOrgID" = var.org_id },
              var.portal_sts_vpc_endpoint_id != "" ? { "aws:SourceVpce" = var.portal_sts_vpc_endpoint_id } : {}
            )
          }
        )
      }] : []
    )
  })

  tags = {
    Project   = "${var.resource_prefix}-platform"
    ManagedBy = "terraform"
  }
}

resource "aws_iam_role_policy" "this" {
  name = "${var.resource_prefix}-hub-service-policy"
  role = aws_iam_role.this.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # Jump into any spoke deployment role within the org
      {
        Sid      = "AssumeSpokeDeploy"
        Effect   = "Allow"
        Action   = "sts:AssumeRole"
        Resource = "arn:aws:iam::*:role/${var.resource_prefix}-spoke-deployment-role"
        Condition = {
          StringEquals = {
            "aws:ResourceOrgID" = var.org_id
          }
        }
      },
      # Jump into the hub brain deployment role (deploys CFN stacks)
      {
        Sid      = "AssumeBrainDeploy"
        Effect   = "Allow"
        Action   = "sts:AssumeRole"
        Resource = "arn:aws:iam::${var.hub_account_id}:role/${var.resource_prefix}-brain-deployment-role"
      },
      # Terraform S3 remote-state backend runs AS this role (same-account hub
      # bucket). Needs object RW on accounts/* + list + the native-lock object.
      {
        Sid    = "TerraformStateBucket"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject"
        ]
        Resource = "arn:aws:s3:::${var.resource_prefix}-tfstate-${var.hub_account_id}-${var.hub_region}-v2/*"
      },
      {
        Sid    = "TerraformStateBucketList"
        Effect = "Allow"
        Action = [
          "s3:ListBucket",
          "s3:GetBucketLocation"
        ]
        Resource = "arn:aws:s3:::${var.resource_prefix}-tfstate-${var.hub_account_id}-${var.hub_region}-v2"
      }
    ]
  })
}

# ── Self-modification lock ────────────────────────────────────────────────
# Explicit Deny on IAM actions that could rewrite this role's trust or inline
# policy, for every principal EXCEPT the named role admins. A stolen instance
# credential (which can assume this role) therefore cannot add a new trusted
# principal or widen its own permissions to persist. Created only when
# role_admin_arns is set. Mirrors the spoke module's DenySelfModification.
resource "aws_iam_role_policy" "self_modification_lock" {
  count = length(var.role_admin_arns) > 0 ? 1 : 0

  name = "${var.resource_prefix}-hub-service-self-mod-lock"
  role = aws_iam_role.this.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "DenySelfModificationExceptAdmins"
      Effect = "Deny"
      Action = [
        "iam:UpdateAssumeRolePolicy",
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy",
        "iam:DeleteRole",
        "iam:UpdateRole"
      ]
      Resource = aws_iam_role.this.arn
      Condition = {
        StringNotEquals = {
          "aws:PrincipalArn" = var.role_admin_arns
        }
      }
    }]
  })
}
