terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 5.0" }
  }
  # Local state: this is a single-operator, opt-in advanced module with no
  # pre-existing state bucket to point a backend at. State lives in
  # terraform.tfstate next to the config.
}

provider "aws" {
  region = var.region
}

# =============================================================================
# Mirage hub VPC (handoff module for the network team).
#
# Purpose: give the Mirage portal EC2 host a dedicated VPC with an interface
# STS endpoint, so the EC2 instance role's assumed hub-service-role credentials
# can be bound to on-box use via an aws:SourceVpce condition on the hub service
# role trust policy (see iam/hub/service-role, portal_instance_role_arn). Also
# provides an S3 gateway endpoint so the code-pull (s3:GetObject) stays on the
# AWS backbone.
#
# Standalone: apply this first, then feed vpc_id / private_subnet_ids /
# sts_vpc_endpoint_id into the ec2/ module and the hub service-role SourceVpce
# condition. No dependency on the rest of the platform.
# =============================================================================

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  az_names = slice(data.aws_availability_zones.available.names, 0, var.az_count)
  # Adopt a pre-created VPC when vpc_id is set; otherwise fall back to creating
  # one. This module builds subnets/NAT/route-tables/endpoints INTO whichever
  # VPC is selected.
  adopt    = var.vpc_id != ""
  vpc_id   = local.adopt ? data.aws_vpc.existing[0].id : aws_vpc.this[0].id
  vpc_cidr = local.adopt ? data.aws_vpc.existing[0].cidr_block : var.vpc_cidr
}

data "aws_vpc" "existing" {
  count = var.vpc_id != "" ? 1 : 0
  id    = var.vpc_id
}

resource "aws_vpc" "this" {
  count                = var.vpc_id == "" ? 1 : 0
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name      = "${var.resource_prefix}-hub-vpc"
    Project   = "${var.resource_prefix}-platform"
    ManagedBy = "terraform"
  }
}

# NOTE: interface VPC endpoints with private DNS require BOTH enableDnsSupport
# and enableDnsHostnames = true on the VPC. If you are adopting a pre-existing
# VPC, confirm both are on; there is no dedicated TF resource for this on an
# adopted VPC. Enable it out-of-band if needed with:
#   aws ec2 modify-vpc-attribute --vpc-id <id> --enable-dns-hostnames
# A VPC created by this module already sets both attributes on aws_vpc.this
# above.

# ── Subnets ────────────────────────────────────────────────────────────────
# Private subnets host the portal EC2 (reached via SSM, no public ingress).
# A public subnet + NAT is optional (var.enable_nat) for outbound internet
# (npm/AWS SSO device-code) if you do not route egress another way.
resource "aws_subnet" "private" {
  count             = var.az_count
  vpc_id            = local.vpc_id
  cidr_block        = cidrsubnet(local.vpc_cidr, 4, count.index)
  availability_zone = local.az_names[count.index]

  tags = {
    Name      = "${var.resource_prefix}-hub-private-${local.az_names[count.index]}"
    Tier      = "private"
    Project   = "${var.resource_prefix}-platform"
    ManagedBy = "terraform"
  }
}

resource "aws_subnet" "public" {
  count                   = var.enable_nat ? var.az_count : 0
  vpc_id                  = local.vpc_id
  cidr_block              = cidrsubnet(local.vpc_cidr, 4, count.index + 8)
  availability_zone       = local.az_names[count.index]
  map_public_ip_on_launch = false

  tags = {
    Name      = "${var.resource_prefix}-hub-public-${local.az_names[count.index]}"
    Tier      = "public"
    Project   = "${var.resource_prefix}-platform"
    ManagedBy = "terraform"
  }
}

# ── Internet + NAT (optional) ────────────────────────────────────────────────
resource "aws_internet_gateway" "this" {
  count  = var.enable_nat ? 1 : 0
  vpc_id = local.vpc_id

  tags = {
    Name      = "${var.resource_prefix}-hub-igw"
    ManagedBy = "terraform"
  }
}

resource "aws_eip" "nat" {
  count  = var.enable_nat ? 1 : 0
  domain = "vpc"

  tags = {
    Name      = "${var.resource_prefix}-hub-nat-eip"
    ManagedBy = "terraform"
  }
}

resource "aws_nat_gateway" "this" {
  count         = var.enable_nat ? 1 : 0
  allocation_id = aws_eip.nat[0].id
  subnet_id     = aws_subnet.public[0].id
  depends_on    = [aws_internet_gateway.this]

  tags = {
    Name      = "${var.resource_prefix}-hub-nat"
    ManagedBy = "terraform"
  }
}

# ── Route tables ─────────────────────────────────────────────────────────────
resource "aws_route_table" "private" {
  vpc_id = local.vpc_id

  tags = {
    Name      = "${var.resource_prefix}-hub-private-rt"
    ManagedBy = "terraform"
  }
}

resource "aws_route" "private_nat" {
  count                  = var.enable_nat ? 1 : 0
  route_table_id         = aws_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this[0].id
}

resource "aws_route_table_association" "private" {
  count          = var.az_count
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

resource "aws_route_table" "public" {
  count  = var.enable_nat ? 1 : 0
  vpc_id = local.vpc_id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this[0].id
  }

  tags = {
    Name      = "${var.resource_prefix}-hub-public-rt"
    ManagedBy = "terraform"
  }
}

resource "aws_route_table_association" "public" {
  count          = var.enable_nat ? var.az_count : 0
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public[0].id
}

# ── Security group for interface endpoints ───────────────────────────────────
# Allows HTTPS from within the VPC to the interface endpoints (STS, SSM, etc).
resource "aws_security_group" "endpoints" {
  name        = "${var.resource_prefix}-hub-vpce-sg"
  description = "HTTPS from the VPC to interface VPC endpoints"
  vpc_id      = local.vpc_id

  ingress {
    description = "HTTPS from within the VPC"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [local.vpc_cidr]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name      = "${var.resource_prefix}-hub-vpce-sg"
    ManagedBy = "terraform"
  }
}

# ── S3 gateway endpoint ──────────────────────────────────────────────────────
# Keeps the EC2 code-pull (s3:GetObject of the CI source zip) on the backbone.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = local.vpc_id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]

  tags = {
    Name      = "${var.resource_prefix}-hub-s3-gw"
    ManagedBy = "terraform"
  }
}

# ── Interface endpoints (STS is the key one for SourceVpce hardening) ────────
resource "aws_vpc_endpoint" "interface" {
  for_each = toset(var.interface_endpoint_services)

  vpc_id              = local.vpc_id
  service_name        = "com.amazonaws.${var.region}.${each.value}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.private[*].id
  security_group_ids  = [aws_security_group.endpoints.id]
  private_dns_enabled = true

  tags = {
    Name      = "${var.resource_prefix}-hub-${each.value}-vpce"
    ManagedBy = "terraform"
  }
}
