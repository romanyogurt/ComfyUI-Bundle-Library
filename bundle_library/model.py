"""Validation of bundles and fields. Imports nothing from ComfyUI, so the store
and its tests can use it on their own."""

import math
import re
import unicodedata

from .constants import (
    AUDIO_EXTENSIONS, FIELD_TYPES, IMAGE_FORMATS, MAX_BUNDLE_NAME, MAX_FIELD_NAME, MAX_FIELDS, MAX_NOTE,
    MAX_ORIGINAL_NAME, MAX_TAG_LENGTH, MAX_TAGS, MAX_TEXT_BYTES, MEDIA_TYPES, VIDEO_EXTENSIONS,
)

ASSET_EXTENSIONS = {e for e, _ in IMAGE_FORMATS.values()} | set(VIDEO_EXTENSIONS) | set(AUDIO_EXTENSIONS)
CODEC_RE = re.compile(r"^[a-z0-9_.-]{1,32}$")
_SURROGATE = re.compile("[\ud800-\udfff]")
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
# A file of the trash folder of 0.0.10 and earlier: trash/<bundle id>.<UTC time>[-n].json.
TRASH_ID_RE = re.compile(r"^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})"
                         r"\.(\d{8}T\d{6}Z)(?:-[1-9]\d{0,5})?$")
# JavaScript's safe integers: the browser reads JSON numbers as doubles, so a
# larger value would change on its way through the editor.
INT_MIN, INT_MAX = -(2 ** 53 - 1), 2 ** 53 - 1

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
    """Names sort regardless of case."""
    return name.casefold()


def lone_surrogates(data):
    """Whether a string in a JSON value (keys included) holds a lone surrogate.
    JSON can escape one (\\ud800), but it is not text and cannot be written as
    UTF-8, so a file or request with one is not valid. Walks without recursion:
    the value may be nested deeply."""
    stack = [data]
    while stack:
        value = stack.pop()
        if isinstance(value, str):
            if _SURROGATE.search(value):
                return True
        elif isinstance(value, dict):
            stack.extend(value.keys())
            stack.extend(value.values())
        elif isinstance(value, list):
            stack.extend(value)
    return False


def _finite(value):
    """An int or float as a finite float, or None: infinite, NaN, or an int too
    large for a float (float() of such an int raises OverflowError)."""
    try:
        number = float(value)
    except OverflowError:
        return None
    return number if math.isfinite(number) else None


def clean_original_name(name):
    """An uploaded file's name, kept for display only."""
    return "".join(c for c in name if unicodedata.category(c) != "Cc")[:MAX_ORIGINAL_NAME]


class _Rules:
    """How a check that only limits size or range is applied. When saving
    (`strict`) every rule is enforced. A stored bundle is read even if it
    breaks such a writing rule, which may have been tightened since it was
    saved: the rule becomes a warning. Rules about the shape of the data are
    enforced either way."""

    def __init__(self, strict):
        self.strict = strict
        self.warnings = []

    def limit(self, ok, message):
        if ok:
            return
        if self.strict:
            raise invalid(message)
        self.warnings.append(message)


def _name(value, label, limit, rules):
    if not isinstance(value, str):
        raise invalid(f"{label}: must be a string.")
    text = unicodedata.normalize("NFC", value.strip())
    if not text:
        raise invalid(f"{label}: must not be empty.")
    if any(unicodedata.category(c) == "Cc" or c in _FORBIDDEN_IN_NAMES for c in text):
        raise invalid(f"{label}: line breaks and control characters are not allowed.")
    rules.limit(len(text) <= limit, f"{label}: at most {limit} characters.")
    return text


def _tags(value, rules):
    if not isinstance(value, list):
        raise invalid("Tags: must be an array of strings.")
    tags, seen = [], set()
    for item in value:
        tag = _name(item, "Tag", MAX_TAG_LENGTH, rules)
        if tag.casefold() not in seen:
            seen.add(tag.casefold())
            tags.append(tag)
    rules.limit(len(tags) <= MAX_TAGS, f"Tags: at most {MAX_TAGS}.")
    return tags


def _note(value, rules):
    if not isinstance(value, str):
        raise invalid("Note: must be a string.")
    rules.limit(len(value) <= MAX_NOTE, f"Note: at most {MAX_NOTE} characters.")
    return value


def _value(field_type, value, label, rules):
    if field_type == "text":
        if not isinstance(value, str):
            raise invalid(f"{label}: a text value must be a string.")
        rules.limit(len(value.encode("utf-8")) <= MAX_TEXT_BYTES,
                    f"{label}: text is limited to {MAX_TEXT_BYTES // (1024 * 1024)} MB.")
        return value
    if field_type == "boolean":
        if not isinstance(value, bool):
            raise invalid(f"{label}: must be true or false.")
        return value
    if field_type == "int":
        if isinstance(value, bool) or not isinstance(value, int):
            raise invalid(f"{label}: must be an integer.")
        rules.limit(INT_MIN <= value <= INT_MAX, f"{label}: must be between {INT_MIN:,} and {INT_MAX:,}.")
        return value
    # float
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise invalid(f"{label}: must be a number.")
    number = _finite(value)
    if number is None:
        raise invalid(f"{label}: must be a finite number.")
    return number


def _asset(value, label):
    """A media field's asset reference: None, or a dict whose sha256 names an
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
    if isinstance(ext, str) and ext in ASSET_EXTENSIONS:  # a list or object is not hashable
        asset["ext"] = ext
    for key in ("width", "height", "bytes", "sample_rate", "channels"):
        number = value.get(key)
        if isinstance(number, int) and not isinstance(number, bool) and number >= 0:
            asset[key] = number
    for key in ("duration", "fps"):
        number = value.get(key)
        if isinstance(number, (int, float)) and not isinstance(number, bool):
            finite = _finite(number)
            if finite is not None and finite >= 0:
                asset[key] = finite
    if isinstance(value.get("has_audio"), bool):
        asset["has_audio"] = value["has_audio"]
    for key in ("codec", "audio_codec"):
        if isinstance(value.get(key), str) and CODEC_RE.match(value[key]):
            asset[key] = value[key]
    return asset


def _field(value, index, rules):
    if not isinstance(value, dict):
        raise invalid(f"Field {index + 1}: must be an object.")
    name = _name(value.get("name"), f"Field {index + 1} name", MAX_FIELD_NAME, rules)
    if name.startswith("@"):
        raise invalid(f"Field '{name}': names starting with '@' are reserved.")
    field_type = value.get("type")
    if field_type not in FIELD_TYPES:
        raise LibraryError(400, "unsupported_type",
                           f"Field '{name}': unsupported type {field_type!r}. "
                           f"Supported types: {', '.join(FIELD_TYPES)}.")
    label = f"Field '{name}'"
    if field_type in MEDIA_TYPES:
        return {"name": name, "type": field_type, "asset": _asset(value.get("asset"), label)}
    if "value" not in value:
        raise invalid(f"{label}: value is missing.")
    return {"name": name, "type": field_type, "value": _value(field_type, value["value"], label, rules)}


def _bundle(data, rules):
    if not isinstance(data, dict):
        raise invalid("A bundle must be a JSON object.")
    fields_value = data.get("fields", [])
    if not isinstance(fields_value, list):
        raise invalid("Fields: must be an array.")
    rules.limit(len(fields_value) <= MAX_FIELDS, f"Fields: at most {MAX_FIELDS}.")
    fields = [_field(f, i, rules) for i, f in enumerate(fields_value)]
    seen = set()
    for field in fields:
        if field["name"] in seen:  # the loader finds fields by name
            raise invalid(f"Duplicate field name: '{field['name']}'")
        seen.add(field["name"])
    return {
        "name": _name(data.get("name"), "Bundle name", MAX_BUNDLE_NAME, rules),
        "tags": _tags(data.get("tags", []), rules),
        "note": _note(data.get("note", ""), rules),
        "fields": fields,
    }


def normalize_tag(value):
    """A tag to put on bundles, checked against the rules of saving: a string,
    not empty, no line breaks or control characters, at most MAX_TAG_LENGTH."""
    return _name(value, "Tag", MAX_TAG_LENGTH, _Rules(strict=True))


def tag_name(value):
    """A tag to look for (to rename or remove it): the same checks without the
    length limit, so a tag saved under looser rules can still be named."""
    return _name(value, "Tag", MAX_TAG_LENGTH, _Rules(strict=False))


def normalize_bundle(data):
    """The editable part of a bundle (name, tags, note, fields), checked against
    every rule and normalized, for saving. Raises LibraryError(400) on the
    first problem."""
    return _bundle(data, _Rules(strict=True))


def read_bundle_content(data):
    """The editable part of a stored bundle and the writing rules it breaks
    (warnings). Rules about the shape of the data still raise LibraryError."""
    rules = _Rules(strict=False)
    return _bundle(data, rules), rules.warnings


def empty_value(field):
    """The field with its value cleared, for duplicating a bundle's structure."""
    if field["type"] in MEDIA_TYPES:
        return {"name": field["name"], "type": field["type"], "asset": None}
    blank = {"text": "", "boolean": False, "int": 0, "float": 0.0}[field["type"]]
    return {"name": field["name"], "type": field["type"], "value": blank}
