terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 5.0" }
  }
}

provider "aws" {
  region = var.region
}

# Apply in Spoke account (222222222222)
#
# Primary security control: trust chain.
# Only ${var.resource_prefix}-hub-service-role (cross-account) and explicit operator ARNs
# can assume this role. Attacker-compromised spoke credentials cannot.
# Resource-level scoping is by service + account, not by name or tag,
# so deployed resources carry no fingerprint that identifies them as lures.

locals {
  hub_service_role_arn = "arn:aws:iam::${var.hub_account_id}:role/${var.resource_prefix}-hub-service-role"
  all_principals       = concat([local.hub_service_role_arn], var.trusted_principal_arns)
}

resource "aws_iam_role" "this" {
  name        = "${var.resource_prefix}-spoke-deployment-role"
  description = "Assumed by hub service role to deploy scenarios in this spoke account"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowHubServiceRoleAndOperator"
      Effect    = "Allow"
      Principal = { AWS = local.all_principals }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = {
          "sts:ExternalId"     = var.external_id
          "aws:PrincipalOrgID" = var.org_id
        }
      }
    }]
  })

  tags = {
    Project   = "${var.resource_prefix}-platform"
    ManagedBy = "terraform"
  }
}

# Permissions are split across three CUSTOMER-MANAGED policies rather than one
# inline policy, because the full action set does not fit in an inline policy.
#
# AWS caps a role's inline policy at 10,240 characters, and that cap is the AGGREGATE
# of every inline policy on the role — so splitting into several inline policies does
# not buy any room. The complete statement set renders to ~10.6k characters, which
# means the previous single aws_iam_role_policy could not be applied at all; it failed
# LimitExceeded. Managed policies are capped per-policy instead (6,144 characters
# each, at least 10 attachable per role), so three groups leave generous headroom for
# scenarios added later.
#
# The grouping is by service domain and carries no security meaning: IAM unions every
# attached policy, and an explicit Deny in any one of them still overrides an Allow in
# the others. When adding a statement, put it in whichever group fits and check the
# rendered size with the policy_sizes output below.
locals {
  # Deploy-time control plane: CloudFormation, EventBridge forwarding rules, and the
  # IAM surface used to build lure roles.
  statements_control = [

    # ── CloudFormation ───────────────────────────────────────────────────────
    # Covers the forwarding stack + any scenario stacks
    {
      Sid    = "CloudFormation"
      Effect = "Allow"
      Action = [
        "cloudformation:CreateStack",
        "cloudformation:UpdateStack",
        "cloudformation:DeleteStack",
        "cloudformation:DescribeStacks",
        "cloudformation:DescribeStackEvents",
        "cloudformation:DescribeStackResources",
        "cloudformation:GetTemplate",
        "cloudformation:ListStacks",
        "cloudformation:ListStackResources",
        # aws cloudformation deploy works through change sets, not direct
        # Create/UpdateStack. Required to deploy the forwarding + scenario stacks.
        "cloudformation:CreateChangeSet",
        "cloudformation:DeleteChangeSet",
        "cloudformation:DescribeChangeSet",
        "cloudformation:ExecuteChangeSet"
      ]
      Resource = "arn:aws:cloudformation:*:${var.account_id}:stack/*"
    },
    {
      Sid    = "CloudFormationValidate"
      Effect = "Allow"
      Action = [
        # ValidateTemplate and GetTemplateSummary do not support resource-level
        # ARN scoping in IAM (AWS limitation — the call is stateless and has no
        # associated stack ARN).
        "cloudformation:ValidateTemplate",
        "cloudformation:GetTemplateSummary"
      ]
      Resource = "*"
    },

    # ── EventBridge — forwarding rules in this account ───────────────────────
    {
      Sid    = "EventBridgeForwardingRules"
      Effect = "Allow"
      Action = [
        "events:PutRule",
        "events:DeleteRule",
        "events:DescribeRule",
        "events:EnableRule",
        "events:DisableRule",
        "events:PutTargets",
        "events:RemoveTargets",
        "events:ListRules",
        "events:ListTargetsByRule",
        "events:TagResource",
        "events:UntagResource"
      ]
      Resource = "arn:aws:events:*:${var.account_id}:rule/${var.resource_prefix}-fwd-*"
    },
    # ListEventBuses / DescribeEventBus — the Terraform AWS provider calls these
    # when managing EventBridge rules to validate the default and named buses.
    # These actions do not support rule/* resource scoping; scoped to this
    # account's event-bus/* ARN prefix instead.
    {
      Sid    = "EventBridgeBusRead"
      Effect = "Allow"
      Action = [
        "events:ListEventBuses",
        "events:DescribeEventBus"
      ]
      Resource = "arn:aws:events:*:${var.account_id}:event-bus/*"
    },

    # ── IAM — lure role lifecycle ────────────────────────────────────────────
    # Scoped to account. Names will be randomized — no prefix scoping.
    {
      Sid    = "IAMRoles"
      Effect = "Allow"
      Action = [
        "iam:CreateRole",
        "iam:DeleteRole",
        "iam:GetRole",
        "iam:UpdateRole",
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:GetRolePolicy",
        "iam:ListRolePolicies",
        "iam:ListAttachedRolePolicies",
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy",
        # The AWS provider calls ListInstanceProfilesForRole when DELETING any
        # aws_iam_role (to detach it from profiles first). Required for every
        # scenario teardown, not just EC2 ones - without it terraform destroy
        # AccessDenies on the role. The profile lifecycle itself is granted
        # separately in IAMInstanceProfiles below.
        "iam:ListInstanceProfilesForRole",
        "iam:TagRole",
        "iam:UntagRole",
        # Required to seed trust policies on lure roles during scenario deploy.
        # DenySelfModification below pins this role's own trust policy shut. The
        # forwarding role's trust stays writable on purpose: deploy-rule keeps it in
        # its one fixed form (any-region <prefix>-fwd-* rules of this account).
        "iam:UpdateAssumeRolePolicy"
      ]
      Resource = "arn:aws:iam::${var.account_id}:role/*"
    },
    # PassRole scoped by service — allows passing lure Lambda execution roles,
    # forwarding role, and any CloudFormation service role used by a scenario.
    {
      Sid      = "IAMPassRoleToServices"
      Effect   = "Allow"
      Action   = "iam:PassRole"
      Resource = "arn:aws:iam::${var.account_id}:role/*"
      Condition = {
        StringEquals = {
          "iam:PassedToService" = [
            "lambda.amazonaws.com",
            "events.amazonaws.com",
            # CloudFormation service role — required when a scenario stack uses
            # an explicit service role (aws cloudformation deploy --role-arn).
            "cloudformation.amazonaws.com"
          ]
        }
      }
    },
    # Customer-managed policy lifecycle — several scenarios (e.g. scenario-1)
    # attach an aws_iam_policy to their lure role. Scoped to account policy/*.
    # NOTE: PutRolePolicy on role/* is already allowed above, so the inline
    # path to attach a policy to a lure role exists regardless; permitting the
    # managed path adds no escalation surface that inline didn't already have.
    {
      Sid    = "IAMManagedPolicies"
      Effect = "Allow"
      Action = [
        "iam:CreatePolicy",
        "iam:DeletePolicy",
        "iam:GetPolicy",
        "iam:GetPolicyVersion",
        "iam:ListPolicyVersions",
        "iam:CreatePolicyVersion",
        "iam:DeletePolicyVersion",
        "iam:SetDefaultPolicyVersion",
        "iam:ListEntitiesForPolicy",
        "iam:TagPolicy",
        "iam:UntagPolicy"
      ]
      Resource = "arn:aws:iam::${var.account_id}:policy/*"
    },
    # IAM SAML provider — scenario 15 (fake Okta SSO)
    {
      Sid    = "IAMSAMLProvider"
      Effect = "Allow"
      Action = [
        "iam:CreateSAMLProvider",
        "iam:DeleteSAMLProvider",
        "iam:UpdateSAMLProvider",
        "iam:GetSAMLProvider",
        "iam:ListSAMLProviders",
        "iam:TagSAMLProvider",
        "iam:UntagSAMLProvider"
      ]
      Resource = "arn:aws:iam::${var.account_id}:saml-provider/*"
    },
    # IAM instance profile — scenario 15 (fake Okta SSO) is the SAML case above;
    # this covers scenario 5's aws_iam_instance_profile ("prod-bastion-ecr-profile"),
    # the lure that makes an ECR-pulling bastion look real. AddRoleToInstanceProfile
    # needs no iam:PassRole, so role/* above is sufficient for the role side.
    {
      Sid    = "IAMInstanceProfiles"
      Effect = "Allow"
      Action = [
        "iam:CreateInstanceProfile",
        "iam:DeleteInstanceProfile",
        "iam:GetInstanceProfile",
        "iam:AddRoleToInstanceProfile",
        "iam:RemoveRoleFromInstanceProfile",
        "iam:TagInstanceProfile",
        "iam:UntagInstanceProfile",
        "iam:ListInstanceProfileTags"
      ]
      Resource = "arn:aws:iam::${var.account_id}:instance-profile/*"
    },

  ]

  # Data-bearing decoys: the resources that actually hold the fake secrets.
  statements_data = [

    # ── S3 — lure buckets ────────────────────────────────────────────────────
    # S3 bucket ARNs have NO account field (the namespace is global), so this
    # statement cannot be account-scoped the way every other statement here is.
    # Scoping instead relies on the naming convention every bucket-creating
    # scenario follows — "<prefix>-${var.account_id}" (scenario-1
    # infra-terraform-state-, scenario-4 devops-deploy-keys-, scenario-6
    # prod-data-sync-artifacts-). That keeps the role off every pre-existing
    # bucket in the spoke account, which a bare arn:aws:s3:::* would have reached.
    #
    # A new decoy bucket MUST carry the -<account_id> suffix or its apply will
    # AccessDeny here. s3:ResourceAccount was the obvious alternative and was
    # rejected: its per-action support is uneven, and an unsupported condition key
    # is simply absent from the request context, so StringEquals returns false and
    # the Allow silently stops matching — it would fail closed on bucket creation.
    {
      Sid    = "S3"
      Effect = "Allow"
      Action = [
        "s3:CreateBucket",
        "s3:DeleteBucket",
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject",
        # Version-aware deletes. The scenarios no longer ENABLE versioning, but
        # these stay required: buckets already deployed while the
        # aws_s3_bucket_versioning blocks existed still hold object versions, and
        # suspending versioning never removes them. Without these, force_destroy on
        # one of those buckets fails AccessDenied and the decoy is left stranded.
        "s3:DeleteObjectVersion",
        "s3:GetObjectVersion",
        "s3:ListBucketVersions",
        "s3:PutBucketPolicy",
        "s3:GetBucketPolicy",
        "s3:DeleteBucketPolicy",
        "s3:PutBucketTagging",
        "s3:GetBucketTagging",
        "s3:PutBucketVersioning",
        "s3:GetBucketVersioning",
        "s3:GetBucketLocation",
        "s3:ListBucket",
        "s3:PutBucketPublicAccessBlock",
        "s3:GetBucketPublicAccessBlock",
        # The AWS provider reads/writes every sub-resource of aws_s3_bucket on
        # create+refresh (GetBucketAcl et al). Missing any one AccessDenies the
        # whole apply. This is the full set the S3 bucket resources across the
        # 19 scenarios touch (ACL/ownership, encryption, lifecycle, versioning,
        # CORS, website, replication, logging, request-payment, accelerate).
        "s3:GetBucketAcl",
        "s3:PutBucketAcl",
        "s3:GetBucketOwnershipControls",
        "s3:PutBucketOwnershipControls",
        "s3:GetEncryptionConfiguration",
        "s3:PutEncryptionConfiguration",
        "s3:GetLifecycleConfiguration",
        "s3:PutLifecycleConfiguration",
        "s3:GetBucketCORS",
        "s3:PutBucketCORS",
        "s3:GetBucketWebsite",
        "s3:PutBucketWebsite",
        "s3:DeleteBucketWebsite",
        "s3:GetReplicationConfiguration",
        "s3:PutReplicationConfiguration",
        "s3:GetBucketLogging",
        "s3:PutBucketLogging",
        "s3:GetBucketRequestPayment",
        "s3:PutBucketRequestPayment",
        "s3:GetAccelerateConfiguration",
        "s3:PutAccelerateConfiguration",
        "s3:GetBucketObjectLockConfiguration",
        "s3:PutBucketObjectLockConfiguration",
        "s3:GetBucketNotification",
        "s3:PutBucketNotification"
      ]
      Resource = [
        "arn:aws:s3:::*-${var.account_id}",
        "arn:aws:s3:::*-${var.account_id}/*"
      ]
    },

    # ── Secrets Manager ──────────────────────────────────────────────────────
    {
      Sid    = "SecretsManager"
      Effect = "Allow"
      Action = [
        "secretsmanager:CreateSecret",
        "secretsmanager:DeleteSecret",
        "secretsmanager:PutSecretValue",
        "secretsmanager:GetSecretValue",
        "secretsmanager:DescribeSecret",
        "secretsmanager:RestoreSecret",
        # The provider reads the secret's resource policy on every refresh, and
        # scenarios 2 & 6 manage aws_secretsmanager_secret_policy explicitly.
        "secretsmanager:GetResourcePolicy",
        "secretsmanager:PutResourcePolicy",
        "secretsmanager:DeleteResourcePolicy",
        "secretsmanager:TagResource",
        "secretsmanager:UntagResource",
        "secretsmanager:ListSecretVersionIds",
        # Destroying an aws_secretsmanager_secret_version does not delete the
        # version — the provider deregisters its staging label (AWSPREVIOUS /
        # AWSCURRENT) via UpdateSecretVersionStage. Without this, every scenario
        # that manages secret versions (2 & 6) applies fine but fails to destroy.
        "secretsmanager:UpdateSecretVersionStage",
        # Same class of gap, found while fixing the one above: changing a
        # secret's description or kms_key_id is an in-place update, not a
        # replace, and the provider calls UpdateSecret for it. All four secrets
        # in scenarios 2 & 6 set `description`, so editing any one of them would
        # fail on apply with the create path still working.
        "secretsmanager:UpdateSecret"
      ]
      Resource = "arn:aws:secretsmanager:*:${var.account_id}:secret:*"
    },

    # ── SSM Parameter Store ──────────────────────────────────────────────────
    # Resource-scoped actions on parameter/*
    {
      Sid    = "SSM"
      Effect = "Allow"
      Action = [
        "ssm:PutParameter",
        "ssm:DeleteParameter",
        "ssm:DeleteParameters",
        "ssm:GetParameter",
        "ssm:GetParameters",
        "ssm:GetParametersByPath",
        "ssm:ListTagsForResource",
        "ssm:AddTagsToResource",
        "ssm:RemoveTagsFromResource"
      ]
      Resource = "arn:aws:ssm:*:${var.account_id}:parameter/*"
    },
    # ssm:DescribeParameters does NOT support resource-level ARN scoping (it's an
    # account-wide list API) — AWS limitation. Narrowed with a region condition.
    {
      Sid      = "SSMDescribe"
      Effect   = "Allow"
      Action   = "ssm:DescribeParameters"
      Resource = "*"
    },

    # ── Lambda ───────────────────────────────────────────────────────────────
    {
      Sid    = "Lambda"
      Effect = "Allow"
      Action = [
        "lambda:CreateFunction",
        "lambda:UpdateFunctionCode",
        "lambda:UpdateFunctionConfiguration",
        "lambda:GetFunction",
        "lambda:GetFunctionConfiguration",
        "lambda:DeleteFunction",
        "lambda:AddPermission",
        "lambda:RemovePermission",
        "lambda:GetPolicy",
        "lambda:ListVersionsByFunction",
        "lambda:ListTags",
        "lambda:GetFunctionCodeSigningConfig",
        "lambda:GetFunctionConcurrency",
        "lambda:PutFunctionConcurrency",
        "lambda:DeleteFunctionConcurrency",
        "lambda:GetFunctionEventInvokeConfig",
        "lambda:GetFunctionUrlConfig",
        "lambda:GetRuntimeManagementConfig",
        "lambda:GetFunctionRecursionConfig",
        "lambda:TagResource",
        "lambda:UntagResource"
      ]
      Resource = "arn:aws:lambda:*:${var.account_id}:function:*"
    },

    # ── DynamoDB ─────────────────────────────────────────────────────────────
    {
      Sid    = "DynamoDB"
      Effect = "Allow"
      Action = [
        "dynamodb:CreateTable",
        "dynamodb:DeleteTable",
        "dynamodb:DescribeTable",
        "dynamodb:DescribeContinuousBackups",
        # Setter for point_in_time_recovery (scenario 9 enables PITR).
        "dynamodb:UpdateContinuousBackups",
        "dynamodb:DescribeTimeToLive",
        "dynamodb:UpdateTimeToLive",
        "dynamodb:PutItem",
        "dynamodb:BatchWriteItem",
        "dynamodb:UpdateTable",
        "dynamodb:TagResource",
        "dynamodb:UntagResource",
        "dynamodb:ListTagsOfResource",
        "dynamodb:DescribeTableReplicaAutoScaling"
      ]
      Resource = "arn:aws:dynamodb:*:${var.account_id}:table/*"
    },

  ]

  # Messaging, crypto, registry and compute decoys.
  statements_platform = [

    # ── SQS ──────────────────────────────────────────────────────────────────
    {
      Sid    = "SQS"
      Effect = "Allow"
      Action = [
        "sqs:CreateQueue",
        "sqs:DeleteQueue",
        "sqs:SendMessage",
        "sqs:GetQueueAttributes",
        "sqs:SetQueueAttributes",
        "sqs:GetQueueUrl",
        "sqs:TagQueue",
        "sqs:UntagQueue",
        # The provider reads tags on every refresh; without this a tagged queue
        # cannot be planned or destroyed.
        "sqs:ListQueueTags"
      ]
      Resource = "arn:aws:sqs:*:${var.account_id}:*"
    },

    # ── SNS ───────────────────────────────────────────────────────────────────
    {
      Sid    = "SNS"
      Effect = "Allow"
      Action = [
        "sns:CreateTopic",
        "sns:DeleteTopic",
        "sns:Publish",
        "sns:GetTopicAttributes",
        "sns:SetTopicAttributes",
        "sns:TagResource",
        "sns:UntagResource",
        # aws_sns_topic_subscription (scenario 12 creates two). Subscribe targets
        # the topic ARN; the rest target the subscription ARN — both are covered
        # by the account-wide wildcard below.
        "sns:Subscribe",
        "sns:Unsubscribe",
        "sns:GetSubscriptionAttributes",
        "sns:SetSubscriptionAttributes",
        # Tag read on every refresh, same reason as sqs:ListQueueTags.
        "sns:ListTagsForResource",
        "sns:GetDataProtectionPolicy",
        "sns:PutDataProtectionPolicy"
      ]
      Resource = "arn:aws:sns:*:${var.account_id}:*"
    },

    # ── CloudWatch Logs ───────────────────────────────────────────────────────
    {
      Sid    = "CloudWatchLogs"
      Effect = "Allow"
      Action = [
        "logs:CreateLogGroup",
        "logs:DeleteLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:PutRetentionPolicy",
        "logs:DescribeLogGroups",
        "logs:TagLogGroup",
        "logs:TagResource",
        # Tag read on every refresh, same reason as sqs:ListQueueTags.
        "logs:ListTagsForResource",
        "logs:DeleteRetentionPolicy"
      ]
      Resource = [
        "arn:aws:logs:*:${var.account_id}:log-group:*",
        "arn:aws:logs:*:${var.account_id}:log-group:*:*"
      ]
    },

    # ── KMS ───────────────────────────────────────────────────────────────────
    # kms:CreateKey has no resource ARN at create time — AWS limitation; the key
    # does not exist yet so there is no ARN to scope to. Narrowed with a region
    # condition. kms:TagResource at creation is also Resource "*" for the same
    # reason (the key ARN is only known after the CreateKey response).
    {
      Sid    = "KMSCreateKey"
      Effect = "Allow"
      Action = [
        "kms:CreateKey",
        "kms:TagResource",
        # kms:ListAliases also has no resource-level scope in IAM (it lists the
        # whole account's aliases), so it belongs in this Resource "*" block
        # rather than KMSManage. The provider calls it on aws_kms_alias read.
        "kms:ListAliases"
      ]
      Resource = "*"
    },
    {
      Sid    = "KMSManage"
      Effect = "Allow"
      Action = [
        "kms:CreateAlias",
        "kms:DeleteAlias",
        "kms:UpdateAlias",
        "kms:DescribeKey",
        "kms:GetKeyPolicy",
        "kms:PutKeyPolicy",
        "kms:ScheduleKeyDeletion",
        "kms:CancelKeyDeletion",
        "kms:ListResourceTags",
        "kms:UntagResource",
        # enable_key_rotation = true (scenario 14). GetKeyRotationStatus is read
        # on every refresh, so without it plan and destroy fail too.
        "kms:EnableKeyRotation",
        "kms:GetKeyRotationStatus",
        # The inverse call, for if scenario-14 ever flips enable_key_rotation
        # back to false. Rotation is a key *setting*, not a separate resource, so
        # destroy does not need this -- only an edit does.
        "kms:DisableKeyRotation"
      ]
      Resource = [
        "arn:aws:kms:*:${var.account_id}:key/*",
        "arn:aws:kms:*:${var.account_id}:alias/*"
      ]
    },

    # ── ECR ───────────────────────────────────────────────────────────────────
    {
      Sid    = "ECR"
      Effect = "Allow"
      Action = [
        "ecr:CreateRepository",
        "ecr:DeleteRepository",
        "ecr:PutImage",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:BatchDeleteImage",
        # force_delete on the repo enumerates images before deleting them.
        "ecr:ListImages",
        "ecr:DescribeRepositories",
        "ecr:GetRepositoryPolicy",
        "ecr:SetRepositoryPolicy",
        "ecr:DeleteRepositoryPolicy",
        "ecr:ListTagsForResource",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetLifecyclePolicy",
        "ecr:PutLifecyclePolicy",
        "ecr:DeleteLifecyclePolicy",
        "ecr:DescribeImages",
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer",
        "ecr:TagResource",
        "ecr:UntagResource",
        # scenario-5 sets image_tag_mutability = "IMMUTABLE" and
        # scan_on_push = true. CreateRepository accepts both inline, so a first
        # apply succeeds without these -- they are only called when one of those
        # two settings is *changed*, which is why their absence stayed latent.
        "ecr:PutImageTagMutability",
        "ecr:PutImageScanningConfiguration"
      ]
      Resource = "arn:aws:ecr:*:${var.account_id}:repository/*"
    },
    # ecr:GetAuthorizationToken has no resource-level ARN scope in IAM (AWS
    # limitation — it returns a token for the registry, not a specific repo).
    {
      Sid      = "ECRAuth"
      Effect   = "Allow"
      Action   = "ecr:GetAuthorizationToken"
      Resource = "*"
    },
    # ── EC2 — scenario 4 bastion decoy ────────────────────────────────────────
    # This IS the widest grant in the policy, and it is here deliberately.
    #
    # An earlier revision omitted ec2:* on the grounds that scenario 4 cannot
    # deploy as shipped anyway — true, and still true: its vpc_id and subnet_id
    # variables have no defaults while deploy-spoke.sh passes only account_id, so
    # Terraform errors out before IAM is ever consulted. That reasoning holds for a
    # role we control and can widen at will. It does not hold for this module,
    # which is handed to a spoke account owner and applied by them: a gap found
    # later costs a second round-trip through another team to re-apply Terraform in
    # an account we have no access to. The permission is cheap now and expensive
    # later, so scenario 4's three resources (aws_security_group,
    # aws_network_interface, aws_instance) are covered up front.
    #
    # To opt out — if EC2 decoys will never run in this spoke — delete this
    # statement and EC2Describe below. Nothing else depends on them.
    {
      Sid    = "EC2ManageDecoyHost"
      Effect = "Allow"
      Action = [
        "ec2:RunInstances",
        "ec2:TerminateInstances",
        "ec2:StartInstances",
        "ec2:StopInstances",
        "ec2:ModifyInstanceAttribute",
        "ec2:CreateSecurityGroup",
        "ec2:DeleteSecurityGroup",
        "ec2:AuthorizeSecurityGroupIngress",
        "ec2:AuthorizeSecurityGroupEgress",
        "ec2:RevokeSecurityGroupIngress",
        "ec2:RevokeSecurityGroupEgress",
        "ec2:ModifySecurityGroupRules",
        "ec2:CreateNetworkInterface",
        "ec2:DeleteNetworkInterface",
        "ec2:AttachNetworkInterface",
        "ec2:DetachNetworkInterface",
        "ec2:ModifyNetworkInterfaceAttribute",
        # The provider tags the instance, its root volume, the ENI and the SG, and
        # reads those tags back on every refresh.
        "ec2:CreateTags",
        "ec2:DeleteTags"
      ]
      Resource = [
        "arn:aws:ec2:*:${var.account_id}:instance/*",
        "arn:aws:ec2:*:${var.account_id}:volume/*",
        "arn:aws:ec2:*:${var.account_id}:network-interface/*",
        "arn:aws:ec2:*:${var.account_id}:security-group/*",
        "arn:aws:ec2:*:${var.account_id}:security-group-rule/*",
        "arn:aws:ec2:*:${var.account_id}:subnet/*",
        "arn:aws:ec2:*:${var.account_id}:vpc/*",
        "arn:aws:ec2:*:${var.account_id}:key-pair/*",
        "arn:aws:ec2:*:${var.account_id}:placement-group/*",
        "arn:aws:ec2:*:${var.account_id}:snapshot/*",
        # RunInstances must also authorize the AMI and its backing snapshot. Those
        # are owned by Amazon or a marketplace publisher, so their ARNs carry no
        # account segment — they cannot be scoped to this account.
        "arn:aws:ec2:*::image/*",
        "arn:aws:ec2:*::snapshot/*"
      ]
    },
    # EC2 Describe* supports no resource-level permissions at all — every one of
    # these is "*"-only by AWS design. Read-only.
    {
      Sid    = "EC2Describe"
      Effect = "Allow"
      Action = [
        "ec2:DescribeInstances",
        "ec2:DescribeInstanceAttribute",
        "ec2:DescribeInstanceStatus",
        "ec2:DescribeInstanceTypes",
        "ec2:DescribeInstanceCreditSpecifications",
        "ec2:DescribeImages",
        "ec2:DescribeVolumes",
        "ec2:DescribeSecurityGroups",
        "ec2:DescribeSecurityGroupRules",
        "ec2:DescribeNetworkInterfaces",
        "ec2:DescribeSubnets",
        "ec2:DescribeVpcs",
        "ec2:DescribeVpcAttribute",
        "ec2:DescribeAvailabilityZones",
        "ec2:DescribeKeyPairs",
        "ec2:DescribeTags"
      ]
      Resource = "*"
    },

  ]

  # Guardrails. Attached alongside the control group; an explicit Deny here beats
  # every Allow in all three policies.
  statements_deny = [

    # ── Explicit denies — prevent privilege escalation ────────────────────────
    # These block the most dangerous actions regardless of any above Allow.
    # Retains the real backdoor/escalation vectors: creating IAM users, minting
    # long-lived access keys, and attaching policies to users. Managed-policy
    # actions (CreatePolicy/CreatePolicyVersion/SetDefaultPolicyVersion) are not
    # denied wholesale here: scenarios legitimately create customer-managed
    # policies for their lure roles, and PutRolePolicy on role/* already grants
    # the equivalent inline path — so a blanket deny blocked deploys without
    # closing any escalation path. They ARE denied on this role's own policies;
    # see DenyOwnPolicyModification below. UpdateAssumeRolePolicy on role/* is still
    # allowed for lure roles (needed to seed trust); this role's own trust is
    # pinned shut by DenySelfModification below. The forwarding role's trust is
    # deliberately left writable — see DenyForwardingRoleModification.
    {
      Sid    = "DenyEscalation"
      Effect = "Deny"
      Action = [
        "iam:CreateUser",
        "iam:CreateAccessKey",
        "iam:AttachUserPolicy",
        "iam:PutUserPolicy"
      ]
      Resource = "*"
    },
    # A taken-over hub must not hand itself the account through a lure role with an
    # AWS admin policy. No scenario attaches these (scripts/validate-scenario.py also
    # rejects them); lure roles keep every other AWS-managed policy.
    {
      Sid      = "DenyAdminPolicyAttach"
      Effect   = "Deny"
      Action   = "iam:AttachRolePolicy"
      Resource = "*"
      Condition = {
        ArnLike = {
          "iam:PolicyARN" = [
            "arn:aws:iam::aws:policy/AdministratorAccess*",
            "arn:aws:iam::aws:policy/PowerUserAccess",
            "arn:aws:iam::aws:policy/IAMFullAccess"
          ]
        }
      }
    },
    # Block modification of this deployment role itself
    {
      Sid    = "DenySelfModification"
      Effect = "Deny"
      Action = [
        "iam:DeleteRole",
        "iam:UpdateRole",
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy",
        # Protect this role's own trust policy. This used to be covered by the
        # global UpdateAssumeRolePolicy deny; since that was narrowed to allow
        # seeding lure-role trust, pin the self-protection here explicitly.
        "iam:UpdateAssumeRolePolicy"
      ]
      Resource = "arn:aws:iam::${var.account_id}:role/${var.resource_prefix}-spoke-deployment-role"
    },
    # Block modification of the forwarding role. UpdateAssumeRolePolicy is
    # deliberately NOT in this list (unlike DenySelfModification above):
    # deploy-rule legitimately calls it on this exact role to append each new
    # rule's ARN as an allowed SourceArn on the trust policy (the mechanism
    # that lets that rule's EventBridge target PutEvents to the hub bus) -
    # denying it here silently breaks forwarding for every new/changed rule.
    # DeleteRole/UpdateRole/PutRolePolicy/AttachRolePolicy/DetachRolePolicy
    # still block the actual escalation paths (deleting the role or changing
    # its permissions/policies).
    {
      Sid    = "DenyForwardingRoleModification"
      Effect = "Deny"
      Action = [
        "iam:DeleteRole",
        "iam:UpdateRole",
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy"
      ]
      Resource = "arn:aws:iam::${var.account_id}:role/${var.resource_prefix}-forwarding-role"
    },
    # Block this role from rewriting its OWN permission policies.
    #
    # This deny exists because the permissions moved from one inline policy to three
    # customer-managed policies. While they were inline, IAMManagedPolicies' grant of
    # CreatePolicyVersion/SetDefaultPolicyVersion on policy/* could not reach them —
    # an inline policy is not a policy/* resource — and DenySelfModification's
    # PutRolePolicy deny was enough. As managed policies they ARE policy/* resources,
    # so without this the role could publish a new default version of
    # ${var.resource_prefix}-spoke-deployment-control granting Action "*" and omitting every deny
    # above, escalating itself to account administrator in two API calls.
    #
    # Scoped to this role's own policies by name prefix, so scenarios keep their
    # ability to create and version customer-managed policies for lure roles.
    {
      Sid    = "DenyOwnPolicyModification"
      Effect = "Deny"
      Action = [
        "iam:CreatePolicyVersion",
        "iam:DeletePolicyVersion",
        "iam:SetDefaultPolicyVersion",
        "iam:DeletePolicy"
      ]
      Resource = "arn:aws:iam::${var.account_id}:policy/${var.resource_prefix}-spoke-deployment-*"
    }
  ]

  # name => rendered policy document. The denies ride with the control group.
  policy_groups = {
    control  = concat(local.statements_control, local.statements_deny)
    data     = local.statements_data
    platform = local.statements_platform
  }

  policy_documents = {
    for name, statements in local.policy_groups :
    name => jsonencode({
      Version   = "2012-10-17"
      Statement = statements
    })
  }
}

resource "aws_iam_policy" "this" {
  for_each = local.policy_documents

  name        = "${var.resource_prefix}-spoke-deployment-${each.key}"
  description = "Spoke deployment permissions (${each.key} group)"
  policy      = each.value

  # Fail at plan time instead of discovering LimitExceeded mid-apply. AWS excludes
  # whitespace when measuring, and jsonencode emits none, so length() is the real
  # figure it will check against the 6,144-character managed policy cap.
  lifecycle {
    precondition {
      condition     = length(each.value) <= 6144
      error_message = "Managed policy '${each.key}' renders to ${length(each.value)} characters, over the 6144 IAM limit. Move statements to another group in local.policy_groups, or add a fourth group."
    }
  }

  tags = {
    Project   = "${var.resource_prefix}-platform"
    ManagedBy = "terraform"
  }
}

resource "aws_iam_role_policy_attachment" "this" {
  for_each = aws_iam_policy.this

  role       = aws_iam_role.this.name
  policy_arn = each.value.arn
}
