"""Normalize reviewed ephemeral uv source roots without changing dependency identities."""
import argparse
import base64
import csv
import hashlib
import importlib.metadata
import io
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path


def canonicalize_sbom(raw: bytes, recipe: dict) -> bytes:
    doc = json.loads(raw)
    timestamp = datetime.fromtimestamp(recipe['sourceDateEpoch'], timezone.utc).strftime('%Y-%m-%dT%H:%M:%S')
    if doc.get('bomFormat') != 'CycloneDX' or doc.get('metadata', {}).get('timestamp') != timestamp + '.000000000Z':
        raise ValueError('SBOM format or build epoch differs from the reviewed recipe')
    distribution, version = recipe['distribution'], recipe['version']
    pattern = re.compile(r'^path\+file:///private/var/folders/[^"#]+/sdists-v9/pypi/' + re.escape(distribution) + '/' + re.escape(version) + r'/[^/]+/src/')
    roots = set()
    changes = 0

    def normalize(value):
        nonlocal changes
        if isinstance(value, dict):
            return {key: normalize(child) for key, child in value.items()}
        if isinstance(value, list):
            return [normalize(child) for child in value]
        if isinstance(value, str):
            match = pattern.match(value)
            if match:
                roots.add(match.group())
                changes += 1
                return 'path+file://' + recipe['normalizedRoot'] + '/' + distribution + '-' + version + '/' + value[match.end():]
            if value.startswith('path+file://'):
                raise ValueError('SBOM contains an unreviewed local source reference')
        return value

    normalized = normalize(doc)
    if len(roots) != 1 or changes == 0:
        raise ValueError('SBOM must reference exactly one reviewed uv source root')
    return (json.dumps(normalized, sort_keys=True, separators=(',', ':')) + '\n').encode()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--recipe', required=True)
    parser.add_argument('--original', required=True)
    arguments = parser.parse_args()
    recipe = json.loads(arguments.recipe)
    dist = importlib.metadata.distribution(recipe['distribution'])
    if dist.version != recipe['version']:
        raise ValueError('installed dependency version differs from the reviewed recipe')
    suffix = '.dist-info/' + recipe['sbom']
    candidates = [entry for entry in dist.files or [] if str(entry).endswith(suffix)]
    if len(candidates) != 1:
        raise ValueError('installed dependency must contain exactly one reviewed SBOM')
    relative = candidates[0]
    path = Path(dist.locate_file(relative))
    original = path.read_bytes()
    normalized = canonicalize_sbom(original, recipe)
    saved = Path(arguments.original)
    saved.parent.mkdir(parents=True, exist_ok=True)
    saved.write_bytes(original)
    path.write_bytes(normalized)
    # Keep installed-package integrity metadata accurate after the explicit build transformation.
    record = path.parent.parent / 'RECORD'
    rows = list(csv.reader(io.StringIO(record.read_text())))
    matching = [row for row in rows if row[0] == str(relative).replace('\\', '/')]
    if len(matching) != 1:
        raise ValueError('installed RECORD does not identify the reviewed SBOM')
    matching[0][1:] = ['sha256=' + base64.urlsafe_b64encode(hashlib.sha256(normalized).digest()).rstrip(b'=').decode(), str(len(normalized))]
    stream = io.StringIO(newline='')
    csv.writer(stream, lineterminator='\n').writerows(rows)
    record.write_text(stream.getvalue())
    print('normalized reviewed dependency SBOM; original retained in the isolated build directory')


if __name__ == '__main__':
    main()
