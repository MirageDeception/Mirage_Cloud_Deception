#!/usr/bin/env bash
#
# abuse-all.sh — Run every scenario's abuse.sh back-to-back against ONE account,
# to see what the detection pipeline actually catches once the event trigger
# rules are deployed for all of them.
#
# ==============================================================================
# WHAT THIS DOES
# ==============================================================================
# Loops over the scenarios below, cd's into each scenario-N/ directory, and runs
# its existing abuse.sh exactly as documented in that scenario's own header — it
# does not reimplement any attack chain, it just sequences the real ones. Each
# scenario's own script resolves its target account from the CURRENT caller
# identity (there is no account_id argument anywhere in this repo's abuse
# scripts), so this wrapper's only job on top of that is:
#   1. Refuse to run unless the current identity is already IN the target
#      account (see ACCOUNT GUARD below) — every sub-script assumes a lure role
#      BY NAME in "the current account", so running this against the wrong
#      account either errors immediately (role not found) or, worse, silently
#      no-ops against resources that don't exist there.
#   2. Keep going when one scenario fails, instead of aborting the whole run
#      (`set -e` in a sub-script must not kill the batch -- a scenario can be
#      missing/half-torn-down in a given spoke account, and a failure there is
#      itself useful signal, not a reason to stop).
#   3. Log each scenario to its own file plus one timestamped summary, so you
#      can line up "what we fired, when" against what the hub actually alerted on.
#
# ==============================================================================
# USAGE
# ==============================================================================
#   # From a laptop with the SSO profile that reaches <your-spoke-profile>:
#   cd scripts && AWS_PROFILE=<your-spoke-profile> ./abuse-all.sh
#
#   # On the box, get an identity in the target spoke account FIRST, e.g.:
#   source scripts/mirage-auth.sh      # or: export AWS_PROFILE=<your-spoke-profile>
#   aws sts get-caller-identity        # confirm Account matches MIRAGE_ABUSE_ACCOUNT_ID before running
#   ./scripts/abuse-all.sh
#
# Flags:
#   -y, --yes              Skip the interactive confirmation prompt.
#   -l, --list             Print the run plan and exit. Fires nothing.
#   --include-scenario-4   Also run scenario-4 (see EXCLUDED, below). Off by default.
#   --full-attack-6        Let scenario-6 take its credential-theft branch (answers
#                           its own "y/N" prompt with y). Off by default — see below.
#   -h, --help              Show this usage block and exit.
#
# ==============================================================================
# EXCLUDED FROM THE DEFAULT RUN (verified by reading each script, not assumed)
# ==============================================================================
#   scenario-4   Not a read-only probe like the rest: it starts a STOPPED EC2
#                instance (ec2:StartInstances), opens an inbound SSH rule on its
#                security group for the caller's current IP, and deliberately
#                does NOT revert either — its own comment says "leave for manual
#                review". That is a real, lingering cost + attack-surface change,
#                not a CloudTrail probe, and it also expects an SSH key file and a
#                human to then interactively SSH in. Matches the standing note
#                that scenario-4 is parked ("leave this one for now"). Run it
#                yourself, deliberately, with --include-scenario-4 — and remember
#                to stop the instance and revoke the SG rule afterward.
#
#   scenario-6   NOT excluded — it runs in the default list, but its own abuse.sh
#                prompts "Steal execution role credentials via code injection?
#                [y/N]" and defaults to N (discovery-only: AssumeRole + list +
#                read config, no code change) whenever nothing is typed. This
#                wrapper feeds every sub-script's stdin from /dev/null, so that
#                prompt always lands on its safe default unless you pass
#                --full-attack-6. The "y" branch calls lambda:UpdateFunctionCode
#                twice (inject, then restore) and lambda:Invoke — it does put
#                the code back, but a failed restore would leave the decoy
#                broken, so it is opt-in, not default.
#
#   scenario-7,  Have NO abuse.sh in this repo. Their README.md claims
#   scenario-8   "abuse.sh ... are current" — checked, that is stale: git history
#                has no commit that ever added either file. Not fabricated here;
#                flagged so the gap is visible instead of silently absent. (Both
#                are Lambda-based scenarios whose attack chain involves invoking/
#                modifying a live function, same class of risk as scenario-6/4 —
#                worth writing deliberately, not folded into a blind sweep.)
#
# Everything else below is read-only exactly as documented in each scenario's
# own "Detection signals generated" trailer (AssumeRole + List/Describe/Get/Scan/
# Receive/Decrypt-denied calls only — confirmed by grepping all 18 scripts for
# put-/delete-/update-/invoke-/create-/start-/stop- and finding only scenario-4
# and scenario-6 above).
#
set -uo pipefail
# Deliberately NOT `set -e` at this level — one scenario's non-zero exit must not
# abort the batch. Each sub-script keeps its own `set -euo pipefail`.

# ---------------------------------------------------------------
# Colors and helpers
# ---------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

step() { echo -e "\n${CYAN}${BOLD}==>${NC} $1"; }
info() { echo -e "  ${GREEN}[+]${NC} $1"; }
warn() { echo -e "  ${YELLOW}[!]${NC} $1"; }
err()  { echo -e "  ${RED}[x]${NC} $1" >&2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCENARIOS_DIR="$(cd "${SCRIPT_DIR}/../scenarios" && pwd)"

# ==============================================================================
# ACCOUNT GUARD — override only if you really mean to point this at another spoke
# ==============================================================================
EXPECTED_ACCOUNT_ID="${MIRAGE_ABUSE_ACCOUNT_ID:?Set MIRAGE_ABUSE_ACCOUNT_ID to the target spoke account id.}"

# ==============================================================================
# Flags
# ==============================================================================
ASSUME_YES=0
LIST_ONLY=0
INCLUDE_SCENARIO_4=0
FULL_ATTACK_6=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -y|--yes) ASSUME_YES=1; shift ;;
    -l|--list) LIST_ONLY=1; shift ;;
    --include-scenario-4) INCLUDE_SCENARIO_4=1; shift ;;
    --full-attack-6) FULL_ATTACK_6=1; shift ;;
    -h|--help) sed -n '2,/^set -uo pipefail/p' "${BASH_SOURCE[0]}" | sed '$d'; exit 0 ;;
    *) err "Unknown flag: $1 (use --help)"; exit 1 ;;
  esac
done

# ==============================================================================
# Run plan — "scenario-dir:script:one-line target" — order matches scenario number
# ==============================================================================
RUN_LIST=(
  "scenario-1:abuse.sh:S3 Terraform state (infra-s3-data-readonly-role-v2)"
  "scenario-2:abuse.sh:Secrets Manager payment creds (payment-secrets-readonly-role-v2)"
  "scenario-3:abuse.sh:SSM Parameter Store infra (infra-config-readonly-role)"
  "scenario-5:abuse.sh:ECR container image (standalone or scenario-4 bastion path)"
  "scenario-6:abuse.sh:Lambda config/env secrets, discovery-only by default (lambda-ops-readonly-role)"
  "scenario-9:abuse.sh:IAM role chain loop A→B→C (prod-microservice-{auth,data,admin}-role)"
  "scenario-10:abuse.sh:DynamoDB customer profiles PII (customer-data-readonly-role)"
  "scenario-11:abuse.sh:DynamoDB active sessions / JWTs (session-store-readonly-role)"
  "scenario-12:abuse.sh:SQS payment events DLQ (payment-queue-readonly-role)"
  "scenario-13:abuse.sh:SNS critical alerts topic (alerts-readonly-role)"
  "scenario-14:abuse.sh:CloudWatch Logs credential patterns (log-analysis-readonly-role)"
  "scenario-15:abuse.sh:KMS CMK policy/grants + Decrypt denied (kms-audit-readonly-role)"
  "scenario-16:abuse.sh:SAML/Okta role enumeration + AssumeRole denied (sso-audit-readonly-role)"
  "scenario-17:abuse.sh:Resource Groups Tagging API inventory (resource-inventory-readonly-role)"
  "scenario-18:abuse.sh:ETL Lambda + enriched profiles pivot (etl-ops-readonly-role)"
  "scenario-19:abuse.sh:SSM db params (infra-params-readonly-role)"
  "scenario-19:abuse-cfn-audit.sh:CloudFormation stack/template audit (cfn-audit-readonly-role)"
)

if [[ "${INCLUDE_SCENARIO_4}" -eq 1 ]]; then
  RUN_LIST+=("scenario-4:abuse.sh:EC2 bastion — STARTS the instance + opens an SG rule, no revert")
fi

step "Run plan (${#RUN_LIST[@]} scenario run(s) against account ${EXPECTED_ACCOUNT_ID})"
for entry in "${RUN_LIST[@]}"; do
  IFS=':' read -r dir script label <<< "${entry}"
  printf "  %-14s %-22s %s\n" "${dir}" "${script}" "${label}"
done
echo ""
warn "Skipped by default: scenario-4 (mutates live infra — see --include-scenario-4 and the"
warn "  header of this script), scenario-7 and scenario-8 (no abuse.sh exists in this repo)."
if [[ "${FULL_ATTACK_6}" -eq 0 ]]; then
  info "scenario-6 will run in discovery-only mode (its own y/N prompt defaults to N)."
else
  warn "scenario-6 will take the credential-theft branch (--full-attack-6): injects, invokes,"
  warn "  then restores lambda-data-sync-processor's code."
fi

if [[ "${LIST_ONLY}" -eq 1 ]]; then
  exit 0
fi

# ==============================================================================
# Account guard
# ==============================================================================
step "Verifying current identity resolves to account ${EXPECTED_ACCOUNT_ID}"
CALLER_JSON=$(aws sts get-caller-identity --output json 2>&1) || {
  err "aws sts get-caller-identity failed:"
  err "${CALLER_JSON}"
  err "Get a valid identity in account ${EXPECTED_ACCOUNT_ID} first (source scripts/mirage-auth.sh"
  err "on the box, or AWS_PROFILE=<your-spoke-profile> on a laptop), then re-run."
  exit 1
}
ACTUAL_ACCOUNT_ID=$(echo "${CALLER_JSON}" | jq -r .Account)
CALLER_ARN=$(echo "${CALLER_JSON}" | jq -r .Arn)

if [[ "${ACTUAL_ACCOUNT_ID}" != "${EXPECTED_ACCOUNT_ID}" ]]; then
  err "Current identity is in account ${ACTUAL_ACCOUNT_ID} (${CALLER_ARN}), not the expected"
  err "${EXPECTED_ACCOUNT_ID}. Every scenario's abuse.sh assumes a lure role BY NAME in"
  err "'the current account' — running this against the wrong account either errors"
  err "immediately or silently targets nothing. Refusing to run."
  err ""
  err "If this account genuinely has decoys deployed and you mean to abuse it instead,"
  err "re-run with MIRAGE_ABUSE_ACCOUNT_ID=${ACTUAL_ACCOUNT_ID} ./scripts/abuse-all.sh"
  exit 1
fi
info "Account: ${ACTUAL_ACCOUNT_ID}"
info "Caller:  ${CALLER_ARN}"

# ==============================================================================
# Confirmation
# ==============================================================================
if [[ "${ASSUME_YES}" -ne 1 ]]; then
  echo ""
  warn "This fires ${#RUN_LIST[@]} real attack chains (AssumeRole + Get/Scan/Describe/Receive"
  warn "calls, real CloudTrail events) against live decoys in account ${EXPECTED_ACCOUNT_ID}."
  read -rp "$(echo -e "${RED}Continue? [y/N]: ${NC}")" CONFIRM
  if [[ "${CONFIRM}" != "y" && "${CONFIRM}" != "Y" ]]; then
    info "Aborted, nothing fired."
    exit 0
  fi
fi

# ==============================================================================
# Run
# ==============================================================================
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RESULTS_DIR="${SCRIPT_DIR}/abuse-results/${TIMESTAMP}"
mkdir -p "${RESULTS_DIR}"
info "Logs: ${RESULTS_DIR}"

HAVE_TIMEOUT=0
command -v timeout >/dev/null 2>&1 && HAVE_TIMEOUT=1

declare -a SUMMARY_ROWS=()
PASS_COUNT=0
FAIL_COUNT=0

for entry in "${RUN_LIST[@]}"; do
  IFS=':' read -r dir script label <<< "${entry}"
  name="${dir}__${script%.sh}"
  log_file="${RESULTS_DIR}/${name}.log"
  step "${dir}/${script} — ${label}"

  start_ts=$(date -u +%s)

  (
    cd "${SCENARIOS_DIR}/${dir}" || exit 127
    if [[ "${script}" == "abuse.sh" && "${dir}" == "scenario-6" && "${FULL_ATTACK_6}" -eq 1 ]]; then
      echo "y" | ./"${script}"
    elif [[ "${HAVE_TIMEOUT}" -eq 1 ]]; then
      timeout 300 ./"${script}" < /dev/null
    else
      ./"${script}" < /dev/null
    fi
  ) > "${log_file}" 2>&1
  exit_code=$?

  end_ts=$(date -u +%s)
  duration=$(( end_ts - start_ts ))

  if [[ ${exit_code} -eq 0 ]]; then
    info "OK (${duration}s) — log: ${log_file}"
    PASS_COUNT=$((PASS_COUNT + 1))
    SUMMARY_ROWS+=("${dir}/${script}|OK|${duration}s|${log_file}")
  else
    warn "FAILED exit ${exit_code} (${duration}s) — log: ${log_file}"
    tail -n 5 "${log_file}" | sed 's/^/      /'
    FAIL_COUNT=$((FAIL_COUNT + 1))
    SUMMARY_ROWS+=("${dir}/${script}|FAILED (${exit_code})|${duration}s|${log_file}")
  fi
done

# ==============================================================================
# Summary
# ==============================================================================
summary_file="${RESULTS_DIR}/summary.md"
{
  echo "# abuse-all.sh run — ${TIMESTAMP}"
  echo ""
  echo "Account: ${ACTUAL_ACCOUNT_ID} (${CALLER_ARN})"
  echo ""
  echo "| Scenario/script | Result | Duration | Log |"
  echo "|---|---|---|---|"
  for row in "${SUMMARY_ROWS[@]}"; do
    IFS='|' read -r r_name r_result r_dur r_log <<< "${row}"
    echo "| ${r_name} | ${r_result} | ${r_dur} | ${r_log} |"
  done
  echo ""
  echo "Skipped: scenario-4 (unless --include-scenario-4), scenario-7, scenario-8 (no abuse.sh)."
  echo ""
  echo "Next: check the hub (the event-processor Lambda / SNS / alerts table) for which of"
  echo "these ${#RUN_LIST[@]} runs actually produced an alert, and cross-reference against"
  echo "whichever scenario rules are deployed so far."
} > "${summary_file}"

step "Done: ${PASS_COUNT} ok, ${FAIL_COUNT} failed"
info "Summary: ${summary_file}"

exit 0
