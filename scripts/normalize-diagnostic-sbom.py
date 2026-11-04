"""Diagnostic only: determine whether uv build-root references explain the remaining identity drift."""
import importlib.metadata, json, re, sys
from pathlib import Path

dist = importlib.metadata.distribution('cryptography')
assert dist.version == '50.0.0'
files = [Path(dist.locate_file(p)) for p in dist.files if str(p).endswith('/sboms/cryptography-rust.cyclonedx.json')]
assert len(files) == 1
path = files[0]
original = path.read_bytes()
(Path(sys.prefix).parent / 'sbom-original.json').write_bytes(original)
doc = json.loads(original)
assert doc['metadata']['timestamp'] == '1970-01-01T00:00:00.000000000Z'
pattern = re.compile(r'^path\+file:///private/var/folders/[^"#]+/sdists-v9/pypi/cryptography/50\.0\.0/[^/]+/src/')
roots = set()
changes = 0
def normalize(value):
    global changes
    if isinstance(value, dict): return {k: normalize(v) for k,v in value.items()}
    if isinstance(value, list): return [normalize(v) for v in value]
    if isinstance(value, str):
        match = pattern.match(value)
        if match:
            roots.add(match.group()); changes += 1
            return 'path+file:///hermes-build/cryptography-50.0.0/' + value[match.end():]
    return value
normalized = normalize(doc)
assert len(roots) == 1 and changes > 0
path.write_text(json.dumps(normalized, sort_keys=True, separators=(',', ':')) + '\n')
print(f'Diagnostic normalized {changes} references to one cryptography build root; original SBOM retained')
