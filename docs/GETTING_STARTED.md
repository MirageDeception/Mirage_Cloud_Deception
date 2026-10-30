# Getting started

From nothing to a working detection. You need:

- An **AWS Organization** — the hub-to-spoke trust is scoped to it.
- A **hub account** and at least one **spoke account** in it. They can be the same account for a
  first trial; a separate spoke is closer to real use.
- Admin access to both, through the AWS console (everything below runs in **CloudShell**).

## 1. Install the hub

In the hub account, open **CloudShell** (the `>_` icon in the console's top bar) and run:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/MirageDeception/Mirage_Cloud_Deception/main/install.sh)
```

It asks one question — how you'll reach the portal:

- **Direct URL** — the portal and SSH are open to *your* IP only. Get your IP from
  https://checkip.amazonaws.com in your browser (CloudShell's own IP is different).
- **SSM tunnel** — no open ports. You'll need the AWS CLI and the
  [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)
  on your laptop.

The install takes 10–15 minutes and finishes only once the portal is actually serving. If
CloudShell times out meanwhile, the install keeps going; run the same command again later and it
prints the details.

> The portal has **no login of its own** — your IP allowlist (or the SSM tunnel) is the only thing
> in front of it.

## 2. Deploy the brain

Open the portal → **Deploy Brain** → enter the hub account id and your alert email → Deploy.
Watch progress on the **Queue** page (~3 minutes). Then **confirm the subscription email** AWS
sends you — alerts never arrive until you do.

The allowlist field is pre-filled with the platform's own deploy role and AWS's own scanners, so
your deploys don't alert on themselves.

## 3. Make sure CloudTrail covers your spokes

Decoy touches are seen through CloudTrail, so every spoke account needs a logging trail. Easiest:
in your Organization's management account, open **CloudTrail → Trails** and enable a trail with
**"Enable for all accounts in my organization"**.

Reads of S3 objects (`GetObject`) are *data events* — turn on S3 data events on that trail if you
deploy S3-based scenarios.

## 4. Onboard a spoke

Sign in to the spoke account as an **admin user (not root)**, open **CloudShell**, and paste the
`SpokeOnboardCommand` the installer printed (also in the hub stack's Outputs). It creates two IAM
roles in the spoke — one the portal uses to deploy decoys, one that forwards detections to the
hub. Terraform is installed automatically.

## 5. Deploy a decoy

Portal → **Catalog** → enter the spoke account id → pick the **Deploy Region** → pick scenarios →
**Deploy Selected**. One deploy uses one region for every scenario in it.

Then open **Active Rules** (the tab shows a badge when rules wait for review) and push the
forwarding rules: the **Identity** rule first (it watches the role decoys from every region),
then each **Regional** rule. Until they are pushed, the decoys are deployed but not monitored;
the dashboard's Global Mesh marks them with an amber ring.

If a deploy fails with "already exists", that account still holds decoys from an earlier install
with the same names — delete those first.

## 6. Touch it and watch the alert

In the spoke's CloudShell — as a **non-root** user, since root cannot assume roles — run a
scenario's attack script, e.g. scenario-2:

```bash
git clone -q --depth 1 https://github.com/MirageDeception/Mirage_Cloud_Deception.git ~/mirage 2>/dev/null; bash ~/mirage/scenarios/scenario-2/abuse.sh
```

Within a minute you get an email, and the alert appears on the portal's **Alerts** page.
Nothing arriving? Check the subscription email was confirmed, that CloudTrail covers the spoke
(step 3), and [`ALERT-WHITELIST.md`](ALERT-WHITELIST.md).

## Removing Mirage

Order matters — decoys are torn down *through* the spoke roles, so they go first:

1. Portal → tear down every deployed scenario.
2. Hub CloudShell: `bash <(curl -fsSL https://raw.githubusercontent.com/MirageDeception/Mirage_Cloud_Deception/main/uninstall.sh)`
   — refuses to run while decoys remain; removes the brain and the hub stack; asks about the
   retained state bucket and encryption key.
3. Each spoke's CloudShell: the offboard command `uninstall.sh` prints (runs
   `iam/spoke/offboard-spoke.sh`, which refuses while forwarding rules remain).

Your CloudTrail trails are left alone.

## Next

- [`SCENARIOS.md`](SCENARIOS.md) — what each scenario baits and detects.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — how the pieces fit together.
- [`SCP-GUIDE.md`](SCP-GUIDE.md) — lock it down org-wide once it works.
