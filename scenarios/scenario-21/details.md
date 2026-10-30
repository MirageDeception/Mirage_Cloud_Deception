# Scenerio-21

Description: A lure finance role that can read a fake, expired accounting-platform API key from SSM Parameter Store. Assuming the role or reading the parameter raises an alert.

**Resources Deployed:**
- `finance-ledger-export-role` (aws_iam_role)
- `/prod/finance/ledger-export-api-key` (aws_ssm_parameter)
