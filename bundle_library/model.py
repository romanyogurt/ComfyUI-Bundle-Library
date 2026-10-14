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
        raise LibraryError(400, "invalid_id", f"번들 ID 형식이 잘못되었습니다: {value!r}")
    return value


def check_sha256(value):
    if not isinstance(value, str) or not SHA256_RE.match(value):
        raise LibraryError(400, "invalid_id", f"에셋 ID 형식이 잘못되었습니다: {value!r}")
    return value


def name_key(name):
    """Bundle names are unique regardless of case."""
    return name.casefold()


def clean_original_name(name):
    """An uploaded file's name, kept for display only."""
    return "".join(c for c in name if unicodedata.category(c) != "Cc")[:MAX_ORIGINAL_NAME]


def _name(value, label, limit):
    if not isinstance(value, str):
        raise invalid(f"{label}: 문자열이어야 합니다.")
    text = unicodedata.normalize("NFC", value.strip())
    if not text:
        raise invalid(f"{label}: 비어 있습니다.")
    if len(text) > limit:
        raise invalid(f"{label}: {limit}자까지입니다.")
    if any(unicodedata.category(c) == "Cc" or c in _FORBIDDEN_IN_NAMES for c in text):
        raise invalid(f"{label}: 줄바꿈이나 제어 문자를 쓸 수 없습니다.")
    return text


def _tags(value):
    if not isinstance(value, list):
        raise invalid("태그: 문자열 배열이어야 합니다.")
    tags, seen = [], set()
    for item in value:
        tag = _name(item, "태그", MAX_TAG_LENGTH)
        if tag.casefold() not in seen:
            seen.add(tag.casefold())
            tags.append(tag)
    if len(tags) > MAX_TAGS:
        raise invalid(f"태그: {MAX_TAGS}개까지입니다.")
    return tags


def _note(value):
    if not isinstance(value, str):
        raise invalid("메모: 문자열이어야 합니다.")
    if len(value) > MAX_NOTE:
        raise invalid(f"메모: {MAX_NOTE}자까지입니다.")
    return value


def _value(field_type, value, label):
    if field_type == "text":
        if not isinstance(value, str):
            raise invalid(f"{label}: 텍스트 값은 문자열이어야 합니다.")
        if len(value.encode("utf-8")) > MAX_TEXT_BYTES:
            raise invalid(f"{label}: 텍스트는 {MAX_TEXT_BYTES // (1024 * 1024)}MB까지입니다.")
        return value
    if field_type == "boolean":
        if not isinstance(value, bool):
            raise invalid(f"{label}: true 또는 false여야 합니다.")
        return value
    if field_type == "int":
        if isinstance(value, bool) or not isinstance(value, int):
            raise invalid(f"{label}: 정수여야 합니다.")
        if not INT_MIN <= value <= INT_MAX:
            raise invalid(f"{label}: 64비트 정수 범위를 벗어납니다.")
        return value
    # float
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise invalid(f"{label}: 숫자여야 합니다.")
    if not math.isfinite(value):
        raise invalid(f"{label}: 유한한 숫자여야 합니다.")
    return float(value)


def _asset(value, label):
    """An image field's asset reference: None, or a dict whose sha256 names an
    uploaded file. Stored metadata passes through; the store refreshes it from
    the file itself when saving, so a client cannot set it."""
    if value is None:
        return None
    if not isinstance(value, dict):
        raise invalid(f"{label}: asset은 객체나 null이어야 합니다.")
    sha = value.get("sha256")
    if not isinstance(sha, str) or not SHA256_RE.match(sha):
        raise invalid(f"{label}: asset.sha256이 올바른 SHA-256 값이 아닙니다.")
    asset = {"sha256": sha}
    original = value.get("original_name")
    if original is not None:
        if not isinstance(original, str):
            raise invalid(f"{label}: asset.original_name은 문자열이어야 합니다.")
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
        raise invalid(f"필드 {index + 1}: 객체여야 합니다.")
    name = _name(value.get("name"), f"필드 {index + 1}의 이름", MAX_FIELD_NAME)
    if name.startswith("@"):
        raise invalid(f"필드 '{name}': '@'로 시작하는 이름은 예약되어 있습니다.")
    field_type = value.get("type")
    if field_type not in FIELD_TYPES:
        raise LibraryError(400, "unsupported_type",
                           f"필드 '{name}': 지원하지 않는 타입입니다 ({field_type!r}). "
                           f"쓸 수 있는 타입: {', '.join(FIELD_TYPES)}")
    label = f"필드 '{name}'"
    if field_type == "image":
        return {"name": name, "type": "image", "asset": _asset(value.get("asset"), label)}
    if "value" not in value:
        raise invalid(f"{label}: value가 없습니다.")
    return {"name": name, "type": field_type, "value": _value(field_type, value["value"], label)}


def normalize_bundle(data):
    """The editable part of a bundle (name, tags, note, fields), checked and
    normalized. Raises LibraryError(400) on the first problem."""
    if not isinstance(data, dict):
        raise invalid("번들은 JSON 객체여야 합니다.")
    fields_value = data.get("fields", [])
    if not isinstance(fields_value, list):
        raise invalid("fields: 배열이어야 합니다.")
    if len(fields_value) > MAX_FIELDS:
        raise invalid(f"fields: 필드는 {MAX_FIELDS}개까지입니다.")
    fields = [_field(f, i) for i, f in enumerate(fields_value)]
    seen = set()
    for field in fields:
        if field["name"] in seen:
            raise invalid(f"필드 이름이 겹칩니다: '{field['name']}'")
        seen.add(field["name"])
    return {
        "name": _name(data.get("name"), "번들 이름", MAX_BUNDLE_NAME),
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
