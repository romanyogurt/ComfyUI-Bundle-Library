"""Bundles on disk: one JSON file each under bundles/, written atomically.

The loader node reads a bundle file directly (see get()); writes replace the
file in one step, so a reader sees either the old or the new version. All
writes and the summary cache share one lock. A deleted bundle moves to
trash/, from where it can be restored; the files it uses stay until a
cleanup finds that nothing, not even a trashed bundle, uses them.
"""

import json
import os
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .assets import KINDS, AssetStore
from .constants import ASSET_GRACE_SECONDS, MAX_BUNDLE_NAME, MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, MEDIA_TYPES
from .model import (
    TRASH_ID_RE, LibraryError, check_bundle_id, check_sha256, check_trash_id, empty_value, invalid, name_key,
    normalize_bundle,
)

FORMAT = "comfyui-bundle-library/bundle"
SCHEMA_VERSION = 1
TEXT_PREVIEW = 200
SYNC_FOLDERS = os.name != "nt"  # Windows cannot open a folder to sync it


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
    if SYNC_FOLDERS:
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
    return LibraryError(404, "not_found", f"Bundle not found: {bundle_id}")


def _stamp_time(stamp):
    """"20261015T074500Z" (a trash file's) as "2026-10-15T07:45:00Z"."""
    return f"{stamp[0:4]}-{stamp[4:6]}-{stamp[6:8]}T{stamp[9:11]}:{stamp[11:13]}:{stamp[13:15]}Z"


def _file_time(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _asset_refs(data):
    """The SHA-256 of each file a bundle's fields use; ValueError if `data` is
    not shaped like a bundle. Loose on purpose: a bundle that fails other
    checks still keeps its files."""
    if not isinstance(data, dict) or not isinstance(data.get("fields"), list):
        raise ValueError("not a bundle")
    return {field["asset"]["sha256"] for field in data["fields"]
            if isinstance(field, dict) and isinstance(field.get("asset"), dict)
            and isinstance(field["asset"].get("sha256"), str)}


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

    def _read(self, path, bundle_id=None):
        """The bundle stored at `path` (with the id `bundle_id`, else the file
        name's), checked. Raises ValueError if it is unusable."""
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict) or data.get("format") != FORMAT:
            raise ValueError("not a bundle file")
        if data.get("schema_version") != SCHEMA_VERSION:
            raise ValueError(f"unsupported schema_version {data.get('schema_version')!r}")
        if data.get("id") != (bundle_id or path.stem):
            raise ValueError("the file name and the id differ")
        revision = data.get("revision")
        if isinstance(revision, bool) or not isinstance(revision, int) or revision < 1:
            raise ValueError("invalid revision")
        for key in ("created_at", "updated_at"):
            if not isinstance(data.get(key), str):
                raise ValueError(f"{key} is missing")
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
                               f"Cannot read bundle file {path.name}: {_reason(e)}") from None

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
                raise LibraryError(409, "name_conflict", f"A bundle named '{bundle['name']}' already exists.")

    def _resolve_assets(self, fields):
        """Fill each media field's metadata from the stored file itself, which
        must be of the field's kind."""
        for field in fields:
            asset = field.get("asset")
            if field["type"] not in MEDIA_TYPES or asset is None:
                continue
            info = self.assets.info(asset["sha256"])
            if info is None:
                raise LibraryError(400, "unknown_asset",
                                   f"Field '{field['name']}': file {asset['sha256'][:12]}… has not been uploaded.")
            kind = self.assets.kind(asset["sha256"])
            if kind != field["type"]:
                raise LibraryError(400, "wrong_kind",
                                   f"Field '{field['name']}': the file is {_article(kind)}, not {_article(field['type'])}.")
            resolved = {k: v for k, v in info.items() if k != "mime"}
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
            raise LibraryError(400, "invalid", "expected_revision (an integer) is required.")
        current = self.get(bundle_id)
        if current["revision"] != expected_revision:
            raise LibraryError(409, "revision_conflict",
                               f"The bundle has changed since it was loaded (now revision {current['revision']}).",
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
        """Move the bundle to trash/; its trash id. Its files stay in the asset store."""
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
            return target.name[:-5]

    def duplicate(self, bundle_id, mode="values", name=None):
        """A new bundle with the same fields; mode "structure" leaves the values empty."""
        if mode not in ("values", "structure"):
            raise LibraryError(400, "invalid", "mode must be 'values' or 'structure'.")
        with self._lock:
            self._scan()
            source = self.get(bundle_id)
            fields = source["fields"] if mode == "values" else [empty_value(f) for f in source["fields"]]
            if name is None:
                name = self._free_name(source["name"], [" copy", *(f" copy {n}" for n in range(2, 1000))])
            return self.create({"name": name, "tags": source["tags"], "note": source["note"], "fields": fields})

    def _free_name(self, name, suffixes):
        """`name` with the first of `suffixes` that no other bundle's name has."""
        taken = {name_key(b["name"]) for b in self._bundles()}
        for suffix in suffixes:
            candidate = name[:MAX_BUNDLE_NAME - len(suffix)] + suffix
            if name_key(candidate) not in taken:
                return candidate
        raise LibraryError(409, "name_conflict", f"Could not find a free name for '{name}'.")

    # -- trash -----------------------------------------------------------------

    def _trash_files(self):
        """(trash id, path, bundle id, deleted at) of each file delete() put in trash/."""
        found = []
        for entry in os.scandir(self.trash_dir):
            match = TRASH_ID_RE.match(entry.name[:-5]) if entry.name.endswith(".json") else None
            if match and entry.is_file(follow_symlinks=False):
                found.append((entry.name[:-5], Path(entry.path), match.group(1), _stamp_time(match.group(2))))
        return found

    def _trash_path(self, trash_id):
        path = self.trash_dir / f"{check_trash_id(trash_id)}.json"
        if not path.is_file() or path.is_symlink():
            raise LibraryError(404, "not_found", f"Not in the trash: {trash_id}")
        return path

    def trash(self):
        """Summaries of the trashed bundles, last deleted first, and the trash
        files that cannot be read."""
        entries, errors = [], []
        with self._lock:
            for trash_id, path, bundle_id, deleted_at in self._trash_files():
                try:
                    bundle = self._read(path, bundle_id)
                except (OSError, ValueError) as e:
                    errors.append({"trash_id": trash_id, "deleted_at": deleted_at, "error": _reason(e)})
                    continue
                entries.append({"trash_id": trash_id, "deleted_at": deleted_at, **_summary(bundle)})
        entries.sort(key=lambda e: (e["deleted_at"], e["trash_id"]), reverse=True)
        errors.sort(key=lambda e: (e["deleted_at"], e["trash_id"]), reverse=True)
        return {"trash": entries, "errors": errors}

    def restore(self, trash_id):
        """Put a trashed bundle back. It keeps its id unless a bundle has that id
        now, and gets a number after its name if a bundle has that name."""
        with self._lock:
            path = self._trash_path(trash_id)
            try:
                bundle = self._read(path, TRASH_ID_RE.match(trash_id).group(1))
            except (OSError, ValueError) as e:
                raise LibraryError(500, "corrupt_bundle", f"Cannot read trash file {path.name}: {_reason(e)}") from None
            self._scan()
            bundle_id = bundle["id"] if not self._path(bundle["id"]).exists() else str(uuid.uuid4())
            name = self._free_name(bundle["name"], ["", *(f" ({n})" for n in range(2, 1000))])
            restored = self._save({**bundle, "id": bundle_id, "name": name, "revision": bundle["revision"] + 1,
                                   "updated_at": _now()})
            path.unlink()  # after the bundle is back: a crash in between leaves a copy, not a loss
            return restored

    def purge(self, trash_id):
        """Delete a trashed bundle for good. The files it used stay until a cleanup."""
        with self._lock:
            self._trash_path(trash_id).unlink()

    def empty_trash(self):
        """Delete every trashed bundle for good; how many."""
        with self._lock:
            files = self._trash_files()
            for _, path, _, _ in files:
                path.unlink(missing_ok=True)
            return len(files)

    # -- unused files ------------------------------------------------------------

    def _used_assets(self):
        """The SHA-256 of every file a bundle or a trashed bundle uses. Refuses
        while a bundle file cannot be read: the files it uses would look unused."""
        used, unreadable = set(), []
        for folder in (self.bundle_dir, self.trash_dir):
            for entry in sorted(os.scandir(folder), key=lambda e: e.name):
                if not entry.name.endswith(".json") or not entry.is_file(follow_symlinks=False):
                    continue
                try:
                    with open(entry.path, encoding="utf-8") as f:
                        used |= _asset_refs(json.load(f))
                except (OSError, ValueError):
                    unreadable.append(f"{folder.name}/{entry.name}")
        if unreadable:
            raise LibraryError(409, "unreadable_bundles",
                               "Unused files cannot be told apart while these bundle files cannot be read: "
                               f"{', '.join(unreadable)}.", files=unreadable)
        return used

    def unused_assets(self):
        """The stored files that no bundle and no trashed bundle uses, oldest
        first. Files stored or uploaded again within the grace time are only
        counted (`recent`): a draft in the editor may be using them."""
        with self._lock:
            used = self._used_assets()
            stored = self.assets.stored()
        cutoff = time.time() - ASSET_GRACE_SECONDS
        unused, recent = [], 0
        for sha256, path in stored:
            if sha256 in used:
                continue
            try:
                stat = path.stat()
            except OSError:
                continue  # removed meanwhile
            if stat.st_mtime >= cutoff:
                recent += 1
                continue
            ext = path.suffix[1:]
            unused.append({"sha256": sha256, "kind": KINDS[ext], "ext": ext, "bytes": stat.st_size,
                           "stored_at": _file_time(stat.st_mtime)})
        unused.sort(key=lambda a: (a["stored_at"], a["sha256"]))
        return {"assets": unused, "bytes": sum(a["bytes"] for a in unused), "recent": recent,
                "grace_hours": ASSET_GRACE_SECONDS // 3600}

    def delete_unused_assets(self, shas):
        """Delete these stored files (the ones unused_assets() showed) if they
        are still unused and past the grace time, with their thumbnails; also
        thumbnails whose file is gone. Files in use again are kept."""
        if not isinstance(shas, list):
            raise invalid("sha256 must be a list of file ids.")
        for sha256 in shas:
            check_sha256(sha256)
        with self._lock:  # no bundle is saved meanwhile, so no file becomes used unseen
            used = self._used_assets()
            cutoff = time.time() - ASSET_GRACE_SECONDS
            deleted, freed = 0, 0
            for sha256 in dict.fromkeys(shas):
                size = None if sha256 in used else self.assets.remove(sha256, cutoff)
                if size is not None:
                    deleted += 1
                    freed += size
            thumbnails = self.assets.remove_stray_thumbnails()
        return {"deleted": deleted, "bytes": freed, "kept": len(dict.fromkeys(shas)) - deleted,
                "thumbnails": thumbnails}


def _search_text(bundle):
    parts = [bundle["name"], *bundle["tags"]]
    for field in bundle["fields"]:
        parts.append(field["name"])
        if field["type"] == "text":
            parts.append(field["value"])
    return "\n".join(parts).casefold()


# What the bundle list tells about a media file (enough to lay out its preview).
PREVIEW_KEYS = {"image": ("sha256", "width", "height"), "video": ("sha256", "width", "height", "duration"),
                "audio": ("sha256", "duration")}


def _article(kind):
    return f"an {kind}" if kind in ("image", "audio") else f"a {kind}"


def _preview(field):
    if field["type"] in MEDIA_TYPES:
        asset = field["asset"]
        return None if asset is None else {k: asset[k] for k in PREVIEW_KEYS[field["type"]] if k in asset}
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
