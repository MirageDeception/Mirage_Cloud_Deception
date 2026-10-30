# NOTE TO OPEN-SOURCE USERS:
# The resources in this scenario have been deployed with realistic, hardcoded names by default.
# You can safely rename any resource manually in this file to fit your environment's naming conventions.

variable "account_id" {
  description = "AWS Account ID"
  type        = string
}

variable "role_name" {
  description = "Name of the IAM role"
  type        = string
  default     = "prod-bastion-ecr-role"
}

variable "repository_name" {
  description = "Name of the ECR repository"
  type        = string
  default     = "prod-payment-service"
}

data "aws_region" "current" {}

resource "aws_iam_role" "bastion_ecr_role" {
  name                 = var.role_name
  description          = "ECR read access for production bastion host container operations"
  max_session_duration = 3600

  # Self-contained as of 2026-10-01. This trust policy previously allowed ONLY
  # Service = ec2.amazonaws.com, so the role could be assumed by nothing except
  # an EC2 instance -- which scenario-4 was meant to supply. Scenario-4 is the
  # one EC2 scenario and is out of scope, so in practice this role could never
  # be assumed and could never emit an sts:AssumeRole event. The ECR repo was
  # the only live part of the scenario.
  #
  # Account-root is the same form the other 18 scenarios use (cf. scenario-2
  # main.tf:21), which is what makes this role reachable and therefore
  # detectable. ec2.amazonaws.com is kept alongside it so the instance profile
  # below still works if scenario-4 is ever revived.
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${var.account_id}:root"
        }
        Action = "sts:AssumeRole"
      },
      {
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      }
    ]
  })

  tags = {
    Environment = "production"
    Project     = "payment-platform"
    ManagedBy   = "terraform"
    CostCenter  = "CC-5830"
  }
}

resource "aws_iam_policy" "bastion_ecr_policy" {
  name = "prod-bastion-ecr-readonly-policy"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "EcrAuth"
        Effect = "Allow"
        Action = [
          "ecr:GetAuthorizationToken"
        ]
        Resource = "*"
      },
      {
        Sid    = "EcrReadRepo"
        Effect = "Allow"
        Action = [
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer",
          "ecr:DescribeRepositories",
          "ecr:ListImages"
        ]
        Resource = aws_ecr_repository.payment_service_repo.arn
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "bastion_ecr_policy_attach" {
  role       = aws_iam_role.bastion_ecr_role.name
  policy_arn = aws_iam_policy.bastion_ecr_policy.arn
}

resource "aws_iam_instance_profile" "bastion_instance_profile" {
  name = "prod-bastion-ecr-profile"
  role = aws_iam_role.bastion_ecr_role.name
}

resource "aws_ecr_repository" "payment_service_repo" {
  name                 = var.repository_name
  image_tag_mutability = "IMMUTABLE"
  # A repository holding images cannot be deleted without this, so a seeded
  # scenario 5 would otherwise be permanently undeletable.
  force_delete = true

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = {
    Environment = "production"
    Project     = "payment-platform"
    ManagedBy   = "terraform"
    CostCenter  = "CC-5830"
  }
}

resource "aws_ecr_repository_policy" "payment_service_repo_policy" {
  repository = aws_ecr_repository.payment_service_repo.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowAccountPull"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${var.account_id}:root"
        }
        Action = [
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer",
          "ecr:DescribeRepositories",
          "ecr:ListImages"
        ]
      }
    ]
  })
}
