#!/bin/bash
# mirage-auth.sh — Validate SSO credentials and export AWS_PROFILE.
# Must be SOURCED, not executed:  source scripts/mirage-auth.sh
#
# Exits (or returns) non-zero if setup is incomplete or login fails.

# Detect whether we're sourced or executed
_MIRAGE_AUTH_SOURCED=0
if [[ "${BASH_SOURCE[0]}" != "${0}" ]]; then
  _MIRAGE_AUTH_SOURCED=1
fi

_mirage_auth_fail() {
  echo "$1" >&2
  if [[ "${_MIRAGE_AUTH_SOURCED}" -eq 1 ]]; then
    return 1
  else
    exit 1
  fi
}

CONFIG_FILE="${HOME}/.mirage/config"

# ── Config check ──────────────────────────────────────────────────────────────
if [[ ! -f "${CONFIG_FILE}" ]]; then
  _mirage_auth_fail "MIRAGE: No config found. Run './scripts/mirage-setup.sh' first."
fi

# shellcheck source=/dev/null
source "${CONFIG_FILE}"

if [[ -z "${MIRAGE_PROFILE:-}" ]]; then
  _mirage_auth_fail "MIRAGE: MIRAGE_PROFILE not set in ${CONFIG_FILE}. Re-run mirage-setup.sh."
fi

# ── Token validity check ──────────────────────────────────────────────────────
if ! aws sts get-caller-identity --profile "${MIRAGE_PROFILE}" >/dev/null 2>&1; then
  echo "MIRAGE: SSO token expired or missing. Logging in..." >&2
  if ! aws sso login --profile "${MIRAGE_PROFILE}"; then
    _mirage_auth_fail "MIRAGE: SSO login failed. Check profile '${MIRAGE_PROFILE}' in ~/.aws/config."
  fi

  # Re-test after login
  if ! aws sts get-caller-identity --profile "${MIRAGE_PROFILE}" >/dev/null 2>&1; then
    _mirage_auth_fail "MIRAGE: Credentials still invalid after login. Run mirage-setup.sh to reconfigure."
  fi
fi

# ── Export ────────────────────────────────────────────────────────────────────
export AWS_PROFILE="${MIRAGE_PROFILE}"

# Unset any explicit key/secret/token that would override the profile
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN

echo "MIRAGE: AWS_PROFILE=${AWS_PROFILE} (${MIRAGE_EMAIL:-unknown})" >&2
