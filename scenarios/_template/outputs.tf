# REQUIRED. The portal reads this after deploy to build the forwarding rule that
# watches your decoys. A decoy missing from here is deployed but NEVER alerts.
#
# One entry per category. `category` must be one the alarm pipeline can match
# (iam, s3, secretsmanager, ssm, dynamodb, kms, ecr, lambda, cloudformation, logs,
# sqs, sns -- see portal/src/lib/decoy-match.ts). `resources` is the decoy's NAME
# (comma-separated for several), not its ARN.
output "decoy_resources" {
  description = "A JSON mapping of decoy resources to their service category"
  value = jsonencode([
    {
      category  = "iam"
      resources = aws_iam_role.lure.name
    },
    {
      category  = "secretsmanager"
      resources = aws_secretsmanager_secret.decoy.name
    }
  ])
}
