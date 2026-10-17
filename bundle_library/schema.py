"""The bundle file format: reading a file of any supported version into the
current one in memory, and sorting files into the states that decide what
the library may do with them (docs/data-format.md, "호환성 정책").

Reading never writes: a file is upgraded in memory and stored in the
current version only when the library saves it for another reason. Imports
nothing from ComfyUI.
"""

import json
import logging
import re

from .constants import MEDIA_TYPES
from .model import UUID_RE, LibraryError, lone_surrogates, read_bundle_content

FORMAT = "comfyui-bundle-library/bundle"
SCHEMA_VERSION = 2

# States, from fully usable to unusable.
OK = "ok"                    # every check passes
WARNING = "warning"          # breaks a writing rule tightened since it was saved; readable
READ_ONLY = "read_only"      # holds keys this version does not know; readable, never written
NEWER = "newer_version"      # a later schema of this format
UNSUPPORTED = "unsupported"  # another format, or a field type this version does not know
CORRUPT = "corrupt"          # unreadable, or breaks the shape of a bundle

READABLE = (OK, WARNING, READ_ONLY)  # a bundle the library can show and run
WRITABLE = (OK, WARNING)             # one it may also save, delete and restore

_COMMON = {"format", "schema_version", "id", "revision", "name", "tags", "note", "fields", "created_at", "updated_at"}
TOP_KEYS = {1: _COMMON, 2: _COMMON | {"deleted_at"}}
VALUE_FIELD_KEYS = {"name", "type", "value"}
MEDIA_FIELD_KEYS = {"name", "type", "asset"}
ASSET_KEYS = {"sha256", "original_name", "ext", "bytes", "width", "height", "duration", "fps", "codec",
              "has_audio", "audio_codec", "sample_rate", "channels"}
_TIME_RE = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,6})?Z$")


def _v1_to_v2(data):
    """Version 2 keeps deleted bundles in bundles/ with the time they were
    deleted; every version-1 file there is active."""
    return {**data, "schema_version": 2, "deleted_at": None}


MIGRATIONS = {1: _v1_to_v2}  # version -> the step to the next version


def migrate(data, version):
    """`data` (a bundle of `version`) as the current version, a new dict."""
    while version < SCHEMA_VERSION:
        data = MIGRATIONS[version](data)
        version += 1
    return data


class Loaded:
    """One bundle file as read: its `state`, the `bundle` in the current
    version (when readable), why it is not fully usable (`problem`), the
    writing rules it breaks (`warnings`), and the files it points at
    (`refs`; None when that cannot be told)."""

    def __init__(self, state, bundle=None, problem=None, warnings=(), refs=None, io_error=False):
        self.state = state
        # The file could not be read at all (permissions, I/O): not a fact about
        # its content, so it is reported apart and read again next time.
        self.io_error = io_error
        self.bundle = bundle
        self.problem = problem
        self.warnings = list(warnings)
        self.refs = refs

    @property
    def readable(self):
        return self.state in READABLE

    @property
    def writable(self):
        return self.state in WRITABLE

    @property
    def deleted(self):
        return self.readable and self.bundle["deleted_at"] is not None


def _unknown_keys(data, version):
    """Where `data` (a file of `version`) has keys that version does not define."""
    found = [f"'{key}'" for key in sorted(set(data) - TOP_KEYS[version])]
    for field in data.get("fields") if isinstance(data.get("fields"), list) else []:
        if not isinstance(field, dict):
            continue
        allowed = MEDIA_FIELD_KEYS if field.get("type") in MEDIA_TYPES else VALUE_FIELD_KEYS
        label = f"field '{field.get('name')}'"
        found += [f"{label}: '{key}'" for key in sorted(set(field) - allowed)]
        if isinstance(field.get("asset"), dict):
            found += [f"{label} file: '{key}'" for key in sorted(set(field["asset"]) - ASSET_KEYS)]
    return found


def _refs(data):
    """The SHA-256 of every file the fields point at, or None if `data` is not
    shaped like a bundle of a known version."""
    if not isinstance(data.get("fields"), list):
        return None
    return {field["asset"]["sha256"] for field in data["fields"]
            if isinstance(field, dict) and isinstance(field.get("asset"), dict)
            and isinstance(field["asset"].get("sha256"), str)}


def read(text, file_id=None):
    """Sort the content of a bundle file into a Loaded. `file_id` is the id its
    file name gives, which the bundle must have."""
    try:
        data = json.loads(text)
    except ValueError:  # includes text that is not UTF-8
        return Loaded(CORRUPT, problem="not valid JSON")
    except RecursionError:
        return Loaded(CORRUPT, problem="nested too deeply")
    if not isinstance(data, dict):
        return Loaded(CORRUPT, problem="not a JSON object")
    if lone_surrogates(data):
        return Loaded(CORRUPT, problem="has text that is not valid Unicode")
    form = data.get("format")
    if form != FORMAT:
        if isinstance(form, str) and form:
            return Loaded(UNSUPPORTED, problem=f"another format ('{form[:60]}')")
        return Loaded(CORRUPT, problem="not a bundle file")
    version = data.get("schema_version")
    if type(version) is not int or version < 1:  # not bool, not 1.0
        return Loaded(CORRUPT, problem=f"invalid schema_version {version!r}")
    if version > SCHEMA_VERSION:
        return Loaded(NEWER, problem=f"saved by a newer Bundle Library (schema version {version}; "
                                     f"this one reads up to {SCHEMA_VERSION})")
    refs = _refs(data)
    unknown = _unknown_keys(data, version)
    data = migrate(data, version)
    problem = _shape_problem(data, file_id)
    if problem:
        return Loaded(CORRUPT, problem=problem, refs=refs)
    try:
        content, warnings = read_bundle_content(data)
    except LibraryError as e:
        state = UNSUPPORTED if e.code == "unsupported_type" else CORRUPT
        return Loaded(state, problem=e.message, refs=refs)
    bundle = {**data, **content}
    if unknown:
        return Loaded(READ_ONLY, bundle, "has data this version does not know: " + ", ".join(unknown[:5]),
                      warnings, refs)
    return Loaded(WARNING if warnings else OK, bundle, warnings=warnings, refs=refs)


def _shape_problem(data, file_id):
    bundle_id = data.get("id")
    if not isinstance(bundle_id, str) or not UUID_RE.match(bundle_id):
        return "invalid id"
    if file_id is not None and bundle_id != file_id:
        return "the file name and the id differ"
    revision = data.get("revision")
    if type(revision) is not int or revision < 1:
        return "invalid revision"
    for key in ("created_at", "updated_at"):
        if not isinstance(data.get(key), str):
            return f"{key} is missing"
    deleted_at = data.get("deleted_at", "missing")
    if deleted_at is not None and not (isinstance(deleted_at, str) and _TIME_RE.match(deleted_at)):
        return "invalid deleted_at"
    return None


def read_file(path, file_id=None):
    try:
        with open(path, "rb") as f:
            text = f.read()
    except OSError as e:
        return Loaded(CORRUPT, problem=f"could not be read ({e.strerror or type(e).__name__})", io_error=True)
    return read_checked(text, file_id, getattr(path, "name", path))


def read_checked(data, file_id=None, name=None):
    """read() of a file's bytes, with the last defence of the file boundary."""
    try:
        return read(data, file_id)
    except Exception as e:  # noqa: BLE001 — the last defence of the file boundary
        # A file must never take down the list of all the others; the cause is
        # logged, since it may be a fault in this code rather than in the file.
        logging.exception("[Bundle Library] could not check %s", name or file_id)
        return Loaded(CORRUPT, problem=f"could not be checked ({type(e).__name__})")
