#!/usr/bin/env python3
"""Self-contained bounded privacy scan. Explicit names can be supplied; no external repository is consulted."""
import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--name-list', type=Path, help='optional explicit JSON list of names; never persisted')
args = parser.parse_args()
try:
    names = json.loads(args.name_list.read_text()) if args.name_list else []
    if not isinstance(names, list) or any(not isinstance(n, str) or not n.strip() for n in names):
        raise ValueError('name list must be an array of nonempty strings')
except Exception:
    print('error: configured name list cannot be read or validated')
    sys.exit(1)
patterns = [
    ('literal home path', re.compile(r'/(?:Users|home)/[^/\s"\']+/')),
    ('credential-shaped value', re.compile(r'(?<![A-Za-z0-9_])(?:apk_[A-Za-z0-9]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{30,})')),
]
errors = []
scanned = 0
skip = {'.git', '.local', 'node_modules', '__pycache__'}
try:
    for f in sorted(ROOT.rglob('*')):
        rel = f.relative_to(ROOT)
        if any(part in skip for part in rel.parts) or not f.is_file() or f.suffix not in {'.md', '.json', '.jsonl', '.mjs', '.js', '.py', '.sh'}:
            continue
        scanned += 1
        text = f.read_text(errors='strict')
        for label, pattern in patterns:
            if pattern.search(text):
                errors.append(f'{rel}: {label}')
        for name in names:
            if re.search(rf'(?<![A-Za-z]){re.escape(name)}(?![A-Za-z])', text, re.I):
                errors.append(f'{rel}: configured listed name')
                break
except Exception:
    print('error: repository enumeration or text read failed')
    sys.exit(1)
if not scanned:
    print('error: no source files were scanned')
    sys.exit(1)
for error in errors:
    print('error:', error)
print(json.dumps({'errors': len(errors), 'files_scanned': scanned, 'checks': ['literal_home_paths', 'credential_shaped_values'], 'listed_name_coverage': 'configured' if args.name_list else 'unavailable; no explicit name list supplied'}))
sys.exit(1 if errors else 0)
