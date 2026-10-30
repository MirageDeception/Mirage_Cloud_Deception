# Mirage hub VPC (network-team handoff)

Standalone Terraform for a dedicated VPC in the **hub** account that
hosts the Mirage portal EC2 instance. It exists mainly so the EC2 instance role's
assumed hub-service-role credentials can be **bound to on-box use** via an
`aws:SourceVpce` condition (see "Why" below).

This module has no dependency on the rest of the platform. Apply it first, then feed its
outputs into `ec2/` and the hub service-role trust condition.

## What it creates

- A VPC (`var.vpc_cidr`, default `10.90.0.0/16`) with DNS support/hostnames on.
- `var.az_count` private subnets (default 2) for the portal host (reached via SSM; no
  public ingress).
- Optional public subnets + IGW + NAT (`var.enable_nat`, default true) for outbound
  internet (npm installs, AWS SSO device-code login). Set false if egress is provided by
  Transit Gateway / proxy.
- An **S3 gateway endpoint** (keeps the CI code-pull `s3:GetObject` on the AWS backbone).
- **Interface endpoints** for `sts`, `ssm`, `ssmmessages`, `ec2messages`
  (`var.interface_endpoint_services`). `sts` is the one the hardening depends on; the SSM
  trio enables Session Manager without public ingress.
- A security group allowing HTTPS from within the VPC to those interface endpoints.

## Variables

| Variable | Default | Purpose |
|---|---|---|
| `region` | `us-west-2` | Region for the VPC. |
| `resource_prefix` | `mirage-ops` | Prefix for every resource name this module creates. |
| `vpc_cidr` | `10.90.0.0/16` | VPC CIDR — **adjust to the network team's IPAM plan**. |
| `az_count` | `2` | AZ spread (1-3). |
| `enable_nat` | `true` | Public subnets + IGW + NAT for outbound internet. |
| `interface_endpoint_services` | `[sts, ssm, ssmmessages, ec2messages]` | Interface VPC endpoints. |

## Outputs (consumed downstream)

| Output | Consumed by |
|---|---|
| `vpc_id` | `ec2/` module `vpc_id` variable. |
| `private_subnet_ids` | where the portal EC2 launches. |
| `sts_vpc_endpoint_id` | the `aws:SourceVpce` value on the hub service-role trust condition. |
| `s3_gateway_endpoint_id`, `interface_endpoint_ids` | reference/audit. |

## How the platform consumes it (after apply)

1. `cd vpc && terraform init && terraform apply` (hub account creds).
2. Take `vpc_id` -> set `ec2/terraform.tfvars` `vpc_id`. Re-apply `ec2/` so the portal lands
   in a private subnet of this VPC.
3. Take `sts_vpc_endpoint_id` -> add an `aws:SourceVpce` StringEquals condition to the
   `AllowPortalInstanceRole` statement in `iam/hub/service-role/main.tf` (currently only
   conditioned on `aws:PrincipalOrgID`; the code has a placeholder note for this). Re-apply
   the hub service-role. Now the instance role can assume the hub service role **only** from
   inside this VPC — exfiltrated credentials are useless off-box.

## Notes

- PAY-as-you-go: interface endpoints bill hourly per-AZ + per-GB. Four services x 2 AZs is
  the main recurring cost of this module; drop `enable_nat` or trim endpoints to reduce it.
- No `prevent_destroy` guards here — this is infrastructure the network team owns and may
  re-shape. Coordinate before destroying once the portal depends on it.
