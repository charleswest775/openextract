"""Checks a data bundle against its JSON Schemas (docs/bundle/schema/<version>/), and its SHA256SUMS.

The schemas are JSON Schema 2020-12 and use only these keywords: type, const, enum,
pattern, minimum, required, properties, additionalProperties (false), items and
local $ref. This checks exactly those, so the tests need no extra package. When
the jsonschema package is installed it checks with that as well.
"""

import hashlib
import json
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCHEMAS = REPO / "docs" / "bundle" / "schema"

# File in the bundle → (schema file, one JSON document or JSON Lines)
FILES = {
    "manifest.json": ("manifest.schema.json", False),
    "conversations.json": ("conversations.schema.json", False),
    "messages.jsonl": ("message.schema.json", True),
    "calls.jsonl": ("call.schema.json", True),
    "voicemail.jsonl": ("voicemail.schema.json", True),
    "contacts.json": ("contacts.schema.json", False),
    "photos.jsonl": ("photo.schema.json", True),
    "albums.json": ("albums.schema.json", False),
    "people.json": ("people.schema.json", False),
}

_TYPES = {
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
    "string": lambda v: isinstance(v, str),
    "boolean": lambda v: isinstance(v, bool),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "null": lambda v: v is None,
}
KEYWORDS = {"$schema", "$id", "$defs", "title", "description", "type", "const", "enum", "pattern",
            "minimum", "required", "properties", "additionalProperties", "items", "$ref"}


def load_schema(version: str, name: str) -> dict:
    return json.loads((SCHEMAS / version / name).read_text(encoding="utf-8"))


def errors(schema: dict, value, root: dict = None, path: str = "$") -> list:
    """Every way ``value`` breaks ``schema``, as "path: problem" strings."""
    root = root or schema
    unknown = set(schema) - KEYWORDS
    if unknown:
        return [f"{path}: schema uses keywords this checker doesn't know: {sorted(unknown)}"]
    if "$ref" in schema:
        ref = schema["$ref"]
        assert ref.startswith("#/$defs/"), ref
        return errors(root["$defs"][ref[len("#/$defs/"):]], value, root, path)
    out = []
    if "type" in schema:
        types = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
        if not any(_TYPES[t](value) for t in types):
            return [f"{path}: {value!r:.80} is not {' or '.join(types)}"]
    if "const" in schema and value != schema["const"]:
        out.append(f"{path}: {value!r:.80} is not {schema['const']!r}")
    if "enum" in schema and value not in schema["enum"]:
        out.append(f"{path}: {value!r:.80} is not one of {schema['enum']}")
    if isinstance(value, str) and "pattern" in schema and not re.search(schema["pattern"], value):
        out.append(f"{path}: {value!r:.80} doesn't match {schema['pattern']}")
    if _TYPES["number"](value) and "minimum" in schema and value < schema["minimum"]:
        out.append(f"{path}: {value} is under {schema['minimum']}")
    if isinstance(value, dict):
        for key in schema.get("required", []):
            if key not in value:
                out.append(f"{path}: {key} is missing")
        props = schema.get("properties", {})
        for key, item in value.items():
            if key in props:
                out += errors(props[key], item, root, f"{path}.{key}")
            elif schema.get("additionalProperties") is False:
                out.append(f"{path}: {key} isn't in the schema")
    if isinstance(value, list) and "items" in schema:
        for i, item in enumerate(value):
            out += errors(schema["items"], item, root, f"{path}[{i}]")
    return out


def _jsonschema_validator(schema: dict):
    try:
        from jsonschema import Draft202012Validator
    except ImportError:
        return None
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


def check_bundle(folder) -> list:
    """Every problem with the bundle in ``folder``: schema errors, and files that don't match SHA256SUMS."""
    folder = Path(folder)
    manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
    version = manifest["schema_version"]
    problems = []
    for name, (schema_name, lines) in FILES.items():
        path = folder / name
        if not path.exists():
            continue
        schema = load_schema(version, schema_name)
        other = _jsonschema_validator(schema)
        text = path.read_text(encoding="utf-8")
        documents = [json.loads(line) for line in text.splitlines()] if lines else [json.loads(text)]
        for i, doc in enumerate(documents):
            where = f"{name}:{i + 1}" if lines else name
            problems += [f"{where} {e}" for e in errors(schema, doc)]
            if other is not None:
                problems += [f"{where} (jsonschema) {e.message}" for e in other.iter_errors(doc)]
    problems += check_sums(folder)
    return problems


def check_sums(folder) -> list:
    """SHA256SUMS lists every other file in the bundle, each with its right hash."""
    folder = Path(folder)
    listed = {}
    for line in (folder / "SHA256SUMS").read_text(encoding="utf-8").splitlines():
        digest, _, rel = line.partition("  ")
        listed[rel] = digest
    on_disk = {p.relative_to(folder).as_posix() for p in folder.rglob("*") if p.is_file()} - {"SHA256SUMS"}
    problems = [f"SHA256SUMS doesn't list {rel}" for rel in sorted(on_disk - set(listed))]
    problems += [f"SHA256SUMS lists {rel}, which isn't there" for rel in sorted(set(listed) - on_disk)]
    for rel in sorted(on_disk & set(listed)):
        if hashlib.sha256((folder / rel).read_bytes()).hexdigest() != listed[rel]:
            problems.append(f"{rel} doesn't match its SHA256SUMS line")
    return problems


def read_lines(path) -> list:
    return [json.loads(line) for line in Path(path).read_text(encoding="utf-8").splitlines()]
