# Starter template for a Mirage scenario. Copy this folder, rename it, and replace
# the example decoys with your own. Read README.md first -- it lists the rules the
# checker (scripts/validate-scenario.py) enforces before a scenario can be deployed.
#
# Do NOT add a provider "aws" block or a backend: the portal generates both at
# deploy time (it assumes the spoke deployment role and stores state in the hub).

variable "account_id" {
  description = "Spoke account ID -- always passed by the portal"
  type        = string
}

variable "role_name" {
  description = "Lure role: what an attacker finds and assumes first"
  type        = string
  default     = "example-config-readonly-role"
}

variable "secret_name" {
  description = "Decoy secret the lure role can read"
  type        = string
  default     = "prod/example-service/api-credentials"
}

# 1. The lure: any principal in the account may assume it. Assuming it is the
#    first alert (category "iam" in outputs.tf).
resource "aws_iam_role" "lure" {
  name                 = var.role_name
  description          = "Read-only access to service configuration"
  max_session_duration = 3600

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { AWS = "arn:aws:iam::${var.account_id}:root" }
      Action    = "sts:AssumeRole"
    }]
  })

  # Realistic tags make the decoy blend in. Never put "decoy", "honeypot" or
  # "mirage" anywhere an attacker can read.
  tags = {
    Environment = "production"
    ManagedBy   = "terraform"
  }
}

# 2. What the lure can reach. Grant only read access to your own decoys --
#    never Action "*", "iam:*" or an admin managed policy (the checker rejects them).
resource "aws_iam_role_policy" "lure_read" {
  name = "service-config-read"
  role = aws_iam_role.lure.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
      Resource = aws_secretsmanager_secret.decoy.arn
    }]
  })
}

# 3. The decoy itself. Reading it is the second alert.
resource "aws_secretsmanager_secret" "decoy" {
  name                    = var.secret_name
  description             = "API credentials for the example service"
  recovery_window_in_days = 0

  tags = {
    Environment = "production"
  }
}

# Fake content only, and always marked EXPIRED so incident responders can tell a
# lure from a real leak. Use neutral wording -- this text is what an attacker reads.
resource "aws_secretsmanager_secret_version" "decoy" {
  secret_id = aws_secretsmanager_secret.decoy.id
  secret_string = jsonencode({
    api_key    = "sk_live_EXAMPLE0000000000000000"
    api_secret = "EXAMPLE/ROTATED/0000000000000000000000"
    status     = "EXPIRED - rotated 2024-01-01, do not use"
  })
}
