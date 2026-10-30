output "discovery_role_arn" {
  description = "ARN of the discovery role (session-store-readonly-role)"
  value       = aws_iam_role.session_store_readonly_role.arn
}

output "table_arn" {
  description = "ARN of the lure DynamoDB table"
  value       = aws_dynamodb_table.active_sessions_table.arn
}

output "table_name" {
  description = "Name of the lure DynamoDB table"
  value       = aws_dynamodb_table.active_sessions_table.id
}

output "decoy_resources" {
  description = "JSON-formatted string of deployed resources for EventBridge rule generation"
  value = jsonencode([
    {
      category  = "iam"
      resources = aws_iam_role.session_store_readonly_role.name
    },
    {
      category  = "dynamodb"
      resources = aws_dynamodb_table.active_sessions_table.name
    }
  ])
}
