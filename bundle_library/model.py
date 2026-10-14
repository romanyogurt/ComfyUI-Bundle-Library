"""Validation of bundles and fields. Imports nothing from ComfyUI, so the store
and its tests can use it on their own."""

import math
import re
import unicodedata

from .constants import (
    FIELD_TYPES, IMAGE_FORMATS, MAX_BUNDLE_NAME, MAX_FIELD_NAME, MAX_FIELDS, MAX_NOTE,
    MAX_ORIGINAL_NAME, MAX_TAG_LENGTH, MAX_TAGS, MAX_TEXT_BYTES,
)

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
INT_MIN, INT_MAX = -(2 ** 63), 2 ** 63 - 1

# Characters that may not appear in a name: line breaks and the bidi controls
# that make a name read differently from what it is.
_FORBIDDEN_IN_NAMES = set("  ‪‫‬‭‮⁦⁧⁨⁩")


class LibraryError(Exception):
    """A request the library refuses. `status` is the HTTP status the API answers with."""

    def __init__(self, status, code, message, **details):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details


def invalid(message, **details):
    return LibraryError(400, "invalid", message, **details)


def check_bundle_id(value):
    if not isinstance(value, str) or not UUID_RE.match(value):
        raise LibraryError(400, "invalid_id", f"Invalid bundle id: {value!r}")
    return value


def check_sha256(value):
    if not isinstance(value, str) or not SHA256_RE.match(value):
        raise LibraryError(400, "invalid_id", f"Invalid asset id: {value!r}")
    return value


def name_key(name):
    """Bundle names are unique regardless of case."""
    return name.casefold()


def clean_original_name(name):
    """An uploaded file's name, kept for display only."""
    return "".join(c for c in name if unicodedata.category(c) != "Cc")[:MAX_ORIGINAL_NAME]


def _name(value, label, limit):
    if not isinstance(value, str):
        raise invalid(f"{label}: must be a string.")
    text = unicodedata.normalize("NFC", value.strip())
    if not text:
        raise invalid(f"{label}: must not be empty.")
    if len(text) > limit:
        raise invalid(f"{label}: at most {limit} characters.")
    if any(unicodedata.category(c) == "Cc" or c in _FORBIDDEN_IN_NAMES for c in text):
        raise invalid(f"{label}: line breaks and control characters are not allowed.")
    return text


def _tags(value):
    if not isinstance(value, list):
        raise invalid("Tags: must be an array of strings.")
    tags, seen = [], set()
    for item in value:
        tag = _name(item, "Tag", MAX_TAG_LENGTH)
        if tag.casefold() not in seen:
            seen.add(tag.casefold())
            tags.append(tag)
    if len(tags) > MAX_TAGS:
        raise invalid(f"Tags: at most {MAX_TAGS}.")
    return tags


def _note(value):
    if not isinstance(value, str):
        raise invalid("Note: must be a string.")
    if len(value) > MAX_NOTE:
        raise invalid(f"Note: at most {MAX_NOTE} characters.")
    return value


def _value(field_type, value, label):
    if field_type == "text":
        if not isinstance(value, str):
            raise invalid(f"{label}: a text value must be a string.")
        if len(value.encode("utf-8")) > MAX_TEXT_BYTES:
            raise invalid(f"{label}: text is limited to {MAX_TEXT_BYTES // (1024 * 1024)} MB.")
        return value
    if field_type == "boolean":
        if not isinstance(value, bool):
            raise invalid(f"{label}: must be true or false.")
        return value
    if field_type == "int":
        if isinstance(value, bool) or not isinstance(value, int):
            raise invalid(f"{label}: must be an integer.")
        if not INT_MIN <= value <= INT_MAX:
            raise invalid(f"{label}: outside the 64-bit integer range.")
        return value
    # float
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise invalid(f"{label}: must be a number.")
    if not math.isfinite(value):
        raise invalid(f"{label}: must be a finite number.")
    return float(value)


def _asset(value, label):
    """An image field's asset reference: None, or a dict whose sha256 names an
    uploaded file. Stored metadata passes through; the store refreshes it from
    the file itself when saving, so a client cannot set it."""
    if value is None:
        return None
    if not isinstance(value, dict):
        raise invalid(f"{label}: asset must be an object or null.")
    sha = value.get("sha256")
    if not isinstance(sha, str) or not SHA256_RE.match(sha):
        raise invalid(f"{label}: asset.sha256 is not a SHA-256 digest.")
    asset = {"sha256": sha}
    original = value.get("original_name")
    if original is not None:
        if not isinstance(original, str):
            raise invalid(f"{label}: asset.original_name must be a string.")
        asset["original_name"] = clean_original_name(original)
    ext = value.get("ext")
    if ext is not None and ext in {e for e, _ in IMAGE_FORMATS.values()}:
        asset["ext"] = ext
    for key in ("width", "height", "bytes"):
        number = value.get(key)
        if isinstance(number, int) and not isinstance(number, bool) and number >= 0:
            asset[key] = number
    return asset


def _field(value, index):
    if not isinstance(value, dict):
        raise invalid(f"Field {index + 1}: must be an object.")
    name = _name(value.get("name"), f"Field {index + 1} name", MAX_FIELD_NAME)
    if name.startswith("@"):
        raise invalid(f"Field '{name}': names starting with '@' are reserved.")
    field_type = value.get("type")
    if field_type not in FIELD_TYPES:
        raise LibraryError(400, "unsupported_type",
                           f"Field '{name}': unsupported type {field_type!r}. "
                           f"Supported types: {', '.join(FIELD_TYPES)}.")
    label = f"Field '{name}'"
    if field_type == "image":
        return {"name": name, "type": "image", "asset": _asset(value.get("asset"), label)}
    if "value" not in value:
        raise invalid(f"{label}: value is missing.")
    return {"name": name, "type": field_type, "value": _value(field_type, value["value"], label)}


def normalize_bundle(data):
    """The editable part of a bundle (name, tags, note, fields), checked and
    normalized. Raises LibraryError(400) on the first problem."""
    if not isinstance(data, dict):
        raise invalid("A bundle must be a JSON object.")
    fields_value = data.get("fields", [])
    if not isinstance(fields_value, list):
        raise invalid("Fields: must be an array.")
    if len(fields_value) > MAX_FIELDS:
        raise invalid(f"Fields: at most {MAX_FIELDS}.")
    fields = [_field(f, i) for i, f in enumerate(fields_value)]
    seen = set()
    for field in fields:
        if field["name"] in seen:
            raise invalid(f"Duplicate field name: '{field['name']}'")
        seen.add(field["name"])
    return {
        "name": _name(data.get("name"), "Bundle name", MAX_BUNDLE_NAME),
        "tags": _tags(data.get("tags", [])),
        "note": _note(data.get("note", "")),
        "fields": fields,
    }


def empty_value(field):
    """The field with its value cleared, for duplicating a bundle's structure."""
    if field["type"] == "image":
        return {"name": field["name"], "type": "image", "asset": None}
    blank = {"text": "", "boolean": False, "int": 0, "float": 0.0}[field["type"]]
    return {"name": field["name"], "type": field["type"], "value": blank}
