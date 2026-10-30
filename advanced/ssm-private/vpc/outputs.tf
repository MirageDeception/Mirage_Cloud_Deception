output "vpc_id" {
  value       = local.vpc_id
  description = "Hub VPC ID (adopted or created). Feed into the ec2/ module's vpc_id."
}

output "private_subnet_ids" {
  value       = aws_subnet.private[*].id
  description = "Private subnet IDs for the portal EC2 host."
}

output "public_subnet_ids" {
  value       = aws_subnet.public[*].id
  description = "Public subnet IDs (empty unless enable_nat = true)."
}

output "sts_vpc_endpoint_id" {
  value       = try(aws_vpc_endpoint.interface["sts"].id, null)
  description = <<EOT
STS interface endpoint ID. Use this as the aws:SourceVpce value on the hub
service-role trust condition for the EC2 instance-role principal, so the
assumed credentials are only usable from inside this VPC (on-box).
EOT
}

output "interface_endpoint_ids" {
  value       = { for k, v in aws_vpc_endpoint.interface : k => v.id }
  description = "Map of service name -> interface VPC endpoint ID."
}

output "s3_gateway_endpoint_id" {
  value       = aws_vpc_endpoint.s3.id
  description = "S3 gateway endpoint ID (keeps the CI code-pull on the backbone)."
}

output "endpoints_security_group_id" {
  value       = aws_security_group.endpoints.id
  description = "Security group attached to the interface endpoints."
}
