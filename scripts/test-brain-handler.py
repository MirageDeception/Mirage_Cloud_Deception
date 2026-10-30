#!/usr/bin/env python3
# ==============================================================================
# test-brain-handler.py - offline tests for the brain Lambda's inline handler
#
# Run ON THE BOX from a workspace root (no AWS calls, no credentials needed):
#   python3 scripts/test-brain-handler.py
#
# Extracts the inline Python out of portal/src/templates/hub/monitoring-brain.yaml,
# stubs boto3, and drives lambda_handler with CloudTrail-shaped events. Covers the
# detection-persistence contract: the SNS/SOAR path still fires, the item shape is
# right, a redelivery is idempotent, and the identity/account fallbacks work.
#
# TEST 2b intentionally documents a KNOWN BUG rather than asserting it passes --
# see the comment there.
# ==============================================================================
import sys, types, os, json, copy, yaml

class CFN(yaml.SafeLoader): pass
CFN.add_multi_constructor("!", lambda l, s, n: f"<{s}>")
d = yaml.load(open("portal/src/templates/hub/monitoring-brain.yaml"), Loader=CFN)
code = d["Resources"]["V2EventProcessor"]["Properties"]["Code"]["ZipFile"]

cap = {"sns": [], "put": []}
class CCFE(Exception): pass
class FakeTable:
    def __init__(self, dup=False): self.dup = dup
    def put_item(self, **kw):
        if self.dup: raise CCFE("duplicate")
        cap["put"].append(kw)
class _Exc: ConditionalCheckFailedException = CCFE
class _Client: exceptions = _Exc
class _Meta: client = _Client
class FakeResource:
    meta = _Meta
    dup = False
    def Table(self, name): return FakeTable(FakeResource.dup)
class FakeSns:
    def publish(self, **kw): cap["sns"].append(kw)

fb = types.ModuleType("boto3")
fb.client = lambda n, **k: FakeSns()
fb.resource = lambda n, **k: FakeResource()
sys.modules["boto3"] = fb

os.environ.update(SNS_TOPIC_ARN="arn:aws:sns:us-west-2:11111111111111:mirage-ops-alerts",
                  WHITELISTED_ARNS=":role/WizScanner-Role,:role/WizAccess-Role",
                  ALERTS_TABLE_NAME="mirage-alerts")
ns = {}
exec(compile(code, "handler.py", "exec"), ns)
handler = ns["lambda_handler"]

class Ctx: aws_request_id = "fallback-req-id"

EVENT = {"source": "aws.s3", "account": "11111111111111", "detail": {
    "eventID": "11111111-2222-3333-4444-555555555555",
    "eventTime": "2026-09-21T18:30:00Z", "eventName": "GetObject",
    "awsRegion": "us-west-2", "sourceIPAddress": "203.0.113.42",
    "recipientAccountId": "222222222222",
    "userIdentity": {"arn": "arn:aws:sts::222222222222:assumed-role/infra-s3-data-readonly-role/attacker"},
    "requestParameters": {"bucketName": "infra-terraform-state-222222222222", "key": "terraform.tfstate"}}}

print("--- TEST 1: real decoy hit ---")
handler(copy.deepcopy(EVENT), Ctx())
assert len(cap["sns"]) == 1, "SNS must still fire"
assert len(cap["put"]) == 1, f"expected 1 put, got {len(cap['put'])}"
it = cap["put"][0]["Item"]
print("  PK:", it["PK"]); print("  SK:", it["SK"])
print("  id:", it["id"]); print("  status:", it["status"])
print("  decoy:", it["resourceName"]); print("  event:", it["eventName"])
print("  callerArn:", it["callerArn"][:60] + "...")
print("  actionStatus:", it["actionStatus"], "| region:", it["awsRegion"], "| ip:", it["sourceIp"])
print("  ttl is int:", isinstance(it["ttl"], int), "| ~days out:", round((it["ttl"] - __import__("time").time())/86400))
print("  ConditionExpression:", cap["put"][0]["ConditionExpression"])
assert it["PK"] == "DETECTION#222222222222"
assert it["id"] == EVENT["detail"]["eventID"], "id must be the CloudTrail eventID"
assert it["SK"] == f"ALERT#{EVENT['detail']['eventTime']}-{EVENT['detail']['eventID']}"
assert it["status"] == "active"
assert cap["put"][0]["ConditionExpression"] == "attribute_not_exists(PK)"
assert json.loads(it["rawDetail"])["eventName"] == "GetObject"

print("--- TEST 2a: whitelisted, IAM role-ARN form (what the pattern matches) ---")
wl = copy.deepcopy(EVENT)
wl["detail"]["userIdentity"]["arn"] = "arn:aws:iam::222222222222:role/WizScanner-Role"
handler(wl, Ctx())
assert len(cap["sns"]) == 1, "whitelisted must NOT publish"
assert len(cap["put"]) == 1, "whitelisted must NOT be persisted"
print("  suppressed before both SNS and DynamoDB: OK")

print("--- TEST 2b: whitelisted role, assumed-role session form ---")
# CloudTrail writes a role session as arn:aws:sts::<acct>:assumed-role/<Role>/<session>.
# Both spellings must suppress now that we compare the extracted role NAME.
wl2 = copy.deepcopy(EVENT)
wl2["detail"]["eventID"] = "wiz-session-event"
wl2["detail"]["userIdentity"]["arn"] = "arn:aws:sts::222222222222:assumed-role/WizScanner-Role/scan"
b_sns, b_put = len(cap["sns"]), len(cap["put"])
handler(wl2, Ctx())
assert len(cap["sns"]) == b_sns, "assumed-role form must NOT publish"
assert len(cap["put"]) == b_put, "assumed-role form must NOT be persisted"
print("  suppressed before both SNS and DynamoDB: OK")

print("--- TEST 2c: attacker-chosen session name must NOT self-suppress ---")
# The whole point of comparing the role component only: a session name containing
# a whitelisted role name must still alert.
ev = copy.deepcopy(EVENT)
ev["detail"]["eventID"] = "attacker-session-event"
ev["detail"]["userIdentity"]["arn"] = "arn:aws:sts::222222222222:assumed-role/attacker-role/WizScanner-Role"
b_sns, b_put = len(cap["sns"]), len(cap["put"])
handler(ev, Ctx())
assert len(cap["sns"]) == b_sns + 1, "attacker session name must NOT suppress the alert"
assert len(cap["put"]) == b_put + 1, "attacker session name must NOT suppress persistence"
print("  alerted despite WizScanner-Role in the session name: OK")

print("--- TEST 2d: a non-whitelisted role still alerts ---")
ev = copy.deepcopy(EVENT)
ev["detail"]["eventID"] = "normal-role-event"
ev["detail"]["userIdentity"]["arn"] = "arn:aws:sts::222222222222:assumed-role/some-other-role/sess"
b_put = len(cap["put"])
handler(ev, Ctx())
assert len(cap["put"]) == b_put + 1, "non-whitelisted role must alert"
print("  alerted: OK")

print("--- TEST 3: Lambda retry (duplicate) ---")
FakeResource.dup = True
n = len(cap["put"])
r = handler(copy.deepcopy(EVENT), Ctx())
assert len(cap["put"]) == n, "duplicate must not add a row"
assert r["statusCode"] == 200, "duplicate must not fail the invocation"
print("  ConditionalCheckFailed swallowed, handler returned 200: OK")
FakeResource.dup = False

print("--- TEST 4: missing eventID falls back to request id ---")
ne = copy.deepcopy(EVENT); del ne["detail"]["eventID"]
handler(ne, Ctx())
assert cap["put"][-1]["Item"]["id"] == "fallback-req-id"
print("  id fell back to context.aws_request_id: OK")

print("--- TEST 5: missing recipientAccountId falls back to envelope account ---")
na = copy.deepcopy(EVENT); del na["detail"]["recipientAccountId"]; na["detail"]["eventID"] = "aaaa-bbbb"
handler(na, Ctx())
assert cap["put"][-1]["Item"]["PK"] == "DETECTION#11111111111111"
print("  PK fell back to event['account']: OK")

print()
print("ALL TESTS PASSED")
