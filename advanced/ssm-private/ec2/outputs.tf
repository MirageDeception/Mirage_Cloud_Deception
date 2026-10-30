output "instance_id" {
  value       = aws_instance.portal.id
  description = "EC2 instance ID"
}

output "ssm_connect" {
  value       = "aws ssm start-session --target ${aws_instance.portal.id} --region ${var.region}"
  description = "SSM Session Manager shell — no public IP / inbound needed, sessions logged in Systems Manager"
}

output "ebs_kms_key_arn" {
  value       = aws_kms_key.ebs.arn
  description = "CMK ARN used for EBS volume encryption (prevent_destroy = true)"
}

output "ebs_kms_key_alias" {
  value       = aws_kms_alias.ebs.name
  description = "Human-readable KMS key alias (alias/<resource_prefix>-portal-ebs)"
}

output "ami_id" {
  value       = data.aws_ami.al2023.id
  description = "AMI used for this instance"
}

output "instance_role_arn" {
  value       = aws_iam_role.portal_instance.arn
  description = "ARN of the EC2 portal instance role. Feed this into the hub service-role module's portal_instance_role_arn so the box can assume the hub service role (SSO-less dashboard)."
}

output "ssm_port_forward" {
  value       = "aws ssm start-session --target ${aws_instance.portal.id} --region ${var.region} --document-name AWS-StartPortForwardingSession --parameters '{\"portNumber\":[\"3000\"],\"localPortNumber\":[\"3000\"]}'"
  description = "Port-forward the portal to localhost:3000 over SSM (no inbound needed). Browse http://localhost:3000."
}

output "ssm_ssh_proxy" {
  value       = "ProxyCommand: aws ssm start-session --target ${aws_instance.portal.id} --document-name AWS-StartSSHSession --parameters portNumber=%p --region ${var.region}"
  description = "Add to ~/.ssh/config for git/ssh over SSM (no public IP / inbound) — useful for break-glass SSH access to the box."
}
