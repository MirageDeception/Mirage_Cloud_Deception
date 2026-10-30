variable "region" {
  type        = string
  description = "AWS region"
  default     = "us-west-2"
}

variable "resource_prefix" {
  type        = string
  description = "Prefix for every hub-infra resource name created by this module (IAM role, policies, KMS alias, security group, key pair)."
  default     = "mirage-ops"
}

variable "vpc_id" {
  type        = string
  description = "VPC ID to deploy into (from the vpc/ module output, or your own pre-existing VPC)."
}

variable "subnet_id" {
  type        = string
  description = "PRIVATE subnet ID for the portal instance (from the vpc/ module private_subnet_ids). No public IP; access via SSM."
}

variable "instance_type" {
  type        = string
  description = "EC2 instance type"
  default     = "t3.medium"
}

variable "root_volume_gb" {
  type        = number
  description = "Root EBS volume size in GB"
  default     = 30
}

variable "hub_account_id" {
  type        = string
  description = "Hub account ID that owns the hub service role (the role the portal chains through)."
}

variable "hub_service_role_name" {
  type        = string
  description = "Name of the hub service role the EC2 instance role is allowed to assume. Leave empty to default to \"<resource_prefix>-hub-service-role\"."
  default     = ""
}

variable "ci_source_bucket" {
  type        = string
  description = "S3 bucket holding the zipped repo the instance pulls (CodeBuild source mirror). Empty disables the S3-pull policy."
  default     = ""
}

variable "ci_kms_key_arn" {
  type        = string
  description = "ARN of the CI CMK used to encrypt the source zip, so the instance can Decrypt on pull. Empty disables the KMS policy."
  default     = ""
}

variable "role_admin_arns" {
  type        = list(string)
  description = "Principal ARNs permitted to modify the instance role's policies. Everyone else (incl. the role itself if stolen) is denied via DenySelfModification. Empty skips the lock."
  default     = []
}

variable "tfstate_bucket" {
  type        = string
  description = "Central Terraform state bucket (created by the brain). Grants the instance role object RW on accounts/*. Empty skips the policy."
  default     = ""
}

variable "audit_logs_bucket" {
  type        = string
  description = "Host/operator audit-logs bucket (created by the brain). Grants the instance role PutObject on host/* + CloudWatch Logs. Empty skips."
  default     = ""
}

variable "enable_ssm_session_logging" {
  type        = bool
  description = "Create an SSM Session Manager preference doc that logs sessions to the audit bucket + CloudWatch. Requires audit_logs_bucket set."
  default     = false
}

variable "repo_url" {
  type        = string
  description = "Optional git URL to clone Mirage from on first boot (e.g. your fork's HTTPS/SSH clone URL). Leave empty to bring the code up yourself after launch."
  default     = ""
}

variable "repo_ref" {
  type        = string
  description = "Branch/tag to check out when repo_url is set."
  default     = "main"
}

variable "spoke_external_id" {
  type        = string
  description = "External ID the portal uses when assuming spoke roles (matches iam/spoke/deployment-role external_id). Written into the box's .env.local as MIRAGE_SPOKE_EXTERNAL_ID."
  default     = ""
}

variable "state_table" {
  type        = string
  description = "DynamoDB single-table name for portal state. Leave empty to default to \"<resource_prefix>-state\"."
  default     = ""
}

variable "alerts_table" {
  type        = string
  description = "DynamoDB table name for persisted decoy-access detections (Active Alerts). Leave empty to default to \"<resource_prefix>-alerts\"."
  default     = ""
}

variable "storage_backend" {
  type        = string
  description = "Portal storage backend written to .env.local: 'local' until the brain stack + table exist, then 'aws'."
  default     = "local"
}

variable "bootstrap_public_key" {
  type        = string
  description = "SSH public key for the ec2-user bootstrap key pair (break-glass SSH-over-SSM access; day-to-day access is via SSM Session Manager)."
}

# NOTE: ssh_allowed_cidrs / portal_allowed_cidrs removed 2026-09-17. The instance
# is private with NO inbound SG rules; all access is via SSM (git/SSH-over-SSM +
# dashboard port-forward). There is no public SSH or :3000 ingress to scope.
