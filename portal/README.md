# Mirage portal

The Next.js orchestration portal: deploy/remove the hub monitoring brain, deploy decoy scenarios
into spoke accounts, generate and manage the EventBridge detection rules, and review history.
For the platform as a whole (hub/spoke model, credential chain), see
[`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md). For the real end-to-end setup path, see
[`../docs/GETTING_STARTED.md`](../docs/GETTING_STARTED.md) — this doc covers the portal's own UI,
once you're at the point of running it.

## Table of Contents
1. [Prerequisites](#prerequisites)
2. [Running it](#running-it)
3. [Platform walkthrough](#platform-walkthrough)
   - [1. Deploy Brain / Remove Brain](#1-deploy-brain--remove-brain)
   - [2. Deception Catalog](#2-deception-catalog)
   - [3. Rule generation](#3-rule-generation)
   - [4. Active Rules & Scenario Review](#4-active-rules--scenario-review)
   - [5. History & Notifications](#5-history--notifications)
   - [6. State: local files vs DynamoDB](#6-state-local-files-vs-dynamodb)

## Prerequisites

- Node.js 18+ and npm.
- Terraform >= 1.0 (used by the backend to provision decoy scenarios and spoke IAM — not needed
  just to click around the UI locally).
- AWS credentials for the account(s) you're pointing at (the hub, and separately each spoke) —
  via `~/.aws/credentials`, exported env vars, or (if the portal is running on the
  `hub/hub-bootstrap.yaml` EC2 host) its instance role.

## Running it

```bash
npm install
STORAGE_BACKEND=local npm run dev    # http://localhost:3000, flat-file state, no AWS writes
```

`STORAGE_BACKEND=local` is safe to click around in — it never touches AWS or real state. Once
you've deployed a hub (see [`../docs/GETTING_STARTED.md`](../docs/GETTING_STARTED.md)), run
`bash ../scripts/sync-env-from-stack.sh` to generate a real `.env.local` and switch to
`STORAGE_BACKEND=aws`.

## Platform walkthrough

### 1. Deploy Brain / Remove Brain
The "Brain" is the hub's own detection infrastructure. **Deploy Brain** runs two CloudFormation
stacks (`portal/src/templates/hub/monitoring-brain.yaml` + `service-rules.yaml`, via the
`<prefix>-brain-deployment-role` the hub bootstrap stack created) that provision:

- **Global EventBus** (`<prefix>-event-bus`) — the ingress point for cross-account CloudTrail
  telemetry from every onboarded spoke.
- **Event Processor Lambda** (`<prefix>-event-processor`) — reads incoming events, checks them
  against the whitelist (see [`../docs/ALERT-WHITELIST.md`](../docs/ALERT-WHITELIST.md)), and
  formats an alert.
- **Alert Dispatcher** (SNS topic `<prefix>-alerts`) — pushes alerts to whatever you subscribe
  (email, a webhook, etc.).
- **Per-service EventBridge rules** — static Tier-2 filtering on the bus, narrowing to the
  specific API calls each decoy category cares about (see
  [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) §5 for the two-tier filtering design).

To deploy or remove the Brain you provide the hub account ID and (optionally) an email/webhook
to subscribe. The deployment role ARN is derived automatically from the account ID and your
`ResourcePrefix` — you don't type it.

### 2. Deception Catalog
The Catalog lists the scenarios vendored into this repo at `scenarios/scenario-N/` (Terraform:
`main.tf` + `outputs.tf`) — there's no external repo and no sync step; the portal reads them
straight off disk (`SCENARIOS_DIR`, see `portal/src/lib/tf-render.ts`).

**Renaming a decoy:** most scenarios now expose their primary lure name(s) as a Terraform
`variable` with a sensible default — open the scenario's `main.tf`, find the `variable` block
(e.g. `bucket_name`, `role_name`), and override it with `-var` at deploy time, or just edit the
default in the file. See [`../docs/SCENARIOS.md`](../docs/SCENARIOS.md) for the full catalog.

**Deploying decoys:** fill in the spoke account ID and the hub's EventBus ARN (shown on the
Deploy Brain page once a brain is live) in the Catalog's auth panel, select scenarios, and
**Deploy Selected**. The spoke deployment/forwarding role ARNs are derived automatically from
the account ID.

### 3. Rule generation
When a scenario deploys, the portal reads the real `terraform output -json` to discover the
exact names of the resources that were just created, then generates an EventBridge rule that
matches CloudTrail calls against those specific names (never a broad `*`).

**Two modes** (toggle in the UI):
1. **Individual Rules** — one EventBridge rule per scenario. Cleaner isolation, uses more of the
   account's rule quota.
2. **Bin-Packing** — decoys are appended to a shared rule up to AWS's event-pattern character
   limit, then overflow into a new one automatically. Tearing down a scenario surgically strips
   just its entries back out of the pattern rather than rewriting the whole rule from scratch.

### 4. Active Rules & Scenario Review
- **Active Rules** — every generated rule and its current JSON event pattern. In bin-packing
  mode, deploying or tearing down a scenario shows a diff (additions/removals) of the pattern
  change before you push it.
- **Active Scenarios** — inventory of what's deployed where: account, scenario, deploy
  timestamp, parameters.

### 5. History & Notifications
- **History tab** — an audit log of every deploy, teardown, rule push, and trust-policy update.
- **Activity feed** — real-time status notifications, including backend Terraform error text
  when an AWS deployment fails.

### 6. State: local files vs DynamoDB
`STORAGE_BACKEND=local` tracks scenarios/rules/history in flat JSON files under `portal/`
(gitignored — they're regenerated, not source, and the portal creates them automatically on
first write if they don't exist). `STORAGE_BACKEND=aws` uses the single `<prefix>-state`
DynamoDB table instead (created by Deploy Brain) — see
[`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) §4 for its key schema. Detections (decoy
hits) always live in DynamoDB (`<prefix>-alerts`), never in a local file, since that table is the
forensic record.
