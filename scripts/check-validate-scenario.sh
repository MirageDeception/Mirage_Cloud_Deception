#!/bin/bash
# Self-check for scripts/validate-scenario.py --strict (custom uploads). Run from the repo root.
# Each case copies scenarios/_template, adds one thing, and expects the checker to accept or reject it.
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
fails=0

# expect <ok|reject> <case name> <shell that edits the copy in $D>
expect() {
  D="$WORK/custom-$2"; cp -R scenarios/_template "$D"; (cd "$D" && eval "$3")
  if python3 scripts/validate-scenario.py --strict "$D" >/dev/null; then got=ok; else got=reject; fi
  if [ "$got" = "$1" ]; then echo "ok   $2"; else echo "FAIL $2: expected $1, got $got"; fails=1; fi
}

expect ok     template           ':'
expect ok     local-module       'mkdir mod && echo "resource \"aws_s3_bucket\" \"b\" { bucket = \"x\" }" > mod/b.tf && printf "\nmodule \"m\" {\n  source = \"./mod\"\n}\n" >> main.tf'
expect ok     path-module-file   'mkdir fake-data && echo "{}" > fake-data/x.json && printf "\nlocals {\n  x = file(\"\${path.module}/fake-data/x.json\")\n}\n" >> main.tf'
expect reject tf-json            'echo "{\"resource\":{\"terraform_data\":{\"p\":{\"provisioner\":{\"local-exec\":{\"command\":\"id\"}}}}}}" > p.tf.json'
expect reject module-provisioner 'mkdir mod && printf "resource \"aws_s3_bucket\" \"b\" {\n  provisioner \"local-exec\" { command = \"id\" }\n}\n" > mod/b.tf && printf "\nmodule \"m\" {\n  source = \"./mod\"\n}\n" >> main.tf'
expect reject remote-module      'printf "\nmodule \"m\" {\n  source = \"git::https://example.com/x.git\"\n}\n" >> main.tf'
expect reject registry-module    'printf "\nmodule \"m\" {\n  source = \"terraform-aws-modules/s3-bucket/aws\"\n}\n" >> main.tf'
expect reject parent-module      'printf "\nmodule \"m\" {\n  source = \"./../other\"\n}\n" >> main.tf'
expect reject provider-alias     'printf "\nprovider \"aws\" {\n  alias  = \"hub\"\n  region = \"us-west-2\"\n}\n" >> main.tf'
expect reject provider-elsewhere 'printf "provider \"aws\" {\n  region = \"us-west-2\"\n}\n" > extra.tf'
expect reject host-file          'printf "\nlocals {\n  x = file(\"/opt/mirage/portal/.env\")\n}\n" >> main.tf'
expect reject parent-file        'printf "\nlocals {\n  x = file(\"\${path.module}/../../.env\")\n}\n" >> main.tf'
expect reject var-file           'printf "\nvariable \"p\" {\n  default = \"/etc/passwd\"\n}\nlocals {\n  x = file(var.p)\n}\n" >> main.tf'
expect reject host-source        'printf "\nresource \"aws_s3_object\" \"o\" {\n  bucket = \"b\"\n  key    = \"k\"\n  source = \"/opt/mirage/portal/.env\"\n}\n" >> main.tf'

exit $fails
