# Example service credentials

Description: A lure IAM role that can read one Secrets Manager secret holding fake, expired service credentials. Assuming the role or reading the secret raises an alert.

**Resources Deployed:**
- `example-config-readonly-role` (aws_iam_role)
- `prod/example-service/api-credentials` (aws_secretsmanager_secret)
