#!/usr/bin/env bash
# ==============================================================================
# probe-decoys.sh — Fire decoys in a spoke account and validate CloudTrail events.
#
# Self-contained: no sub-script calls. Every scenario implemented inline.
#
# USAGE
# ──────
#   # Interactive — prompts yes/no for every scenario:
#   bash scripts/probe-decoys.sh
#
#   # Run all scenarios, no prompts:
#   bash scripts/probe-decoys.sh -a
#
#   # Run specific scenarios by ID:
#   bash scripts/probe-decoys.sh 1 2 15
#   bash scripts/probe-decoys.sh 16 17 18 19-ssm 19-cfn
#
#   # Verbose — print full AWS response bodies:
#   bash scripts/probe-decoys.sh -v -a
#   bash scripts/probe-decoys.sh -v 1 6 15
#
# FLAGS
#   -a / --all          Run all scenarios, no per-scenario prompts
#   -v / --verbose      Print full AWS response bodies (default: suppressed)
#   -l / --list         Print scenario list and exit — fires nothing
#   -r / --region R     Override spoke region (default us-west-2)
#   -h / --help         Show usage and exit
#
# POSITIONAL ARGS
#   One or more scenario IDs. Mutually exclusive with -a.
#   Valid IDs: 1 2 3 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19-ssm 19-cfn
#
# EXCLUDED
#   scenario-4  Starts a real EC2 instance + opens an SG rule. Always excluded.
# ==============================================================================
set -uo pipefail

# ── colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

hdr()    { echo -e "\n${CYAN}${BOLD}━━━ $* ━━━${NC}"; }
ok()     { echo -e "  ${GREEN}[✓]${NC} $*"; }
info()   { echo -e "  ${DIM}[·]${NC} $*"; }
warn()   { echo -e "  ${YELLOW}[!]${NC} $*"; }
fail()   { echo -e "  ${RED}[✗]${NC} $*"; }
attack() { echo -e "  ${RED}[⚡]${NC} $*"; }

# ── scenario registry ─────────────────────────────────────────────────────────
SCENARIOS=(
  "1|S3 Terraform state lure"
  "2|Secrets Manager payment credentials"
  "3|SSM Parameter Store infra config"
  "5|ECR container image registry"
  "6|Lambda data-sync config + env secrets"
  "7|Lambda code-injection discovery"
  "8|IAM circular role chain (auth→data→admin→auth)"
  "9|IAM role chain loop"
  "10|DynamoDB customer profiles PII"
  "11|DynamoDB active sessions / JWT tokens"
  "12|SQS payment events dead-letter queue"
  "13|SNS critical alerts topic"
  "14|CloudWatch Logs leaked credentials"
  "15|KMS CMK audit + Decrypt denied"
  "16|IAM SAML/Okta SSO enumeration"
  "17|Resource Groups tag inventory"
  "18|ETL Lambda + DynamoDB enriched PII"
  "19-ssm|SSM DB parameter cross-reference chain"
  "19-cfn|CloudFormation stack outputs lure"
)

VALID_IDS=()
for _s in "${SCENARIOS[@]}"; do VALID_IDS+=("${_s%%|*}"); done

# ── flag parsing ──────────────────────────────────────────────────────────────
RUN_ALL=0; VERBOSE=0; LIST_ONLY=0
REGION="${AWS_DEFAULT_REGION:-us-west-2}"
EXPECTED_ACCOUNT="${MIRAGE_PROBE_ACCOUNT:?Set MIRAGE_PROBE_ACCOUNT to the target spoke account id.}"
REQUESTED_IDS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    -a|--all)     RUN_ALL=1;    shift ;;
    -v|--verbose) VERBOSE=1;    shift ;;
    -l|--list)    LIST_ONLY=1;  shift ;;
    -r|--region)  REGION="$2";  shift 2 ;;
    -h|--help)    sed -n '2,/^set -uo pipefail/p' "${BASH_SOURCE[0]}" | sed '$d'; exit 0 ;;
    -*)           echo "Unknown flag: $1 (use --help)" >&2; exit 1 ;;
    *)
      _ok=0
      for _v in "${VALID_IDS[@]}"; do [[ "$1" == "$_v" ]] && { _ok=1; break; }; done
      if [[ $_ok -eq 0 ]]; then
        echo "Unknown scenario ID: '$1'  Valid: ${VALID_IDS[*]}" >&2; exit 1
      fi
      REQUESTED_IDS+=("$1"); shift ;;
  esac
done

[[ $RUN_ALL -eq 1 && ${#REQUESTED_IDS[@]} -gt 0 ]] && {
  echo "-a and specific IDs are mutually exclusive." >&2; exit 1; }

# ── list ──────────────────────────────────────────────────────────────────────
if [[ $LIST_ONLY -eq 1 ]]; then
  echo -e "\n${BOLD}probe-decoys.sh — available scenarios${NC}\n"
  printf "  %-12s %s\n" "ID" "Description"
  printf "  %-12s %s\n" "────────────" "────────────────────────────────────────────"
  for s in "${SCENARIOS[@]}"; do
    IFS='|' read -r id desc <<< "$s"; printf "  %-12s %s\n" "$id" "$desc"
  done
  echo -e "\n  scenario-4 always excluded (EC2 StartInstances + SG rule)"
  echo -e "\n  ${BOLD}Examples:${NC}"
  echo "    bash scripts/probe-decoys.sh -a"
  echo "    bash scripts/probe-decoys.sh 1 6 15"
  echo "    bash scripts/probe-decoys.sh -v 16 17 18 19-ssm 19-cfn"
  echo ""; exit 0
fi

# ── build RUN_IDS ─────────────────────────────────────────────────────────────
RUN_IDS=()

_desc() {
  local qid="$1"
  for s in "${SCENARIOS[@]}"; do
    IFS='|' read -r id desc <<< "$s"
    [[ "$id" == "$qid" ]] && { echo "$desc"; return; }
  done; echo "unknown"
}

if [[ $RUN_ALL -eq 1 ]]; then
  for s in "${SCENARIOS[@]}"; do RUN_IDS+=("${s%%|*}"); done
elif [[ ${#REQUESTED_IDS[@]} -gt 0 ]]; then
  # preserve registry order
  for s in "${SCENARIOS[@]}"; do
    sid="${s%%|*}"
    for rid in "${REQUESTED_IDS[@]}"; do
      [[ "$sid" == "$rid" ]] && { RUN_IDS+=("$sid"); break; }
    done
  done
else
  # interactive
  echo -e "\n${BOLD}Select scenarios to probe${NC}  (Enter/y = yes, n = skip)\n"
  printf "  %-12s %-44s %s\n" "ID" "Description" "Run?"
  printf "  %-12s %-44s %s\n" "────────────" "────────────────────────────────────" "────"
  for s in "${SCENARIOS[@]}"; do
    IFS='|' read -r id desc <<< "$s"
    printf "  ${CYAN}%-12s${NC} %-44s " "$id" "$desc"
    read -r _ans </dev/tty
    if [[ -z "${_ans}" || "${_ans}" == "y" || "${_ans}" == "Y" ]]; then
      RUN_IDS+=("$id"); echo -e "  ${DIM}↳ added${NC}"
    else
      echo -e "  ${DIM}↳ skipped${NC}"
    fi
  done
fi

if [[ ${#RUN_IDS[@]} -eq 0 ]]; then
  warn "No scenarios selected — nothing to run."; exit 0
fi

# ── run plan + confirmation ───────────────────────────────────────────────────
echo -e "\n${BOLD}Run plan${NC}  (${#RUN_IDS[@]} scenario(s)  ·  account ${EXPECTED_ACCOUNT}  ·  region ${REGION})\n"
for id in "${RUN_IDS[@]}"; do
  printf "  ${GREEN}✓${NC}  %-12s %s\n" "$id" "$(_desc "$id")"
done
echo ""
[[ $VERBOSE -eq 1 ]] && info "Verbose mode ON — full AWS responses will be printed"

read -rp "$(echo -e "${RED}Fire these probes? [y/N]: ${NC}")" _confirm </dev/tty
[[ "${_confirm}" == "y" || "${_confirm}" == "Y" ]] || { info "Aborted."; exit 0; }

# ── preflight: verify identity ────────────────────────────────────────────────
echo -e "\n${BOLD}probe-decoys.sh${NC}  —  decoy validation"
echo -e "${DIM}region: ${REGION}   expected account: ${EXPECTED_ACCOUNT}${NC}\n"
info "Verifying AWS identity..."
set +e
CALLER_JSON=$(aws sts get-caller-identity --output json 2>&1)
ID_RC=$?
set -e
if [[ $ID_RC -ne 0 ]]; then
  fail "aws sts get-caller-identity failed: ${CALLER_JSON}"
  fail "Set AWS_PROFILE or export credentials, then retry."; exit 1
fi
ACTUAL_ACCOUNT=$(echo "$CALLER_JSON" | jq -r '.Account')
CALLER_ARN=$(echo "$CALLER_JSON"     | jq -r '.Arn')
ok "Account: ${ACTUAL_ACCOUNT}  (${CALLER_ARN})"
if [[ "${ACTUAL_ACCOUNT}" != "${EXPECTED_ACCOUNT}" ]]; then
  fail "Credentials are for ${ACTUAL_ACCOUNT}, not ${EXPECTED_ACCOUNT}."
  fail "  MIRAGE_PROBE_ACCOUNT=${ACTUAL_ACCOUNT} bash scripts/probe-decoys.sh"; exit 1
fi

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/probe-results/${TIMESTAMP}"
mkdir -p "${LOG_DIR}"
info "Logs: ${LOG_DIR}"

# ── core helpers ──────────────────────────────────────────────────────────────
ASSUMED_KEY=""; ASSUMED_SECRET=""; ASSUMED_TOKEN=""

assume_role() {
  local arn="$1" sess="$2"
  attack "sts:AssumeRole → ${arn}"
  local raw; set +e
  raw=$(aws sts assume-role --role-arn "${arn}" --role-session-name "${sess}" \
        --query "Credentials" --output json 2>&1)
  local rc=$?; set -e
  if [[ $rc -ne 0 ]]; then fail "AssumeRole failed: ${raw}"; return 1; fi
  ASSUMED_KEY=$(echo "$raw"    | jq -r '.AccessKeyId'     2>/dev/null) || { fail "jq parse error"; return 1; }
  ASSUMED_SECRET=$(echo "$raw" | jq -r '.SecretAccessKey' 2>/dev/null) || { fail "jq parse error"; return 1; }
  ASSUMED_TOKEN=$(echo "$raw"  | jq -r '.SessionToken'    2>/dev/null) || { fail "jq parse error"; return 1; }
  export AWS_ACCESS_KEY_ID="$ASSUMED_KEY"
  export AWS_SECRET_ACCESS_KEY="$ASSUMED_SECRET"
  export AWS_SESSION_TOKEN="$ASSUMED_TOKEN"
  ok "Role assumed"; return 0
}

unset_creds() {
  unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN 2>/dev/null || true
  ASSUMED_KEY=""; ASSUMED_SECRET=""; ASSUMED_TOKEN=""
}
trap 'unset_creds' EXIT

CALL_FAILED=0
run_call() {
  local label="$1"; shift
  attack "${label}"
  local out; set +e
  out=$("$@" 2>&1); local rc=$?; set -e
  if [[ $rc -ne 0 ]]; then
    if echo "$out" | grep -q "AccessDenied\|is not authorized"; then
      ok "Denied (expected signal): ${label}"
    else
      fail "[rc=${rc}] ${label}"; info "  └─ $(echo "$out" | head -2 | tr '\n' ' ')"
      CALL_FAILED=1
    fi
    return 0
  fi
  ok "${label}"
  [[ $VERBOSE -eq 1 ]] && echo "$out" || true
}

role_exists() {
  local name="$1"; set +e
  aws iam get-role --role-name "${name}" --query "Role.RoleName" \
      --output text >/dev/null 2>&1
  local rc=$?; set -e; return $rc
}

# ── result tracking ───────────────────────────────────────────────────────────
declare -a RESULTS=()
PASS=0; SKIP=0; FAIL_COUNT=0
record() {
  local id="$1" st="$2" det="$3"
  RESULTS+=("${id}|${st}|${det}")
  case "$st" in PASS) PASS=$((PASS+1));; SKIP) SKIP=$((SKIP+1));; FAIL) FAIL_COUNT=$((FAIL_COUNT+1));; esac
}

# should_run: returns 0 if $1 is in RUN_IDS, 1 otherwise
should_run() {
  local qid="$1"
  for rid in "${RUN_IDS[@]}"; do [[ "$rid" == "$qid" ]] && return 0; done
  return 1
}

# run_scenario: gate + subshell wrapper used by every scenario
# Usage: run_scenario ID LOGFILE { body }
# Actually we inline each block — should_run check is the FIRST thing inside
# each { ... } subshell so the subshell itself is always syntactically closed.

# ==============================================================================
# SCENARIO 1 — S3 Terraform state
# ==============================================================================
hdr "Scenario 1 — S3 Terraform state"
{
  if ! should_run "1"; then record "1" "SKIP" "not selected"
  else
    CALL_FAILED=0
    ROLE="infra-s3-data-readonly-role-v2"
    if ! role_exists "${ROLE}"; then
      warn "Role ${ROLE} not found — not deployed"; record "1" "SKIP" "role not found"
    elif assume_role "arn:aws:iam::${ACTUAL_ACCOUNT}:role/${ROLE}" "probe-s1"; then
      BUCKET="infra-terraform-state-${ACTUAL_ACCOUNT}"
      run_call "s3:ListBucket → ${BUCKET}" \
        aws s3api list-objects-v2 --bucket "${BUCKET}" --max-items 5 --region "${REGION}" --output json
      run_call "s3:GetObject → terraform.tfstate" \
        aws s3api get-object --bucket "${BUCKET}" \
          --key "env/production/terraform.tfstate" --region "${REGION}" /dev/null
      unset_creds
      [[ $CALL_FAILED -eq 0 ]] && record "1" "PASS" "AssumeRole+ListBucket+GetObject" \
                                || record "1" "FAIL" "call failed — check log"
    else
      unset_creds; record "1" "FAIL" "AssumeRole denied"
    fi
  fi
} 2>&1 | tee "${LOG_DIR}/s1.log"

# ==============================================================================
# SCENARIO 2 — Secrets Manager payment credentials
# ==============================================================================
hdr "Scenario 2 — Secrets Manager payment credentials"
{
  if ! should_run "2"; then record "2" "SKIP" "not selected"
  else
    CALL_FAILED=0
    ROLE="payment-secrets-readonly-role-v2"
    if ! role_exists "${ROLE}"; then
      warn "Role ${ROLE} not found — not deployed"; record "2" "SKIP" "role not found"
    elif assume_role "arn:aws:iam::${ACTUAL_ACCOUNT}:role/${ROLE}" "probe-s2"; then
      for secret in "prod/payment-gateway/stripe-keys-v2" \
                    "prod/payment-gateway/braintree-credentials-v2" \
                    "prod/internal-api/service-accounts-v2"; do
        run_call "secretsmanager:GetSecretValue → ${secret}" \
          aws secretsmanager get-secret-value --secret-id "${secret}" \
            --region "${REGION}" --query "Name" --output text
      done
      unset_creds
      [[ $CALL_FAILED -eq 0 ]] && record "2" "PASS" "AssumeRole+GetSecretValue×3" \
                                || record "2" "FAIL" "call failed — check log"
    else
      unset_creds; record "2" "FAIL" "AssumeRole denied"
    fi
  fi
} 2>&1 | tee "${LOG_DIR}/s2.log"

# ==============================================================================
# SCENARIO 3 — SSM Parameter Store infra config
# ==============================================================================
hdr "Scenario 3 — SSM Parameter Store infra config"
{
  if ! should_run "3"; then record "3" "SKIP" "not selected"
  else
    CALL_FAILED=0
    ROLE="infra-config-readonly-role"
    if ! role_exists "${ROLE}"; then
      warn "Role ${ROLE} not found — not deployed"; record "3" "SKIP" "role not found"
    elif assume_role "arn:aws:iam::${ACTUAL_ACCOUNT}:role/${ROLE}" "probe-s3"; then
      run_call "ssm:GetParametersByPath → /prod" \
        aws ssm get-parameters-by-path --path "/prod" --recursive \
          --region "${REGION}" --query "Parameters[].Name" --output json
      for param in "/prod/database/master-credentials" \
                   "/prod/ci-cd/github-deploy-token" \
                   "/prod/monitoring/datadog-api-keys" \
                   "/prod/vpn/admin-credentials" \
                   "/prod/kubernetes/cluster-admin-kubeconfig"; do
        run_call "ssm:GetParameter → ${param}" \
          aws ssm get-parameter --name "${param}" \
            --region "${REGION}" --query "Parameter.Name" --output text
      done
      unset_creds
      [[ $CALL_FAILED -eq 0 ]] && record "3" "PASS" "AssumeRole+GetParametersByPath+GetParameter×5" \
                                || record "3" "FAIL" "call failed — check log"
    else
      unset_creds; record "3" "FAIL" "AssumeRole denied"
    fi
  fi
} 2>&1 | tee "${LOG_DIR}/s3.log"

# ==============================================================================
# SCENARIO 4 — EC2 bastion (EXCLUDED)
# ==============================================================================
hdr "Scenario 4 — EC2 bastion (EXCLUDED)"
{
  warn "Starts a real EC2 instance + opens SG rule. Run scenarios/scenario-4/abuse.sh manually."
  record "4" "SKIP" "excluded — EC2 StartInstances + SG rule"
} 2>&1 | tee "${LOG_DIR}/s4.log"

# ==============================================================================
# SCENARIO 5 — ECR container image registry
# ==============================================================================
hdr "Scenario 5 — ECR container image registry"
{
  if ! should_run "5"; then record "5" "SKIP" "not selected"
  else
    CALL_FAILED=0
    REPO="prod-payment-service"
    set +e
    ECR_CHECK=$(aws ecr describe-repositories --repository-names "${REPO}" \
      --region "${REGION}" --query "repositories[0].repositoryName" --output text 2>&1)
    set -e
    if [[ "$ECR_CHECK" != "${REPO}" ]]; then
      warn "ECR repo ${REPO} not found — not deployed"; record "5" "SKIP" "ECR repo not found"
    else
      set +e; TOKEN_OUT=$(aws ecr get-login-password --region "${REGION}" 2>&1); TOKEN_RC=$?; set -e
      if [[ $TOKEN_RC -ne 0 ]]; then
        fail "ecr:GetAuthorizationToken failed: ${TOKEN_OUT}"; CALL_FAILED=1
      else
        ok "ecr:GetAuthorizationToken"
      fi
      run_call "ecr:DescribeRepositories → ${REPO}" \
        aws ecr describe-repositories --repository-names "${REPO}" \
          --region "${REGION}" --query "repositories[0].repositoryUri" --output text
      run_call "ecr:ListImages → ${REPO}" \
        aws ecr list-images --repository-name "${REPO}" \
          --region "${REGION}" --query "imageIds[0]" --output json
      [[ $CALL_FAILED -eq 0 ]] && record "5" "PASS" "GetAuthorizationToken+DescribeRepositories+ListImages" \
                                || record "5" "FAIL" "call failed — check log"
    fi
  fi
} 2>&1 | tee "${LOG_DIR}/s5.log"

# ==============================================================================
# SCENARIO 6 — Lambda data-sync (discovery only)
# ==============================================================================
hdr "Scenario 6 — Lambda data-sync (discovery only)"
{
  if ! should_run "6"; then record "6" "SKIP" "not selected"
  else
    CALL_FAILED=0
    ROLE="lambda-ops-readonly-role"; FUNCTION="prod-data-sync-processor"
    if ! role_exists "${ROLE}"; then
      warn "Role ${ROLE} not found — not deployed"; record "6" "SKIP" "role not found"
    elif assume_role "arn:aws:iam::${ACTUAL_ACCOUNT}:role/${ROLE}" "probe-s6"; then
      run_call "lambda:ListFunctions" \
        aws lambda list-functions --region "${REGION}" \
          --query "Functions[].FunctionName" --output json
      run_call "lambda:GetFunctionConfiguration → ${FUNCTION}" \
        aws lambda get-function-configuration --function-name "${FUNCTION}" \
          --region "${REGION}" --query "{Role:Role,Env:Environment.Variables}" --output json
      unset_creds
      [[ $CALL_FAILED -eq 0 ]] && record "6" "PASS" "AssumeRole+ListFunctions+GetFunctionConfiguration" \
                                || record "6" "FAIL" "call failed — check log"
    else
      unset_creds; record "6" "FAIL" "AssumeRole denied"
    fi
  fi
} 2>&1 | tee "${LOG_DIR}/s6.log"

# ==============================================================================
# SCENARIO 7 — Lambda code-injection (discovery only — no inject fired)
# ==============================================================================
hdr "Scenario 7 — Lambda code-injection (discovery only)"
{
  if ! should_run "7"; then record "7" "SKIP" "not selected"
  else
    CALL_FAILED=0; USE_ROLE=""; FUNCTION_S7=""
    if role_exists "lambda-inject-readonly-role"; then
      USE_ROLE="lambda-inject-readonly-role"; FUNCTION_S7="prod-data-inject-processor"
      info "Standalone mode"
    elif role_exists "lambda-ops-readonly-role"; then
      USE_ROLE="lambda-ops-readonly-role"; FUNCTION_S7="prod-data-sync-processor"
      info "Linked mode (scenario-7 patched lambda-ops-readonly-role)"
    else
      warn "Neither role found — not deployed"; record "7" "SKIP" "role not found"
    fi
    if [[ -n "${USE_ROLE}" ]]; then
      if assume_role "arn:aws:iam::${ACTUAL_ACCOUNT}:role/${USE_ROLE}" "probe-s7"; then
        run_call "lambda:ListFunctions" \
          aws lambda list-functions --region "${REGION}" \
            --query "Functions[].FunctionName" --output json
        run_call "lambda:GetFunctionConfiguration → ${FUNCTION_S7}" \
          aws lambda get-function-configuration --function-name "${FUNCTION_S7}" \
            --region "${REGION}" --query "{Role:Role,Env:Environment.Variables}" --output json
        info "UpdateFunctionCode+Invoke not fired (reserved for manual drill)"
        unset_creds
        [[ $CALL_FAILED -eq 0 ]] && record "7" "PASS" "AssumeRole+ListFunctions+GetFunctionConfiguration" \
                                  || record "7" "FAIL" "call failed — check log"
      else
        unset_creds; record "7" "FAIL" "AssumeRole denied"
      fi
    fi
  fi
} 2>&1 | tee "${LOG_DIR}/s7.log"

# ==============================================================================
# SCENARIO 8 — IAM circular role chain (auth→data→admin→auth)
# ==============================================================================
hdr "Scenario 8 — IAM circular role chain"
{
  if ! should_run "8"; then record "8" "SKIP" "not selected"
  else
    CALL_FAILED=0
    ROLE_A="prod-microservice-auth-role"
    ROLE_B="prod-microservice-data-role"
    ROLE_C="prod-microservice-admin-role"
    if ! role_exists "${ROLE_A}"; then
      warn "Roles not found — not deployed"; record "8" "SKIP" "roles not found"
    else
      if assume_role "arn:aws:iam::${ACTUAL_ACCOUNT}:role/${ROLE_A}" "probe-s8-a"; then
        run_call "ssm:GetParameter → /prod/auth/oidc-config" \
          aws ssm get-parameter --name "/prod/auth/oidc-config" \
            --region "${REGION}" --query "Parameter.Name" --output text
        if assume_role "arn:aws:iam::${ACTUAL_ACCOUNT}:role/${ROLE_B}" "probe-s8-b"; then
          run_call "ssm:GetParameter → /prod/data/lake-credentials" \
            aws ssm get-parameter --name "/prod/data/lake-credentials" \
              --region "${REGION}" --query "Parameter.Name" --output text
          if assume_role "arn:aws:iam::${ACTUAL_ACCOUNT}:role/${ROLE_C}" "probe-s8-c"; then
            run_call "ssm:GetParameter → /prod/admin/console-credentials" \
              aws ssm get-parameter --name "/prod/admin/console-credentials" \
                --region "${REGION}" --query "Parameter.Name" --output text
            # C → A loop close
            attack "sts:AssumeRole → ${ROLE_A} (loop close ⚠️ CRITICAL SIGNAL)"
            set +e
            LOOP=$(aws sts assume-role \
              --role-arn "arn:aws:iam::${ACTUAL_ACCOUNT}:role/${ROLE_A}" \
              --role-session-name "probe-s8-loop" \
              --query "Credentials" --output json 2>&1)
            LOOP_RC=$?; set -e
            if [[ $LOOP_RC -eq 0 ]]; then ok "Loop close: Role A re-assumed from C"; unset_creds
            else fail "Loop close failed: ${LOOP}"; CALL_FAILED=1; unset_creds; fi
          else unset_creds; CALL_FAILED=1; fi
        else unset_creds; CALL_FAILED=1; fi
      else unset_creds; CALL_FAILED=1; fi
      unset_creds
      [[ $CALL_FAILED -eq 0 ]] && record "8" "PASS" "AssumeRole A→B→C→A+GetParameter×3" \
                                || record "8" "FAIL" "step failed — check log"
    fi
  fi
} 2>&1 | tee "${LOG_DIR}/s8.log"

# ==============================================================================
# SCENARIO 9 — IAM role chain loop
# ==============================================================================
hdr "Scenario 9 — IAM role chain loop"
{
  if ! should_run "9"; then record "9" "SKIP" "not selected"
  else
    CALL_FAILED=0
    ROLE_A="prod-microservice-auth-role"
    if ! role_exists "${ROLE_A}"; then
      warn "Roles not found — not deployed"; record "9" "SKIP" "roles not found"
    elif assume_role "arn:aws:iam::${ACTUAL_ACCOUNT}:role/${ROLE_A}" "probe-s9-a"; then
      run_call "ssm:GetParameter → /prod/auth/oidc-config (s9 session)" \
        aws ssm get-parameter --name "/prod/auth/oidc-config" \
          --region "${REGION}" --query "Parameter.Name" --output text
      unset_creds
      [[ $CALL_FAILED -eq 0 ]] && record "9" "PASS" "AssumeRole+GetParameter" \
                                || record "9" "FAIL" "call failed — check log"
    else
      unset_creds; record "9" "FAIL" "AssumeRole denied"
    fi
  fi
} 2>&1 | tee "${LOG_DIR}/s9.log"

# ==============================================================================
# SCENARIO 10 — DynamoDB customer profiles
# ==============================================================================
hdr "Scenario 10 — DynamoDB customer profiles"
{
  if ! should_run "10"; then record "10" "SKIP" "not selected"
  else
    CALL_FAILED=0
    ROLE="customer-data-readonly-role"; TABLE="prod-customer-profiles"
    if ! role_exists "${ROLE}"; then
      warn "Role ${ROLE} not found — not deployed"; record "10" "SKIP" "role not found"
    elif assume_role "arn:aws:iam::${ACTUAL_ACCOUNT}:role/${ROLE}" "probe-s10"; then
      run_call "dynamodb:ListTables" \
        aws dynamodb list-tables --region "${REGION}" --query "TableNames" --output json
      run_call "dynamodb:DescribeTable → ${TABLE}" \
        aws dynamodb describe-table --table-name "${TABLE}" \
          --region "${REGION}" --query "Table.TableName" --output text
      run_call "dynamodb:Scan → ${TABLE} (limit 3)" \
        aws dynamodb scan --table-name "${TABLE}" \
          --region "${REGION}" --limit 3 --query "Items[0]" --output json
      unset_creds
      [[ $CALL_FAILED -eq 0 ]] && record "10" "PASS" "AssumeRole+ListTables+DescribeTable+Scan" \
                                || record "10" "FAIL" "call failed — check log"
    else
      unset_creds; record "10" "FAIL" "AssumeRole denied"
    fi
  fi
} 2>&1 | tee "${LOG_DIR}/s10.log"

# ==============================================================================
# SCENARIO 11 — DynamoDB active sessions
# ==============================================================================
hdr "Scenario 11 — DynamoDB active sessions"
{
  if ! should_run "11"; then record "11" "SKIP" "not selected"
  else
    CALL_FAILED=0
    ROLE="session-store-readonly-role"; TABLE="prod-active-sessions"
    if ! role_exists "${ROLE}"; then
      warn "Role ${ROLE} not found — not deployed"; record "11" "SKIP" "role not found"
    elif assume_role "arn:aws:iam::${ACTUAL_ACCOUNT}:role/${ROLE}" "probe-s11"; then
      run_call "dynamodb:ListTables" \
        aws dynamodb list-tables --region "${REGION}" --query "TableNames" --output json
      run_call "dynamodb:Scan → ${TABLE} (limit 3)" \
        aws dynamodb scan --table-name "${TABLE}" \
          --region "${REGION}" --limit 3 --query "Items[0]" --output json
      unset_creds
      [[ $CALL_FAILED -eq 0 ]] && record "11" "PASS" "AssumeRole+ListTables+Scan" \
                                || record "11" "FAIL" "call failed — check log"
    else
      unset_creds; record "11" "FAIL" "AssumeRole denied"
    fi
  fi
} 2>&1 | tee "${LOG_DIR}/s11.log"

# ==============================================================================
# SCENARIO 12 — SQS payment events DLQ
# ==============================================================================
hdr "Scenario 12 — SQS payment events DLQ"
{
  if ! should_run "12"; then record "12" "SKIP" "not selected"
  else
    CALL_FAILED=0
    ROLE="payment-queue-readonly-role"; DLQ="prod-payment-events-dlq.fifo"
    if ! role_exists "${ROLE}"; then
      warn "Role ${ROLE} not found — not deployed"; record "12" "SKIP" "role not found"
    elif assume_role "arn:aws:iam::${ACTUAL_ACCOUNT}:role/${ROLE}" "probe-s12"; then
      run_call "sqs:ListQueues" \
        aws sqs list-queues --region "${REGION}" --query "QueueUrls" --output json
      set +e
      DLQ_URL=$(aws sqs get-queue-url --queue-name "${DLQ}" \
        --region "${REGION}" --query "QueueUrl" --output text 2>/dev/null)
      set -e
      if [[ -z "${DLQ_URL}" || "${DLQ_URL}" == "None" ]]; then
        fail "Could not resolve DLQ URL for ${DLQ}"; CALL_FAILED=1
      else
        run_call "sqs:GetQueueAttributes → ${DLQ}" \
          aws sqs get-queue-attributes --queue-url "${DLQ_URL}" \
            --attribute-names All --region "${REGION}" \
            --query "Attributes.QueueArn" --output text
        run_call "sqs:ReceiveMessage → ${DLQ}" \
          aws sqs receive-message --queue-url "${DLQ_URL}" \
            --max-number-of-messages 1 --region "${REGION}" \
            --query "Messages[0].MessageId" --output text
      fi
      unset_creds
      [[ $CALL_FAILED -eq 0 ]] && record "12" "PASS" "AssumeRole+ListQueues+GetQueueAttributes+ReceiveMessage" \
                                || record "12" "FAIL" "call failed — check log"
    else
      unset_creds; record "12" "FAIL" "AssumeRole denied"
    fi
  fi
} 2>&1 | tee "${LOG_DIR}/s12.log"

# ==============================================================================
# SCENARIO 13 — SNS critical alerts topic
# ==============================================================================
hdr "Scenario 13 — SNS critical alerts topic"
{
  if ! should_run "13"; then record "13" "SKIP" "not selected"
  else
    CALL_FAILED=0
    ROLE="alerts-readonly-role"; TOPIC_NAME="prod-alerts-critical"
    if ! role_exists "${ROLE}"; then
      warn "Role ${ROLE} not found — not deployed"; record "13" "SKIP" "role not found"
    elif assume_role "arn:aws:iam::${ACTUAL_ACCOUNT}:role/${ROLE}" "probe-s13"; then
      run_call "sns:ListTopics" \
        aws sns list-topics --region "${REGION}" --query "Topics[].TopicArn" --output json
      set +e
      TOPIC_ARN=$(aws sns list-topics --region "${REGION}" \
        --query "Topics[?ends_with(TopicArn,'${TOPIC_NAME}')].TopicArn | [0]" \
        --output text 2>/dev/null)
      set -e
      if [[ -z "${TOPIC_ARN}" || "${TOPIC_ARN}" == "None" ]]; then
        fail "Topic ${TOPIC_NAME} not found in SNS"; CALL_FAILED=1
      else
        run_call "sns:GetTopicAttributes → ${TOPIC_NAME}" \
          aws sns get-topic-attributes --topic-arn "${TOPIC_ARN}" \
            --region "${REGION}" --query "Attributes.TopicArn" --output text
        run_call "sns:ListSubscriptionsByTopic → ${TOPIC_NAME}" \
          aws sns list-subscriptions-by-topic --topic-arn "${TOPIC_ARN}" \
            --region "${REGION}" --query "Subscriptions[].Protocol" --output json
      fi
      unset_creds
      [[ $CALL_FAILED -eq 0 ]] && record "13" "PASS" "AssumeRole+ListTopics+GetTopicAttributes+ListSubscriptions" \
                                || record "13" "FAIL" "call failed — check log"
    else
      unset_creds; record "13" "FAIL" "AssumeRole denied"
    fi
  fi
} 2>&1 | tee "${LOG_DIR}/s13.log"

# ==============================================================================
# SCENARIO 14 — CloudWatch Logs leaked credentials
# ==============================================================================
hdr "Scenario 14 — CloudWatch Logs leaked credentials"
{
  if ! should_run "14"; then record "14" "SKIP" "not selected"
  else
    CALL_FAILED=0
    ROLE="log-analysis-readonly-role"; LOG_GROUP="/prod/payment-service/application"
    if ! role_exists "${ROLE}"; then
      warn "Role ${ROLE} not found — not deployed"; record "14" "SKIP" "role not found"
    elif assume_role "arn:aws:iam::${ACTUAL_ACCOUNT}:role/${ROLE}" "probe-s14"; then
      run_call "logs:DescribeLogGroups" \
        aws logs describe-log-groups --region "${REGION}" \
          --query "logGroups[].logGroupName" --output json
      run_call "logs:DescribeLogStreams → ${LOG_GROUP}" \
        aws logs describe-log-streams --log-group-name "${LOG_GROUP}" \
          --region "${REGION}" --order-by LastEventTime --descending \
          --query "logStreams[0].logStreamName" --output text
      run_call "logs:FilterLogEvents → ${LOG_GROUP} (keyword: password)" \
        aws logs filter-log-events --log-group-name "${LOG_GROUP}" \
          --region "${REGION}" --filter-pattern "password" --limit 5 \
          --query "events[0].message" --output text
      unset_creds
      [[ $CALL_FAILED -eq 0 ]] && record "14" "PASS" "AssumeRole+DescribeLogGroups+DescribeLogStreams+FilterLogEvents" \
                                || record "14" "FAIL" "call failed — check log"
    else
      unset_creds; record "14" "FAIL" "AssumeRole denied"
    fi
  fi
} 2>&1 | tee "${LOG_DIR}/s14.log"

# ==============================================================================
# SCENARIO 15 — KMS CMK audit + Decrypt denied
# ==============================================================================
hdr "Scenario 15 — KMS CMK audit"
{
  if ! should_run "15"; then record "15" "SKIP" "not selected"
  else
    CALL_FAILED=0
    ROLE="kms-audit-readonly-role"; ALIAS="alias/prod-customer-data-encryption"
    if ! role_exists "${ROLE}"; then
      warn "Role ${ROLE} not found — not deployed"; record "15" "SKIP" "role not found"
    elif assume_role "arn:aws:iam::${ACTUAL_ACCOUNT}:role/${ROLE}" "probe-s15"; then
      run_call "kms:ListAliases" \
        aws kms list-aliases --region "${REGION}" \
          --query "Aliases[?AliasName=='${ALIAS}'].TargetKeyId" --output json
      set +e
      KEY_ID=$(aws kms list-aliases --region "${REGION}" \
        --query "Aliases[?AliasName=='${ALIAS}'].TargetKeyId | [0]" \
        --output text 2>/dev/null)
      set -e
      if [[ -z "${KEY_ID}" || "${KEY_ID}" == "None" ]]; then
        fail "KMS alias ${ALIAS} not found"; CALL_FAILED=1
      else
        run_call "kms:DescribeKey → ${ALIAS}" \
          aws kms describe-key --key-id "${ALIAS}" --region "${REGION}" \
            --query "KeyMetadata.KeyId" --output text
        run_call "kms:GetKeyPolicy → ${ALIAS}" \
          aws kms get-key-policy --key-id "${ALIAS}" --policy-name default \
            --region "${REGION}" --query "Policy" --output text
        # Decrypt is explicitly denied — AccessDenied IS the detection signal
        attack "kms:Decrypt → ${ALIAS}  (expect: AccessDenied — this IS the signal)"
        set +e
        DECRYPT_OUT=$(aws kms decrypt --key-id "${ALIAS}" \
          --ciphertext-blob fileb:///dev/urandom --region "${REGION}" 2>&1 | head -1)
        set -e
        if echo "${DECRYPT_OUT}" | grep -qE "AccessDenied|is not authorized|InvalidCiphertextException"; then
          ok "kms:Decrypt denied (expected) — CloudTrail event fired"
        else
          warn "Unexpected kms:Decrypt response: ${DECRYPT_OUT}"
        fi
      fi
      unset_creds
      [[ $CALL_FAILED -eq 0 ]] && record "15" "PASS" "AssumeRole+ListAliases+DescribeKey+GetKeyPolicy+Decrypt(denied)" \
                                || record "15" "FAIL" "call failed — check log"
    else
      unset_creds; record "15" "FAIL" "AssumeRole denied"
    fi
  fi
} 2>&1 | tee "${LOG_DIR}/s15.log"

# ==============================================================================
# SCENARIO 16 — IAM SAML/Okta SSO enumeration
# ==============================================================================
hdr "Scenario 16 — IAM SAML/Okta SSO enumeration"
{
  if ! should_run "16"; then record "16" "SKIP" "not selected"
  else
    CALL_FAILED=0
    ROLE="sso-audit-readonly-role"
    OKTA_ADMIN="prod-okta-admin-role"; OKTA_DEV="prod-okta-developer-role"
    if ! role_exists "${ROLE}"; then
      warn "Role ${ROLE} not found — not deployed"; record "16" "SKIP" "role not found"
    elif assume_role "arn:aws:iam::${ACTUAL_ACCOUNT}:role/${ROLE}" "probe-s16"; then
      run_call "iam:ListSAMLProviders" \
        aws iam list-saml-providers --query "SAMLProviderList[].Arn" --output json
      set +e
      PROVIDER_ARN=$(aws iam list-saml-providers \
        --query "SAMLProviderList[?ends_with(Arn,'ProdOktaSSO')].Arn | [0]" \
        --output text 2>/dev/null)
      set -e
      if [[ -n "${PROVIDER_ARN}" && "${PROVIDER_ARN}" != "None" ]]; then
        run_call "iam:GetSAMLProvider → ProdOktaSSO" \
          aws iam get-saml-provider --saml-provider-arn "${PROVIDER_ARN}" \
            --query "CreateDate" --output text
      fi
      run_call "iam:GetRole → ${OKTA_ADMIN}" \
        aws iam get-role --role-name "${OKTA_ADMIN}" --query "Role.Arn" --output text
      run_call "iam:GetRole → ${OKTA_DEV}" \
        aws iam get-role --role-name "${OKTA_DEV}" --query "Role.Arn" --output text
      # AssumeRole on SAML role must be denied — no SAML assertion
      attack "sts:AssumeRole → ${OKTA_ADMIN}  (expect: AccessDenied — no SAML assertion)"
      set +e
      SAML_OUT=$(aws sts assume-role \
        --role-arn "arn:aws:iam::${ACTUAL_ACCOUNT}:role/${OKTA_ADMIN}" \
        --role-session-name "probe-s16-deny" \
        --query "Credentials" --output json 2>&1)
      set -e
      if echo "${SAML_OUT}" | grep -qE "AccessDenied|is not authorized"; then
        ok "AssumeRole on ${OKTA_ADMIN} denied (expected) — CloudTrail event fired"
      else
        warn "Unexpected SAML AssumeRole response: ${SAML_OUT}"
      fi
      unset_creds
      [[ $CALL_FAILED -eq 0 ]] && record "16" "PASS" "AssumeRole+ListSAMLProviders+GetSAMLProvider+GetRole×2+AssumeRole(denied)" \
                                || record "16" "FAIL" "call failed — check log"
    else
      unset_creds; record "16" "FAIL" "AssumeRole denied"
    fi
  fi
} 2>&1 | tee "${LOG_DIR}/s16.log"

# ==============================================================================
# SCENARIO 17 — Resource Groups tag inventory
# ==============================================================================
hdr "Scenario 17 — Resource Groups tag inventory"
{
  if ! should_run "17"; then record "17" "SKIP" "not selected"
  else
    CALL_FAILED=0
    ROLE="resource-inventory-readonly-role"
    if ! role_exists "${ROLE}"; then
      warn "Role ${ROLE} not found — not deployed"; record "17" "SKIP" "role not found"
    elif assume_role "arn:aws:iam::${ACTUAL_ACCOUNT}:role/${ROLE}" "probe-s17"; then
      run_call "tag:GetTagKeys" \
        aws resourcegroupstaggingapi get-tag-keys \
          --region "${REGION}" --query "TagKeys[0:10]" --output json
      for tag_filter in "ConfigBackup" "RelatedRole" "BackupBucket"; do
        run_call "tag:GetResources (filter: ${tag_filter})" \
          aws resourcegroupstaggingapi get-resources \
            --tag-filters "Key=${tag_filter}" --region "${REGION}" \
            --query "ResourceTagMappingList[].ResourceARN" --output json
      done
      run_call "iam:ListRoleTags → prod-backup-automation-role" \
        aws iam list-role-tags --role-name "prod-backup-automation-role" \
          --query "Tags[].Key" --output json
      run_call "ssm:ListTagsForResource → /prod/inventory/service-registry" \
        aws ssm list-tags-for-resource --resource-type "Parameter" \
          --resource-id "/prod/inventory/service-registry" \
          --region "${REGION}" --query "TagList[].Key" --output json
      unset_creds
      [[ $CALL_FAILED -eq 0 ]] && record "17" "PASS" "AssumeRole+GetTagKeys+GetResources×3+ListRoleTags+ListTagsForResource" \
                                || record "17" "FAIL" "call failed — check log"
    else
      unset_creds; record "17" "FAIL" "AssumeRole denied"
    fi
  fi
} 2>&1 | tee "${LOG_DIR}/s17.log"

# ==============================================================================
# SCENARIO 18 — ETL Lambda + DynamoDB enriched PII
# ==============================================================================
hdr "Scenario 18 — ETL Lambda + DynamoDB enriched PII"
{
  if ! should_run "18"; then record "18" "SKIP" "not selected"
  else
    CALL_FAILED=0
    ROLE="etl-ops-readonly-role"
    FUNCTION="prod-user-data-enrichment"; TABLE="prod-enriched-user-profiles"
    if ! role_exists "${ROLE}"; then
      warn "Role ${ROLE} not found — not deployed"; record "18" "SKIP" "role not found"
    elif assume_role "arn:aws:iam::${ACTUAL_ACCOUNT}:role/${ROLE}" "probe-s18"; then
      run_call "lambda:ListFunctions" \
        aws lambda list-functions --region "${REGION}" \
          --query "Functions[].FunctionName" --output json
      run_call "lambda:GetFunctionConfiguration → ${FUNCTION}" \
        aws lambda get-function-configuration --function-name "${FUNCTION}" \
          --region "${REGION}" --query "{Role:Role,Env:Environment.Variables}" --output json
      # Scan will be AccessDenied on the discovery role — that IS the signal
      run_call "dynamodb:Scan → ${TABLE} (expect: AccessDenied if using discovery role)" \
        aws dynamodb scan --table-name "${TABLE}" \
          --region "${REGION}" --limit 3 --query "Count" --output text
      unset_creds
      [[ $CALL_FAILED -eq 0 ]] && record "18" "PASS" "AssumeRole+ListFunctions+GetFunctionConfiguration+Scan" \
                                || record "18" "FAIL" "call failed — check log"
    else
      unset_creds; record "18" "FAIL" "AssumeRole denied"
    fi
  fi
} 2>&1 | tee "${LOG_DIR}/s18.log"

# ==============================================================================
# SCENARIO 19a — SSM DB parameter cross-reference chain
# ==============================================================================
hdr "Scenario 19a — SSM DB parameter chain"
{
  if ! should_run "19-ssm"; then record "19-ssm" "SKIP" "not selected"
  else
    CALL_FAILED=0
    ROLE="infra-params-readonly-role"
    if ! role_exists "${ROLE}"; then
      warn "Role ${ROLE} not found — not deployed"; record "19-ssm" "SKIP" "role not found"
    elif assume_role "arn:aws:iam::${ACTUAL_ACCOUNT}:role/${ROLE}" "probe-s19ssm"; then
      run_call "ssm:DescribeParameters (filter /prod/db)" \
        aws ssm describe-parameters --region "${REGION}" \
          --parameter-filters "Key=Path,Values=/prod/db" \
          --query "Parameters[].Name" --output json
      for param in "/prod/db/primary" "/prod/db/replica" "/prod/db/backup-config" \
                   "/prod/db/encryption-config" "/prod/db/monitoring"; do
        run_call "ssm:GetParameter → ${param}" \
          aws ssm get-parameter --name "${param}" \
            --region "${REGION}" --query "Parameter.Name" --output text
      done
      unset_creds
      [[ $CALL_FAILED -eq 0 ]] && record "19-ssm" "PASS" "AssumeRole+DescribeParameters+GetParameter×5" \
                                || record "19-ssm" "FAIL" "call failed — check log"
    else
      unset_creds; record "19-ssm" "FAIL" "AssumeRole denied"
    fi
  fi
} 2>&1 | tee "${LOG_DIR}/s19-ssm.log"

# ==============================================================================
# SCENARIO 19b — CloudFormation stack outputs lure
# ==============================================================================
hdr "Scenario 19b — CloudFormation stack outputs"
{
  if ! should_run "19-cfn"; then record "19-cfn" "SKIP" "not selected"
  else
    CALL_FAILED=0
    ROLE="cfn-audit-readonly-role"; STACK="prod-core-infrastructure"
    if ! role_exists "${ROLE}"; then
      warn "Role ${ROLE} not found — not deployed"; record "19-cfn" "SKIP" "role not found"
    elif assume_role "arn:aws:iam::${ACTUAL_ACCOUNT}:role/${ROLE}" "probe-s19cfn"; then
      run_call "cloudformation:ListStacks" \
        aws cloudformation list-stacks --region "${REGION}" \
          --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
          --query "StackSummaries[].StackName" --output json
      run_call "cloudformation:DescribeStacks → ${STACK}" \
        aws cloudformation describe-stacks --stack-name "${STACK}" \
          --region "${REGION}" --query "Stacks[0].Outputs[].OutputKey" --output json
      run_call "cloudformation:ListExports" \
        aws cloudformation list-exports --region "${REGION}" \
          --query "Exports[?starts_with(Name,'prod-')].Name" --output json
      run_call "cloudformation:GetTemplate → ${STACK}" \
        aws cloudformation get-template --stack-name "${STACK}" \
          --region "${REGION}" --query "TemplateBody" --output text
      unset_creds
      [[ $CALL_FAILED -eq 0 ]] && record "19-cfn" "PASS" "AssumeRole+ListStacks+DescribeStacks+ListExports+GetTemplate" \
                                || record "19-cfn" "FAIL" "call failed — check log"
    else
      unset_creds; record "19-cfn" "FAIL" "AssumeRole denied"
    fi
  fi
} 2>&1 | tee "${LOG_DIR}/s19-cfn.log"

# ==============================================================================
# SUMMARY
# ==============================================================================
hdr "Run complete — ${TIMESTAMP}"

SUMMARY_FILE="${LOG_DIR}/summary.md"
{
  echo "# probe-decoys.sh — ${TIMESTAMP}"
  echo ""
  echo "**Account:** ${ACTUAL_ACCOUNT}  **Caller:** ${CALLER_ARN}  **Region:** ${REGION}"
  echo ""
  echo "| Scenario | Status | CloudTrail events fired |"
  echo "|---|---|---|"
  for row in "${RESULTS[@]}"; do
    IFS='|' read -r id status detail <<< "$row"
    case "$status" in PASS) icon="✅";; SKIP) icon="⏭️";; FAIL) icon="❌";; *) icon="❓";; esac
    echo "| ${id} | ${icon} ${status} | ${detail} |"
  done
  echo ""
  echo "**Totals:** ${PASS} PASS  ${SKIP} SKIP  ${FAIL_COUNT} FAIL"
  echo ""
  echo "**Next:** cross-reference hub alerts (the event-processor Lambda / alerts table)"
  echo "to confirm which scenarios fired a detection rule."
  echo ""
  echo "### Logs"
  for f in "${LOG_DIR}"/*.log; do echo "- \`${f}\`"; done
} > "${SUMMARY_FILE}"

printf "\n  %-12s %-8s %s\n" "SCENARIO" "STATUS" "DETAIL"
printf "  %-12s %-8s %s\n" "────────────" "────────" "──────────────────────────────────────────"
for row in "${RESULTS[@]}"; do
  IFS='|' read -r id status detail <<< "$row"
  case "$status" in PASS) col="${GREEN}";; SKIP) col="${YELLOW}";; FAIL) col="${RED}";; *) col="${NC}";; esac
  printf "  %-12s ${col}%-8s${NC} %s\n" "$id" "$status" "$detail"
done
echo ""
echo -e "  ${BOLD}Totals:${NC}  ${GREEN}${PASS} PASS${NC}  ${YELLOW}${SKIP} SKIP${NC}  ${RED}${FAIL_COUNT} FAIL${NC}"
echo ""
info "Summary: ${SUMMARY_FILE}"
info "Logs:    ${LOG_DIR}/"
echo ""
