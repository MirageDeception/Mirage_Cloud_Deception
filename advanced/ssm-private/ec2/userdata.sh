#!/bin/bash
# Bootstrap script for MIRAGE portal EC2 (Amazon Linux 2023)
# Runs once at first boot as root. Single-operator box: no shared git repo,
# no per-user onboarding — just ec2-user with the one bootstrap SSH key.
set -euo pipefail

LOG="/var/log/mirage/bootstrap.log"
mkdir -p /var/log/mirage
exec > >(tee -a "$LOG") 2>&1
echo "=== MIRAGE bootstrap started: $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

# ── System update ─────────────────────────────────────────────────────────────
dnf update -y

# ── Required packages ─────────────────────────────────────────────────────────
# NOTE: do NOT install "curl" here - AL2023 ships curl-minimal and requesting the
# full curl package causes a dnf conflict that (under set -e) aborts the whole
# bootstrap. curl-minimal already provides the curl binary we use below.
dnf install -y git jq unzip

# ── Node.js 20 ────────────────────────────────────────────────────────────────
curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
dnf install -y nodejs
echo "Node.js: $(node --version)  npm: $(npm --version)"

# ── Terraform 1.10+ ──────────────────────────────────────────────────────────
TF_VERSION="1.10.5"
curl -fsSL "https://releases.hashicorp.com/terraform/$${TF_VERSION}/terraform_$${TF_VERSION}_linux_amd64.zip" \
  -o /tmp/tf.zip
unzip -q /tmp/tf.zip -d /tmp
install -o root -g root -m 0755 /tmp/terraform /usr/local/bin/terraform
rm /tmp/tf.zip
echo "Terraform: $(terraform version | head -1)"

# ── Project directory ─────────────────────────────────────────────────────────
mkdir -p /opt/mirage
chown ec2-user:ec2-user /opt/mirage

# ── SSH hardening ─────────────────────────────────────────────────────────────
# Written as a drop-in under sshd_config.d so the main sshd_config is never
# mutated. Amazon Linux 2023's sshd_config includes /etc/ssh/sshd_config.d/*.conf
# at the top — settings here override the defaults in the main file.
cat > /etc/ssh/sshd_config.d/99-mirage-hardening.conf << 'SSHEOF'
# MIRAGE security hardening — managed by userdata.sh, do not edit manually

# Authentication
PasswordAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
AuthorizedKeysFile .ssh/authorized_keys

# Brute-force mitigation
MaxAuthTries 3
# 120 (the OpenSSH default), NOT the 30 this used to be. LoginGraceTime bounds how
# long an UNAUTHENTICATED connection may hold a pre-auth slot — a control for an
# internet-facing sshd. Reaching port 22 here already requires a valid hub SSO
# identity plus the org SCP tag gate (no public IP, zero inbound SG rules), so 30s
# bought nothing and made a first login unachievable: the operator must accept
# the host key AND type a key passphrase inside the window, and got
#   "Timeout before authentication for connection from 127.0.0.1"
# MaxAuthTries + PasswordAuthentication no are what actually stop guessing.
LoginGraceTime 120

# Idle session timeout: disconnect after 10 min of inactivity
ClientAliveInterval 300
ClientAliveCountMax 2

# Disable unused authentication methods
ChallengeResponseAuthentication no
KerberosAuthentication no
GSSAPIAuthentication no
X11Forwarding no
SSHEOF

chmod 600 /etc/ssh/sshd_config.d/99-mirage-hardening.conf
systemctl reload sshd
echo "SSH hardening applied via /etc/ssh/sshd_config.d/99-mirage-hardening.conf"

# ── Host/operator audit logging (auditd + CloudWatch agent -> S3 audit bucket) ──
# Captures command + file-access (auditd), SSH/sudo/session (/var/log/secure).
# Shipped to CloudWatch Logs /mirage/* then to the audit bucket. Only
# configured when an audit bucket was provided.
if [[ -n "${audit_logs_bucket}" ]]; then
  echo "Configuring host audit logging -> ${audit_logs_bucket}"
  dnf install -y audit amazon-cloudwatch-agent 2>/dev/null || dnf install -y audit
  # auditd rules: log execve (commands, with uid) + writes to sensitive paths.
  cat > /etc/audit/rules.d/mirage.rules << 'AUDITEOF'
-a always,exit -F arch=b64 -S execve -k mirage_exec
-a always,exit -F arch=b32 -S execve -k mirage_exec
-w /etc/sudoers -p wa -k mirage_sudoers
-w /etc/sudoers.d/ -p wa -k mirage_sudoers
-w /opt/mirage/ -p wa -k mirage_appwrite
AUDITEOF
  augenrules --load 2>/dev/null || true
  systemctl enable auditd 2>/dev/null || true
  systemctl restart auditd 2>/dev/null || service auditd restart 2>/dev/null || true

  # CloudWatch agent: ship auditd + secure logs to /mirage/* log groups.
  mkdir -p /opt/aws/amazon-cloudwatch-agent/etc
  cat > /opt/aws/amazon-cloudwatch-agent/etc/mirage-cwagent.json << 'CWEOF'
{
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          { "file_path": "/var/log/audit/audit.log", "log_group_name": "/mirage/host-auditd", "log_stream_name": "{instance_id}" },
          { "file_path": "/var/log/secure", "log_group_name": "/mirage/host-secure", "log_stream_name": "{instance_id}" }
        ]
      }
    }
  }
}
CWEOF
  /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
    -a fetch-config -m ec2 -s \
    -c file:/opt/aws/amazon-cloudwatch-agent/etc/mirage-cwagent.json 2>/dev/null \
    || echo "WARN: CloudWatch agent config failed; auditd still logs locally."
  echo "Host audit logging configured."
else
  echo "No audit_logs_bucket; skipping host audit logging."
fi

# ── Portal environment (.env.local) ─────────────────────────────────────────
# The portal reads these. Credentials come from the instance profile (no keys).
# STORAGE_BACKEND starts 'local'; flip to 'aws' after the brain stack + table exist.
#
# Written to a path OUTSIDE /opt/mirage: if repo_url is set below, the clone
# step needs an empty target directory, and this file is copied in afterward.
# If repo_url is empty, the operator copies it in themselves once they have
# the repo on the box.
cat > /opt/mirage-portal.env << ENVLOCAL
MIRAGE_RESOURCE_PREFIX=${resource_prefix}
MIRAGE_SPOKE_EXTERNAL_ID=${spoke_external_id}
MIRAGE_HUB_ACCOUNT_ID=${hub_account_id}
MIRAGE_HUB_SERVICE_ROLE_ARN=arn:aws:iam::${hub_account_id}:role/${hub_service_role_name}
MIRAGE_STATE_TABLE=${state_table}
STORAGE_BACKEND=${storage_backend}
AWS_REGION=${region}
ENVLOCAL
chown ec2-user:ec2-user /opt/mirage-portal.env
chmod 600 /opt/mirage-portal.env
echo "Wrote /opt/mirage-portal.env -- copy to portal/.env.local if you clone the repo yourself."

# ── systemd unit for the portal ─────────────────────────────────────────────
# Single, non-templated unit (one operator, one portal). Runs the built
# Next.js server. AWS creds resolve from the instance profile via the SDK
# default provider chain (AWS_SDK_LOAD_CONFIG=1 is set by next.config.ts).
# -H 127.0.0.1 binds to loopback ONLY: this is the SSM-only private path, with
# no public IP and no inbound SG rules — reach it with an SSM port-forward
# (see the ec2/ module's ssm_port_forward output), never a public listener.
cat > /etc/systemd/system/mirage-portal.service << 'UNIT'
[Unit]
Description=Mirage portal (Next.js)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ec2-user
WorkingDirectory=/opt/mirage/portal
EnvironmentFile=/opt/mirage/portal/.env.local
ExecStart=/usr/bin/npm run start -- -H 127.0.0.1 -p 3000
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
chmod 644 /etc/systemd/system/mirage-portal.service
systemctl daemon-reload
echo "mirage-portal.service installed"

# ── Code: clone + build + start, or leave the box ready ──────────────────────
if [[ -n "${repo_url}" ]]; then
  echo "Cloning ${repo_url} (${repo_ref})..."
  rmdir /opt/mirage 2>/dev/null || true
  sudo -u ec2-user git clone --branch "${repo_ref}" "${repo_url}" /opt/mirage
  install -o ec2-user -g ec2-user -m 640 /opt/mirage-portal.env /opt/mirage/portal/.env.local
  ( cd /opt/mirage/portal \
      && sudo -u ec2-user npm ci --prefer-offline --no-audit --no-fund \
      && sudo -u ec2-user npm run build ) \
    && systemctl enable --now mirage-portal.service \
    && echo "mirage-portal.service started on 127.0.0.1:3000" \
    || echo "WARN: clone/build/start failed; finish it by hand (see advanced/ssm-private/README.md)."
else
  echo "No repo_url given. Finish setup by hand:"
  echo "  1. As ec2-user: git clone <your fork> /opt/mirage"
  echo "  2. cp /opt/mirage-portal.env /opt/mirage/portal/.env.local"
  echo "  3. cd /opt/mirage/portal && npm ci && npm run build"
  echo "  4. sudo systemctl enable --now mirage-portal.service"
fi

echo "=== MIRAGE bootstrap complete: $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
