# Finance ledger export lure: a role an "accounting integration" would use, which can
# read the ledger export API key from SSM. Every value is fake and marked expired.

variable "account_id" {
  description = "Spoke account ID -- always passed by the portal"
  type        = string
}

resource "aws_iam_role" "ledger_export" {
  name                 = "finance-ledger-export-role"
  description          = "Nightly general ledger export to the accounting platform"
  max_session_duration = 3600

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { AWS = "arn:aws:iam::${var.account_id}:root" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = {
    Environment = "production"
    Department  = "finance"
    ManagedBy   = "terraform"
  }
}

resource "aws_iam_role_policy" "ledger_export_read" {
  name = "ledger-export-config-read"
  role = aws_iam_role.ledger_export.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ssm:GetParameter"]
      Resource = aws_ssm_parameter.ledger_api_key.arn
    }]
  })
}

resource "aws_ssm_parameter" "ledger_api_key" {
  name        = "/prod/finance/ledger-export-api-key"
  description = "Accounting platform API key for the ledger export job"
  type        = "SecureString"
  value = jsonencode({
    endpoint = "https://api.accounting.example.com/v2/ledger"
    api_key  = "EXAMPLE-LEDGER-0000000000000000"
    status   = "EXPIRED - rotated 2024-06-01, do not use"
  })

  tags = {
    Environment = "production"
    Department  = "finance"
  }
}
