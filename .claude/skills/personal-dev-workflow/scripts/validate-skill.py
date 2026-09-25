#!/usr/bin/env python3
from pathlib import Path
import re, sys

root = Path(sys.argv[1] if len(sys.argv) > 1 else '.').resolve()
skills = list(root.rglob('SKILL.md')) + list(root.rglob('skill.md'))
# de-duplicate case-sensitive files that may be same path set
skills = list(dict.fromkeys(skills))
if len(skills) != 1:
    raise SystemExit(f'FAIL: expected exactly one SKILL.md, found {len(skills)}')
p = skills[0]
text = p.read_text(encoding='utf-8')
if not text.startswith('---\n'):
    raise SystemExit('FAIL: missing YAML frontmatter')
parts=text.split('---',2)
if len(parts)<3: raise SystemExit('FAIL: malformed frontmatter')
fm=parts[1]
def field(name):
    m=re.search(rf'(?m)^{re.escape(name)}:\s*(.+?)\s*$',fm)
    return m.group(1).strip().strip('"\'') if m else None
name=field('name'); desc=field('description')
if not name or not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*',name): raise SystemExit('FAIL: invalid name')
if p.parent.name != name: raise SystemExit(f'FAIL: name {name!r} must match directory {p.parent.name!r}')
if not desc or len(desc)>1024: raise SystemExit('FAIL: description missing or >1024 chars')
# Check inline backtick references to local md/js paths that begin with known dirs.
refs=set(re.findall(r'`((?:references|assets|scripts|evals)/[^`\s]+)`', text))
missing=[r for r in refs if not (root/r).exists()]
if missing: raise SystemExit('FAIL: missing referenced files: '+', '.join(sorted(missing)))
print('PASS: structure/frontmatter/local references')
print('NOTE: this validator does NOT prove behavioral or semantic correctness; run evals and smoke tests.')
