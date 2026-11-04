import hashlib, importlib.metadata, json, shutil, sys
from pathlib import Path
output = Path(sys.argv[1]); output.mkdir(parents=True, exist_ok=True)
dist = importlib.metadata.distribution("cryptography")
root = Path(dist.locate_file("")).resolve()
entries = []
for entry in dist.files:
    source = Path(dist.locate_file(entry)).resolve()
    try: name = source.relative_to(root)
    except ValueError: continue
    if not source.is_file() or "__pycache__" in name.parts: continue
    data = source.read_bytes()
    entries.append({"path": str(name), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    if source.suffix == ".so" or "sboms" in name.parts:
        target = output / name; target.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(source, target)
(output / "files.json").write_text(json.dumps(entries, indent=2) + "\n")

original = Path(sys.prefix).parent / 'sbom-original.json'
if original.exists(): shutil.copyfile(original, output / 'sbom-original.json')
