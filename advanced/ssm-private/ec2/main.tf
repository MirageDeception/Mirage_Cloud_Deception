terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 5.0" }
  }
  # Local state: this is a single-operator, opt-in advanced module with no
  # pre-existing state bucket to point a backend at. State lives in
  # terraform.tfstate next to the config.
}

provider "aws" {
  region = var.region
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  # These default to "<resource_prefix>-*" when left empty (variable defaults
  # can't reference other variables).
  hub_service_role_name = var.hub_service_role_name != "" ? var.hub_service_role_name : "${var.resource_prefix}-hub-service-role"
  state_table           = var.state_table != "" ? var.state_table : "${var.resource_prefix}-state"
  alerts_table          = var.alerts_table != "" ? var.alerts_table : "${var.resource_prefix}-alerts"
}

data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]
  filter {
    name   = "name"
    values = ["al2023-ami-*-x86_64"]
  }
  filter {
    name   = "state"
    values = ["available"]
  }
}

data "aws_vpc" "target" {
  id = var.vpc_id
}

# Private subnet (from the vpc/ module output). The instance has no public IP and
# is reached only via SSM (Session Manager shell + dashboard port-forward).
data "aws_subnet" "target" {
  id = var.subnet_id
}

# ── KMS CMK — EBS encryption ───────────────────────────────────────────────
# prevent_destroy = true: a destroyed CMK makes encrypted data permanently
# irrecoverable. Remove this lifecycle guard manually and schedule key
# deletion (30-day window) only when decommissioning the entire platform.
resource "aws_kms_key" "ebs" {
  description             = "MIRAGE portal — EBS volume encryption CMK"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # Root: required anchor — allows IAM policies to delegate key permissions.
      {
        Sid    = "RootAdministration"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"
        }
        Action   = "kms:*"
        Resource = "*"
      },
      # EC2/EBS service — encrypt/decrypt volumes only when called via the EC2
      # service from this account. kms:ViaService blocks direct KMS API calls
      # using this key from other services or clients.
      {
        Sid    = "EBSServiceEncryption"
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKeyWithoutPlaintext",
          "kms:CreateGrant",
          "kms:DescribeKey",
          "kms:ReEncryptFrom",
          "kms:ReEncryptTo",
        ]
        Resource = "*"
        Condition = {
          StringEquals = {
            "kms:ViaService"    = "ec2.${data.aws_region.current.region}.amazonaws.com"
            "kms:CallerAccount" = data.aws_caller_identity.current.account_id
          }
        }
      },
    ]
  })

  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Name      = "${var.resource_prefix}-portal-ebs-cmk"
    Project   = "${var.resource_prefix}-platform"
    ManagedBy = "terraform"
  }
}

resource "aws_kms_alias" "ebs" {
  name          = "alias/${var.resource_prefix}-portal-ebs"
  target_key_id = aws_kms_key.ebs.key_id
}

# ── IAM instance profile — SSM Session Manager ────────────────────────────
# Enables shell access via Systems Manager without requiring inbound port 22.
# Operators can use `aws ssm start-session --target <instance-id>` instead
# of SSH once the instance is registered with SSM (~2 min after first boot).
resource "aws_iam_role" "portal_instance" {
  name = "${var.resource_prefix}-portal-instance-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = {
    Project   = "${var.resource_prefix}-platform"
    ManagedBy = "terraform"
  }
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.portal_instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# ── Instance role: assume the hub service role ────────────────────────────
# The portal (running under this instance profile) chains:
#   instance-role -> <resource_prefix>-hub-service-role -> {spoke-deploy | brain-deploy}.
# This is the ONLY standing privilege the box carries; the hub service role's
# own policy scopes what can be assumed downstream. SourceVpce hardening on the
# hub trust is added once the dedicated VPC + STS endpoint exist (see vpc/).
resource "aws_iam_role_policy" "assume_hub_service" {
  name = "${var.resource_prefix}-portal-assume-hub-service"
  role = aws_iam_role.portal_instance.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "AssumeHubServiceRole"
      Effect   = "Allow"
      Action   = "sts:AssumeRole"
      Resource = "arn:aws:iam::${var.hub_account_id}:role/${local.hub_service_role_name}"
    }]
  })
}

# ── Instance role: portal state in DynamoDB (<resource_prefix>-state, same account) ──
# The portal reads/writes brains, rules, scenarios, history, spokes directly
# with its ambient instance-role creds (the state table is in the hub account,
# no assume needed). Without this the DB writes fail silently (saveBrain etc.),
# which is why a "successful" brain deploy left the dashboard empty.
resource "aws_iam_role_policy" "state_table_rw" {
  name = "${var.resource_prefix}-portal-state-table-rw"
  role = aws_iam_role.portal_instance.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "MirageStateTableRW"
      Effect = "Allow"
      Action = [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:Query",
        "dynamodb:Scan",
        "dynamodb:BatchGetItem",
        "dynamodb:BatchWriteItem",
        "dynamodb:DescribeTable"
      ]
      Resource = [
        "arn:aws:dynamodb:${var.region}:${var.hub_account_id}:table/${local.state_table}",
        "arn:aws:dynamodb:${var.region}:${var.hub_account_id}:table/${local.state_table}/index/*"
      ]
    }]
  })
}

# ── Instance role: Active Alerts table (<resource_prefix>-alerts, same account) ──
# The portal reads detections and advances their triage status
# (active -> in_progress -> resolved). Deliberately NO PutItem/DeleteItem:
# only the brain Lambda creates an alert, so a compromised portal can neither
# fabricate nor destroy a forensic record.
resource "aws_iam_role_policy" "alerts_table_rw" {
  name = "${var.resource_prefix}-portal-alerts-table-rw"
  role = aws_iam_role.portal_instance.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "MirageAlertsTableReadUpdate"
      Effect = "Allow"
      Action = [
        "dynamodb:GetItem",
        "dynamodb:Query",
        "dynamodb:Scan",
        "dynamodb:BatchGetItem",
        "dynamodb:UpdateItem",
        "dynamodb:DescribeTable"
      ]
      Resource = "arn:aws:dynamodb:${var.region}:${var.hub_account_id}:table/${local.alerts_table}"
    }]
  })
}

# ── Instance role: Terraform remote-state (hub S3 bucket, same account) ───
# The portal runs terraform with hub-service creds for the S3 backend; the
# instance role itself also needs object RW so `assumeHubServiceRole` isn't the
# only path (and for any box-side state ops). Scoped to accounts/* keys.
resource "aws_iam_role_policy" "tfstate_rw" {
  count = var.tfstate_bucket != "" ? 1 : 0

  name = "${var.resource_prefix}-portal-tfstate-rw"
  role = aws_iam_role.portal_instance.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "StateObjectRW"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = "arn:aws:s3:::${var.tfstate_bucket}/accounts/*"
      },
      {
        Sid      = "StateListBucket"
        Effect   = "Allow"
        Action   = ["s3:ListBucket", "s3:GetBucketLocation"]
        Resource = "arn:aws:s3:::${var.tfstate_bucket}"
      }
    ]
  })
}

# ── Instance role: host/operator audit logging to the audit-logs bucket ───
# Ships auditd + /var/log/secure + sudo/session logs (via CloudWatch agent) and
# SSM session logs. S3 write scoped to the host/ prefix; CloudWatch Logs create/put.
resource "aws_iam_role_policy" "audit_logging" {
  count = var.audit_logs_bucket != "" ? 1 : 0

  name = "${var.resource_prefix}-portal-audit-logging"
  role = aws_iam_role.portal_instance.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "AuditS3Put"
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = "arn:aws:s3:::${var.audit_logs_bucket}/host/*"
      },
      {
        Sid    = "CloudWatchLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogStreams",
          "logs:DescribeLogGroups"
        ]
        Resource = "arn:aws:logs:${var.region}:${data.aws_caller_identity.current.account_id}:log-group:/mirage/*"
      }
    ]
  })
}

# ── Instance role: pull the code zip from the CI S3 mirror (LEGACY) ───────
# DEAD PATH — code now arrives via repo_url (git clone, see userdata.sh) or a
# manual clone. Kept only so a `ci_source_bucket` value in an old tfvars file
# still renders; leave it empty (count = 0, nothing created). Scoped to the
# single source/ prefix + Decrypt on the CI CMK if ever re-enabled. No broad
# S3 access.
resource "aws_iam_role_policy" "ci_pull" {
  count = var.ci_source_bucket != "" ? 1 : 0

  name = "${var.resource_prefix}-portal-ci-pull"
  role = aws_iam_role.portal_instance.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [
        {
          Sid      = "ReadSourceZip"
          Effect   = "Allow"
          Action   = ["s3:GetObject"]
          Resource = "arn:aws:s3:::${var.ci_source_bucket}/source/*"
        },
        {
          Sid      = "ListSourceBucket"
          Effect   = "Allow"
          Action   = ["s3:ListBucket"]
          Resource = "arn:aws:s3:::${var.ci_source_bucket}"
          Condition = {
            StringLike = { "s3:prefix" = ["source/*"] }
          }
        }
      ],
      var.ci_kms_key_arn != "" ? [
        {
          Sid      = "DecryptSourceZip"
          Effect   = "Allow"
          Action   = ["kms:Decrypt", "kms:DescribeKey"]
          Resource = var.ci_kms_key_arn
        }
      ] : []
    )
  })
}

# ── Instance role: self-modification lock ─────────────────────────────────
# Deny IAM mutations of this role for everyone except the named admins, so a
# stolen instance credential cannot widen its own privileges or alter its
# trust to persist. Created only when role_admin_arns is set.
resource "aws_iam_role_policy" "instance_self_mod_lock" {
  count = length(var.role_admin_arns) > 0 ? 1 : 0

  name = "${var.resource_prefix}-portal-instance-self-mod-lock"
  role = aws_iam_role.portal_instance.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "DenySelfModificationExceptAdmins"
      Effect = "Deny"
      Action = [
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy",
        "iam:UpdateAssumeRolePolicy",
        "iam:DeleteRole",
        "iam:UpdateRole"
      ]
      Resource = aws_iam_role.portal_instance.arn
      Condition = {
        StringNotEquals = {
          "aws:PrincipalArn" = var.role_admin_arns
        }
      }
    }]
  })
}

resource "aws_iam_instance_profile" "portal" {
  name = "${var.resource_prefix}-portal-instance-profile"
  role = aws_iam_role.portal_instance.name

  tags = {
    Project   = "${var.resource_prefix}-platform"
    ManagedBy = "terraform"
  }
}

# ── SSM Session Manager logging preference (account-level) ────────────────
# Every SSM session (shell + break-glass SSH-over-SSM) is logged to the audit
# bucket + CloudWatch, per caller identity. This is the "who ran what over
# SSM" half of the host audit. Named SSM-SessionManagerRunShell = the account
# default preference SSM applies to all sessions.
resource "aws_ssm_document" "session_prefs" {
  count           = var.enable_ssm_session_logging && var.audit_logs_bucket != "" ? 1 : 0
  name            = "SSM-SessionManagerRunShell"
  document_type   = "Session"
  document_format = "JSON"

  content = jsonencode({
    schemaVersion = "1.0"
    description   = "Mirage SSM Session Manager preferences - log to S3 + CloudWatch"
    sessionType   = "Standard_Stream"
    inputs = {
      s3BucketName                = var.audit_logs_bucket
      s3KeyPrefix                 = "host/ssm-sessions"
      s3EncryptionEnabled         = true
      cloudWatchLogGroupName      = "/mirage/ssm-sessions"
      cloudWatchEncryptionEnabled = false
      cloudWatchStreamingEnabled  = true
      idleSessionTimeout          = "20"
    }
  })

  tags = {
    Project   = "${var.resource_prefix}-platform"
    ManagedBy = "terraform"
  }
}

# ── Security group ─────────────────────────────────────────────────────────
# NO inbound rules. The box is private (no public IP); all access — the shell
# channel AND the dashboard port-forward (portal binds 127.0.0.1:3000) — goes
# through SSM Session Manager, which needs no inbound SG rule. Egress-only
# (AWS APIs via VPC endpoints, npm/git via NAT).
resource "aws_security_group" "portal" {
  name        = "${var.resource_prefix}-portal-sg"
  description = "MIRAGE portal EC2: egress-only. All access via SSM (no inbound)."
  vpc_id      = data.aws_vpc.target.id

  # Outbound: AWS APIs (SSM/STS via VPC endpoints), npm/git over NAT.
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name      = "${var.resource_prefix}-portal-sg"
    Project   = "${var.resource_prefix}-platform"
    ManagedBy = "terraform"
  }
}

# ── EC2 instance ──────────────────────────────────────────────────────────
resource "aws_key_pair" "bootstrap" {
  key_name   = "${var.resource_prefix}-bootstrap-key"
  public_key = var.bootstrap_public_key

  tags = {
    Project   = "${var.resource_prefix}-platform"
    ManagedBy = "terraform"
  }
}

resource "aws_instance" "portal" {
  ami                    = data.aws_ami.al2023.id
  instance_type          = var.instance_type
  subnet_id              = var.subnet_id
  vpc_security_group_ids = [aws_security_group.portal.id]
  key_name               = aws_key_pair.bootstrap.key_name
  iam_instance_profile   = aws_iam_instance_profile.portal.name

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_gb
    encrypted             = true
    kms_key_id            = aws_kms_key.ebs.arn
    delete_on_termination = true
    tags = {
      Name      = "${var.resource_prefix}-portal-root"
      ManagedBy = "terraform"
    }
  }

  user_data = base64encode(templatefile("${path.module}/userdata.sh", {
    region                = var.region
    resource_prefix       = var.resource_prefix
    spoke_external_id     = var.spoke_external_id
    hub_account_id        = var.hub_account_id
    hub_service_role_name = local.hub_service_role_name
    state_table           = local.state_table
    storage_backend       = var.storage_backend
    audit_logs_bucket     = var.audit_logs_bucket
    repo_url              = var.repo_url
    repo_ref              = var.repo_ref
  }))

  # IMDSv2 only — prevents SSRF-based credential theft from the portal process.
  # hop_limit = 1 blocks container workloads from reaching the metadata endpoint.
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  tags = {
    Name = "${var.resource_prefix}-portal"
    # If your org gates ssm:StartSession via an SCP on a resource tag, add that
    # tag here too so the portal instance is covered.
    Project   = "${var.resource_prefix}-platform"
    ManagedBy = "terraform"
  }
}

# No EIP / public IP: the instance lives in a private subnet and is reached only
# via SSM (Session Manager shell, break-glass SSH-over-SSM, + dashboard
# port-forward). Outbound is via the NAT gateway in the vpc/ module.
