#!/usr/bin/env python3
"""
Validates every scenarios/scenario-N/populate-manifest.json against the real
Terraform it is supposed to seed. Run it after touching a manifest, a
scenario's outputs.tf, or fake-data/.

It catches the four ways a manifest goes wrong silently -- all of which show up
at populate time as "No matching deployed decoy found" or a corrupt payload,
long after the deploy has reported success:

  1. fakeDataFile does not exist (the file was moved to another scenario)
  2. the seed's category is not declared in that scenario's decoy_resources, so
     resolveResourceName() can never resolve a name
  3. matchContains matches zero, or more than one, of the real resource names in
     that category -- `.find()` silently takes the first, so an ambiguous
     substring seeds the WRONG resource
  4. a category with multiple real resources has seeds that omit matchContains,
     which makes every one of them land on the same first resource

Exits non-zero on any error. Warnings do not fail the run.
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCENARIOS = os.path.join(ROOT, 'scenarios')

# resource type -> decoy category, mirroring deploy-spoke's categories
TYPE_TO_CATEGORY = {
    'aws_s3_bucket': 's3',
    'aws_secretsmanager_secret': 'secretsmanager',
    'aws_ssm_parameter': 'ssm',
    'aws_dynamodb_table': 'dynamodb',
    'aws_sqs_queue': 'sqs',
    'aws_sns_topic': 'sns',
    'aws_cloudwatch_log_group': 'logs',
    'aws_kms_key': 'kms',
    'aws_ecr_repository': 'ecr',
    'aws_lambda_function': 'lambda',
    'aws_iam_role': 'iam',
}

# Scenarios that intentionally have no manifest, with the reason. Keeping this
# explicit means a genuinely forgotten manifest is still reported.
NO_MANIFEST_EXPECTED = {
    'scenario-4': 'excluded from portal deploys (needs vpc_id/subnet_id)',
    'scenario-5': 'ECR needs a real docker push; no SDK call seeds a layer',
    'scenario-7': 'secrets live in Lambda environment variables, set inline in HCL',
    'scenario-12': 'SNS Publish is transient; a topic stores no readable body',
    'scenario-14': 'KMS Decrypt needs attacker-supplied ciphertext; a key has no content',
    'scenario-15': 'IAM/SAML only; no data resource to seed',
    'scenario-16': 'self-seeds its SSM parameter via an HCL heredoc',
    'scenario-19': 'self-seeds its SSM parameters via HCL heredocs',
    'scenario-20': 'documentation only; no .tf files',
}

errors: list[str] = []
warnings: list[str] = []


def real_names(main_tf: str, category: str) -> list[str]:
    """`name =` / `bucket =` values of resources in this category: literals, or
    `var.X` resolved to that variable's string default (most lure names are
    variables, so ignoring them reported correct manifests as broken)."""
    defaults = dict(re.findall(
        r'variable "([a-z0-9_]+)" \{[^}]*?\bdefault\s+=\s+"([^"]+)"', main_tf, re.S))
    out = []
    for rtype, cat in TYPE_TO_CATEGORY.items():
        if cat != category:
            continue
        attr = 'bucket' if rtype == 'aws_s3_bucket' else 'name'
        pattern = r'resource "' + rtype + r'" "[a-z0-9_]+" \{(.*?)\n\}'
        for m in re.finditer(pattern, main_tf, re.S):
            nm = re.search(r'\n\s+' + attr + r'\s+=\s+(?:"([^"]+)"|var\.([a-z0-9_]+))', m.group(1))
            if nm and nm.group(1):
                out.append(nm.group(1))
            elif nm and nm.group(2) in defaults:
                out.append(defaults[nm.group(2)])
    return out


def declared_categories(outputs_tf: str) -> set[str]:
    blk = re.search(r'output "decoy_resources".*?\n\}\n', outputs_tf, re.S)
    if not blk:
        return set()
    return set(re.findall(r'category\s*=\s*"([a-z0-9]+)"', blk.group(0)))


def check(scenario: str) -> None:
    sdir = os.path.join(SCENARIOS, scenario)
    mpath = os.path.join(sdir, 'populate-manifest.json')
    main_path = os.path.join(sdir, 'main.tf')
    outputs_path = os.path.join(sdir, 'outputs.tf')

    if not os.path.exists(mpath):
        # Optional (scenarios/_template/README.md): without one the decoys deploy with no
        # seeded content. A warning, so a hub's sync never rejects a scenario for it.
        if scenario not in NO_MANIFEST_EXPECTED:
            warnings.append(f'{scenario}: no populate-manifest.json, so its decoys deploy empty; '
                            'add one, or list the reason in NO_MANIFEST_EXPECTED')
        return
    if scenario in NO_MANIFEST_EXPECTED:
        warnings.append(
            f'{scenario}: has a manifest but is listed as NO_MANIFEST_EXPECTED '
            f'({NO_MANIFEST_EXPECTED[scenario]}) -- update this script'
        )

    try:
        manifest = json.load(open(mpath))
    except json.JSONDecodeError as e:
        errors.append(f'{scenario}: populate-manifest.json is not valid JSON ({e})')
        return

    if manifest.get('scenarioId') != scenario:
        errors.append(
            f'{scenario}: manifest scenarioId is '
            f'{manifest.get("scenarioId")!r}, expected {scenario!r}'
        )

    main_tf = open(main_path).read() if os.path.exists(main_path) else ''
    outputs_tf = open(outputs_path).read() if os.path.exists(outputs_path) else ''
    declared = declared_categories(outputs_tf)

    seeds = manifest.get('seeds', [])
    # how many seeds reference each category, for the ambiguity check
    per_category: dict[str, list[dict]] = {}
    for seed in seeds:
        if seed.get('sdkOperation') == 'none':
            continue
        per_category.setdefault(seed.get('category', ''), []).append(seed)

    for category, cat_seeds in per_category.items():
        if category not in declared:
            errors.append(
                f'{scenario}: seeds target category {category!r} but '
                f'decoy_resources does not declare it -- resolveResourceName() '
                f'will never find a name (declared: {sorted(declared)})'
            )
        names = real_names(main_tf, category)
        for seed in cat_seeds:
            label = seed.get('label', '?')
            mc = seed.get('matchContains')
            if mc is None:
                if len(names) > 1 and len(cat_seeds) > 1:
                    errors.append(
                        f'{scenario}: seed {label!r} omits matchContains but '
                        f'{category!r} has {len(names)} resources {names} and '
                        f'{len(cat_seeds)} seeds -- every seed would resolve to '
                        f'the same first resource'
                    )
                continue
            hits = [n for n in names if mc in n]
            if not names:
                warnings.append(
                    f'{scenario}: seed {label!r} matchContains={mc!r} could not '
                    f'be checked -- no literal {category!r} names found in main.tf '
                    f'(computed name?)'
                )
            elif len(hits) == 0:
                errors.append(
                    f'{scenario}: seed {label!r} matchContains={mc!r} matches none '
                    f'of the real {category!r} names {names}'
                )
            elif len(hits) > 1:
                errors.append(
                    f'{scenario}: seed {label!r} matchContains={mc!r} is AMBIGUOUS '
                    f'-- matches {hits}; .find() would silently pick {hits[0]!r}'
                )

    for seed in seeds:
        fdf = seed.get('fakeDataFile')
        if not fdf:
            continue
        fpath = os.path.join(sdir, 'fake-data', fdf)
        if not os.path.exists(fpath):
            errors.append(
                f'{scenario}: seed {seed.get("label")!r} references '
                f'fake-data/{fdf} which does not exist'
            )
            continue
        # The multi-record ops require a JSON array; injectExpiredMarker would
        # corrupt one, and parseRecordArray throws on anything else.
        op = seed.get('sdkOperation')
        if op in ('dynamodb:PutItem', 'sqs:SendMessage'):
            try:
                data = json.load(open(fpath))
            except json.JSONDecodeError as e:
                errors.append(f'{scenario}: fake-data/{fdf} is not valid JSON ({e})')
                continue
            if not isinstance(data, list):
                errors.append(
                    f'{scenario}: fake-data/{fdf} must be a JSON array for {op}, '
                    f'got {type(data).__name__}'
                )
        elif op == 'logs:PutLogEvents':
            try:
                data = json.load(open(fpath))
            except json.JSONDecodeError as e:
                errors.append(f'{scenario}: fake-data/{fdf} is not valid JSON ({e})')
                continue
            if not isinstance(data, dict) or 'streams' not in data:
                errors.append(
                    f'{scenario}: fake-data/{fdf} must be '
                    f'{{"streams": {{"<name>": [...]}}}} for {op}'
                )


def main() -> int:
    scenarios = sorted(
        (d for d in os.listdir(SCENARIOS) if re.fullmatch(r'scenario-\d+', d)),
        key=lambda s: int(s.split('-')[1]),
    )
    for s in scenarios:
        check(s)

    have = sum(
        1 for s in scenarios
        if os.path.exists(os.path.join(SCENARIOS, s, 'populate-manifest.json'))
    )
    print(f'checked {len(scenarios)} scenarios; {have} have a populate manifest')
    for w in warnings:
        print(f'  WARN  {w}')
    for e in errors:
        print(f'  ERROR {e}')
    if errors:
        print(f'\n{len(errors)} error(s)')
        return 1
    print('all manifests valid')
    return 0


if __name__ == '__main__':
    sys.exit(main())
