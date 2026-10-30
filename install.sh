#!/bin/bash
# Mirage hub installer. Run it in AWS CloudShell of the account that will be the hub:
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/MirageDeception/Mirage_Cloud_Deception/main/install.sh)
#
# (Use "bash <(...)", not "curl | bash" -- the pipe form cannot ask questions.)
#
# It deploys hub/hub-bootstrap.yaml, which builds and starts the portal on first
# boot and only reports CREATE_COMPLETE once the portal is serving. Re-running it
# after a finished install just prints the connection details again.
set -euo pipefail

REPO_URL="${MIRAGE_REPO_URL:-https://github.com/MirageDeception/Mirage_Cloud_Deception.git}"
REPO_REF="${MIRAGE_REPO_REF:-main}"
STACK="${MIRAGE_STACK:-mirage-hub-bootstrap}"
PREFIX="${MIRAGE_RESOURCE_PREFIX:-mirage-ops}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || true)}}"

say()  { echo -e "\033[1;36m==>\033[0m $*"; }
fail() { echo -e "\033[1;31mERROR:\033[0m $*" >&2; exit 1; }
ask()  { local a; read -r -p "$1" a < /dev/tty; echo "$a"; }

print_outputs() {
  local out
  out=$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" --query 'Stacks[0].Outputs' --output json)
  get() { echo "$out" | jq -r --arg k "$1" '.[] | select(.OutputKey==$k) | .OutputValue'; }
  echo
  say "Mirage hub is ready."
  if [[ "$(get AccessMode)" == "ssm" ]]; then
    echo "  Portal: run this on your laptop (AWS CLI + Session Manager plugin), then open http://localhost:3000"
    echo "    $(get PortalTunnelCommand)"
  else
    # Stack outputs keep the first-boot IP; a stop/start assigns a new one.
    local ip
    ip=$(aws ec2 describe-instances --region "$REGION" --instance-ids "$(get InstanceId)" \
      --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
    echo "  Portal: http://$ip:3000   (only reachable from your allowed IP)"
    echo "  SSH:    ssh ec2-user@$ip"
  fi
  echo
  echo "  Next steps:"
  echo "   1. Open the portal -> Deploy Brain (enter your alert email), then confirm the AWS email."
  echo "   2. Make sure CloudTrail logs every spoke account (an organization trail is easiest)."
  echo "   3. In CloudShell of each SPOKE account (as an admin there, not root), paste:"
  echo
  echo "      $(get SpokeOnboardCommand)"
  echo
  echo "   4. Portal -> Catalog: enter the spoke account id, deploy scenarios, then Deploy Rule."
}

# ── Checks ──────────────────────────────────────────────────────────────────
command -v aws >/dev/null || fail "AWS CLI not found. Run this in AWS CloudShell."
command -v jq  >/dev/null || fail "jq not found. Run this in AWS CloudShell."
[[ -n "$REGION" ]] || fail "No AWS region set. Export AWS_REGION (e.g. us-west-2) and retry."
ACCOUNT=$(aws sts get-caller-identity --query Account --output text) || fail "Not signed in to AWS."
ORG_ID=$(aws organizations describe-organization --query Organization.Id --output text 2>/dev/null) \
  || fail "This account is not in an AWS Organization. Mirage needs one (the hub-to-spoke trust is scoped to it)."
say "Hub account $ACCOUNT, region $REGION, organization $ORG_ID"

STATUS=$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || true)
case "$STATUS" in
  "") ;;
  CREATE_COMPLETE|UPDATE_COMPLETE) say "Stack $STACK already exists."; print_outputs; exit 0 ;;
  *_IN_PROGRESS) fail "Stack $STACK is $STATUS -- wait for it to finish, then re-run this to see the details." ;;
  *) fail "Stack $STACK is $STATUS. Delete it in the CloudFormation console, then re-run." ;;
esac

# ── Questions ───────────────────────────────────────────────────────────────
echo
echo "How do you want to reach the portal?"
echo "  1) Direct URL - open to your IP only, plus SSH (simplest)"
echo "  2) SSM        - no open ports; you run a tunnel command on your laptop"
MODE=$(ask "Choose 1 or 2 [1]: ")
PARAMS=(ResourcePrefix="$PREFIX" OrgId="$ORG_ID" RepoUrl="$REPO_URL" RepoRef="$REPO_REF")

if [[ "$MODE" == "2" ]]; then
  PARAMS+=(AccessMode=ssm)
  SUMMARY="SSM tunnel (no open ports)"
else
  echo
  echo "Your laptop's public IP is needed (CloudShell's own IP is different)."
  echo "Open https://checkip.amazonaws.com in your browser and paste the number shown."
  IP=$(ask "Your IP: ")
  [[ "$IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || fail "'$IP' is not an IPv4 address."
  KEY=$(ask "Paste your SSH public key, or press Enter to create one here: ")
  if [[ -z "$KEY" ]]; then
    [[ -f ~/.ssh/mirage_hub ]] || ssh-keygen -q -t ed25519 -N "" -f ~/.ssh/mirage_hub -C mirage-hub
    KEY=$(cat ~/.ssh/mirage_hub.pub)
    echo "  Created ~/.ssh/mirage_hub in CloudShell -- download it (Actions > Download file) to SSH from your laptop."
  fi
  [[ "$KEY" =~ ^(ssh-ed25519|ssh-rsa|ecdsa-sha2-) ]] || fail "That does not look like an SSH public key."
  PARAMS+=(AccessMode=public AllowedCidr="$IP/32" SshPublicKey="$KEY")
  SUMMARY="direct URL from $IP"
fi

echo
say "About to create stack $STACK in $ACCOUNT ($REGION): portal access by $SUMMARY."
echo "  Creates a VPC, one t3.medium EC2 host (~\$35/month while running), 3 IAM roles and an S3 state bucket."
[[ "$(ask "Proceed? [y/N]: ")" =~ ^[Yy]$ ]] || fail "Cancelled -- nothing was created."

# ── Deploy ──────────────────────────────────────────────────────────────────
WORK=$(mktemp -d)
git clone -q --depth 1 -b "$REPO_REF" "$REPO_URL" "$WORK/mirage" || fail "Could not clone $REPO_URL ($REPO_REF)."
say "Deploying. This takes 10-15 minutes (the host builds the portal before reporting done)."
echo "  If this CloudShell session times out, the install keeps going -- re-run this command later for the details."
if ! aws cloudformation deploy --region "$REGION" --stack-name "$STACK" \
     --template-file "$WORK/mirage/hub/hub-bootstrap.yaml" \
     --capabilities CAPABILITY_NAMED_IAM --tags Project="$PREFIX" \
     --parameter-overrides "${PARAMS[@]}"; then
  echo
  aws cloudformation describe-stack-events --region "$REGION" --stack-name "$STACK" \
    --query 'StackEvents[?contains(ResourceStatus,`FAILED`)].[LogicalResourceId,ResourceStatusReason]' --output text | head -5
  fail "Install failed (reasons above). Delete the stack in the CloudFormation console before retrying."
fi
rm -rf "$WORK"
print_outputs
