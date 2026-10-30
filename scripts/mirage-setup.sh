#!/bin/bash
# mirage-setup.sh — One-time SSO profile setup per Linux user.
# Run once after SSH-ing into the EC2 instance with your Linux account.
# Safe to re-run: exits immediately if already configured.
#
# Usage: ./scripts/mirage-setup.sh

set -euo pipefail

CONFIG_FILE="${HOME}/.mirage/config"
PROFILE_NAME="mirage-${USER}"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${CYAN}================================================${NC}"
echo -e "${CYAN}  MIRAGE — First-Time SSO Setup                 ${NC}"
echo -e "${CYAN}================================================${NC}"
echo ""

# ── Already configured? ──────────────────────────────────────────────────────
if [[ -f "${CONFIG_FILE}" ]]; then
  source "${CONFIG_FILE}"
  echo -e "${GREEN}Already configured.${NC}"
  echo -e "  Profile : ${MIRAGE_PROFILE}"
  echo -e "  Email   : ${MIRAGE_EMAIL}"
  echo ""
  echo -e "To reconfigure, delete ${CONFIG_FILE} and re-run this script."
  exit 0
fi

# ── Prompts ───────────────────────────────────────────────────────────────────
echo -e "This will create AWS SSO profile ${YELLOW}${PROFILE_NAME}${NC} for your Linux user."
echo ""

read -rp "  SSO start URL (e.g. https://your-domain.awsapps.com/start): " SSO_START_URL
read -rp "  SSO account ID (e.g. 123456789012): " SSO_ACCOUNT_ID
[[ -n "$SSO_ACCOUNT_ID" ]] || { echo "SSO account ID is required." >&2; exit 1; }

read -rp "  SSO role name (e.g. AWSReservedSSO_ADMIN_xxxxxxxxxxxxxxxx): " SSO_ROLE_NAME
[[ -n "$SSO_ROLE_NAME" ]] || { echo "SSO role name is required." >&2; exit 1; }

read -rp "  AWS region [us-west-2]: " SSO_REGION
SSO_REGION="${SSO_REGION:-us-west-2}"

read -rp "  Your email (e.g. you@domain.com): " USER_EMAIL

echo ""

# ── Validate inputs ───────────────────────────────────────────────────────────
if [[ -z "${SSO_START_URL}" || -z "${USER_EMAIL}" ]]; then
  echo -e "${RED}Error: SSO start URL and email are required.${NC}"
  exit 1
fi

if [[ ! "${USER_EMAIL}" == *"@"* ]]; then
  echo -e "${RED}Error: '${USER_EMAIL}' does not look like an email address.${NC}"
  exit 1
fi

# ── Write AWS CLI SSO profile ─────────────────────────────────────────────────
echo -e "${YELLOW}Writing AWS profile to ~/.aws/config...${NC}"

AWS_CONFIG="${HOME}/.aws/config"
mkdir -p "${HOME}/.aws"

# Remove existing profile block if present (idempotent re-run)
if grep -q "\[profile ${PROFILE_NAME}\]" "${AWS_CONFIG}" 2>/dev/null; then
  # Remove the stale block using Python (portable, no sed -i portability issues)
  python3 - "${AWS_CONFIG}" "${PROFILE_NAME}" <<'PYEOF'
import sys, re

path, profile = sys.argv[1], sys.argv[2]
with open(path) as f:
    content = f.read()

# Remove the profile block and everything until the next [section]
pattern = r'\[profile ' + re.escape(profile) + r'\][^\[]*'
content = re.sub(pattern, '', content)

with open(path, 'w') as f:
    f.write(content)
PYEOF
fi

cat >> "${AWS_CONFIG}" <<EOF

[profile ${PROFILE_NAME}]
sso_start_url = ${SSO_START_URL}
sso_account_id = ${SSO_ACCOUNT_ID}
sso_role_name = ${SSO_ROLE_NAME}
sso_region = ${SSO_REGION}
region = ${SSO_REGION}
output = json
EOF

echo -e "${GREEN}  ✓ Profile written${NC}"
echo ""

# ── Authenticate ──────────────────────────────────────────────────────────────
echo -e "${YELLOW}Launching SSO login (browser will open)...${NC}"
aws sso login --profile "${PROFILE_NAME}"
echo ""

# ── Verify ───────────────────────────────────────────────────────────────────
echo -e "${YELLOW}Verifying credentials...${NC}"
IDENTITY=$(aws sts get-caller-identity --profile "${PROFILE_NAME}" --output json)
VERIFIED_ACCOUNT=$(echo "${IDENTITY}" | python3 -c "import sys,json; print(json.load(sys.stdin)['Account'])")
VERIFIED_ARN=$(echo "${IDENTITY}" | python3 -c "import sys,json; print(json.load(sys.stdin)['Arn'])")

if [[ "${VERIFIED_ACCOUNT}" != "${SSO_ACCOUNT_ID}" ]]; then
  echo -e "${RED}Error: Authenticated to account ${VERIFIED_ACCOUNT}, expected ${SSO_ACCOUNT_ID}.${NC}"
  echo -e "${RED}Check SSO role name and account ID and re-run.${NC}"
  rm -f "${CONFIG_FILE}"
  exit 1
fi

echo -e "${GREEN}  ✓ Account : ${VERIFIED_ACCOUNT}${NC}"
echo -e "${GREEN}  ✓ ARN     : ${VERIFIED_ARN}${NC}"
echo ""

# ── Save Mirage config ────────────────────────────────────────────────────────
mkdir -p "${HOME}/.mirage"
cat > "${CONFIG_FILE}" <<EOF
MIRAGE_PROFILE=${PROFILE_NAME}
MIRAGE_EMAIL=${USER_EMAIL}
EOF
chmod 600 "${CONFIG_FILE}"

echo -e "${GREEN}  ✓ Saved ${CONFIG_FILE}${NC}"
echo ""
echo -e "${CYAN}================================================${NC}"
echo -e "${CYAN}  Setup complete.                               ${NC}"
echo -e "${CYAN}================================================${NC}"
echo ""
echo -e "  Profile : ${PROFILE_NAME}"
echo -e "  Email   : ${USER_EMAIL}"
echo ""
echo -e "Each new terminal session: ${YELLOW}source scripts/mirage-auth.sh${NC}"
echo ""
