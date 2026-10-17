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
import logging
import os
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from collections import Counter

from . import organization, schema
from . import tags as tag_rules
from .assets import KINDS, AssetStore
from .constants import (
    ASSET_GRACE_SECONDS, MAX_BUNDLE_NAME, MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, MAX_TAGS, MEDIA_TYPES,
)
from .model import (
    INT_MAX, INT_MIN, TRASH_ID_RE, UUID_RE, LibraryError, check_bundle_id, check_sha256, empty_value, invalid,
    name_key, normalize_bundle, normalize_tag, tag_name,
)

TEXT_PREVIEW = 200
MAX_BATCH = 1000  # bundles in one batch request
BATCH_ACTIONS = ("set_category", "set_favorite", "trash", "add_tags", "remove_tags")
MAX_BATCH_TAGS = 20  # tags in one add_tags or remove_tags request
SYNC_FOLDERS = os.name != "nt"  # Windows cannot open a folder to sync it
# Told with a change that is made but may not survive a power loss (_write_json).
UNSYNCED = "Saved, but the library folder could not be synced to the disk; a power loss could undo it."


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _write_json(path, data, tmp_dir):
    """Replace `path` with `data` as JSON in one step (see _write_file)."""
    return _write_file(path, (json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode("utf-8"), tmp_dir)


def _write_file(path, raw, tmp_dir):
    """Replace `path` with the bytes `raw` in one step. A failure before the
    replace raises and leaves the old file (nothing is written). After it, the
    file is the new one: a failure to sync the folder is logged, not raised,
    and the result is False (written, but a power loss could undo it)."""
    temp = Path(tmp_dir) / f"{uuid.uuid4().hex}.json.part"
    try:
        with open(temp, "wb") as f:
            f.write(raw)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(temp, 0o644)
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)
    if SYNC_FOLDERS:
        try:
            folder = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(folder)
            finally:
                os.close(folder)
        except OSError as e:
            logging.warning("[Bundle Library] %s was written, but its folder could not be synced: %s",
                            path.name, e.strerror or type(e).__name__)
            return False
    return True


def _stat_key(stat):
    """What tells that a file may read differently now: its content (mtime,
    size), its permissions or owner (ctime), or a replacement (inode)."""
    return (stat.st_mtime_ns, stat.st_size, stat.st_ctime_ns, stat.st_ino)


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
        self.organization_path = root / "organization.json"  # categories and favorites (organization.py)
        self._organization_cache = None  # ((mtime_ns, size), Organization)
        for folder in (self.bundle_dir, self.tmp_dir):
            folder.mkdir(parents=True, exist_ok=True)
        # Only this process writes here, so whatever is left is from an interrupted write.
        for leftover in self.tmp_dir.iterdir():
            if leftover.is_file():
                leftover.unlink()
        self.assets = AssetStore(root, self.tmp_dir, max_image_bytes, max_image_pixels)
        self._lock = threading.RLock()
        self._cache = {}  # file name -> (_stat_key or None, schema.Loaded)
        self._synced = True  # whether the last write was synced (see _write_json); read under the lock
        with self._lock:
            self._move_legacy_trash()

    # -- reading ---------------------------------------------------------------

    def _path(self, bundle_id):
        return self.bundle_dir / f"{check_bundle_id(bundle_id)}.json"

    def _exists(self, bundle_id):
        """Whether `bundle_id` has a bundle file (a symlink is not one)."""
        path = self._path(bundle_id)
        return path.is_file() and not path.is_symlink()

    def _load(self, bundle_id):
        """The bundle file of `bundle_id`, read now: a schema.Loaded, or None if there is none."""
        if not self._exists(bundle_id):
            return None
        return schema.read_file(self._path(bundle_id), bundle_id)

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
            if cached and cached[0] == _stat_key(stat):
                continue
            self._remember(entry.name, stat, schema.read_file(Path(entry.path), entry.name[:-5]))
        for name in set(self._cache) - seen:
            del self._cache[name]

    def _remember(self, name, stat, loaded):
        """Keep how the file `name` read, for as long as it does not change. A
        read error is kept without the file's key, so the next scan reads it
        again: it may pass (permissions fixed) without the file changing. The
        scan and a save both go through here."""
        self._cache[name] = (None if loaded.io_error else _stat_key(stat), loaded)

    def _files(self):
        """(file name, schema.Loaded) of every bundle file, as last scanned."""
        return [(name, entry[1]) for name, entry in sorted(self._cache.items())]

    def _bundles(self, deleted=False):
        """The readable bundles in use, or with `deleted` those in the trash."""
        return [loaded.bundle for _, loaded in self._files() if loaded.readable and loaded.deleted == deleted]

    def _errors(self):
        """The bundle files this version cannot use, and old trash files it did not move."""
        # A file that could not be read at all gets no id: deleting it for good is not offered.
        errors = [{"file": f"bundles/{name}", "id": None, "code": "read_error", "error": loaded.problem}
                  if loaded.io_error else
                  {"file": f"bundles/{name}", "id": name[:-5] if _is_id(name[:-5]) else None,
                   "code": loaded.state, "error": loaded.problem}
                  for name, loaded in self._files() if not loaded.readable]
        for path in self._legacy_trash_files():
            errors.append({"file": f"trash/{path.name}", "id": None, "code": "legacy_trash",
                           "error": "left in the old trash folder: " + self._legacy_reason(path)})
        org = self._organization()
        if not org.writable:
            errors.append({"file": "organization.json", "id": None, "code": "read_error" if org.io_error else org.state,
                           "error": f"{org.problem}; categories and favorites cannot be changed"})
        return errors

    def list(self, query="", tag="", sort="name"):
        """Summaries of the bundles in use matching `query` (name, tags, field
        names and text values) and `tag`, plus the files that could not be used."""
        with self._lock:
            self._scan()
            loaded = [entry for _, entry in self._files() if entry.readable and not entry.deleted]
            errors = self._errors()
            org = self._organization()
        names = {c["id"]: c["name"] for c in self._categories_of(org)}
        query, tag = query.strip().casefold(), tag.strip().casefold()
        if query:
            loaded = [entry for entry in loaded
                      if query in _search_text(entry.bundle, names.get(self._category_of(org, entry.bundle["id"])))]
        if tag:
            loaded = [entry for entry in loaded if tag in (t.casefold() for t in entry.bundle["tags"])]
        loaded.sort(key=lambda entry: (name_key(entry.bundle["name"]), entry.bundle["id"]))
        if sort == "updated":
            loaded.sort(key=lambda entry: entry.bundle["updated_at"], reverse=True)  # stable: ties stay by name
        counts = {}
        for entry in loaded:
            category = self._category_of(org, entry.bundle["id"])
            counts[category] = counts.get(category, 0) + 1
        return {
            "bundles": [self._organized(_summary(entry), org) for entry in loaded],
            "errors": errors,
            "categories": [{**c, "count": counts.get(c["id"], 0)} for c in self._categories_of(org)],
            "organization": {"revision": org.revision, "state": org.state if org.exists else "missing"},
        }

    def health(self):
        with self._lock:
            self._scan()
            files = self._files()
            legacy = [path.name for path in self._legacy_trash_files()]
            org = self._organization()
        by_state = {state: sorted(name for name, loaded in files if loaded.state == state)
                    for state in (schema.CORRUPT, schema.NEWER, schema.UNSUPPORTED)}
        return {
            "organization": org.state if org.exists else "missing",
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
        self._synced = _write_json(path, bundle, self.tmp_dir)
        self._remember(path.name, path.stat(), schema.read_file(path, bundle["id"]))
        return bundle

    def create(self, data, category=None):
        """A new bundle. With `category`, it is also put in that category; that is
        a second file, so if only that fails the bundle stays made and the
        problem comes back as `placement_error` (place it again, do not create
        it again)."""
        if category is not None:
            _check_category_id(category)  # a malformed one is refused before anything is written
        editable = normalize_bundle(data)
        with self._lock:
            self._resolve_assets(editable["fields"])
            now = _now()
            bundle = {"format": schema.FORMAT, "schema_version": schema.SCHEMA_VERSION, "id": str(uuid.uuid4()),
                      "revision": 1, **editable, "created_at": now, "updated_at": now, "deleted_at": None}
            bundle = self._save(bundle)
            if category is None:
                return bundle
            try:
                self.set_category(bundle["id"], category)
            except LibraryError as e:
                return {**bundle, "placement_error": e.message}
            except OSError as e:
                return {**bundle, "placement_error": f"organization.json could not be written: {_reason(e)}"}
            return bundle

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
        """Move the bundle to the trash: the same file, with the time it was
        deleted. The result is the batch's for one bundle (_trash_one)."""
        if expected_revision is None:
            raise LibraryError(400, "invalid", "expected_revision (an integer) is required.")
        with self._lock:
            return self._trash_one(bundle_id, expected_revision)

    def _trash_one(self, bundle_id, expected_revision):
        """Move one bundle to the trash (under the lock), for DELETE and the batch
        alike: {"id", "ok", "changed", "revision"?, "warning"?}. A bundle in the
        trash already is a change done already. Refusals raise LibraryError and
        write failures OSError."""
        loaded = self._load(bundle_id)
        if loaded is not None and loaded.readable and loaded.deleted:
            return {"id": bundle_id, "ok": True, "changed": False}
        current = self._in_use(self._writable(bundle_id, expected_revision))
        saved = self._save({**current, "deleted_at": _now(), "revision": current["revision"] + 1})
        return self._written({"id": bundle_id, "ok": True, "changed": True, "revision": saved["revision"]})

    def _written(self, result):
        """A result of a write, with the warning when the folder could not be synced."""
        if not self._synced:
            result["warning"] = UNSYNCED
        return result

    def duplicate(self, bundle_id, mode="values", name=None):
        """A new bundle with the same fields; mode "structure" leaves the values empty."""
        if mode not in ("values", "structure"):
            raise LibraryError(400, "invalid", "mode must be 'values' or 'structure'.")
        with self._lock:
            source = self._in_use(self._writable(bundle_id))
            fields = source["fields"] if mode == "values" else [empty_value(f) for f in source["fields"]]
            if name is None or name == "":
                name = source["name"][:MAX_BUNDLE_NAME - len(" copy")] + " copy"
            category = self._category_of(self._organization(), bundle_id)  # the copy goes beside its source
            return self.create({"name": name, "tags": source["tags"], "note": source["note"], "fields": fields},
                               category)

    # -- the trash -------------------------------------------------------------

    def trash(self):
        """Summaries of the bundles in the trash, last deleted first, and the
        files this version cannot use (which may or may not be deleted ones)."""
        with self._lock:
            self._scan()
            loaded = [entry for _, entry in self._files() if entry.deleted]
            errors = self._errors()
            org = self._organization()
        loaded.sort(key=lambda entry: (entry.bundle["deleted_at"], entry.bundle["id"]), reverse=True)
        return {"trash": [{**self._organized(_summary(entry), org), "deleted_at": entry.bundle["deleted_at"]}
                          for entry in loaded],
                "errors": errors}

    def restore(self, bundle_id):
        """Put a bundle in the trash back in use: the same id and the same name."""
        with self._lock:
            bundle = self._writable(bundle_id)
            if bundle["deleted_at"] is None:
                raise LibraryError(409, "not_in_trash", f"Bundle '{bundle['name']}' is not in the trash.")
            return self._save({**bundle, "deleted_at": None, "revision": bundle["revision"] + 1})

    def purge(self, bundle_id, unreadable=False, expected_revision=None):
        """Delete a bundle in the trash for good; the files it used stay until a
        cleanup. `expected_revision` is the one the user saw: a bundle restored or
        changed since then is kept. A file this version cannot fully read is
        deleted only when asked for explicitly (`unreadable`); one it can still
        read (read-only) must be in the trash as well."""
        with self._lock:
            loaded = self._load(bundle_id)
            if loaded is None:
                raise _not_found(bundle_id)
            if loaded.readable:
                self._check_trashed(loaded, expected_revision)
                if not loaded.writable and not unreadable:
                    raise LibraryError(409, "unreadable_file",
                                       f"Bundle '{loaded.bundle['name']}' {loaded.problem}; delete it for good only "
                                       "if you are sure.")
            elif not unreadable:
                raise LibraryError(409, "unreadable_file",
                                   f"This version cannot fully read {bundle_id}.json ({loaded.problem}); "
                                   "delete it for good only if you are sure.")
            self._path(bundle_id).unlink()
            self._cache.pop(f"{bundle_id}.json", None)
            self._forget([bundle_id])

    @staticmethod
    def _check_trashed(loaded, expected_revision):
        bundle = loaded.bundle
        if not loaded.deleted:
            raise LibraryError(409, "not_in_trash", f"Bundle '{bundle['name']}' is not in the trash.")
        if expected_revision is not None and bundle["revision"] != expected_revision:
            raise LibraryError(409, "revision_conflict",
                               f"Bundle '{bundle['name']}' changed since the trash was shown "
                               f"(now revision {bundle['revision']}).", current_revision=bundle["revision"])

    def empty_trash(self, expected_revisions):
        """Delete for good the bundles the user saw in the trash (id -> the
        revision shown), those still there at that revision: {"deleted",
        "results"}, a result per bundle as in a batch. Bundles put in the trash
        since are not touched, nor are files this version cannot fully read."""
        if not isinstance(expected_revisions, dict):
            raise invalid("expected_revisions must map each bundle id shown in the trash to its revision.")
        for bundle_id, revision in expected_revisions.items():
            check_bundle_id(bundle_id)
            if isinstance(revision, bool) or not isinstance(revision, int):
                raise invalid(f"expected_revisions: the revision of {bundle_id} must be an integer.")
        results = []
        with self._lock:
            for bundle_id, revision in expected_revisions.items():
                try:
                    loaded = self._load(bundle_id)
                    if loaded is None:
                        raise _not_found(bundle_id)
                    if not loaded.writable:  # whether it is in the trash, or what it holds, is not fully known
                        raise LibraryError(409, "unreadable_file",
                                           f"This version cannot fully read {bundle_id}.json; it is left alone.")
                    self._check_trashed(loaded, revision)
                    self._path(bundle_id).unlink()
                    self._cache.pop(f"{bundle_id}.json", None)
                    results.append({"id": bundle_id, "ok": True, "changed": True})
                except LibraryError as e:
                    results.append(_failure(bundle_id, e))
                except OSError as e:
                    results.append(_io_failure(bundle_id, e))
            self._forget([r["id"] for r in results if r["ok"]])
        return {"deleted": sum(1 for r in results if r["ok"]), "results": results}

    # -- categories and favorites (organization.json) ----------------------------

    def _organization(self):
        """organization.json as it is now, read again only when the file changed."""
        try:
            stat = self.organization_path.stat()
        except FileNotFoundError:
            self._organization_cache = None
            return organization.empty()
        key = _stat_key(stat)
        if self._organization_cache is None or self._organization_cache[0] != key:
            org = organization.read_file(self.organization_path)
            if org.io_error:
                return org  # not remembered: the next request reads it again
            self._organization_cache = (key, org)
        return self._organization_cache[1]

    @staticmethod
    def _categories_of(org):
        """The categories to show, by name: none from a file this version cannot read."""
        if not org.readable:
            return []
        return sorted(org.categories, key=lambda c: (name_key(c["name"]), c["id"]))

    @staticmethod
    def _category_of(org, bundle_id):
        return org.category_of(bundle_id) if org.readable else None

    def _organized(self, summary, org):
        return {**summary, "category": self._category_of(org, summary["id"]),
                "favorite": org.readable and summary["id"] in org.favorites}

    def _existing_ids(self):
        """The ids of every bundle file there is: in use, in the trash, unreadable,
        or still in the old trash folder. Their places and stars are kept."""
        ids = {entry.name[:-5] for entry in os.scandir(self.bundle_dir) if entry.name.endswith(".json")}
        ids |= {m.group(1) for p in self._legacy_trash_files() if (m := TRASH_ID_RE.match(p.stem))}
        return ids

    def _organization_unwritable(self, org):
        return LibraryError(409, "organization_unwritable",
                            f"organization.json {org.problem}; this version does not change categories or "
                            "favorites.", state=org.state)

    def _change_organization(self, change):
        """Apply `change(org)` to a copy of the organization and save it, dropping
        places and stars of bundles that are gone and places in categories that
        are gone. Returns what `change` returns."""
        current = self._organization()
        if not current.writable:
            raise self._organization_unwritable(current)
        org = organization.Organization(schema.OK, None, current.revision, current.categories, current.placement,
                                        current.favorites)
        result = change(org)
        existing = self._existing_ids()
        known = {c["id"] for c in org.categories}
        org.placement = {b: c for b, c in sorted(org.placement.items()) if b in existing and c in known}
        org.favorites = [b for b in dict.fromkeys(org.favorites) if b in existing]
        org.revision += 1
        self._synced = _write_json(self.organization_path, org.as_file(), self.tmp_dir)
        self._organization_cache = None
        return result

    def _forget(self, bundle_ids):
        """Drop the places and stars of bundles deleted for good. Entries that stay
        (an organization this version cannot write, or a write that failed) do no
        harm: they are ignored when read and dropped by the next write. So this
        never fails the delete itself."""
        org = self._organization()
        if org.writable and any(b in org.placement or b in org.favorites for b in bundle_ids):
            try:
                self._change_organization(lambda org: None)  # dropping what is gone is part of every save
            except OSError as e:
                logging.warning("[Bundle Library] organization.json not updated after a delete: %s", _reason(e))

    def categories(self):
        with self._lock:
            listing = self.list()
        return {"categories": listing["categories"], **listing["organization"]}

    def create_category(self, name, parent=None):
        if parent is not None:
            raise LibraryError(400, "nesting_not_supported", "Categories cannot be put in other categories yet.")

        def change(org):
            if len(org.categories) >= organization.MAX_CATEGORIES:
                raise invalid(f"A library has {organization.MAX_CATEGORIES} categories at most.")
            category = {"id": str(uuid.uuid4()), "name": organization.category_name(name, org), "parent": None}
            org.categories.append(category)
            return category

        with self._lock:
            return self._change_organization(change)

    def rename_category(self, category_id, name):
        _check_category_id(category_id)

        def change(org):
            category = org.category(category_id)
            if category is None:
                raise LibraryError(404, "not_found", f"Category not found: {category_id}")
            category["name"] = organization.category_name(name, org, own_id=category_id)
            return dict(category)

        with self._lock:
            return self._change_organization(change)

    def delete_category(self, category_id):
        """Delete a category; its bundles become uncategorized. How many there were."""
        _check_category_id(category_id)

        def change(org):
            if org.category(category_id) is None:
                raise LibraryError(404, "not_found", f"Category not found: {category_id}")
            org.categories = [c for c in org.categories if c["id"] != category_id]
            moved = [b for b, c in org.placement.items() if c == category_id]
            for bundle_id in moved:
                del org.placement[bundle_id]
            return len(moved)

        with self._lock:
            return self._change_organization(change)

    def set_category(self, bundle_id, category_id):
        """Put a bundle (in use or in the trash) in a category, or in none with
        None. The batch's code for one bundle: nothing is written when the bundle
        is there already."""
        check_bundle_id(bundle_id)
        if category_id is not None:
            _check_category_id(category_id)
        _single(self._place_bundles(category_id, [bundle_id]))
        return category_id

    def set_favorite(self, bundle_id, favorite):
        check_bundle_id(bundle_id)
        if not isinstance(favorite, bool):
            raise invalid("favorite must be true or false.")
        _single(self._star_bundles(favorite, [bundle_id]))
        return favorite

    def _place_bundles(self, category, ids):
        return self._batch_organize(ids, lambda org, bundle_id: org.category_of(bundle_id) == category,
                                    lambda org, bundle_id: _place(org, bundle_id, category), category=category)

    def _star_bundles(self, favorite, ids):
        return self._batch_organize(ids, lambda org, bundle_id: (bundle_id in org.favorites) == favorite,
                                    lambda org, bundle_id: _star(org, bundle_id, favorite))

    # -- one action on many bundles --------------------------------------------

    def batch(self, data):
        """Apply one action to many bundles: {"action", "results", "changed",
        "unchanged", "failed"}, with a result per bundle in the order asked
        ({"id", "ok", "changed"} and "revision" for a bundle file written, or
        "code" and "message" for a failure; "retry" when trying again may help).

        The request as a whole (action, ids, arguments, an organization this
        version cannot write) is checked before anything is written. Categories
        and favorites are written in one change of organization.json, and only
        if something changes. The trash is written bundle by bundle under the
        lock, each with its expected revision: a failure stops that bundle only.
        """
        if not isinstance(data, dict):
            raise invalid("A batch is a JSON object.")
        action = data.get("action")
        if action not in BATCH_ACTIONS:
            raise invalid(f"Unknown batch action: {action!r}.")
        ids = data.get("ids")
        if not isinstance(ids, list) or not ids:
            raise invalid("ids must be a non-empty list of bundle ids.")
        ids = list(dict.fromkeys(check_bundle_id(bundle_id) for bundle_id in ids))
        if len(ids) > MAX_BATCH:
            raise invalid(f"A batch takes {MAX_BATCH} bundles at most.")
        if action == "trash":
            results = self._batch_trash(ids, data.get("expected_revisions"))
        elif action in ("add_tags", "remove_tags"):
            given = data.get("tags")
            if not isinstance(given, list) or not given or len(given) > MAX_BATCH_TAGS:
                raise invalid(f"tags must be a list of 1 to {MAX_BATCH_TAGS} tags.")
            if action == "add_tags":  # a new tag follows the rules of saving
                new = [normalize_tag(tag) for tag in given]
                results = self._batch_tags(ids, lambda tags: tag_rules.added(tags, new))
            else:  # any tag a bundle has, also one saved under looser rules
                gone = [tag_name(tag) for tag in given]
                results = self._batch_tags(ids, lambda tags: tag_rules.removed(tags, gone))
        elif action == "set_category":
            if "category" not in data:  # null takes the bundles out of their categories; absent is a mistake
                raise invalid("category is required: a category id, or null for no category.")
            category = data["category"]
            if category is not None:
                _check_category_id(category)
            results = self._place_bundles(category, ids)
        else:
            favorite = data.get("favorite")
            if not isinstance(favorite, bool):
                raise invalid("favorite must be true or false.")
            results = self._star_bundles(favorite, ids)
        return {"action": action, "results": results,
                "changed": sum(1 for r in results if r["ok"] and r["changed"]),
                "unchanged": sum(1 for r in results if r["ok"] and not r["changed"]),
                "failed": sum(1 for r in results if not r["ok"])}

    def _batch_organize(self, ids, done, apply, category=None):
        """Categories or favorites of many bundles in one write of organization.json.
        `done(org, id)` says the bundle is as asked already; `apply(org, id)` makes it so."""
        with self._lock:
            org = self._organization()
            if not org.writable:
                raise self._organization_unwritable(org)
            if category is not None and org.category(category) is None:
                raise LibraryError(404, "not_found", f"Category not found: {category}")
            results = {}
            to_change = []
            for bundle_id in ids:
                if not self._exists(bundle_id):
                    results[bundle_id] = _failure(bundle_id, _not_found(bundle_id))
                elif done(org, bundle_id):
                    results[bundle_id] = {"id": bundle_id, "ok": True, "changed": False}
                else:
                    to_change.append(bundle_id)
            if to_change:
                try:
                    self._change_organization(lambda changing: [apply(changing, b) for b in to_change])
                except OSError as e:  # nothing was written: the old file is in place
                    for bundle_id in to_change:
                        results[bundle_id] = _io_failure(bundle_id, e, "organization.json could not be written")
                else:
                    for bundle_id in to_change:
                        results[bundle_id] = self._written({"id": bundle_id, "ok": True, "changed": True})
        return [results[bundle_id] for bundle_id in ids]

    def _batch_tags(self, ids, change):
        """Change the tags of each bundle in use as `change(tags)` says, bundle by
        bundle under the lock, as it is stored now (no revision is asked for: a
        tag change applies to the latest version). Only the tags change; nothing
        is written when they stay the same. A change may not bring a bundle over
        MAX_TAGS tags, unless it had more already and does not add any."""
        results = []
        with self._lock:
            for bundle_id in ids:
                try:
                    current = self._in_use(self._writable(bundle_id))
                    tags = change(current["tags"])
                    if tags == current["tags"]:
                        results.append({"id": bundle_id, "ok": True, "changed": False})
                        continue
                    if len(tags) > MAX_TAGS and len(tags) > len(current["tags"]):
                        raise LibraryError(409, "too_many_tags",
                                           f"Bundle '{current['name']}' would have {len(tags)} tags; a bundle has "
                                           f"{MAX_TAGS} at most.")
                    saved = self._save({**current, "tags": tags, "revision": current["revision"] + 1,
                                        "updated_at": _now()})
                    results.append(self._written({"id": bundle_id, "ok": True, "changed": True,
                                                  "revision": saved["revision"]}))
                except LibraryError as e:
                    results.append(_failure(bundle_id, e))
                except OSError as e:
                    results.append(_io_failure(bundle_id, e))
        return results

    def _batch_trash(self, ids, expected_revisions):
        if not isinstance(expected_revisions, dict):
            raise invalid("expected_revisions must map each bundle id to the revision it was seen at.")
        for bundle_id in ids:
            revision = expected_revisions.get(bundle_id)
            if isinstance(revision, bool) or not isinstance(revision, int):
                raise invalid(f"expected_revisions has no revision for {bundle_id}.")
        results = []
        with self._lock:
            for bundle_id in ids:
                try:
                    results.append(self._trash_one(bundle_id, expected_revisions[bundle_id]))
                except LibraryError as e:
                    results.append(_failure(bundle_id, e))
                except OSError as e:
                    results.append(_io_failure(bundle_id, e))
        return results

    # -- exports (exchange.py) ---------------------------------------------------

    def files_for_export(self, ids):
        """Each bundle of `ids` as its file is stored now, for an export: (id,
        the file's bytes, how this version reads them (schema.Loaded), the name
        of its category or None); bytes and the rest are None when there is no
        such file. Read under the lock, so a bundle being saved is read either
        before or after the save."""
        with self._lock:
            org = self._organization()
            names = {c["id"]: c["name"] for c in self._categories_of(org)}
            found = []
            for bundle_id in ids:
                if not self._exists(bundle_id):
                    found.append((bundle_id, None, None, None))
                    continue
                path = self._path(bundle_id)
                try:
                    data = path.read_bytes()
                except OSError as e:
                    found.append((bundle_id, b"", schema.Loaded(schema.CORRUPT, problem=f"could not be read ({_reason(e)})",
                                                               io_error=True), None))
                    continue
                found.append((bundle_id, data, schema.read_checked(data, bundle_id, path.name),
                              names.get(self._category_of(org, bundle_id))))
        return found

    def import_bundles(self, items, conflict, place):
        """Write the bundles of an import (exchange.py), under the lock: `items`
        are (id, the file's bytes, schema.Loaded) of bundles this version may
        write. A bundle new here goes byte for byte. One whose id is here
        already is skipped, overwritten (its id, its revision + 1, back from
        the trash if it was there) or copied under a new id, as `conflict`
        says. Then `place` ({"mode": "zip" | "one" | "none", "id"?} and the
        category name each bundle had, by id) puts them in categories, in one
        change of organization.json. A result per bundle: {"id" (here), "source",
        "ok", "as": "new" | "overwritten" | "copied" | "skipped", ...}, and
        {"categories_created": [{"id", "name"}], "placement_error"?}."""
        results = []
        with self._lock:
            for source, data, loaded in items:
                try:
                    results.append(self._import_one(source, data, loaded, conflict))
                except LibraryError as e:
                    results.append({**_failure(source, e), "source": source})
                except OSError as e:
                    results.append({**_io_failure(source, e), "source": source})
            placed = [r for r in results if r["ok"] and r["as"] != "skipped"]
            extra = {"categories_created": []}
            if placed:
                try:
                    extra["categories_created"] = self._change_organization(
                        lambda org: _place_imported(org, placed, place))
                except LibraryError as e:
                    extra["placement_error"] = e.message
                except OSError as e:
                    extra["placement_error"] = f"organization.json could not be written: {_reason(e)}"
        return results, extra

    def _import_one(self, source, data, loaded, conflict):
        existing = self._load(source)
        if existing is None:
            if loaded.bundle["deleted_at"] is None:  # as exported: the file goes as it is
                path = self._path(source)
                self._synced = _write_file(path, data, self.tmp_dir)
                self._remember(path.name, path.stat(), schema.read_file(path, source))
            else:
                self._save({**loaded.bundle, "deleted_at": None})
            return self._written({"id": source, "source": source, "ok": True, "changed": True, "as": "new"})
        if conflict == "skip":
            return {"id": source, "source": source, "ok": True, "changed": False, "as": "skipped"}
        if conflict == "overwrite":
            current = self._writable(source)  # one this version cannot change stays as it is
            saved = self._save({**loaded.bundle, "id": source, "revision": current["revision"] + 1,
                                "created_at": current["created_at"], "updated_at": _now(), "deleted_at": None})
            return self._written({"id": source, "source": source, "ok": True, "changed": True, "as": "overwritten",
                                  "revision": saved["revision"], "restored": current["deleted_at"] is not None})
        now = _now()
        copy = self._save({**loaded.bundle, "id": str(uuid.uuid4()), "revision": 1, "created_at": now, "updated_at": now,
                           "deleted_at": None})
        return self._written({"id": copy["id"], "source": source, "ok": True, "changed": True, "as": "copied"})

    # -- tags across the library -------------------------------------------------

    def tags(self):
        """Every tag of the bundle files this version can read, in use and in the
        trash: {"tags": [{"name", "spellings", "active", "trash", "protected"}],
        "unreadable", "legacy"}. A tag is one entry whatever its case; `name` is
        the spelling most bundles use. `protected` counts the bundles with the
        tag this version cannot change (a rename or delete leaves them alone);
        `unreadable` the bundle files it cannot read, which may have any tag, and
        `legacy` the files left in the old trash folder, which it does not change."""
        with self._lock:
            self._scan()
            files = self._files()
            legacy = len(self._legacy_trash_files())
        found = {}
        unreadable = 0
        for _, loaded in files:
            if not loaded.readable:
                unreadable += 1
                continue
            for tag in loaded.bundle["tags"]:
                entry = found.setdefault(tag_rules.key(tag), {"spellings": Counter(), "active": 0, "trash": 0,
                                                              "protected": 0})
                entry["spellings"][tag] += 1
                entry["trash" if loaded.deleted else "active"] += 1
                if not loaded.writable:
                    entry["protected"] += 1
        tags = [{"name": entry["spellings"].most_common(1)[0][0], "spellings": sorted(entry["spellings"]),
                 "active": entry["active"], "trash": entry["trash"], "protected": entry["protected"]}
                for _, entry in sorted(found.items())]
        return {"tags": tags, "unreadable": unreadable, "legacy": legacy}

    def rename_tag(self, old, new):
        """Call the tag `old` `new` in every bundle that has it, in use and in the
        trash. A bundle that has both keeps one `new`, where the first of them
        was (merged). The result is as in delete_tag(), with "merged"."""
        old, new = tag_name(old), normalize_tag(new)
        if old == new:
            raise invalid("The new name is the same as the old one.")
        merges = tag_rules.key(new) != tag_rules.key(old)
        return self._retag_all(old, lambda tags: tag_rules.renamed(tags, old, new),
                               merged=lambda tags: merges and tag_rules.has(tags, new))

    def delete_tag(self, tag):
        """Take the tag off every bundle that has it, in use and in the trash:
        {"changed", "excluded", "unknown", "legacy", "warning"?}. `excluded`
        lists the bundles with the tag left as they are ({"id", "name", "code",
        "reason", "retry"?}: this version cannot change them, or writing failed),
        `unknown` the files it cannot read ({"file", "reason"}: whether they
        have the tag is not known), `legacy` the files of the old trash folder."""
        tag = tag_name(tag)
        return self._retag_all(tag, lambda tags: tag_rules.removed(tags, [tag]))

    def _retag_all(self, tag, change, merged=None):
        """Apply `change` to the tags of every bundle file that has `tag`, under
        the lock, each written on its own: a failure stops that bundle only."""
        changed, merged_count, excluded, unknown = 0, 0, [], []
        unsynced = False
        with self._lock:
            self._scan()
            for name, loaded in self._files():
                if not loaded.readable:
                    unknown.append({"file": f"bundles/{name}", "reason": loaded.problem})
                    continue
                bundle = loaded.bundle
                if not tag_rules.has(bundle["tags"], tag):
                    continue
                if not loaded.writable:
                    excluded.append({"id": bundle["id"], "name": bundle["name"], "code": loaded.state,
                                     "reason": loaded.problem})
                    continue
                tags = change(bundle["tags"])
                if tags == bundle["tags"]:
                    continue  # a change of case done already
                try:
                    self._save({**bundle, "tags": tags, "revision": bundle["revision"] + 1, "updated_at": _now()})
                except OSError as e:
                    excluded.append({"id": bundle["id"], "name": bundle["name"], "code": "io_error",
                                     "reason": f"The bundle file could not be written: {_reason(e)}", "retry": True})
                    continue
                unsynced = unsynced or not self._synced
                changed += 1
                if merged and merged(bundle["tags"]):
                    merged_count += 1
            legacy = len(self._legacy_trash_files())
        result = {"changed": changed, "excluded": excluded, "unknown": unknown, "legacy": legacy}
        if merged:
            result["merged"] = merged_count
        if unsynced:
            result["warning"] = UNSYNCED
        return result

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


def _failure(bundle_id, error):
    """A bundle's result in a batch for a refusal (LibraryError), with its details (current_revision...)."""
    return {"id": bundle_id, "ok": False, "changed": False, "code": error.code, "message": error.message,
            **error.details}


def _io_failure(bundle_id, error, what="The bundle file could not be written"):
    """A bundle's result for a failed write: nothing was written, and trying again may work."""
    return {"id": bundle_id, "ok": False, "changed": False, "code": "io_error",
            "message": f"{what}: {_reason(error)}", "retry": True}


# The HTTP status of a failure a single-bundle command reports from a batch result.
_STATUS = {"not_found": 404, "io_error": 500}


def _single(results):
    """The result of a command on one bundle; a failure is raised as LibraryError."""
    [result] = results
    if not result["ok"]:
        details = {k: v for k, v in result.items() if k not in ("id", "ok", "changed", "code", "message")}
        raise LibraryError(_STATUS.get(result["code"], 409), result["code"], result["message"], **details)
    return result


def _place(org, bundle_id, category):
    if category is None:
        org.placement.pop(bundle_id, None)
    else:
        org.placement[bundle_id] = category


def _place_imported(org, results, place):
    """Put imported bundles in categories (`place`, see import_bundles); the categories made, as {"id", "name"}."""
    created = []
    by_name = {c["name"].casefold(): c["id"] for c in org.categories}
    for result in results:
        if place["mode"] == "one":
            category = place["id"]
        elif place["mode"] == "zip" and place["names"].get(result["source"]):
            name = place["names"][result["source"]]
            category = by_name.get(name.casefold())
            if category is None:
                try:
                    checked = organization.category_name(name, org)
                except LibraryError:
                    checked = None  # not a name this library takes: the bundle stays uncategorized
                if checked is not None and len(org.categories) < organization.MAX_CATEGORIES:
                    category = str(uuid.uuid4())
                    org.categories.append({"id": category, "name": checked, "parent": None})
                    by_name[checked.casefold()] = category
                    created.append({"id": category, "name": checked})
        else:
            category = None
        _place(org, result["id"], category)
    return created


def _star(org, bundle_id, favorite):
    org.favorites = [b for b in org.favorites if b != bundle_id] + ([bundle_id] if favorite else [])


def _check_category_id(value):
    if not isinstance(value, str) or not UUID_RE.match(value):
        raise LibraryError(400, "invalid_id", f"Invalid category id: {value!r}")
    return value


def _is_id(text):
    try:
        check_bundle_id(text)
        return True
    except LibraryError:
        return False


def _search_text(bundle, category_name=None):
    parts = [bundle["name"], *bundle["tags"], category_name or ""]
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
