output "decoy_resources" {
  description = "A JSON mapping of decoy resources to their service category"
  value = jsonencode([
    {
      category  = "iam"
      resources = aws_iam_role.ledger_export.name
    },
    {
      category  = "ssm"
      resources = aws_ssm_parameter.ledger_api_key.name
    }
  ])
}
