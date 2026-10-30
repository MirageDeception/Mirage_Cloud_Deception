#!/bin/bash
# Self-check for portal/src/lib/tf-errors.ts (plain messages for Terraform failures). Run from the repo root.
set -euo pipefail
OUT=$(mktemp -d); trap 'rm -rf "$OUT"' EXIT
(cd portal && npx tsc --outDir "$OUT" --module commonjs --target es2020 src/lib/tf-errors.ts)
cat > "$OUT/test.js" <<'JS'
const assert = require('assert');
const { existingResources, deployErrorMessage } = require('./tf-errors.js');
// Real output from a deploy into an account that still held an earlier install's decoys.
const tf = `Command failed: terraform apply -auto-approve -input=false -var="account_id=111111111111"
╷
│ Error: creating IAM Role (infra-config-readonly-role): operation error IAM: CreateRole, https response error StatusCode: 409, RequestID: 9e20, EntityAlreadyExists: Role with name infra-config-readonly-role already exists.
│
│   with aws_iam_role.infra_config_readonly_role,
╵
╷
│ Error: creating IAM Policy (infra-config-readonly-policy): operation error IAM: CreatePolicy, https response error StatusCode: 409, RequestID: bf42, EntityAlreadyExists: A policy called infra-config-readonly-policy already exists. Duplicate names are not allowed.
╵
╷
│ Error: creating SSM Parameter (/prod/database/master-credentials): operation error SSM: PutParameter, https response error StatusCode: 400, ParameterAlreadyExists: The parameter already exists.
╵`;
assert.deepStrictEqual(existingResources(tf), ['infra-config-readonly-role', 'infra-config-readonly-policy', '/prod/database/master-credentials']);
const msg = deployErrorMessage({ message: tf, stderr: tf }, '111111111111');
assert.ok(msg.startsWith('Already exists in account 111111111111: infra-config-readonly-role, infra-config-readonly-policy, /prod/database/master-credentials.'));
// Other failures keep Terraform's own text.
const denied = 'Command failed: terraform apply\n│ Error: creating IAM Role (x): operation error IAM: CreateRole, StatusCode: 403, AccessDenied: not authorized';
assert.deepStrictEqual(existingResources(denied), []);
assert.strictEqual(deployErrorMessage({ message: denied }, '1'), denied);
// One "exists" block does not pull in a different failure next to it.
assert.deepStrictEqual(existingResources(`Error: creating S3 Bucket (b-1): BucketAlreadyOwnedByYou: yours\nError: creating Lambda Function (f): InvalidParameterValueException: bad role`), ['b-1']);
console.log('tf-errors ok');
JS
node "$OUT/test.js"
