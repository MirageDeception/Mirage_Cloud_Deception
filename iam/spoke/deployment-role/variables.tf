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
  description = "Hub account ID (the hub service role lives here). Required - no default."
}

variable "resource_prefix" {
  type        = string
  description = "Prefix applied to every resource/policy name this module creates or references, so it matches the hub's MIRAGE_RESOURCE_PREFIX convention"
  default     = "mirage-ops"
}

# No default: each hub install generates its own ExternalId (hub-bootstrap.yaml's
# ExternalId output), and a committed value would be shared by every install.
# One ID is shared across all spokes of the same hub.
variable "external_id" {
  type        = string
  description = "External ID required by the trust policy — prevents confused deputy attacks. Must match the hub's ExternalId stack output (the portal's MIRAGE_SPOKE_EXTERNAL_ID)."
}

variable "org_id" {
  type        = string
  description = "AWS Organizations ID — restricts trust to callers within the org even if ExternalId leaks. Required - no default."
}

variable "trusted_principal_arns" {
  type        = list(string)
  description = "Optional operator ARNs for direct access. Leave empty to restrict to hub service role only."
  default     = []
}
