# Alert whitelist — roster and procedure

Which roles' decoy access is **not** alerted on, why, and exactly how to add one.

The worked example below (roster, numbers, timestamps) is from one real deployment's tuning
pass — kept because it shows the mechanism concretely, not because the specific numbers are
universal. Expect your own roster to differ; the *procedure* and the matching rules are what
to take from this doc.

That pass was derived from a full scan of the alerts table (110 items at the time,
**all 110 false positives** — signal-to-noise was 0:110). The nine roles below accounted for 93
of them.

## How matching actually works

`<prefix>-event-processor` (hub account) reads the `WHITELISTED_ARNS` environment variable and
matches **by exact role name**:

```python
WHITELISTED_ARNS      = [a.strip() for a in whitelist_str.split(',') if a.strip()]
WHITELISTED_ROLE_NAMES = {w.rstrip('/').split('/')[-1] for w in WHITELISTED_ARNS}
# ...
name = caller_role_name(caller_arn)      # handles both ARN spellings
return bool(name) and name in WHITELISTED_ROLE_NAMES
```

Source: `portal/src/templates/hub/monitoring-brain.yaml` (the Lambda's inline code, search for
`is_whitelisted`).

Three consequences that are easy to get wrong:

1. **Wildcards do not work.** Matching is set membership, not a glob. `AWSServiceRoleFor*`
   would match nothing — each service-linked role must be listed individually.
2. **Both spellings are accepted.** Because the parser keeps the last `/` segment, a bare
   `WizScanner-Role` and a `:role/WizScanner-Role` fragment are equivalent. **Bare names are
   preferred** — the `:role/` form is a leftover from when this was a substring test.
3. **It is deliberately not a substring test on the ARN.** An earlier version compared
   `":role/WizScanner-Role"` against the whole ARN, which never appears in the
   `":assumed-role/WizScanner-Role/<session>"` form CloudTrail actually writes — so it
   suppressed nothing and had fired zero times since deploy. A substring test would also let an
   attacker pick a *session name* containing a whitelisted role name and suppress their own
   alert. Verified still safe: an ARN of
   `arn:aws:sts::<spoke-account-id>:assumed-role/attacker-role/WizScanner-Role` is **not**
   suppressed.

## The worked example (9 entries)

| Role name | Alerts | Why it was suppressed |
|---|---:|---|
| `<prefix>-spoke-deployment-role` | 32 | The platform's own spoke deploy role. Trips decoys during its own deploy/teardown. See the tradeoff below. |
| `AWSConfig` | 24 | Corporate AWS Config/ServiceNow inventory poller. Also the source of a self-sustaining loop: it keeps polling *destroyed* decoys, each poll producing `ResourceNotFoundException` and a persisted alert. |
| `WizAccess-Role` | 0 | Pre-existing entry; Wiz CSPM. Kept. |

Replaying the live Lambda logic against the real 110 alerts in that pass: **93 suppressed, 17
still alerting.**

### Deliberately NOT whitelisted

`AWSReservedSSO_ADMIN_*` — 17 alerts, the only ones left after that change.

This is the **human operator** role. Suppressing it would blind the platform to exactly the
insider-threat behaviour Mirage exists to catch, and would be an attacker-reachable suppression
path for anyone who can get an SSO admin session. The noise is accepted on purpose.

The right fix for *this* noise is behavioural, not a whitelist entry: **do not verify decoys by
reading them with admin credentials.** Read decoy content from the scenario source or from
Terraform state instead. Every one of those 17 alerts was an operator inspecting a decoy.

### Tradeoff accepted on `<prefix>-spoke-deployment-role`

It is 32 of 110 alerts in the example above, and all of it is self-noise from legitimate deploys
and teardowns. But it is also a high-value target — it can create IAM roles and policies in the
spoke. Whitelisting it means a **compromise of that role would not be caught by decoy access.**

Accepted, because misuse of that role is better detected on its IAM actions (CloudTrail on
`CreateRole`/`AttachRolePolicy`/`PutPolicyVersion`) than on decoy reads, and because leaving it
unsuppressed guarantees alert fatigue that hides real hits. Revisit if the role is ever used
outside of portal-driven deploys.

## Procedure — adding a role to the whitelist

Change **both** places or the change silently reverts.

### 1. Source (otherwise the next Deploy Brain reverts it)

`portal/src/templates/hub/monitoring-brain.yaml`, the `WhitelistedARNs` parameter `Default`.
The Lambda env is `!Ref WhitelistedARNs`, so CloudFormation will overwrite any live edit on the
next brain deploy.

### 2. Live (takes effect in seconds, no redeploy)

```bash
export AWS_PROFILE=<hub-profile>
export PREFIX=mirage-ops       # your ResourcePrefix
export HUB_ACCOUNT_ID=<hub-account-id>
cat > /tmp/lambda-env.json <<EOF
{"Variables":{
  "SNS_TOPIC_ARN":"arn:aws:sns:us-west-2:${HUB_ACCOUNT_ID}:${PREFIX}-alerts",
  "ALERTS_TABLE_NAME":"${PREFIX}-alerts",
  "WHITELISTED_ARNS":"<comma-separated role names>"
}}
EOF
aws lambda update-function-configuration --region us-west-2 \
  --function-name "${PREFIX}-event-processor" \
  --environment file:///tmp/lambda-env.json \
  --query 'Environment.Variables.WHITELISTED_ARNS' --output text
```

`update-function-configuration` **replaces the whole `Environment` block**, so all three
variables must be present. Omitting `SNS_TOPIC_ARN` or `ALERTS_TABLE_NAME` silently breaks
alerting rather than erroring.

Do **not** use the `--environment "Variables={...}"` shorthand: it cannot represent a value
containing commas and fails with `Expected: '=', received: ','`.

### 3. Verify before trusting it

Get the real role name from the alert data rather than guessing at the ARN:

```bash
aws dynamodb scan --region us-west-2 --table-name "${PREFIX}-alerts" \
  --projection-expression "callerArn" --output json \
| python3 -c "
import json,sys,collections
def r(a):
    if ':assumed-role/' in a: return a.split(':assumed-role/')[1].split('/')[0]
    if ':role/' in a: return a.split(':role/')[1].split('/')[0]
    return a or '(none)'
d=json.load(sys.stdin)
for k,v in collections.Counter(r(i['callerArn']['S']) for i in d['Items']).most_common():
    print('%-45s %d'%(k,v))"
```

Then confirm the new entry suppresses what you expect and nothing more, by replaying
`is_whitelisted` locally against that output before relying on live traffic.
