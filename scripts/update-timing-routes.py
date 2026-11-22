"""Refresh the conservative telemetry route allowlists, without importing the app.

Run from any directory with: python scripts/update-timing-routes.py
Only literal router prefixes/decorators and filesystem page paths are trusted.
"""
import ast
import json
import re
from pathlib import Path

root = Path(__file__).resolve().parents[1]
templates = {"/:id"}
for source in (root / "backend/app/api").glob("*.py"):
    tree = ast.parse(source.read_text())
    prefix = ""
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "APIRouter":
            for keyword in node.keywords:
                if keyword.arg == "prefix" and isinstance(keyword.value, ast.Constant):
                    prefix = keyword.value.value
    for node in ast.walk(tree):
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and isinstance(node.func.value, ast.Name) and node.func.value.id == "router"
                and node.func.attr in ("get", "post", "put", "patch", "delete", "head", "options")
                and node.args and isinstance(node.args[0], ast.Constant)
                and isinstance(node.args[0].value, str)):
            templates.add(re.sub(r"\{[^}]+\}", ":id", "/api" + prefix + node.args[0].value).rstrip("/") or "/")
page_root = root / "frontend/src/app"
for page in page_root.rglob("page.tsx"):
    relative = page.parent.relative_to(page_root)
    parts = [re.sub(r"\[[^]]+\]", ":id", part) for part in relative.parts if not part.startswith("(")]
    templates.add("/" + "/".join(parts))
content = json.dumps(sorted(templates), indent=2) + "\n"
for target in ("backend/app/services/timing_routes.json", "frontend/src/lib/timingRoutes.json"):
    (root / target).write_text(content)
