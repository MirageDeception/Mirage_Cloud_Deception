output "database_endpoint" {
  description = "Production RDS PostgreSQL primary endpoint"
  value       = "prod-core-db.c9aksj2e7rzo.us-west-2.rds.amazonaws.com"
}

output "database_password" {
  description = "Production database master password (decoy credential — intentionally fake)"
  value       = "Pr0d#Db$M@ster!2026xKqL9"
  sensitive   = true
}

output "api_gateway_url" {
  description = "Production API Gateway base URL"
  value       = "https://k7x9m2p4q1.execute-api.us-west-2.amazonaws.com/prod"
}

output "api_key" {
  description = "Production API Gateway API key (decoy credential — intentionally fake)"
  value       = "ak_prod_V8kN3mP7qR2wX5jL9tY4bF6hC1dA0eG"
  sensitive   = true
}

output "redis_endpoint" {
  description = "Production ElastiCache Redis primary endpoint"
  value       = "prod-cache.r3k8m2.0001.usw2.cache.amazonaws.com"
}

output "redis_auth_token" {
  description = "Production Redis AUTH token (decoy credential — intentionally fake)"
  value       = "rT#2026pR0d!cAcHe$sEcUrE9xMkL3"
  sensitive   = true
}

output "admin_dashboard_url" {
  description = "Production admin dashboard URL"
  value       = "https://admin.prod.internal.corp"
}

output "vpc_id" {
  description = "Production VPC ID"
  value       = "vpc-0a1b2c3d4e5f67890"
}

output "private_subnet_ids" {
  description = "Production private subnet IDs (comma-separated)"
  value       = "subnet-0a1b2c3d4e5f6789a,subnet-0b2c3d4e5f6789a1b"
}

output "db_security_group_id" {
  description = "Production database security group ID"
  value       = "sg-0a1b2c3d4e5f67890"
}

output "discovery_role_arn" {
  description = "ARN of the discovery role (cfn-audit-readonly-role)"
  value       = aws_iam_role.cfn_audit_readonly_role.arn
}

output "decoy_resources" {
  description = "JSON array of decoy resources for EventBridge rule generation"
  value = jsonencode([
    {
      category  = "iam"
      resources = aws_iam_role.cfn_audit_readonly_role.name
    },
    {
      category  = "ssm"
      resources = "${aws_ssm_parameter.infra_endpoint_param.name},${aws_ssm_parameter.infra_secrets_param.name}"
    },
  ])
}
