# AWS Cloud Deception Scenarios

## Overview

This project deploys internal-only AWS deception infrastructure to detect insider threats and attackers who have already gained access to an AWS account. Each scenario creates a realistic resource chain with enticing names and fake credentials that lure attackers into interacting with honeypot resources — generating high-fidelity CloudTrail detection signals.

All resources follow AWS security best practices to blend in with legitimate infrastructure. Credentials and data look real but are completely fake.

| Property | Value |
|----------|-------|
| Region | Any; chosen per deploy (default us-west-2) |
| Total scenarios | 19 |
| Total monthly cost | ~$3.30 |
| IaC | Terraform |
| Access model | Internal account only (root principal) |

---

## Design Principles

- **Internal only** — all lures target insider threats or attackers already in the account
- **No public access** — every resource has public access fully blocked (scenario-4's bastion is the one deliberate, opt-in exception: its SSH ingress is controlled by an `allowed_cidr_blocks` variable that defaults to an internal range, and a user can override it to intentionally expose that one scenario)
- **No cross-account** — no external account references or trust policies
- **No IAM users** — only IAM roles used throughout
- **Least privilege** — each role only gets the exact permissions the scenario requires
- **No overt "fake" labels, but a quiet tell for responders** — seeded content never says FAKE/REVOKED, or any of mirage/decoy/deception/honeypot/lure, so it reads as ordinary production data to an attacker. Where it's safe to do so, the populate step adds a neutral `status: EXPIRED` marker (or a `# status: EXPIRED (rotated out, do not use)` comment line, for formats that can't carry a field) to seeded content, so an incident responder who finds the record during a real investigation can tell at a glance that it's lure content and not a live secret, without the marker itself giving away that this is a deception platform.

---

## Detection Strategy

Detection is tuned for **high-confidence, low-noise alerts**. We monitor two categories of CloudTrail events:

**1. AssumeRole on lure roles** — no legitimate user should assume these decoy roles. Any AssumeRole event targeting a lure role name is a true positive.

**2. Resource-specific API calls on exact lure resource ARNs** — calls that require a specific resource identifier (ARN, name, or ID) and target a decoy resource. If someone is calling `DescribeKey` on our decoy KMS key or `GetObject` on our decoy S3 bucket, they found the lure and are actively investigating it.

**Excluded from monitoring (false positive reduction):**

All broad enumeration calls that return every resource of a type without targeting a specific one. These are made routinely by legitimate users, automation, AWS Config, and Security Hub:

`ListBuckets`, `ListSecrets`, `DescribeParameters`, `ListTables`, `ListQueues`, `ListTopics`, `ListFunctions`, `ListRoles`, `ListAliases`, `ListKeys`, `DescribeLogGroups`

**Kept in monitoring (resource-specific):**

`AssumeRole`, `GetObject`, `GetSecretValue`, `GetParameter`, `GetParametersByPath`, `Scan`, `Query`, `GetItem`, `ReceiveMessage`, `GetQueueAttributes`, `BatchGetImage`, `GetDownloadUrlForLayer`, `StartInstances`, `AuthorizeSecurityGroupIngress`, `Decrypt`, `DescribeKey`, `DescribeTable`, `GetTopicAttributes`, `ListSubscriptionsByTopic`, `Publish`, `GetFunctionConfiguration`, `InvokeFunction`, `UpdateFunctionCode`, `GetLogEvents`, `FilterLogEvents`

---

## Scenario Inventory

| # | Name | Lure Type | AWS Services | Cost/mo |
|---|------|-----------|-------------|---------|
| 1 | Terraform State Lure | S3 bucket with fake tfstate | IAM, S3 | $0.00 |
| 2 | Payment Credentials | Secrets Manager secrets | IAM, SecretsManager | $1.20 |
| 3 | Infrastructure Vault | SSM Parameter Store | IAM, SSM | $0.05 |
| 4 | SSH Key → EC2 Bastion | S3 key + stopped EC2 | IAM, S3, EC2 | $0.64 |
| 5 | ECR Container Image | Docker image with secrets | IAM, ECR | $0.01 |
| 6 | Lambda Data Sync | Lambda env vars → S3/SM/SSM | IAM, Lambda, S3, SM, SSM | $0.40 |
| 7 | Lambda Code Injection | Lambda discovery role with code-update rights | IAM, Lambda | $0.00 |
| 8 | Role Chain Loop | 3 roles in circular chain + SSM | IAM, SSM | $0.00 |
| 9 | Customer Profiles | DynamoDB with fake PII (+ optional sessions table) | IAM, DynamoDB | $0.00 |
| 10 | Active Sessions | DynamoDB with fake JWTs | IAM, DynamoDB | $0.00 |
| 11 | Payment Events + DLQ | SQS FIFO with fake transactions | IAM, SQS | $0.00 |
| 12 | Critical Alerts | SNS topic with pending email subscription | IAM, SNS | $0.00 |
| 13 | Leaked Logs | CloudWatch Logs with creds in traces | IAM, CloudWatch | $0.00 |
| 14 | Encryption Key | KMS key (describe-only, deny decrypt) | IAM, KMS | $1.00 |
| 16 | Tag Breadcrumbs | Resource tags referencing other lures | IAM, Tags, SSM | $0.00 |
| 17 | Enriched User PII | Lambda + DynamoDB with enriched profiles | IAM, Lambda, DynamoDB | $0.00 |
| 18 | SSM Chain | 5 SSM params cross-referencing each other | IAM, SSM | $0.00 |
| 19 | Core-Infra Secrets Reference | SSM params exposing secret references | IAM, SSM | $0.00 |
| 21 | Finance Ledger Export | SSM param holding an expired accounting-platform API key | IAM, SSM | $0.00 |

> There is no scenario-15 — it was retired before this numbering was finalized and will not be reused or backfilled. `scenario-20` was a stub that never shipped a `main.tf` and has been removed. 18 is the true, final count.

---

## Scenario 1 — S3 Terraform State Lure

**Role**: `infra-s3-data-readonly-role-v2` · **Folder**: `scenario-1` · **Cost**: $0.00/mo

Attacker assumes a role that grants S3 read access, discovers a bucket named `infra-terraform-state-<account-id>`, and downloads a Terraform state file containing RDS credentials, Stripe API keys, IAM access keys, Redis auth tokens, and SSM connection strings.

```
Attacker → AssumeRole → GetObject (terraform.tfstate)
             → Extracts: RDS creds, Stripe keys, IAM keys, Redis token, DB connection string
```

| Monitored Event | CloudTrail Event | Resource |
|----------------|-----------------|----------|
| Role assumption | AssumeRole | `role/infra-s3-data-readonly-role-v2` |
| State file download | GetObject | `infra-terraform-state-<acct>/env/production/terraform.tfstate` |

---

## Scenario 2 — Secrets Manager Payment Credentials Lure

**Role**: `payment-secrets-readonly-role-v2` · **Folder**: `scenario-2` · **Cost**: $1.20/mo

Attacker assumes a role and reads three Secrets Manager secrets: Stripe keys, Braintree credentials, and internal service account credentials.

```
Attacker → AssumeRole → GetSecretValue × 3
             → Extracts: Stripe sk_live_, Braintree merchant keys, service account API keys
```

| Monitored Event | CloudTrail Event | Resource |
|----------------|-----------------|----------|
| Role assumption | AssumeRole | `role/payment-secrets-readonly-role-v2` |
| Stripe secret read | GetSecretValue | `secret:prod/payment-gateway/stripe-keys-v2-*` |
| Braintree secret read | GetSecretValue | `secret:prod/payment-gateway/braintree-credentials-v2-*` |
| Service accounts read | GetSecretValue | `secret:prod/internal-api/service-accounts-v2-*` |

---

## Scenario 3 — SSM Parameter Store Infrastructure Vault

**Role**: `infra-config-readonly-role` · **Folder**: `scenario-3` · **Cost**: $0.05/mo

Attacker reads SSM parameters under `/prod/*` containing database master credentials, GitHub deploy token, Datadog API keys, VPN admin credentials, and an EKS cluster-admin kubeconfig.

```
Attacker → AssumeRole → GetParametersByPath /prod/* or GetParameter × 5
```

| Monitored Event | CloudTrail Event | Resource |
|----------------|-----------------|----------|
| Role assumption | AssumeRole | `role/infra-config-readonly-role` |
| Bulk parameter read | GetParametersByPath | `parameter/prod` |
| Individual reads (×5) | GetParameter | `parameter/prod/database/master-credentials` etc. |

---

## Scenario 4 — S3 SSH Key → EC2 Bastion with Sensitive Files

**Role**: `devops-s3-deploy-role` · **Folder**: `scenario-4` · **Cost**: $0.64/mo

Attacker downloads an SSH key from S3, modifies a security group, starts a stopped bastion instance, and SSHs in to find sensitive files. This is the one scenario in the collection with any public-facing posture: SSH ingress is controlled by an `allowed_cidr_blocks` variable, which defaults to an internal CIDR range (`10.0.0.0/8`) but can be deliberately overridden to expose the bastion externally.

```
Attacker → AssumeRole → GetObject (SSH key) → AuthorizeSecurityGroupIngress ⚠️
         → StartInstances ⚠️ → SSH in → finds .env, db-backup-creds, internal-hosts, AWS creds
```

| Monitored Event | CloudTrail Event | Resource |
|----------------|-----------------|----------|
| Role assumption | AssumeRole | `role/devops-s3-deploy-role` |
| Key download | GetObject | `devops-deploy-keys-<acct>/keys/prod-bastion.pem` |
| SG modification ⚠️ | AuthorizeSecurityGroupIngress | `security-group/<sg-id>` |
| Instance start ⚠️ | StartInstances | `instance/<instance-id>` |
| SSH connection | VPC Flow Logs | Bastion public IP, port 22 |

**Note**: Instance deploys stopped. Combinable with scenario 5.

---

## Scenario 5 — ECR Container Image with PII & Credentials

**Role**: `prod-bastion-ecr-role` · **Folder**: `scenario-5` · **Cost**: $0.01/mo

Attacker authenticates to ECR, pulls `prod-payment-service` image containing DB creds, Stripe keys, PII records, and AWS session tokens. This is an ECR-only lure: it ships an optional IAM instance-profile attachment point so it *can* be wired to an EC2 instance, but on its own it deploys no compute. Scenario-4 is the one actual EC2/bastion scenario.

```
Attacker → BatchGetImage (pull prod-payment-service) → inspect layers
         → Finds: .env, secrets.json (PII), AWS credentials
```

| Monitored Event | CloudTrail Event | Resource |
|----------------|-----------------|----------|
| Image pull | BatchGetImage | `repository/prod-payment-service` |
| Layer download | GetDownloadUrlForLayer | `repository/prod-payment-service` |

**Trust**: `ec2.amazonaws.com` (instance profile) plus account-root. Combinable with scenario 4.

---

## Scenario 6 — Lambda Data Sync with Environment Variable Secrets

**Role**: `lambda-ops-readonly-role` · **Folder**: `scenario-6` · **Cost**: $0.40/mo

Attacker reads Lambda function `prod-data-sync-processor` configuration and extracts DB credentials, Stripe key, Slack webhook, and encryption key from environment variables. The execution role pivots to S3, Secrets Manager, and SSM (all three optional, default on). Scenario-7 links to this scenario's Lambda when `link_to_scenario_6 = true`.

```
Attacker → AssumeRole → GetFunctionConfiguration (env vars)
         → Execution role pivots to: S3, Secrets Manager, SSM
```

| Monitored Event | CloudTrail Event | Resource |
|----------------|-----------------|----------|
| Role assumption | AssumeRole | `role/lambda-ops-readonly-role` |
| Lambda config read | GetFunctionConfiguration | `function:prod-data-sync-processor` |
| S3 artifact read | GetObject | `prod-data-sync-artifacts-<acct>/*` |
| Secret read | GetSecretValue | `secret:prod/data-sync/api-credentials-*` |
| SSM read | GetParameter | `parameter/prod/data-sync/config` |

---

## Scenario 7 — Lambda Code Injection

**Role**: `lambda-inject-readonly-role` · **Folder**: `scenario-7` · **Cost**: $0.00/mo

Unlike scenario-6, the discovery role here also grants `lambda:InvokeFunction` and `lambda:UpdateFunctionCode` on the target function. An attacker can overwrite the function's code with their own payload and have it execute with the Lambda execution role's temporary credentials — a privilege-escalation path, not just a read. Deployable standalone (own discovery role + function `prod-data-inject-processor`) or linked to scenario-6's function via `link_to_scenario_6 = true`.

```
Attacker → AssumeRole (discovery) → GetFunctionConfiguration
         → UpdateFunctionCode ⚠️ (overwrite with payload) → InvokeFunction ⚠️
         → payload runs with the execution role's temporary credentials
```

| Monitored Event | CloudTrail Event | Resource |
|----------------|-----------------|----------|
| Role assumption | AssumeRole | `role/lambda-inject-readonly-role` |
| Lambda config read | GetFunctionConfiguration | `function:prod-data-inject-processor` |
| Code overwrite ⚠️ | UpdateFunctionCode | `function:prod-data-inject-processor` |
| Invocation ⚠️ | InvokeFunction | `function:prod-data-inject-processor` |

---

## Scenario 8 — IAM Role Chain Loop

**Roles**: `prod-microservice-auth-role` → `-data-role` → `-admin-role` → loop · **Folder**: `scenario-8` · **Cost**: $0.00/mo

Three roles that assume each other in a circle. Each role has an SSM parameter with themed credentials.

```
auth-role ──► data-role ──► admin-role ──► auth-role (loop)
   │              │              │
   ▼              ▼              ▼
/prod/auth/   /prod/data/   /prod/admin/
oidc-config   lake-creds    console-creds
```

| Monitored Event | CloudTrail Event | Resource |
|----------------|-----------------|----------|
| Role assumptions (×3+) | AssumeRole | `role/prod-microservice-auth-role`, `-data-role`, `-admin-role` |
| SSM reads (×3) | GetParameter | `parameter/prod/auth/*`, `/prod/data/*`, `/prod/admin/*` |

---

## Scenario 9 — DynamoDB Customer Profiles (+ optional Active Sessions)

**Role**: `customer-data-readonly-role` · **Folder**: `scenario-9` · **Cost**: $0.00/mo

Attacker scans a DynamoDB table `prod-customer-profiles` seeded with fake PII records. A second table (`prod-active-sessions`) can optionally be deployed here too, but it defaults off because scenario-10 already owns a table with that same name — running both at once would collide.

```
Attacker → AssumeRole → DescribeTable → Scan/Query (PII records)
```

| Monitored Event | CloudTrail Event | Resource |
|----------------|-----------------|----------|
| Role assumption | AssumeRole | `role/customer-data-readonly-role` |
| Table describe | DescribeTable | `table/prod-customer-profiles` |
| Data scan | Scan | `table/prod-customer-profiles` |
| Data query | Query | `table/prod-customer-profiles` |

---

## Scenario 10 — DynamoDB Active Sessions

**Role**: `session-store-readonly-role` · **Folder**: `scenario-10` · **Cost**: $0.00/mo

Attacker scans a DynamoDB table `prod-user-sessions` with fake JWT tokens, session IDs, and refresh tokens.

```
Attacker → AssumeRole → DescribeTable → Scan (session records with JWTs)
```

| Monitored Event | CloudTrail Event | Resource |
|----------------|-----------------|----------|
| Role assumption | AssumeRole | `role/session-store-readonly-role` |
| Table describe | DescribeTable | `table/prod-user-sessions` |
| Session scan | Scan | `table/prod-user-sessions` |

---

## Scenario 11 — SQS Payment Events + Dead Letter Queue

**Role**: `payment-queue-readonly-role` · **Folder**: `scenario-11` · **Cost**: $0.00/mo

Attacker reads messages from the FIFO queue `prod-payment-events.fifo` (and its DLQ, `prod-payment-events-dlq.fifo`) containing fake payment events with card tokens and amounts.

```
Attacker → AssumeRole → GetQueueAttributes → ReceiveMessage
```

| Monitored Event | CloudTrail Event | Resource |
|----------------|-----------------|----------|
| Role assumption | AssumeRole | `role/payment-queue-readonly-role` |
| Queue attributes | GetQueueAttributes | `prod-payment-events.fifo`, `prod-payment-events-dlq.fifo` |
| Message read | ReceiveMessage | `prod-payment-events.fifo`, `prod-payment-events-dlq.fifo` |

---

## Scenario 12 — SNS Critical Alerts Topic

**Role**: `alerts-readonly-role` · **Folder**: `scenario-12` · **Cost**: $0.00/mo

Attacker discovers SNS topic `prod-alerts-critical` with a pending (unconfirmed) email subscription — present so the topic doesn't look abandoned, with the endpoint deliberately on an unroutable TLD so the confirmation email is never actually delivered anywhere.

```
Attacker → AssumeRole → GetTopicAttributes → ListSubscriptionsByTopic
```

| Monitored Event | CloudTrail Event | Resource |
|----------------|-----------------|----------|
| Role assumption | AssumeRole | `role/alerts-readonly-role` |
| Topic attributes | GetTopicAttributes | `prod-alerts-critical` |
| Subscription enumeration | ListSubscriptionsByTopic | `prod-alerts-critical` |
| Publish attempt | Publish | `prod-alerts-critical` |

---

## Scenario 13 — CloudWatch Logs with Leaked Credentials

**Role**: `log-analysis-readonly-role` · **Folder**: `scenario-13` · **Cost**: $0.00/mo

Attacker reads CloudWatch log group `/prod/payment-service/application` containing seeded log entries with accidentally-logged credentials.

```
Attacker → AssumeRole → GetLogEvents / FilterLogEvents
             → Finds: DB connection strings, API keys, passwords in log entries
```

| Monitored Event | CloudTrail Event | Resource |
|----------------|-----------------|----------|
| Role assumption | AssumeRole | `role/log-analysis-readonly-role` |
| Log reads | GetLogEvents | `log-group:/prod/payment-service/application` |
| Keyword search | FilterLogEvents | `log-group:/prod/payment-service/application` |

---

## Scenario 14 — KMS Customer Data Encryption Key

**Role**: `kms-audit-readonly-role` · **Folder**: `scenario-14` · **Cost**: $1.00/mo

Attacker discovers KMS key `alias/prod-customer-data-encryption`, reads metadata and grants, but decrypt is explicitly denied.

```
Attacker → AssumeRole → DescribeKey → Decrypt → DENIED ⚠️
```

| Monitored Event | CloudTrail Event | Resource |
|----------------|-----------------|----------|
| Role assumption | AssumeRole | `role/kms-audit-readonly-role` |
| Key metadata | DescribeKey | `key/<key-id>` |
| Decrypt denied ⚠️ | Decrypt (failure) | `key/<key-id>` |

---

## Scenario 16 — Resource Tags Breadcrumb Trail

**Role**: `resource-inventory-readonly-role` · **Folder**: `scenario-16` · **Cost**: $0.00/mo

Resources are tagged with ARNs and S3 URIs referencing other resources (some possibly non-existent), creating a breadcrumb trail. An attacker who enumerates tags follows it hop by hop. The primary detection signal is the role assumption itself; every tag-reading hop also generates its own CloudTrail event.

```
Attacker → AssumeRole → ListRoleTags / ListTagsForResource → follows breadcrumb tags
```

| Monitored Event | CloudTrail Event | Resource |
|----------------|-----------------|----------|
| Role assumption | AssumeRole | `role/resource-inventory-readonly-role` |
| Tag enumeration | ListRoleTags, ListTagsForResource | `role/prod-backup-automation-role`, `parameter/prod/inventory/service-registry` |

---

## Scenario 17 — Lambda + DynamoDB Enriched User PII

**Role**: `etl-ops-readonly-role` · **Folder**: `scenario-17` · **Cost**: $0.00/mo

Attacker reads Lambda function `prod-user-data-enrichment` env vars (third-party enrichment API keys plus the DynamoDB table name), then scans the DynamoDB table for enriched user profiles. The discovery role itself has no DynamoDB access — the attacker needs the Lambda's execution role for that hop.

```
Attacker → AssumeRole (discovery) → GetFunctionConfiguration → discovers table name + API keys
         → (execution role) → Scan (enriched PII)
```

| Monitored Event | CloudTrail Event | Resource |
|----------------|-----------------|----------|
| Role assumption | AssumeRole | `role/etl-ops-readonly-role` |
| Lambda config read | GetFunctionConfiguration | `function:prod-user-data-enrichment` |
| Table describe | DescribeTable | `table/prod-enriched-user-profiles` |
| DynamoDB scan | Scan | `table/prod-enriched-user-profiles` |

---

## Scenario 18 — SSM Parameter Cross-Reference Chain

**Role**: `infra-params-readonly-role` · **Folder**: `scenario-18` · **Cost**: $0.00/mo

Five SSM parameters under `/prod/db/*` cross-reference each other via `see_also` fields, creating a breadcrumb chain.

```
/prod/db/primary → /prod/db/replica → /prod/db/backup-config
                                           → /prod/db/encryption-config → /prod/db/monitoring
```

| Monitored Event | CloudTrail Event | Resource |
|----------------|-----------------|----------|
| Role assumption | AssumeRole | `role/infra-params-readonly-role` |
| Chain reads (×5) | GetParameter | `parameter/prod/db/primary`, `replica`, `backup-config`, `encryption-config`, `monitoring` |
| Bulk read | GetParametersByPath | `parameter/prod/db` |

---

## Scenario 19 — Core Infrastructure Secrets Reference

**Role**: `cfn-audit-readonly-role` · **Folder**: `scenario-19` · **Cost**: $0.00/mo

Two SSM parameters expose production-looking infrastructure details: `/prod/core-infra/endpoints` (DB/cache/API Gateway endpoints, VPC and subnet IDs) and `/prod/core-infra/secrets-ref` (ARN-shaped references into Secrets Manager for the database password, API key, and Redis auth token).

```
Attacker → AssumeRole → GetParameter (endpoints) → GetParameter (secrets-ref)
```

| Monitored Event | CloudTrail Event | Resource |
|----------------|-----------------|----------|
| Role assumption | AssumeRole | `role/cfn-audit-readonly-role` |
| Parameter reads | GetParameter | `parameter/prod/core-infra/endpoints`, `parameter/prod/core-infra/secrets-ref` |

---

## Scenario 21 — Finance Ledger Export

**Role**: `finance-ledger-export-role` · **Folder**: `scenario-21` · **Cost**: $0.00/mo

A finance role that can read a fake, expired accounting-platform API key from
`/prod/finance/ledger-export-api-key`. A small sample of the scenario format (one role, one parameter).

```
Attacker → AssumeRole → GetParameter (ledger API key)
```

| Monitored Event | CloudTrail Event | Resource |
|----------------|-----------------|----------|
| Role assumption | AssumeRole | `role/finance-ledger-export-role` |
| Parameter read | GetParameter | `parameter/prod/finance/ledger-export-api-key` |

---

## Consolidated Detection Rules

### Lure Roles — Monitor AssumeRole

| # | Role Name |
|---|-----------|
| 1 | `infra-s3-data-readonly-role-v2` |
| 2 | `payment-secrets-readonly-role-v2` |
| 3 | `infra-config-readonly-role` |
| 4 | `devops-s3-deploy-role` |
| 5 | `prod-bastion-ecr-role` |
| 6 | `lambda-ops-readonly-role` |
| 7 | `lambda-inject-readonly-role` |
| 8 | `prod-microservice-auth-role`, `prod-microservice-data-role`, `prod-microservice-admin-role` |
| 9 | `customer-data-readonly-role` |
| 10 | `session-store-readonly-role` |
| 11 | `payment-queue-readonly-role` |
| 12 | `alerts-readonly-role` |
| 13 | `log-analysis-readonly-role` |
| 14 | `kms-audit-readonly-role` |
| 16 | `resource-inventory-readonly-role` |
| 17 | `etl-ops-readonly-role` |
| 18 | `infra-params-readonly-role` |
| 19 | `cfn-audit-readonly-role` |
| 21 | `finance-ledger-export-role` |

### Lure Resources — Monitor Resource-Specific API Calls

| # | Resource | Monitored API Calls |
|---|----------|-------------------|
| 1 | `s3:::infra-terraform-state-<acct>` | GetObject |
| 2 | `secret:prod/payment-gateway/*`, `secret:prod/internal-api/*` | GetSecretValue |
| 3 | `parameter/prod/database/*`, `parameter/prod/ci-cd/*`, `parameter/prod/monitoring/*`, `parameter/prod/vpn/*`, `parameter/prod/kubernetes/*` | GetParameter, GetParametersByPath |
| 4 | `devops-deploy-keys-<acct>`, `instance/<id>`, `security-group/<id>` | GetObject, StartInstances, AuthorizeSecurityGroupIngress |
| 5 | `repository/prod-payment-service` | BatchGetImage, GetDownloadUrlForLayer |
| 6 | `function:prod-data-sync-processor`, `prod-data-sync-artifacts-<acct>`, `secret:prod/data-sync/*`, `parameter/prod/data-sync/*` | GetFunctionConfiguration, GetObject, GetSecretValue, GetParameter |
| 7 | `function:prod-data-inject-processor` | GetFunctionConfiguration, UpdateFunctionCode, InvokeFunction |
| 8 | `parameter/prod/auth/*`, `parameter/prod/data/*`, `parameter/prod/admin/*` | GetParameter |
| 9 | `table/prod-customer-profiles` | DescribeTable, Scan, Query, GetItem |
| 10 | `table/prod-user-sessions` | DescribeTable, Scan, Query |
| 11 | `prod-payment-events.fifo`, `prod-payment-events-dlq.fifo` | GetQueueAttributes, ReceiveMessage |
| 12 | `prod-alerts-critical` | GetTopicAttributes, ListSubscriptionsByTopic, Publish |
| 13 | `log-group:/prod/payment-service/application` | GetLogEvents, FilterLogEvents |
| 14 | `key/<key-id>` (`alias/prod-customer-data-encryption`) | DescribeKey, Decrypt |
| 16 | `role/prod-backup-automation-role`, `parameter/prod/inventory/service-registry` | ListRoleTags, ListTagsForResource |
| 17 | `function:prod-user-data-enrichment`, `table/prod-enriched-user-profiles` | GetFunctionConfiguration, DescribeTable, Scan |
| 18 | `parameter/prod/db/*` | GetParameter, GetParametersByPath |
| 19 | `parameter/prod/core-infra/*` | GetParameter |
| 21 | `parameter/prod/finance/ledger-export-api-key` | GetParameter |

---

## Cost Summary

| Category | Scenarios | Monthly Cost |
|----------|-----------|-------------|
| Free tier (IAM, SSM Standard, DynamoDB, SQS, SNS, CW Logs, Lambda, Tags) | 1, 7-13, 16-19, 21 | $0.00 |
| Secrets Manager ($0.40/secret) | 2 (×3), 6 (×1) | $1.60 |
| SSM Advanced (kubeconfig) | 3 | $0.05 |
| EC2 stopped (EBS only) | 4 | $0.64 |
| ECR storage | 5 | $0.01 |
| KMS key | 14 | $1.00 |
| **Total** | **19 scenarios** | **~$3.30/month** |

---

## Folder Mapping

Every scenario's number is its folder name. There is no `scenario-15` (retired) and no `scenario-20` (never shipped a `main.tf`), so the numbers skip 15 and 20.

| # | Folder | Name |
|---|--------|------|
| 1 | `scenario-1` | Terraform State Lure |
| 2 | `scenario-2` | Payment Credentials |
| 3 | `scenario-3` | Infrastructure Vault |
| 4 | `scenario-4` | SSH Key → EC2 Bastion |
| 5 | `scenario-5` | ECR Container Image |
| 6 | `scenario-6` | Lambda Data Sync |
| 7 | `scenario-7` | Lambda Code Injection |
| 8 | `scenario-8` | Role Chain Loop |
| 9 | `scenario-9` | Customer Profiles |
| 10 | `scenario-10` | Active Sessions |
| 11 | `scenario-11` | Payment Events + DLQ |
| 12 | `scenario-12` | Critical Alerts |
| 13 | `scenario-13` | Leaked Logs |
| 14 | `scenario-14` | Encryption Key |
| 16 | `scenario-16` | Tag Breadcrumbs |
| 17 | `scenario-17` | Enriched User PII |
| 18 | `scenario-18` | SSM Chain |
| 19 | `scenario-19` | Core-Infra Secrets Reference |
| 21 | `scenario-21` | Finance Ledger Export |

---

## Deployment

**Decoys are Terraform.** Each scenario is self-contained in its folder with:

| File | Purpose |
|------|---------|
| `main.tf` + `outputs.tf` | Terraform decoy definition — what the portal deploys. `outputs.tf` names are the source of truth for the EventBridge detection rules |
| `details.md` | Metadata parsed by `/api/scenarios` for the portal catalog |
| `abuse.sh` | Attack simulation script with colored output |
| `fake-data/` | Seed data files (JSON, CSV, YAML) — see P2 in `docs/FEATURES.md` |
| `README.md` | Scenario documentation |

> CloudFormation support (a `template.yaml` + `deploy.sh` pair) was removed. The portal only
> reads Terraform, and a scenario without a `main.tf` is not listed as deployable. Do not add
> CloudFormation scenarios.

### Deploy a scenario

Normally from the portal: **Catalog → Deploy Decoy** (it runs `terraform apply` against the S3 state
backend under `accounts/<acct>/<region>/<scenario>/`). By hand, with spoke credentials:

```bash
cd scenarios/scenario-N
terraform init
terraform apply
```

### Simulate the attack

```bash
chmod +x abuse.sh
./abuse.sh
```

### Teardown

From the portal (**Remove Decoy**), or by hand:

```bash
cd scenarios/scenario-N
terraform destroy     # Terraform empties/removes what it created
```
