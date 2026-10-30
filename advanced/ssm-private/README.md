# Advanced: SSM-only private hub (optional)

This is an **optional, hardened** alternative to the default `hub/hub-bootstrap.yaml`
path. Where the default path launches a single public-IP EC2 instance from one
CloudFormation template, this path puts the portal host in a **private subnet with no
public IP**, reachable only through **SSM Session Manager**, fronted by a VPC with a
NAT gateway and interface VPC endpoints.

Use the default `hub/hub-bootstrap.yaml` unless you specifically want:

- No public IP on the portal instance, and no inbound security-group rules at all.
- All access (shell, dashboard port-forward) over SSM Session Manager instead of SSH
  or a public `:3000` listener.
- The EC2 instance role's assumed hub-service-role credentials bound to on-box use via
  an `aws:SourceVpce` condition (so stolen credentials are useless off the VPC).
- Separate Terraform modules you apply and manage individually, instead of one
  CloudFormation stack.

This is more infrastructure to run and pay for (NAT gateway + per-AZ interface
endpoints bill hourly) in exchange for a smaller network attack surface. It's designed
for a **single operator** — there's no multi-user onboarding, shared dev box, or
per-person workspace tooling here.

## Modules, in apply order

Each module is its own Terraform root with **local state** (no shared backend to
bootstrap first — just `terraform init && terraform apply` in each directory with the
right AWS credentials). Apply them in this order; each one's outputs feed the next
module's variables:

1. **`vpc/`** — Creates (or adopts) a VPC with private subnets, an optional NAT
   gateway, an S3 gateway endpoint, and interface endpoints (`sts`, `ssm`,
   `ssmmessages`, `ec2messages`). No dependency on anything else in this directory.
   Outputs `vpc_id`, `private_subnet_ids`, and `sts_vpc_endpoint_id` feed into `ec2/`
   and `iam-hub/service-role/`.

2. **`ec2/`** — Launches the portal EC2 instance into the VPC's private subnet(s),
   with an IAM instance role/profile, an EBS encryption CMK, a security group with no
   inbound rules, and a userdata script that bootstraps the box (Node, Terraform,
   SSH hardening, optional audit logging, and — if you set `repo_url` — a clone +
   build + start of the portal). Needs `vpc/`'s `vpc_id` and a `private_subnet_ids`
   entry as `subnet_id`. Its `instance_role_arn` output feeds
   `iam-hub/service-role/`'s `portal_instance_role_arn`.

3. **`iam-hub/service-role/`** — Creates the hub service role: the "jump role" that
   named SSO users (and, optionally, the portal instance role) assume to reach spoke
   deployment roles or the brain deployment role. Takes `ec2/`'s `instance_role_arn`
   as `portal_instance_role_arn` (optional — omit it to run SSO-only, no machine
   principal) and `vpc/`'s `sts_vpc_endpoint_id` as `portal_sts_vpc_endpoint_id`
   (optional — binds the portal's assumed credentials to on-box use once set). Its
   `role_arn` output feeds `iam-hub/brain-deployment-role/`'s `trusted_principal_arns`.

4. **`iam-hub/brain-deployment-role/`** — Creates the role that deploys the hub's
   monitoring/detection CloudFormation stacks (the "brain"). Takes the hub service
   role's `role_arn` as (one entry in) `trusted_principal_arns`, so only the service
   role — not arbitrary principals — can assume it.

Each module has a `terraform.tfvars.example` — copy it to `terraform.tfvars` and fill
in your own account IDs, org ID, and VPC/subnet IDs before applying.

```
cd vpc                      && terraform init && terraform apply
cd ../ec2                    && terraform init && terraform apply
cd ../iam-hub/service-role   && terraform init && terraform apply
cd ../brain-deployment-role  && terraform init && terraform apply
```

To tear everything down again (reverse order, with the extra steps the EBS CMK's
`prevent_destroy` guard requires), see `teardown.sh` in this directory.

## `resource_prefix`

Every module takes a `resource_prefix` variable (default `"mirage-ops"`) that's
threaded into every resource name it creates — the VPC and its subnets/NAT/endpoints,
the portal instance role and KMS alias, the hub service role, the brain deployment
role, CloudFormation stack names, DynamoDB tables, S3 buckets, and so on. Set it the
same way in every module (and in `hub/hub-bootstrap.yaml`'s `ResourcePrefix`, if you're
also using pieces of the default path) so names match up across modules.

## State

Each module keeps its own local `terraform.tfstate` next to its config — there's no
shared S3 backend to stand up first. That's a deliberate simplification: the chicken-
and-egg problem of "where does the state bucket's own state live" doesn't apply to a
single-operator deployment the way it does to a shared one. If you later want remote
state (e.g. to collaborate with a second operator), add a `backend "s3" {}` block to
each module's `terraform { }` block yourself.
