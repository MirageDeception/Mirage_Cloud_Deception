# NOTE TO OPEN-SOURCE USERS:
# The resources in this scenario have been deployed with realistic, hardcoded names by default.
# You can safely rename any resource manually in this file to fit your environment's naming conventions.

variable "account_id" {
  description = "AWS Account ID"
  type        = string
}

data "aws_region" "current" {}

variable "role_name" {
  description = "Name of the IAM role"
  type        = string
  default     = "alerts-readonly-role"
}

variable "topic_name" {
  description = "Name of the SNS topic (primary, headline data store)"
  type        = string
  default     = "prod-alerts-critical"
}

# ---------------------------------------------------------------
# IAM Role (Discovery) — alerts-readonly-role
# ---------------------------------------------------------------
resource "aws_iam_role" "alerts_readonly_role" {
  name                 = var.role_name
  description          = "Read-only access to SNS alerting infrastructure for SRE team"
  max_session_duration = 3600

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${var.account_id}:root"
        }
        Action = "sts:AssumeRole"
      }
    ]
  })

  tags = {
    Environment = "production"
    Project     = "sre-platform"
    ManagedBy   = "terraform"
    CostCenter  = "CC-4200"
  }
}

resource "aws_iam_role_policy_attachment" "alerts_readonly_policy_attachment" {
  role       = aws_iam_role.alerts_readonly_role.name
  policy_arn = aws_iam_policy.alerts_readonly_policy.arn
}

resource "aws_iam_policy" "alerts_readonly_policy" {
  name = "alerts-readonly-policy"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "SNSListTopics"
        Effect = "Allow"
        Action = [
          "sns:ListTopics"
        ]
        Resource = "*"
      },
      {
        Sid    = "SNSReadTopic"
        Effect = "Allow"
        Action = [
          "sns:GetTopicAttributes",
          "sns:ListSubscriptionsByTopic",
          "sns:ListTagsForResource"
        ]
        Resource = aws_sns_topic.critical_alerts_topic.arn
      }
    ]
  })
}

# ---------------------------------------------------------------
# SNS Topic — prod-alerts-critical
# ---------------------------------------------------------------
resource "aws_sns_topic" "critical_alerts_topic" {
  name              = var.topic_name
  display_name      = "Production Critical Alerts"
  kms_master_key_id = "alias/aws/sns"

  tags = {
    Environment = "production"
    Project     = "sre-platform"
    Severity    = "critical"
    ManagedBy   = "terraform"
    CostCenter  = "CC-4200"
  }
}

resource "aws_sns_topic_policy" "critical_alerts_topic_policy" {
  arn = aws_sns_topic.critical_alerts_topic.arn

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowAccountPublish"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${var.account_id}:root"
        }
        Action   = "sns:Publish"
        Resource = aws_sns_topic.critical_alerts_topic.arn
      },
      {
        Sid       = "DenyExternalPublish"
        Effect    = "Deny"
        Principal = "*"
        Action    = "sns:Publish"
        Resource  = aws_sns_topic.critical_alerts_topic.arn
        Condition = {
          StringNotEquals = {
            "aws:PrincipalAccount" = var.account_id
          }
        }
      }
    ]
  })
}

# ---------------------------------------------------------------
# SNS Subscription — Email (PendingConfirmation)
#
# The subscription exists for ONE reason: an attacker who enumerates this
# topic calls ListSubscriptionsByTopic, and a topic with zero subscribers is a
# tell that it is not a real alerting path. A PendingConfirmation entry is
# exactly what a real, recently-provisioned topic looks like.
#
# The endpoint MUST stay on an RFC 2606 reserved TLD (.invalid), which has no MX
# record anywhere by definition, so SNS's confirmation mail is undeliverable and
# cannot reach a human. It previously pointed at a real inbox, which AWS then
# emailed on EVERY deploy of this scenario.
#
# Do NOT "fix" this to a working address, and do NOT re-add the HTTPS webhook
# that used to sit here (`https://httpstat.us/200`). SNS POSTs the
# SubscriptionConfirmation -- which carries the full topic ARN and this account
# id -- to the endpoint, so that subscription published infrastructure details
# to an unrelated third-party service on every deploy. There is no safe
# external equivalent; a no-op realism prop is not worth an outbound data leak.
# ---------------------------------------------------------------
resource "aws_sns_topic_subscription" "email_subscription" {
  topic_arn = aws_sns_topic.critical_alerts_topic.arn
  protocol  = "email"
  endpoint  = "soc-oncall@domain.com"
}
