variable "region" {
  type        = string
  description = "AWS region for the hub VPC."
  default     = "us-west-2"
}

variable "resource_prefix" {
  type        = string
  description = "Prefix for every hub-infra resource name created by this module (VPC, subnets, NAT, route tables, endpoints, security groups)."
  default     = "mirage-ops"
}

variable "vpc_id" {
  type        = string
  description = <<EOT
Adopt an existing VPC by ID (e.g. <your-vpc-id>). When set, the module builds
subnets/NAT/route-tables/endpoints INTO it and does NOT create a VPC. Leave
empty to create a new VPC from vpc_cidr.
EOT
  default     = ""
}

variable "vpc_cidr" {
  type        = string
  description = "CIDR for a NEWLY-created VPC (ignored when vpc_id is set; the adopted VPC's own CIDR is used)."
  default     = "10.90.0.0/16"
}

variable "az_count" {
  type        = number
  description = "Number of AZs to spread subnets across."
  default     = 2

  validation {
    condition     = var.az_count >= 1 && var.az_count <= 3
    error_message = "az_count must be between 1 and 3."
  }
}

variable "enable_nat" {
  type        = bool
  description = "Create public subnets + IGW + NAT for outbound internet (npm installs, AWS SSO device-code login). Set false if egress is provided another way (Transit Gateway, proxy)."
  default     = true
}

variable "interface_endpoint_services" {
  type        = list(string)
  description = <<EOT
Interface VPC endpoints to create. STS is required for the SourceVpce hardening
(binding the EC2 instance role's assumed hub-service-role creds to on-box use).
SSM/SSMMessages/EC2Messages enable Session Manager without public ingress.
EOT
  default = [
    "sts",
    "ssm",
    "ssmmessages",
    "ec2messages",
  ]
}
