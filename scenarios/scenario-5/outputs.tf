output "ecr_repo_uri" {
  description = "URI of the lure ECR repository"
  value       = "${var.account_id}.dkr.ecr.${data.aws_region.current.name}.amazonaws.com/${aws_ecr_repository.payment_service_repo.name}"
}

output "ecr_repo_arn" {
  description = "ARN of the lure ECR repository"
  value       = aws_ecr_repository.payment_service_repo.arn
}

output "instance_profile_arn" {
  description = "ARN of the lure instance profile (optional; unused when this scenario is deployed standalone)"
  value       = aws_iam_instance_profile.bastion_instance_profile.arn
}

output "instance_profile_name" {
  description = "Name of the instance profile"
  value       = aws_iam_instance_profile.bastion_instance_profile.name
}

output "decoy_resources" {
  description = "JSON array of decoy resources for EventBridge rule generation"
  value = jsonencode([
    {
      category  = "iam"
      resources = aws_iam_role.bastion_ecr_role.name
    },
    {
      category  = "ecr"
      resources = aws_ecr_repository.payment_service_repo.name
    },
  ])
}
