output "discovery_role_arn" {
  description = "ARN of the discovery role (infra-params-readonly-role)"
  value       = aws_iam_role.infra_params_readonly_role.arn
}

output "primary_param_arn" {
  description = "ARN of the /prod/db/primary SSM parameter"
  value       = "arn:aws:ssm:${data.aws_region.current.name}:${var.account_id}:parameter${aws_ssm_parameter.db_primary_param.name}"
}

output "replica_param_arn" {
  description = "ARN of the /prod/db/replica SSM parameter"
  value       = "arn:aws:ssm:${data.aws_region.current.name}:${var.account_id}:parameter/prod/db/replica"
}

output "backup_config_param_arn" {
  description = "ARN of the /prod/db/backup-config SSM parameter"
  value       = "arn:aws:ssm:${data.aws_region.current.name}:${var.account_id}:parameter/prod/db/backup-config"
}

output "encryption_config_param_arn" {
  description = "ARN of the /prod/db/encryption-config SSM parameter"
  value       = "arn:aws:ssm:${data.aws_region.current.name}:${var.account_id}:parameter/prod/db/encryption-config"
}

output "monitoring_param_arn" {
  description = "ARN of the /prod/db/monitoring SSM parameter"
  value       = "arn:aws:ssm:${data.aws_region.current.name}:${var.account_id}:parameter/prod/db/monitoring"
}

output "decoy_resources" {
  description = "JSON array of decoy resources for EventBridge rule generation"
  value = jsonencode([
    {
      category  = "iam"
      resources = aws_iam_role.infra_params_readonly_role.name
    },
    {
      category = "ssm"
      # db_encryption_config_param was missing from this list: the parameter was
      # deployed, so GetParameter on /prod/db/encryption-config was possible but
      # unwatched, and populate could not resolve it. Of the five parameters this
      # scenario creates it is the most attractive to an attacker, so it was the
      # worst one to leave uncovered.
      resources = "${aws_ssm_parameter.db_primary_param.name},${aws_ssm_parameter.db_replica_param.name},${aws_ssm_parameter.db_backup_config_param.name},${aws_ssm_parameter.db_encryption_config_param.name},${aws_ssm_parameter.db_monitoring_param.name}"
    },
  ])
}
