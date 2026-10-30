# Scenario 8 — Lambda Role Chaining: Compliance Data Pivot

> **Deployment is Terraform.** This decoy is defined in `main.tf` + `outputs.tf` and is deployed by
> the Mirage portal (Deploy Decoy), or by `terraform init && terraform apply` in this directory.
> The `template.yaml` / `deploy.sh` CloudFormation path that some sections below describe was
> **removed** — treat those sections as historical background. `abuse.sh`, `ABUSE_STEPS.md` and
> `fake-data/` are current.

## Deception Story

An attacker reads a Lambda function's configuration and discovers a
`PIVOT_ROLE_ARN` environment variable pointing to `prod-compliance-data-access-role`.
Unlike the execution role (which only Lambda can assume), this pivot role is
assumable by any account principal. The attacker assumes it directly and gains
access to compliance reports, encryption keys, and database credentials.

## Attack Path

```
Attacker
  │
  ├─► Assumes discovery role
  │     (lambda-ops-readonly-role if linked, compliance-audit-readonly-role if standalone)
  │
  ├─► Reads Lambda config → finds PIVOT_ROLE_ARN in env vars
  │
  ├─► sts:AssumeRole → prod-compliance-data-access-role ⚠️ (directly assumable!)
  │
  └─► Reads compliance data:
        ├─► S3: compliance-audit-reports-<acct>/
        │     ├─► PCI-DSS assessment reports
        │     └─► SOX controls matrix
        ├─► Secrets Manager: prod/compliance/encryption-keys
        │     └─► Data encryption keys, KMS references
        └─► SSM Parameters:
              ├─► /prod/compliance/database-credentials
              └─► /prod/compliance/third-party-integrations
```

## Key Insight

The pivot role has `arn:aws:iam::<AccountId>:root` in its trust policy —
meaning any principal in the account can assume it. The attacker doesn't need
to go through the Lambda. The Lambda is just the breadcrumb that reveals the
pivot role's existence.

## Deployment Modes

| Mode | Description |
|------|-------------|
| **Linked** (recommended) | Adds `PIVOT_ROLE_ARN` to Scenario 6's Lambda env vars. Attacker uses Scenario 6's discovery role as entry point. |
| **Standalone** | Creates its own Lambda + discovery role. Independent of Scenario 6. |

## Detection Signals

| Signal | CloudTrail Event | Confidence |
|--------|-----------------|------------|
| Discovery role assumption | AssumeRole on discovery role | High |
| Lambda config read | GetFunctionConfiguration | High |
| Pivot role assumption | AssumeRole on `prod-compliance-data-access-role` | **Critical** |
| S3 report reads | GetObject on compliance bucket | High |
| Secret read | GetSecretValue on encryption-keys | High |
| SSM reads | GetParameter on /prod/compliance/* | High |

## Cost

| Component | Monthly |
|-----------|---------|
| Secrets Manager (1 secret) | $0.40 |
| S3 (small report files) | $0.00 |
| SSM Standard (2 params) | $0.00 |
| Lambda (standalone, never invoked) | $0.00 |
| **Total** | **$0.40** |

## Deployment (historical — the CloudFormation path was removed)

```bash
chmod +x deploy.sh
./deploy.sh
```

The script will ask whether to link to Scenario 6 or deploy standalone.

### Deploy order (for linked mode)

```bash
cd ../scenario-6 && ./deploy.sh   # Base Lambda blueprint (first)
cd ../scenario-8 && ./deploy.sh   # Compliance pivot (links to scenario-6)
```
