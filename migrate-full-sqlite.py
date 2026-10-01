from pathlib import Path
import re

ROOT = Path("mini-services/animaxia-backend")

EXTS = {".js", ".mjs", ".cjs", ".sql"}

SKIP = {
    "node_modules",
    ".git",
}

def wanted(p):
    if p.suffix not in EXTS:
        return False
    if any(x in SKIP for x in p.parts):
        return False
    if ".before-" in p.name or p.name.endswith(".bak"):
        return False
    return True

changes = []

for p in ROOT.rglob("*"):
    if not p.is_file() or not wanted(p):
        continue

    try:
        old = p.read_text(encoding="utf-8")
    except Exception:
        continue

    s = old

    # PostgreSQL casts that map naturally to SQLite storage.
    s = re.sub(r"::jsonb\b", "", s, flags=re.I)
    s = re.sub(r"::int\b", "", s, flags=re.I)
    s = re.sub(r"::integer\b", "", s, flags=re.I)
    s = re.sub(r"::float\b", "", s, flags=re.I)
    s = re.sub(r"::numeric\b", "", s, flags=re.I)
    s = re.sub(r"::text\b", "", s, flags=re.I)

    # PostgreSQL time arithmetic.
    s = re.sub(
        r"NOW\(\)\s*-\s*INTERVAL\s*'(\d+)\s+days?'",
        r"datetime('now','-\1 days')",
        s,
        flags=re.I,
    )
    s = re.sub(
        r"NOW\(\)\s*-\s*INTERVAL\s*'(\d+)\s+hours?'",
        r"datetime('now','-\1 hours')",
        s,
        flags=re.I,
    )
    s = re.sub(
        r"NOW\(\)\s*\+\s*INTERVAL\s*'(\d+)\s+hours?'",
        r"datetime('now','+\1 hours')",
        s,
        flags=re.I,
    )

    s = re.sub(r"\bNOW\(\)", "CURRENT_TIMESTAMP", s, flags=re.I)

    # Straightforward case-insensitive comparisons.
    s = re.sub(r"\bILIKE\b", "LIKE", s, flags=re.I)

    if s != old:
        p.write_text(s, encoding="utf-8")
        changes.append(str(p))

print(f"MODIFIED={len(changes)}")
for p in changes:
    print(p)
