# Hub bootstrap

`hub-bootstrap.yaml` stands up a Mirage hub. The easy way to deploy it is `install.sh` at the repo
root (see the top-level README) — it asks the questions and fills in every parameter. It creates:

- A VPC with one public subnet (no NAT, no VPC interface endpoints — nothing extra to pay for
  or misconfigure).
- The portal EC2 host, which clones `RepoUrl`, builds and starts the portal on first boot. The
  stack only reaches `CREATE_COMPLETE` once the portal is serving (a CloudFormation creation
  signal), so a failed build fails the stack with a reason instead of leaving a dead host.
- The three hub IAM roles (`<prefix>-portal-instance-role`, `<prefix>-hub-service-role`,
  `<prefix>-brain-deployment-role`) with the same least-privilege scoping and self-modification
  locks the platform has always used.
- The Terraform state bucket (`<prefix>-tfstate-<account>-<region>`) that every later Terraform
  step — onboarding a spoke, deploying a decoy scenario — writes its state into.

Everything downstream reads its configuration from **this stack's Outputs**, not from a
hand-edited file. That is deliberate: a flat config file can drift from what's actually deployed;
re-reading the stack cannot.

## Access model — read this before you deploy

`AccessMode` picks how you reach the portal host:

- **`public`** (default) — SSH (22) and the portal UI (3000) open to `AllowedCidr` only, with SSH
  key auth. Simplest, but the host is internet-routable even though the security group blocks
  everyone but you.
- **`ssm`** — no inbound rules at all. Reach the UI with the `PortalTunnelCommand` output (AWS CLI +
  Session Manager plugin on your laptop). The host keeps a public IP purely for outbound downloads.
  Some organizations block SSM; use `public` there.

For no public IP at all (NAT + VPC interface endpoints), use `advanced/ssm-private/` instead.

The portal itself has **no application-layer login** — authentication/RBAC is future work. Your
`AllowedCidr` (or the SSM tunnel) is the only thing standing between the internet and a console
that can deploy and destroy cross-account AWS infrastructure. Don't widen it past your own IP.

## Deploy by hand (instead of install.sh)

Copy `parameters.example.json` to `parameters.json`, fill in `OrgId`
(`aws organizations describe-organization --query Organization.Id --output text`), `AccessMode`,
and for `public` also `AllowedCidr` (your IP from https://checkip.amazonaws.com, as `x.x.x.x/32`)
and `SshPublicKey`. `RepoUrl` must be a URL the host can clone without credentials. Then:

```bash
aws cloudformation deploy \
  --template-file hub-bootstrap.yaml \
  --stack-name mirage-hub-bootstrap \
  --parameter-overrides file://parameters.json \
  --capabilities CAPABILITY_NAMED_IAM
```

It takes 10–15 minutes (EC2 boot, Node/Terraform install, portal build). Then:

```bash
aws cloudformation describe-stacks --stack-name mirage-hub-bootstrap \
  --query 'Stacks[0].Outputs' --output table
```

The outputs you need: `PortalUrl` (or `PortalTunnelCommand`), `ExternalId` (generated per
install), and `SpokeOnboardCommand` (paste into each spoke's CloudShell). The host's portal
settings are written from the same values, so nothing needs editing on the box. To run a portal on
your laptop against this hub instead, `bash ../scripts/sync-env-from-stack.sh` writes
`portal/.env.local` from the outputs.

`PortalUrl` keeps the first-boot IP; after stopping and starting the instance, re-run
`install.sh` to print the current one.

Next: **Deploy Brain**, onboard a spoke, deploy a decoy, run its `abuse.sh`. Full walkthrough in
`docs/GETTING_STARTED.md`.

## Changing the resource-name prefix

Every hub-infra resource this template creates is named `${ResourcePrefix}-...` (default
`mirage-ops`). Set a different `ResourcePrefix` parameter before you deploy if you want the
platform's own management-plane resources (roles, event bus, tables, state bucket) under a
different name — it's the one place that controls all of them. This is separate from decoy
naming, which is per-scenario (see `scenarios/`).

## Tearing down

```bash
aws cloudformation delete-stack --stack-name mirage-hub-bootstrap
```

The Terraform state bucket and the EBS encryption key are `Retain`ed on delete (so destroying the
stack can't take your state or your encrypted volume's key with it) — remove those by hand once
you've confirmed you don't need them.
