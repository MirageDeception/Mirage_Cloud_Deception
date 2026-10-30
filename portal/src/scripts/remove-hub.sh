#!/bin/bash
# ==============================================================================
# remove-hub.sh — Remove ALL v2 resources from the HUB account
# ==============================================================================

set -euo pipefail

# Inputs
REGION=$1
WHITELISTED_ARNS=$2 # Not strictly needed for teardown, but kept for signature consistency if needed
PREFIX="${MIRAGE_RESOURCE_PREFIX:-mirage-ops}" # inherited from the portal's own env (remove-brain/route.ts spreads process.env)

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

echo -e "============================================"
echo -e "  CLEANUP v2 — Delete Hub Resources         "
echo -e "============================================"
echo -e "  Hub Account: ${ACCOUNT_ID}"
echo -e "  Region:      ${REGION}"
echo ""

# ------------------------------------------------------------------------------
# empty_bucket <name>
#
# Removes every object version AND delete marker. A plain `s3 rm --recursive` is
# not enough on a versioned bucket: it only adds delete markers, and S3 still
# refuses the bucket delete while any version or marker remains.
# ------------------------------------------------------------------------------
empty_bucket() {
  local bucket=$1
  echo -e "    emptying s3://${bucket} ..."
  BUCKET="${bucket}" REGION="${REGION}" python3 - <<'PY'
import json, os, subprocess, sys

bucket, region = os.environ["BUCKET"], os.environ["REGION"]

def aws(*args, payload=None):
    cmd = ["aws", "s3api", *args, "--bucket", bucket, "--region", region, "--output", "json"]
    if payload is not None:
        cmd += ["--delete", payload]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        sys.exit(f"      aws s3api {args[0]} failed: {r.stderr.strip()[:300]}")
    return json.loads(r.stdout) if r.stdout.strip() else {}

removed = 0
while True:
    page = aws("list-object-versions")
    objs = [{"Key": o["Key"], "VersionId": o["VersionId"]}
            for o in (page.get("Versions") or []) + (page.get("DeleteMarkers") or [])]
    if not objs:
        break
    # S3 caps delete-objects at 1000 keys per call.
    for i in range(0, len(objs), 1000):
        chunk = objs[i:i + 1000]
        aws("delete-objects", payload=json.dumps({"Objects": chunk, "Quiet": True}))
        removed += len(chunk)

print(f"    ✓ removed {removed} versions/markers from {bucket}")
PY
}

# ------------------------------------------------------------------------------
# delete_stack <name>
#
# An absent stack is success — a correct no-op, not a removal. The caller relies
# on that to report the step as skipped rather than done.
#
# CloudFormation cannot delete a non-empty bucket, and DeletionPolicy: Delete does
# not imply "empty it first": S3 answers 409 "The bucket you tried to delete is
# not empty. You must delete all versions in the bucket." So on that specific
# failure we empty exactly the buckets CFN named, then retry once.
#
# Only buckets CloudFormation itself tried to delete are ever emptied. That is the
# safety property: CFN never attempts deletion of a DeletionPolicy: Retain
# resource, so a Retain bucket cannot reach this path and its contents — the whole
# point of Retain — are never touched.
# ------------------------------------------------------------------------------
delete_stack() {
  local stack=$1 attempt status blocked
  if ! aws cloudformation describe-stacks --stack-name "${stack}" \
        --region "${REGION}" >/dev/null 2>&1; then
    echo -e "  ○ ${stack} not present — nothing to delete"
    return 0
  fi

  for attempt in 1 2; do
    echo -e "  Deleting stack: ${stack} (attempt ${attempt})..."
    aws cloudformation delete-stack --stack-name "${stack}" --region "${REGION}"

    if aws cloudformation wait stack-delete-complete \
         --stack-name "${stack}" --region "${REGION}" 2>/dev/null; then
      echo -e "  ✓ ${stack} deleted"
      return 0
    fi

    # `wait` also reports failure once the stack no longer exists at all.
    if ! aws cloudformation describe-stacks --stack-name "${stack}" \
          --region "${REGION}" >/dev/null 2>&1; then
      echo -e "  ✓ ${stack} deleted"
      return 0
    fi

    status=$(aws cloudformation describe-stacks --stack-name "${stack}" \
      --region "${REGION}" --query 'Stacks[0].StackStatus' --output text)
    aws cloudformation describe-stack-events --stack-name "${stack}" \
      --region "${REGION}" \
      --query 'StackEvents[?ResourceStatus==`DELETE_FAILED`].[LogicalResourceId,PhysicalResourceId,ResourceStatusReason]' \
      --output json > /tmp/remove-hub-failures.json

    if [ "${attempt}" -eq 1 ]; then
      blocked=$(python3 -c '
import json
seen = []
for logical, physical, reason in json.load(open("/tmp/remove-hub-failures.json")) or []:
    if physical and reason and "not empty" in reason and physical not in seen:
        seen.append(physical)
print("\n".join(seen))')
      if [ -n "${blocked}" ]; then
        echo -e "  ${stack} is ${status}: buckets still hold contents. Emptying them:"
        while read -r bucket; do
          [ -n "${bucket}" ] && empty_bucket "${bucket}"
        done <<<"${blocked}"
        continue
      fi
    fi

    echo -e "  ✗ ${stack} is ${status} and could not be deleted:" >&2
    python3 -c '
import json, sys
for logical, physical, reason in json.load(open("/tmp/remove-hub-failures.json")) or []:
    print(f"      {logical}: {reason}", file=sys.stderr)'
    return 1
  done
  return 1
}

delete_stack "${PREFIX}-service-rules"
delete_stack "${PREFIX}-monitoring"

echo ""
echo -e "  Hub account v2 cleanup complete."
