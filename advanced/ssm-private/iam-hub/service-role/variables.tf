variable "hub_account_id" {
  type        = string
  description = "Hub AWS account ID"
}

variable "hub_region" {
  type        = string
  description = "Hub AWS region"
  default     = "us-west-2"
}

variable "resource_prefix" {
  type        = string
  description = "Prefix for every hub-infra resource name created by this module (IAM role, policies) and referenced from other accounts' roles (spoke-deployment-role, brain-deployment-role)."
  default     = "mirage-ops"
}

variable "org_id" {
  type        = string
  description = "AWS Organization ID — scopes AssumeRole to any account in the org"
}

variable "allowed_sso_user_ids" {
  type        = list(string)
  description = <<EOT
Per-user SSO session IDs allowed to assume this role.
Format: <RoleId>:<email>  — from `aws sts get-caller-identity` UserId field.
Matched via aws:userId StringEquals — scoped to the specific named user only,
not the entire permission set. Anyone else with ADMIN cannot assume this role.
EOT
  default = [
    "AROAEXAMPLE123456789:you@example.com",
  ]
}

variable "portal_instance_role_arn" {
  type        = string
  description = <<EOT
ARN of the Mirage EC2 portal instance role (from the ec2/ module) allowed to
assume this hub service role, so the dashboard can operate without interactive
SSO. Empty disables the machine principal (SSO-only mode). A dedicated-VPC
SourceVpce condition should be added here once the vpc/ module exists, to bind
these assumed credentials to on-box use.
EOT
  default     = ""
}

variable "portal_sts_vpc_endpoint_id" {
  type        = string
  description = <<EOT
STS interface VPC endpoint id (from the vpc/ module, e.g. vpce-071db70f75cdda4b9).
When set, the AllowPortalInstanceRole trust statement adds an aws:SourceVpce
condition so the instance role can assume this role ONLY from inside that VPC.
Empty = OrgID-only (no VPC binding).
EOT
  default     = ""
}

variable "role_admin_arns" {
  type        = list(string)
  description = <<EOT
Principal ARNs permitted to modify this role's trust/inline policies. Everyone
else (including this role itself, if its credentials are stolen) is denied via
an explicit DenySelfModification statement. Leave empty to skip the lock.
EOT
  default     = []
}
