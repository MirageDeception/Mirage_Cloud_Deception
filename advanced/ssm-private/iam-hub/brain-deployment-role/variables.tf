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
  description = "Prefix for every hub-infra resource name created or referenced by this module (IAM role/policy, CloudFormation stacks, Lambda, SNS, EventBridge, log groups, DynamoDB tables, S3 buckets)."
  default     = "mirage-ops"
}

variable "trusted_principal_arns" {
  type        = list(string)
  description = "IAM principal ARNs (users or roles) allowed to assume this role"
}
