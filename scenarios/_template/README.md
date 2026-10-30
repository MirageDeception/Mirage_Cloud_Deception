# Scenario template

Start every new scenario from this folder. It is a complete, deployable example: a lure
IAM role that can read one decoy secret.

## Files

| File | Required | What it is |
|---|---|---|
| `main.tf` | yes | The decoys. Must declare `variable "account_id"`. No `provider "aws"` or backend — the portal adds both. |
| `outputs.tf` | yes | `output "decoy_resources"` — tells the portal which decoys to watch. A decoy missing here never alerts. |
| `details.md` | yes | First line `# <Name>` (shown in the catalog), then a description. |
| `.terraform.lock.hcl` | yes (official) | Pins the AWS provider version so deploys reuse the shared plugin cache instead of downloading ~768 MB each time. Copy this one unless you need another provider. |
| `abuse.sh` | recommended | Walks the attack path so you can see each step alert. |
| `populate-manifest.json` + `fake-data/` | optional | Seeds decoy content after deploy (see an existing scenario, e.g. scenario-2). |

## Rules the checker enforces

Run `python3 scripts/validate-scenario.py <folder>` (add `--strict` for custom uploads,
`--terraform` to also run `terraform validate`).

- Every `decoy_resources` category is one the alarm pipeline can match:
  `iam, s3, secretsmanager, ssm, dynamodb, kms, ecr, lambda, cloudformation, logs, sqs, sns`.
- No `provisioner` blocks and no `data "external"` — they run commands on the portal host.
  Every `.tf` file is checked, including those in subfolders.
- Modules only from a folder inside the scenario (`source = "./name"`). Remote and registry
  modules are downloaded at deploy time and never checked. No `.tf.json` files.
- No `Action = "*"`, no `"iam:*"`, no admin-level managed policies.
- Custom uploads (`--strict`) may only use `aws_*`, `archive_*` and `random_*` resources,
  and no provider other than `aws`. A `provider "aws"` block may only be in `main.tf`
  (the portal replaces it with one that assumes the spoke role) and may not use `alias`.
  File paths (`file()`, `source`, `filename`, ...) must stay inside the scenario folder:
  `"${path.module}/..."` or a plain relative path, never absolute and never `..`.

## Conventions

- Decoy names must be unique per account: two scenarios with the same decoy name cannot
  both deploy.
- Fake data is obviously fake and marked **EXPIRED**, in neutral wording — never "decoy",
  "honeypot" or "mirage" anywhere an attacker can read.
