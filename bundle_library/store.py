"""Bundles on disk: one JSON file each under bundles/, written atomically.

The loader node reads a bundle file directly (see get()); writes replace the
file in one step, so a reader sees either the old or the new version. All
writes and the summary cache share one lock.
"""

import json
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .assets import AssetStore
from .constants import MAX_BUNDLE_NAME, MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS
from .model import LibraryError, check_bundle_id, empty_value, name_key, normalize_bundle

FORMAT = "comfyui-bundle-library/bundle"
SCHEMA_VERSION = 1
TEXT_PREVIEW = 200


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _write_json(path, data, tmp_dir):
    temp = Path(tmp_dir) / f"{uuid.uuid4().hex}.json.part"
    try:
        with open(temp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.chmod(temp, 0o644)
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)
    folder = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(folder)
    finally:
        os.close(folder)


def _reason(error):
    """An error's description without the file path an OSError carries."""
    if isinstance(error, OSError):
        return error.strerror or type(error).__name__
    return str(error)


def _not_found(bundle_id):
    return LibraryError(404, "not_found", f"번들을 찾을 수 없습니다: {bundle_id}")


class BundleStore:
    def __init__(self, root, max_image_bytes=MAX_IMAGE_BYTES, max_image_pixels=MAX_IMAGE_PIXELS):
        root = Path(root)
        self.bundle_dir = root / "bundles"
        self.trash_dir = root / "trash"
        self.tmp_dir = root / "tmp"
        for folder in (self.bundle_dir, self.trash_dir, self.tmp_dir):
            folder.mkdir(parents=True, exist_ok=True)
        # Only this process writes here, so whatever is left is from an interrupted write.
        for leftover in self.tmp_dir.iterdir():
            if leftover.is_file():
                leftover.unlink()
        self.assets = AssetStore(root, self.tmp_dir, max_image_bytes, max_image_pixels)
        self._lock = threading.RLock()
        self._cache = {}  # file name -> (mtime_ns, size, bundle or None, error or None)

    # -- reading ---------------------------------------------------------------

    def _path(self, bundle_id):
        return self.bundle_dir / f"{check_bundle_id(bundle_id)}.json"

    def _read(self, path):
        """The bundle stored at `path`, checked. Raises ValueError if it is unusable."""
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict) or data.get("format") != FORMAT:
            raise ValueError("번들 파일 형식이 아닙니다.")
        if data.get("schema_version") != SCHEMA_VERSION:
            raise ValueError(f"지원하지 않는 schema_version입니다: {data.get('schema_version')!r}")
        if data.get("id") != path.stem:
            raise ValueError("파일 이름과 id가 다릅니다.")
        revision = data.get("revision")
        if isinstance(revision, bool) or not isinstance(revision, int) or revision < 1:
            raise ValueError("revision이 잘못되었습니다.")
        for key in ("created_at", "updated_at"):
            if not isinstance(data.get(key), str):
                raise ValueError(f"{key}가 없습니다.")
        try:
            editable = normalize_bundle(data)
        except LibraryError as e:
            raise ValueError(e.message) from None
        return {**data, **editable}

    def get(self, bundle_id):
        """The bundle as stored now, read from disk."""
        path = self._path(bundle_id)
        if not path.is_file() or path.is_symlink():
            raise _not_found(bundle_id)
        try:
            return self._read(path)
        except (OSError, ValueError) as e:
            raise LibraryError(500, "corrupt_bundle",
                               f"번들 파일을 읽을 수 없습니다 ({path.name}): {_reason(e)}") from None

    def _scan(self):
        """Refresh the summary cache from the bundle folder; only changed files are reread."""
        seen = set()
        for entry in os.scandir(self.bundle_dir):
            if not entry.name.endswith(".json") or not entry.is_file(follow_symlinks=False):
                continue
            seen.add(entry.name)
            stat = entry.stat(follow_symlinks=False)
            cached = self._cache.get(entry.name)
            if cached and cached[0] == stat.st_mtime_ns and cached[1] == stat.st_size:
                continue
            try:
                bundle, error = self._read(Path(entry.path)), None
            except (OSError, ValueError) as e:
                bundle, error = None, _reason(e)
            self._cache[entry.name] = (stat.st_mtime_ns, stat.st_size, bundle, error)
        for name in set(self._cache) - seen:
            del self._cache[name]

    def _bundles(self):
        return [entry[2] for entry in self._cache.values() if entry[2] is not None]

    def list(self, query="", tag="", sort="name"):
        """Summaries of the bundles matching `query` (name, tags, field names and
        text values) and `tag`, plus the files that could not be read."""
        with self._lock:
            self._scan()
            bundles = self._bundles()
            errors = [{"file": name, "error": entry[3]} for name, entry in sorted(self._cache.items())
                      if entry[3] is not None]
        query, tag = query.strip().casefold(), tag.strip().casefold()
        if query:
            bundles = [b for b in bundles if query in _search_text(b)]
        if tag:
            bundles = [b for b in bundles if tag in (t.casefold() for t in b["tags"])]
        bundles.sort(key=lambda b: name_key(b["name"]))
        if sort == "updated":
            bundles.sort(key=lambda b: b["updated_at"], reverse=True)  # stable: ties stay by name
        return {"bundles": [_summary(b) for b in bundles], "errors": errors}

    def health(self):
        with self._lock:
            self._scan()
            corrupt = sorted(name for name, entry in self._cache.items() if entry[3] is not None)
            count = len(self._bundles())
        return {"bundles": count, "corrupt": corrupt, "writable": os.access(self.tmp_dir, os.W_OK)}

    # -- writing ---------------------------------------------------------------

    def _check_name_free(self, name, own_id=None):
        key = name_key(name)
        for bundle in self._bundles():
            if bundle["id"] != own_id and name_key(bundle["name"]) == key:
                raise LibraryError(409, "name_conflict", f"같은 이름의 번들이 이미 있습니다: {bundle['name']}")

    def _resolve_assets(self, fields):
        """Fill each image field's metadata from the stored file itself."""
        for field in fields:
            asset = field.get("asset")
            if field["type"] != "image" or asset is None:
                continue
            info = self.assets.info(asset["sha256"])
            if info is None:
                raise LibraryError(400, "unknown_asset",
                                   f"필드 '{field['name']}': 올린 적 없는 이미지입니다 ({asset['sha256'][:12]}…).")
            resolved = {k: info[k] for k in ("sha256", "ext", "width", "height", "bytes")}
            if asset.get("original_name"):
                resolved["original_name"] = asset["original_name"]
            field["asset"] = resolved

    def _save(self, bundle):
        path = self._path(bundle["id"])
        _write_json(path, bundle, self.tmp_dir)
        stat = path.stat()
        self._cache[path.name] = (stat.st_mtime_ns, stat.st_size, bundle, None)
        return bundle

    def create(self, data):
        editable = normalize_bundle(data)
        with self._lock:
            self._scan()
            self._check_name_free(editable["name"])
            self._resolve_assets(editable["fields"])
            now = _now()
            bundle = {"format": FORMAT, "schema_version": SCHEMA_VERSION, "id": str(uuid.uuid4()),
                      "revision": 1, **editable, "created_at": now, "updated_at": now}
            return self._save(bundle)

    def _current(self, bundle_id, expected_revision):
        if isinstance(expected_revision, bool) or not isinstance(expected_revision, int):
            raise LibraryError(400, "invalid", "expected_revision(정수)이 필요합니다.")
        current = self.get(bundle_id)
        if current["revision"] != expected_revision:
            raise LibraryError(409, "revision_conflict",
                               f"번들이 그사이 바뀌었습니다 (현재 revision {current['revision']}).",
                               current_revision=current["revision"])
        return current

    def update(self, bundle_id, data, expected_revision):
        editable = normalize_bundle(data)
        with self._lock:
            self._scan()
            current = self._current(bundle_id, expected_revision)
            self._check_name_free(editable["name"], own_id=bundle_id)
            self._resolve_assets(editable["fields"])
            bundle = {**current, **editable, "revision": current["revision"] + 1, "updated_at": _now()}
            return self._save(bundle)

    def delete(self, bundle_id, expected_revision):
        """Move the bundle to trash/. Its images stay in the asset store."""
        with self._lock:
            self._current(bundle_id, expected_revision)
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            target = self.trash_dir / f"{bundle_id}.{stamp}.json"
            n = 2
            while target.exists():
                target = self.trash_dir / f"{bundle_id}.{stamp}-{n}.json"
                n += 1
            os.replace(self._path(bundle_id), target)
            self._cache.pop(f"{bundle_id}.json", None)

    def duplicate(self, bundle_id, mode="values", name=None):
        """A new bundle with the same fields; mode "structure" leaves the values empty."""
        if mode not in ("values", "structure"):
            raise LibraryError(400, "invalid", "mode는 'values' 또는 'structure'입니다.")
        with self._lock:
            self._scan()
            source = self.get(bundle_id)
            fields = source["fields"] if mode == "values" else [empty_value(f) for f in source["fields"]]
            if name is None:
                name = self._copy_name(source["name"])
            return self.create({"name": name, "tags": source["tags"], "note": source["note"], "fields": fields})

    def _copy_name(self, name):
        taken = {name_key(b["name"]) for b in self._bundles()}
        for n in range(1, 1000):
            suffix = " 복사본" if n == 1 else f" 복사본 {n}"
            candidate = name[:MAX_BUNDLE_NAME - len(suffix)] + suffix
            if name_key(candidate) not in taken:
                return candidate
        raise LibraryError(409, "name_conflict", "복사본 이름을 정할 수 없습니다. 이름을 직접 지정하세요.")


def _search_text(bundle):
    parts = [bundle["name"], *bundle["tags"]]
    for field in bundle["fields"]:
        parts.append(field["name"])
        if field["type"] == "text":
            parts.append(field["value"])
    return "\n".join(parts).casefold()


def _preview(field):
    if field["type"] == "image":
        asset = field["asset"]
        return None if asset is None else {k: asset[k] for k in ("sha256", "width", "height")}
    if field["type"] == "text":
        return field["value"][:TEXT_PREVIEW]
    return field["value"]


def _summary(bundle):
    return {
        "id": bundle["id"],
        "name": bundle["name"],
        "tags": bundle["tags"],
        "revision": bundle["revision"],
        "updated_at": bundle["updated_at"],
        "fields": [{"name": f["name"], "type": f["type"], "preview": _preview(f)} for f in bundle["fields"]],
    }
