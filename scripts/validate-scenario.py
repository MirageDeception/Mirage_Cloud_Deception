#!/usr/bin/env python3
"""
Checks that a scenario folder follows the contract the portal relies on, so a
broken or unsafe scenario is rejected up front instead of failing (or silently
never alerting) at deploy time. Used by the repo, by GitHub sync, and by
custom-scenario upload.

    validate-scenario.py                     # every scenarios/scenario-N in this repo
    validate-scenario.py DIR [DIR ...]       # specific scenario folders
      --strict      rules for user-uploaded (custom) scenarios -- see STRICT_*
      --terraform   also run `terraform init -backend=false && terraform validate`
      --json        machine-readable result (used by the portal)

Contract (see scenarios/_template/README.md):
  main.tf, outputs.tf, details.md ("# Name" first line, then a description),
  output "decoy_resources" = jsonencode([{ category = "<known>", resources = ... }]),
  .terraform.lock.hcl (the provider version pin the plugin cache depends on),
  optional populate-manifest.json (checked by validate-populate-manifests.py),
  optional abuse.sh.

Exits 1 if any scenario has an error. Warnings never fail the run.
"""
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DECOY_MATCH_TS = os.path.join(ROOT, 'portal', 'src', 'lib', 'decoy-match.ts')

# Never allowed: they run commands or programs on the portal host.
FORBIDDEN = [
    (r'\bprovisioner\s+"', 'provisioner blocks run commands on the portal host'),
    (r'\bdata\s+"external"', 'data "external" runs a program on the portal host'),
]
# Identity grants that would hand an attacker the account instead of a lure.
IAM_FORBIDDEN = [
    (r'Action\s*=\s*"\*"', 'Action = "*" grants every action'),
    (r'Action\s*=\s*\[[^\]]*"\*"', 'Action list contains "*"'),
    (r'"iam:\*"', '"iam:*" grants full IAM control'),
    (r'policy/(AdministratorAccess|PowerUserAccess|IAMFullAccess)\b', 'attaches an admin-level managed policy'),
]
# --strict (custom uploads): only these resource/data type prefixes. Notably no
# local_* (writes files on the portal host), null_*, http, tls_*.
STRICT_ALLOWED_PREFIXES = ('aws_', 'archive_', 'random_')
# --strict: values that name a file on the portal host must stay inside the scenario
# folder, or Terraform reads (or overwrites) hub files, such as the portal's .env.
HOST_PATH_ATTR = re.compile(r'\b(source|source_dir|source_file|output_path|filename)\s*=\s*(.+)')
HOST_PATH_FUNC = re.compile(r'\b(file\w*|templatefile)\s*\(\s*([^,)]+)')
SAFE_PATH = re.compile(r'"(\$\{path\.module\}/)?(?!/)[A-Za-z0-9_./-]*"|path\.module'
                       r'|data\.archive_file\.[A-Za-z0-9_-]+(\[[^\]]*\])?\.output_path')


def known_categories() -> set[str]:
    """Keys of CATEGORY_MATCH -- the categories the alarm pipeline can match."""
    src = open(DECOY_MATCH_TS, encoding='utf-8').read()
    block = re.search(r'CATEGORY_MATCH: Record<string, DecoyMatch> = \{(.*?)\n\};', src, re.S)
    return set(re.findall(r'^  ([a-z0-9]+): \{', block.group(1), re.M)) if block else set()


def load_manifest_checker():
    spec = importlib.util.spec_from_file_location(
        'vpm', os.path.join(ROOT, 'scripts', 'validate-populate-manifests.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def read(path: str) -> str:
    try:
        return open(path, encoding='utf-8').read()
    except FileNotFoundError:
        return ''


def strip_comments(hcl: str) -> str:
    hcl = re.sub(r'/\*.*?\*/', '', hcl, flags=re.S)
    return re.sub(r'(?m)^\s*(#|//).*$', '', hcl)


def blocks(hcl: str, header: str) -> list[str]:
    """Bodies of every block whose header matches, brace-counted so nested blocks stay inside."""
    out = []
    for m in re.finditer(header + r'\s*\{', hcl):
        depth, i = 1, m.end()
        while depth and i < len(hcl):
            depth += {'{': 1, '}': -1}.get(hcl[i], 0)
            i += 1
        out.append(hcl[m.end():i - 1])
    return out


def check_dir(sdir: str, strict: bool, run_tf: bool, categories: set[str], vpm) -> dict:
    sid = os.path.basename(os.path.normpath(sdir))
    errors: list[str] = []
    warnings: list[str] = []
    # Every folder: Terraform loads a local module's files just like main.tf.
    tf_files = []
    for d, sub, files in os.walk(sdir):
        sub[:] = [s for s in sub if s != '.terraform']
        tf_files += [os.path.relpath(os.path.join(d, f), sdir) for f in files if f.endswith(('.tf', '.tf.json'))]
    tf_files.sort()
    hcl = strip_comments('\n'.join(read(os.path.join(sdir, f)) for f in tf_files if f.endswith('.tf')))
    for f in tf_files:
        if f.endswith('.tf.json'):
            errors.append(f'{f}: write Terraform as .tf files; .tf.json is not checked')
    for body in blocks(hcl, r'\bmodule\s+"[^"]+"'):
        src = re.search(r'(?m)^\s*source\s*=\s*(.+)$', body)
        if not (src and re.fullmatch(r'"\./[A-Za-z0-9_./-]*"', src.group(1).strip()) and '..' not in src.group(1)):
            errors.append('a module must come from a folder inside the scenario ("./name"); '
                          'remote modules are downloaded at deploy time and never checked')

    for f in ('main.tf', 'outputs.tf', 'details.md'):
        if not os.path.isfile(os.path.join(sdir, f)):
            errors.append(f'missing {f}')

    details = read(os.path.join(sdir, 'details.md')).strip().splitlines()
    if details and not details[0].startswith('# '):
        errors.append('details.md must start with "# <Scenario name>"')
    if details and not any(l.strip() and not l.startswith('#') for l in details[1:]):
        errors.append('details.md has no description under the title')

    out = strip_comments(read(os.path.join(sdir, 'outputs.tf')))
    blk = re.search(r'output\s+"decoy_resources"\s*\{.*?jsonencode\((.*?)\)\s*\n\s*\}', out, re.S)
    if not blk:
        errors.append('outputs.tf has no output "decoy_resources" = jsonencode([...]) -- deployed decoys would never be watched')
    else:
        cats = re.findall(r'category\s*=\s*"([^"]+)"', blk.group(1))
        n_res = len(re.findall(r'\bresources\s*=', blk.group(1)))
        if not cats:
            errors.append('decoy_resources lists no { category = ..., resources = ... } entries')
        if n_res != len(cats):
            errors.append(f'decoy_resources has {len(cats)} category but {n_res} resources entries -- each entry needs both')
        for c in cats:
            if c not in categories:
                errors.append(f'decoy_resources category "{c}" is not one the alarm pipeline can match '
                              f'({", ".join(sorted(categories))})')

    if not re.search(r'variable\s+"account_id"', hcl):
        warnings.append('no variable "account_id" -- the portal always passes -var account_id=...')

    for pat, why in FORBIDDEN + IAM_FORBIDDEN:
        if re.search(pat, hcl):
            errors.append(why)

    if strict:
        for kind, rtype in re.findall(r'\b(resource|data)\s+"([a-z0-9_]+)"', hcl):
            if not rtype.startswith(STRICT_ALLOWED_PREFIXES):
                errors.append(f'{kind} "{rtype}" is not allowed in custom scenarios (only {", ".join(STRICT_ALLOWED_PREFIXES)}*)')
        for p in re.findall(r'\bprovider\s+"([a-z0-9_-]+)"', hcl):
            if p != 'aws':
                errors.append(f'provider "{p}" is not allowed in custom scenarios')
        # The portal replaces main.tf's provider with one that assumes the spoke role. Any
        # other provider block (an alias, or one inside a module) would run with the hub's
        # own credentials instead.
        for f in tf_files:
            if f != 'main.tf' and f.endswith('.tf') and re.search(r'\bprovider\s+"', strip_comments(read(os.path.join(sdir, f)))):
                errors.append(f'{f}: provider blocks are only allowed in main.tf')
        if any(re.search(r'\balias\s*=', b) for b in blocks(hcl, r'\bprovider\s+"[^"]+"')):
            errors.append('provider aliases are not allowed in custom scenarios')
        for m in [*HOST_PATH_ATTR.finditer(hcl), *HOST_PATH_FUNC.finditer(hcl)]:
            value = m.group(2).strip()
            if not SAFE_PATH.fullmatch(value) or '..' in value:
                errors.append(f'{m.group(1)} uses {value}: file paths must stay inside the scenario folder '
                              '("${path.module}/...", no "..")')

    if not os.path.isfile(os.path.join(sdir, '.terraform.lock.hcl')):
        (warnings if strict else errors).append(
            'no .terraform.lock.hcl -- without the version pin every deploy downloads the AWS provider (~768 MB)')

    if os.path.isfile(os.path.join(sdir, 'populate-manifest.json')) or not strict:
        vpm.SCENARIOS = os.path.dirname(os.path.abspath(sdir))
        vpm.errors.clear(); vpm.warnings.clear()
        if re.fullmatch(r'scenario-\d+', sid) or os.path.isfile(os.path.join(sdir, 'populate-manifest.json')):
            vpm.check(sid)
        errors += [e.split(': ', 1)[-1] for e in vpm.errors]
        warnings += [w.split(': ', 1)[-1] for w in vpm.warnings]

    if not os.path.isfile(os.path.join(sdir, 'abuse.sh')):
        warnings.append('no abuse.sh -- nothing to demonstrate the detection with')

    if run_tf and not errors:
        errors += terraform_validate(sdir)

    resources = [f'{t}.{n}' for t, n in re.findall(r'\bresource\s+"([a-z0-9_]+)"\s+"([A-Za-z0-9_-]+)"', hcl)]
    return {'id': sid, 'dir': sdir, 'errors': errors, 'warnings': warnings, 'resources': resources}


def terraform_validate(sdir: str) -> list[str]:
    if not shutil.which('terraform'):
        return ['terraform not found on PATH (needed for --terraform)']
    with tempfile.TemporaryDirectory() as tmp:
        work = os.path.join(tmp, 'scenario')
        # Never copy a provider cache (.terraform) -- same rule the portal's deploy uses.
        shutil.copytree(sdir, work, ignore=shutil.ignore_patterns('.terraform'))
        for cmd in (['terraform', 'init', '-backend=false', '-input=false', '-no-color'],
                    ['terraform', 'validate', '-no-color']):
            r = subprocess.run(cmd, cwd=work, capture_output=True, text=True)
            if r.returncode:
                tail = (r.stderr or r.stdout).strip().splitlines()[-6:]
                return [f'`{" ".join(cmd[:2])}` failed: ' + ' | '.join(l.strip() for l in tail if l.strip())]
    return []


def main(argv: list[str]) -> int:
    strict = '--strict' in argv
    run_tf = '--terraform' in argv
    as_json = '--json' in argv
    dirs = [a for a in argv if not a.startswith('--')]
    if not dirs:
        base = os.path.join(ROOT, 'scenarios')
        dirs = sorted((os.path.join(base, d) for d in os.listdir(base) if re.fullmatch(r'scenario-\d+', d)),
                      key=lambda p: int(p.rsplit('-', 1)[1]))

    categories = known_categories()
    if not categories:
        print(f'cannot read decoy categories from {DECOY_MATCH_TS}', file=sys.stderr)
        return 2
    vpm = load_manifest_checker()
    results = [check_dir(d, strict, run_tf, categories, vpm) for d in dirs]

    if as_json:
        print(json.dumps({'ok': not any(r['errors'] for r in results), 'results': results}, indent=2))
    else:
        for r in results:
            status = 'FAIL' if r['errors'] else 'ok  '
            print(f'{status} {r["id"]}')
            for e in r['errors']:
                print(f'       ERROR {e}')
            for w in r['warnings']:
                print(f'       warn  {w}')
        bad = sum(1 for r in results if r['errors'])
        print(f'\n{len(results)} checked, {bad} failed')
    return 1 if any(r['errors'] for r in results) else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
