variable "account_id" {
  type        = string
  description = "AWS account ID where this role is being created"
}

variable "region" {
  type        = string
  description = "AWS region"
  default     = "us-west-2"
}

variable "hub_account_id" {
  type        = string
  description = "Hub account ID (where the hub event bus lives). Required - no default."
}

variable "resource_prefix" {
  type        = string
  description = "Prefix applied to every resource name this module creates or references, so it matches the hub's MIRAGE_RESOURCE_PREFIX convention"
  default     = "mirage-ops"
}

variable "hub_region" {
  type        = string
  description = "Hub AWS region"
  default     = "us-west-2"
}
