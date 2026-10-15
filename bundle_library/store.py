"""Bundles on disk: one JSON file per bundle under bundles/, written atomically.

A bundle is one UUID and one file. The trash is a state of the bundle, not a
folder: `deleted_at` is null while it is in use and the UTC time it was
deleted while it is in the trash, where it can be restored or deleted for
good. The files a bundle uses stay until a cleanup finds that nothing, not
even a bundle in the trash, uses them.

The loader node reads a bundle file directly (see get()); writes replace the
file in one step, so a reader sees either the old or the new version. All
writes and the summary cache share one lock.

Files this version does not fully understand (schema.py) are never written:
only an explicit permanent delete touches them, and their presence stops a
cleanup of unused files.
"""

import json
import os
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from . import schema
from .assets import KINDS, AssetStore
from .constants import ASSET_GRACE_SECONDS, MAX_BUNDLE_NAME, MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, MEDIA_TYPES
from .model import (
    INT_MAX, INT_MIN, TRASH_ID_RE, LibraryError, check_bundle_id, check_sha256, empty_value, invalid, name_key,
    normalize_bundle,
)

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
    """"20261015T074500Z" (an old trash file's) as "2026-10-15T07:45:00.000Z"."""
    return f"{stamp[0:4]}-{stamp[4:6]}-{stamp[6:8]}T{stamp[9:11]}:{stamp[11:13]}:{stamp[13:15]}.000Z"


def _file_time(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _unusable(loaded, name):
    """The error for a bundle file this version cannot use (`name` names it)."""
    if loaded.state == schema.NEWER:
        return LibraryError(409, "newer_version",
                            f"Bundle file {name} was saved by a newer Bundle Library; update the node to use it.")
    if loaded.state == schema.UNSUPPORTED:
        return LibraryError(409, "unsupported", f"Bundle file {name} cannot be used by this version: {loaded.problem}.")
    return LibraryError(500, "corrupt_bundle", f"Cannot read bundle file {name}: {loaded.problem}")


class BundleStore:
    def __init__(self, root, max_image_bytes=MAX_IMAGE_BYTES, max_image_pixels=MAX_IMAGE_PIXELS):
        root = Path(root)
        self.bundle_dir = root / "bundles"
        self.tmp_dir = root / "tmp"
        self.legacy_trash_dir = root / "trash"  # 0.0.10 and earlier; emptied into bundles/ on start
        for folder in (self.bundle_dir, self.tmp_dir):
            folder.mkdir(parents=True, exist_ok=True)
        # Only this process writes here, so whatever is left is from an interrupted write.
        for leftover in self.tmp_dir.iterdir():
            if leftover.is_file():
                leftover.unlink()
        self.assets = AssetStore(root, self.tmp_dir, max_image_bytes, max_image_pixels)
        self._lock = threading.RLock()
        self._cache = {}  # file name -> (mtime_ns, size, schema.Loaded)
        with self._lock:
            self._move_legacy_trash()

    # -- reading ---------------------------------------------------------------

    def _path(self, bundle_id):
        return self.bundle_dir / f"{check_bundle_id(bundle_id)}.json"

    def _load(self, bundle_id):
        """The bundle file of `bundle_id`, read now: a schema.Loaded, or None if there is none."""
        path = self._path(bundle_id)
        if not path.is_file() or path.is_symlink():
            return None
        return schema.read_file(path, bundle_id)

    def get(self, bundle_id, details=False):
        """The bundle in use with this id, as stored now (read from disk, in the
        current version). With `details`, (bundle, schema.Loaded)."""
        loaded = self._load(bundle_id)
        if loaded is None:
            raise _not_found(bundle_id)
        if not loaded.readable:
            raise _unusable(loaded, f"{bundle_id}.json")
        if loaded.deleted:
            raise LibraryError(404, "in_trash",
                               f"Bundle '{loaded.bundle['name']}' is in the trash; restore it to use it.")
        return (loaded.bundle, loaded) if details else loaded.bundle

    def _scan(self):
        """Refresh the cache from the bundle folder; only changed files are reread."""
        if self.legacy_trash_dir.is_dir():
            self._move_legacy_trash()  # a restored old backup can bring one back
        seen = set()
        for entry in os.scandir(self.bundle_dir):
            if not entry.name.endswith(".json") or not entry.is_file(follow_symlinks=False):
                continue
            seen.add(entry.name)
            stat = entry.stat(follow_symlinks=False)
            cached = self._cache.get(entry.name)
            if cached and cached[0] == stat.st_mtime_ns and cached[1] == stat.st_size:
                continue
            stem = entry.name[:-5]
            self._cache[entry.name] = (stat.st_mtime_ns, stat.st_size, schema.read_file(Path(entry.path), stem))
        for name in set(self._cache) - seen:
            del self._cache[name]

    def _files(self):
        """(file name, schema.Loaded) of every bundle file, as last scanned."""
        return [(name, entry[2]) for name, entry in sorted(self._cache.items())]

    def _bundles(self, deleted=False):
        """The readable bundles in use, or with `deleted` those in the trash."""
        return [loaded.bundle for _, loaded in self._files() if loaded.readable and loaded.deleted == deleted]

    def _errors(self):
        """The bundle files this version cannot use, and old trash files it did not move."""
        errors = [{"file": f"bundles/{name}", "id": name[:-5] if _is_id(name[:-5]) else None,
                   "code": loaded.state, "error": loaded.problem}
                  for name, loaded in self._files() if not loaded.readable]
        for path in self._legacy_trash_files():
            errors.append({"file": f"trash/{path.name}", "id": None, "code": "legacy_trash",
                           "error": "left in the old trash folder: " + self._legacy_reason(path)})
        return errors

    def list(self, query="", tag="", sort="name"):
        """Summaries of the bundles in use matching `query` (name, tags, field
        names and text values) and `tag`, plus the files that could not be used."""
        with self._lock:
            self._scan()
            loaded = [entry for _, entry in self._files() if entry.readable and not entry.deleted]
            errors = self._errors()
        query, tag = query.strip().casefold(), tag.strip().casefold()
        if query:
            loaded = [entry for entry in loaded if query in _search_text(entry.bundle)]
        if tag:
            loaded = [entry for entry in loaded if tag in (t.casefold() for t in entry.bundle["tags"])]
        loaded.sort(key=lambda entry: (name_key(entry.bundle["name"]), entry.bundle["id"]))
        if sort == "updated":
            loaded.sort(key=lambda entry: entry.bundle["updated_at"], reverse=True)  # stable: ties stay by name
        return {"bundles": [_summary(entry) for entry in loaded], "errors": errors}

    def health(self):
        with self._lock:
            self._scan()
            files = self._files()
            legacy = [path.name for path in self._legacy_trash_files()]
        by_state = {state: sorted(name for name, loaded in files if loaded.state == state)
                    for state in (schema.CORRUPT, schema.NEWER, schema.UNSUPPORTED)}
        return {
            "bundles": sum(1 for _, loaded in files if loaded.readable and not loaded.deleted),
            "trash": sum(1 for _, loaded in files if loaded.deleted),
            "corrupt": by_state[schema.CORRUPT],
            "newer": by_state[schema.NEWER],
            "unsupported": by_state[schema.UNSUPPORTED],
            "legacy_trash": legacy,
            "writable": os.access(self.tmp_dir, os.W_OK),
        }

    # -- writing ---------------------------------------------------------------

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
        self._cache[path.name] = (stat.st_mtime_ns, stat.st_size, schema.read_file(path, bundle["id"]))
        return bundle

    def create(self, data):
        editable = normalize_bundle(data)
        with self._lock:
            self._resolve_assets(editable["fields"])
            now = _now()
            bundle = {"format": schema.FORMAT, "schema_version": schema.SCHEMA_VERSION, "id": str(uuid.uuid4()),
                      "revision": 1, **editable, "created_at": now, "updated_at": now, "deleted_at": None}
            return self._save(bundle)

    def _writable(self, bundle_id, expected_revision=None):
        """The bundle of `bundle_id` as stored, if this version may write it."""
        loaded = self._load(bundle_id)
        if loaded is None:
            raise _not_found(bundle_id)
        if not loaded.readable:
            raise _unusable(loaded, f"{bundle_id}.json")
        if not loaded.writable:
            raise LibraryError(409, "read_only",
                               f"Bundle '{loaded.bundle['name']}' {loaded.problem}, so this version does not "
                               "change it.")
        bundle = loaded.bundle
        if expected_revision is not None:
            if isinstance(expected_revision, bool) or not isinstance(expected_revision, int):
                raise LibraryError(400, "invalid", "expected_revision (an integer) is required.")
            if bundle["revision"] != expected_revision:
                raise LibraryError(409, "revision_conflict",
                                   f"The bundle has changed since it was loaded (now revision {bundle['revision']}).",
                                   current_revision=bundle["revision"])
        return bundle

    def _in_use(self, bundle):
        if bundle["deleted_at"] is not None:
            raise LibraryError(409, "in_trash", f"Bundle '{bundle['name']}' is in the trash; restore it first.")
        return bundle

    def update(self, bundle_id, data, expected_revision):
        if expected_revision is None:
            raise LibraryError(400, "invalid", "expected_revision (an integer) is required.")
        editable = normalize_bundle(data)
        with self._lock:
            current = self._in_use(self._writable(bundle_id, expected_revision))
            self._resolve_assets(editable["fields"])
            return self._save({**current, **editable, "revision": current["revision"] + 1, "updated_at": _now()})

    def delete(self, bundle_id, expected_revision):
        """Move the bundle to the trash: the same file, with the time it was deleted."""
        if expected_revision is None:
            raise LibraryError(400, "invalid", "expected_revision (an integer) is required.")
        with self._lock:
            current = self._in_use(self._writable(bundle_id, expected_revision))
            self._save({**current, "deleted_at": _now(), "revision": current["revision"] + 1})

    def duplicate(self, bundle_id, mode="values", name=None):
        """A new bundle with the same fields; mode "structure" leaves the values empty."""
        if mode not in ("values", "structure"):
            raise LibraryError(400, "invalid", "mode must be 'values' or 'structure'.")
        with self._lock:
            source = self._in_use(self._writable(bundle_id))
            fields = source["fields"] if mode == "values" else [empty_value(f) for f in source["fields"]]
            if name is None:
                name = source["name"][:MAX_BUNDLE_NAME - len(" copy")] + " copy"
            return self.create({"name": name, "tags": source["tags"], "note": source["note"], "fields": fields})

    # -- the trash -------------------------------------------------------------

    def trash(self):
        """Summaries of the bundles in the trash, last deleted first, and the
        files this version cannot use (which may or may not be deleted ones)."""
        with self._lock:
            self._scan()
            loaded = [entry for _, entry in self._files() if entry.deleted]
            errors = self._errors()
        loaded.sort(key=lambda entry: (entry.bundle["deleted_at"], entry.bundle["id"]), reverse=True)
        return {"trash": [{**_summary(entry), "deleted_at": entry.bundle["deleted_at"]} for entry in loaded],
                "errors": errors}

    def restore(self, bundle_id):
        """Put a bundle in the trash back in use: the same id and the same name."""
        with self._lock:
            bundle = self._writable(bundle_id)
            if bundle["deleted_at"] is None:
                raise LibraryError(409, "not_in_trash", f"Bundle '{bundle['name']}' is not in the trash.")
            return self._save({**bundle, "deleted_at": None, "revision": bundle["revision"] + 1})

    def purge(self, bundle_id, unreadable=False):
        """Delete a bundle in the trash for good. A file this version cannot
        fully read is deleted only when asked for explicitly (`unreadable`).
        The files it used stay until a cleanup."""
        with self._lock:
            loaded = self._load(bundle_id)
            if loaded is None:
                raise _not_found(bundle_id)
            if loaded.writable:
                if not loaded.deleted:
                    raise LibraryError(409, "not_in_trash",
                                       f"Bundle '{loaded.bundle['name']}' is not in the trash; delete it first.")
            elif not unreadable:
                raise LibraryError(409, "unreadable_file",
                                   f"This version cannot fully read {bundle_id}.json ({loaded.problem}); "
                                   "delete it for good only if you are sure.")
            self._path(bundle_id).unlink()
            self._cache.pop(f"{bundle_id}.json", None)

    def empty_trash(self):
        """Delete every bundle in the trash for good; how many. Files this version
        cannot fully read are left alone: whether they are in the trash is unknown."""
        with self._lock:
            self._scan()
            names = [name for name, loaded in self._files() if loaded.writable and loaded.deleted]
            for name in names:
                (self.bundle_dir / name).unlink(missing_ok=True)
                self._cache.pop(name, None)
            return len(names)

    # -- the trash folder of 0.0.10 and earlier --------------------------------

    def _legacy_trash_files(self):
        if not self.legacy_trash_dir.is_dir():
            return []
        return sorted(p for p in self.legacy_trash_dir.iterdir() if p.is_file() and not p.is_symlink())

    def _legacy_reason(self, path):
        match = TRASH_ID_RE.match(path.stem) if path.suffix == ".json" else None
        if not match:
            return "not a trash file"
        if self._path(match.group(1)).exists():
            return "a bundle with its id exists"
        loaded = schema.read_file(path, match.group(1))
        if not loaded.writable:
            return loaded.problem
        return "an older copy of a bundle deleted again later"

    def _move_legacy_trash(self):
        """Move the old trash folder's files into bundles/ as deleted bundles of
        the current version. Only a readable file whose id no other bundle file
        has is moved, the last deleted one if an id was deleted more than once;
        everything else stays where it is and is reported. The folder goes once
        it is empty."""
        by_id = {}
        for path in self._legacy_trash_files():
            match = TRASH_ID_RE.match(path.stem) if path.suffix == ".json" else None
            if match:
                by_id.setdefault(match.group(1), []).append((match.group(2), path))
        for bundle_id, copies in by_id.items():
            stamp, path = max(copies)  # the last deleted copy
            if self._path(bundle_id).exists():
                continue
            loaded = schema.read_file(path, bundle_id)
            if not loaded.writable:
                continue
            deleted_at = loaded.bundle["deleted_at"] or _stamp_time(stamp)
            _write_json(self._path(bundle_id), {**loaded.bundle, "deleted_at": deleted_at}, self.tmp_dir)
            path.unlink()
        try:
            self.legacy_trash_dir.rmdir()  # only when empty
        except OSError:
            pass

    # -- unused files ------------------------------------------------------------

    def _used_assets(self):
        """The SHA-256 of every file a bundle uses, in use or in the trash.
        Refuses while a bundle file cannot be fully read: the files it uses
        could look unused."""
        self._scan()
        used, unclear = set(), []
        files = [(f"bundles/{name}", loaded) for name, loaded in self._files()]
        files += [(f"trash/{path.name}", schema.read_file(path)) for path in self._legacy_trash_files()]
        for name, loaded in files:
            # Fully read, or broken in a way that still shows its fields of a known version.
            if loaded.refs is not None and (loaded.writable or loaded.state == schema.CORRUPT):
                used |= loaded.refs
            else:
                unclear.append(name)
        if unclear:
            raise LibraryError(409, "unreadable_bundles",
                               "Unused files cannot be told apart while these bundle files cannot be fully read: "
                               f"{', '.join(unclear)}.", files=unclear)
        return used

    def unused_assets(self):
        """The stored files that no bundle uses (in use or in the trash), oldest
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


def _is_id(text):
    try:
        check_bundle_id(text)
        return True
    except LibraryError:
        return False


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


def exact_int(value):
    """An int outside JavaScript's safe range as its decimal text, which a
    browser keeps exactly; other values as they are."""
    if isinstance(value, int) and not isinstance(value, bool) and not INT_MIN <= value <= INT_MAX:
        return str(value)
    return value


def _preview(field):
    if field["type"] in MEDIA_TYPES:
        asset = field["asset"]
        return None if asset is None else {k: asset[k] for k in PREVIEW_KEYS[field["type"]] if k in asset}
    if field["type"] == "text":
        return field["value"][:TEXT_PREVIEW]
    return exact_int(field["value"])


def _summary(loaded):
    bundle = loaded.bundle
    summary = {
        "id": bundle["id"],
        "name": bundle["name"],
        "tags": bundle["tags"],
        "revision": bundle["revision"],
        "updated_at": bundle["updated_at"],
        "fields": [{"name": f["name"], "type": f["type"], "preview": _preview(f)} for f in bundle["fields"]],
    }
    if loaded.warnings:
        summary["warnings"] = loaded.warnings
    if loaded.state == schema.READ_ONLY:
        summary["read_only"] = loaded.problem
    return summary


def present(bundle, loaded=None):
    """A bundle as the API answers with it: an int outside JavaScript's safe
    range also as exact text (`value_text`), and with `loaded`, the writing
    rules it breaks (`warnings`) and why it cannot be changed (`read_only`)."""
    fields = []
    for field in bundle["fields"]:
        text = exact_int(field.get("value")) if field["type"] == "int" else None
        fields.append({**field, "value_text": text} if isinstance(text, str) else field)
    out = {**bundle, "fields": fields}
    if loaded is not None:
        if loaded.warnings:
            out["warnings"] = loaded.warnings
        if loaded.state == schema.READ_ONLY:
            out["read_only"] = loaded.problem
    return out
