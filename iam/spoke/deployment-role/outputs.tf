output "role_arn" {
  description = "ARN of the spoke deployment role"
  value       = aws_iam_role.this.arn
}

output "role_name" {
  description = "Name of the spoke deployment role"
  value       = aws_iam_role.this.name
}

output "policy_arns" {
  description = "ARNs of the managed policies attached to the deployment role"
  value       = { for name, p in aws_iam_policy.this : name => p.arn }
}

# Headroom check. Each managed policy is capped at 6,144 characters and the full
# action set already overflowed a single policy once, so surface the live numbers
# rather than leaving the next person to rediscover the ceiling. A precondition on
# aws_iam_policy.this fails the plan if any group goes over.
output "policy_sizes" {
  description = "Rendered size of each managed policy in characters (IAM limit: 6144 each)"
  value       = { for name, doc in local.policy_documents : name => length(doc) }
}
