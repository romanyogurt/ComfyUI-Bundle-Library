"""Bundles to and from a ZIP file (Phase 8), apart from the store.

An export holds each bundle file as it is stored, byte for byte: not the
content as this version reads it (schema.Loaded.bundle) nor as the API shows
it (store.present). So it carries what this version would not keep, such as
values outside rules tightened since, or data of a newer version. Beside the
bundles go the originals of the files they use, and a manifest:

    manifest.json
    bundles/<UUID>.json
    assets/<SHA-256>.<ext>

The manifest names the format and its version, when and by what the export
was made, each bundle (its id, name, file, the SHA-256 of that file's bytes
and the name of its category) and each file (SHA-256, file, kind, bytes).
Categories go by name, since their ids belong to a library; stars stay.

An export waits in the library's temporary folder for an hour, under a token
the page gets back, and is downloaded from there.
"""

import hashlib
import json
import os
import re
import secrets
import time
import unicodedata
import zipfile
import zlib
from datetime import datetime, timezone
from pathlib import Path

from . import schema
from .constants import VERSION
from .model import LibraryError, check_bundle_id, invalid

FORMAT = "comfyui-bundle-library/export"
FORMAT_VERSION = 1
MAX_EXPORT = 1000  # bundles in one export
EXPORT_TTL = 3600  # seconds an export can be downloaded
TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{22}$")  # secrets.token_urlsafe(16)


def _utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def file_name(names, now=None):
    """The name an export is downloaded under: the bundle's name for one, else the library and the time."""
    if len(names) == 1:
        # Letters, digits and a few marks every file system takes; never < > : " / \ | ? *
        safe = "".join(c if unicodedata.category(c)[0] in "LN" or c in " -_.()[]" else "_" for c in names[0]).strip(" .")
        if safe:
            return f"{safe[:80]}.zip"
    stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime(now))
    return f"bundle-library-{stamp}.zip"


class Exports:
    """The exports waiting to be downloaded, in `<library>/tmp/exports/`."""

    def __init__(self, tmp_dir):
        self.folder = Path(tmp_dir) / "exports"

    def path(self, token):
        """The export of `token`, if it is still there."""
        self.forget_old()
        if not isinstance(token, str) or not TOKEN_RE.match(token):
            raise LibraryError(404, "not_found", "No such export.")
        path = self.folder / f"{token}.zip"
        if not path.is_file():
            raise LibraryError(404, "not_found", "No such export; it may have expired. Export again.")
        return path

    def forget_old(self, now=None):
        """Delete the exports older than EXPORT_TTL, and what failed ones left."""
        if not self.folder.is_dir():
            return
        now = time.time() if now is None else now
        for entry in os.scandir(self.folder):
            try:
                if now - entry.stat().st_mtime > EXPORT_TTL:
                    os.remove(entry.path)
            except OSError:
                pass  # gone already, or in use: the next round takes it

    def create(self, store, ids):
        """Write an export of the bundles `ids` (those in use). The answer:
        {"token", "file_name", "bytes", "bundles", "assets", "skipped",
        "missing"}: `skipped` lists the ids left out ({"id", "code", "reason"}),
        `missing` the files bundles point at that the library does not have
        ({"sha256", "bundles"}: the bundles go, without those files)."""
        if not isinstance(ids, list) or not ids:
            raise invalid("ids must be a non-empty list of bundle ids.")
        ids = list(dict.fromkeys(check_bundle_id(bundle_id) for bundle_id in ids))
        if len(ids) > MAX_EXPORT:
            raise invalid(f"An export takes {MAX_EXPORT} bundles at most.")
        self.forget_old()
        bundles, skipped = [], []
        for bundle_id, data, loaded, category in store.files_for_export(ids):
            reason = (("not_found", "No longer in the library.") if data is None
                      else ("read_error" if loaded.io_error else loaded.state, loaded.problem) if not loaded.readable
                      else ("in_trash", "In the trash.") if loaded.deleted else None)
            if reason:
                skipped.append({"id": bundle_id, "code": reason[0], "reason": reason[1]})
            else:
                bundles.append((bundle_id, data, loaded, category))
        if not bundles:
            raise LibraryError(409, "nothing_to_export", "None of these bundles can be exported.", skipped=skipped)
        assets, missing = {}, {}
        for _, _, loaded, _ in bundles:
            for sha in sorted(loaded.refs or ()):
                if sha in assets:
                    continue
                if sha in missing or (path := store.assets.path(sha)) is None:
                    missing.setdefault(sha, []).append(loaded.bundle["name"])
                else:
                    assets[sha] = path
        manifest = {
            "format": FORMAT, "version": FORMAT_VERSION, "exported_at": _utc_now(), "generator": f"Bundle Library {VERSION}",
            "bundles": [{"id": bundle_id, "name": loaded.bundle["name"], "file": f"bundles/{bundle_id}.json",
                         "sha256": hashlib.sha256(data).hexdigest(), "category": category}
                        for bundle_id, data, loaded, category in bundles],
            "assets": [{"sha256": sha, "file": f"assets/{path.name}", "kind": store.assets.kind(sha),
                        "bytes": path.stat().st_size} for sha, path in assets.items()],
        }
        token = secrets.token_urlsafe(16)
        self.folder.mkdir(parents=True, exist_ok=True)
        part = self.folder / f"{token}.part"
        try:
            # The bundles were read under the store's lock; the files they use are
            # named by their content, so they cannot change while the ZIP is written.
            with zipfile.ZipFile(part, "w", allowZip64=True) as zf:
                zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=1),
                            compress_type=zipfile.ZIP_DEFLATED)
                for bundle_id, data, _, _ in bundles:
                    zf.writestr(f"bundles/{bundle_id}.json", data, compress_type=zipfile.ZIP_DEFLATED)
                for path in assets.values():
                    zf.write(path, f"assets/{path.name}", compress_type=zipfile.ZIP_STORED)  # compressed already
            path = self.folder / f"{token}.zip"
            os.replace(part, path)
        except BaseException:
            part.unlink(missing_ok=True)
            raise
        return {"token": token, "file_name": file_name([b[2].bundle["name"] for b in bundles]),
                "bytes": path.stat().st_size, "bundles": len(bundles), "assets": len(assets), "skipped": skipped,
                "missing": [{"sha256": sha, "bundles": names} for sha, names in missing.items()]}


# -- imports (Phase 8b) ---------------------------------------------------------

MAX_IMPORT_BYTES = 4 * 1024 ** 3  # the ZIP uploaded
MAX_UNPACKED = 8 * 1024 ** 3  # what its entries hold, counted as they are read
MAX_ENTRIES = 10000
MAX_BUNDLE_FILE = 40 * 1024 ** 2
MAX_MANIFEST = 16 * 1024 ** 2
CONFLICTS = ("skip", "overwrite", "copy")
CATEGORY_MODES = ("zip", "one", "none")
SHA_RE = re.compile(r"^[0-9a-f]{64}$")


def _bad(message):
    return LibraryError(400, "invalid_export", f"This is not an export this version can read: {message}")


class ExportFile:
    """An export ZIP opened for an import, with its manifest checked. Entries
    are read only under the names the manifest gives, and their bytes are
    counted as they come (what the ZIP declares is not trusted)."""

    def __init__(self, path):
        try:
            self.zip = zipfile.ZipFile(path)
        except (zipfile.BadZipFile, OSError) as e:
            raise _bad(f"not a ZIP file ({e})") from None
        infos = self.zip.infolist()
        if len(infos) > MAX_ENTRIES:
            raise _bad(f"more than {MAX_ENTRIES} entries")
        if any(info.flag_bits & 0x1 for info in infos):
            raise _bad("it is encrypted")
        self.entries = {info.filename: info for info in infos}
        self.unpacked = 0
        self.manifest = self._manifest()

    def close(self):
        self.zip.close()

    def read(self, name, limit):
        """The bytes of entry `name`, at most `limit` of them."""
        try:
            with self.zip.open(self.entries[name]) as f:
                data = f.read(limit + 1)
        except (zipfile.BadZipFile, zlib.error, EOFError, NotImplementedError) as e:
            raise _bad(f"{name} cannot be unpacked ({e})") from None
        if len(data) > limit:
            raise _bad(f"{name} is larger than {limit // (1024 * 1024)} MB")
        self._count(len(data))
        return data

    def extract(self, name, temp, limit):
        """Copy entry `name` to `temp`, at most `limit` bytes; the SHA-256 of what was copied."""
        digest, total = hashlib.sha256(), 0
        try:
            with self.zip.open(self.entries[name]) as source, open(temp, "wb") as target:
                while chunk := source.read(1024 * 1024):
                    total += len(chunk)
                    if total > limit:
                        raise LibraryError(413, "too_large", f"{name} is larger than this kind of file may be.")
                    self._count(len(chunk))
                    digest.update(chunk)
                    target.write(chunk)
        except (zipfile.BadZipFile, zlib.error, EOFError, NotImplementedError) as e:
            raise _bad(f"{name} cannot be unpacked ({e})") from None
        return digest.hexdigest()

    def _count(self, size):
        self.unpacked += size
        if self.unpacked > MAX_UNPACKED:
            raise _bad(f"it unpacks to more than {MAX_UNPACKED // 1024 ** 3} GB")

    def _manifest(self):
        if "manifest.json" not in self.entries:
            raise _bad("there is no manifest.json")
        try:
            data = json.loads(self.read("manifest.json", MAX_MANIFEST))
        except (ValueError, RecursionError):
            raise _bad("manifest.json is not valid JSON") from None
        if not isinstance(data, dict) or data.get("format") != FORMAT:
            raise _bad("manifest.json does not name the Bundle Library export format")
        version = data.get("version")
        if type(version) is not int:
            raise _bad("manifest.json has no version")
        if version > FORMAT_VERSION:
            raise LibraryError(400, "newer_export", f"This export was made by a newer Bundle Library (format version "
                                                    f"{version}); update the node pack to import it.")
        bundles, assets = data.get("bundles"), data.get("assets")
        if not isinstance(bundles, list) or not isinstance(assets, list) or len(bundles) > MAX_EXPORT:
            raise _bad(f"manifest.json must list up to {MAX_EXPORT} bundles and their files")
        seen = set()
        for entry in bundles:
            ok = (isinstance(entry, dict) and isinstance(entry.get("id"), str) and isinstance(entry.get("name"), str)
                  and isinstance(entry.get("sha256"), str) and SHA_RE.match(entry["sha256"])
                  and (entry.get("category") is None or isinstance(entry.get("category"), str)))
            if not ok:
                raise _bad("a bundle in manifest.json is not described as it should be")
            check_bundle_id(entry["id"])
            if entry.get("file") != f"bundles/{entry['id']}.json" or entry["id"] in seen:
                raise _bad(f"bundle {entry['id']} is not where manifest.json says, or listed twice")
            if entry["file"] not in self.entries:
                raise _bad(f"{entry['file']} is not in the ZIP")
            seen.add(entry["id"])
        from .assets import KINDS  # noqa: PLC0415 — the extensions and kinds the library stores
        shas = set()
        for entry in assets:
            ok = (isinstance(entry, dict) and isinstance(entry.get("sha256"), str) and SHA_RE.match(entry["sha256"])
                  and isinstance(entry.get("file"), str) and entry["sha256"] not in shas)
            ext = entry["file"].rsplit(".", 1)[-1] if ok else None
            if not ok or entry["file"] != f"assets/{entry['sha256']}.{ext}" or KINDS.get(ext) != entry.get("kind"):
                raise _bad("a file in manifest.json is not described as it should be")
            if entry["file"] not in self.entries:
                raise _bad(f"{entry['file']} is not in the ZIP")
            shas.add(entry["sha256"])
        declared = sum(self.entries[e["file"]].file_size for e in [*bundles, *assets])
        if declared > MAX_UNPACKED:
            raise _bad(f"it unpacks to more than {MAX_UNPACKED // 1024 ** 3} GB")
        return data


class Imports:
    """ZIPs uploaded to import, in `<library>/tmp/imports/`, until applied or an hour old."""

    def __init__(self, tmp_dir):
        self.folder = Path(tmp_dir) / "imports"

    def new_part(self):
        """A token and the path to receive its upload at (rename it to .zip once complete)."""
        self.forget_old()
        self.folder.mkdir(parents=True, exist_ok=True)
        token = secrets.token_urlsafe(16)
        return token, self.folder / f"{token}.part"

    def path(self, token):
        self.forget_old()
        if not isinstance(token, str) or not TOKEN_RE.match(token):
            raise LibraryError(404, "not_found", "No such import.")
        path = self.folder / f"{token}.zip"
        if not path.is_file():
            raise LibraryError(404, "not_found", "No such import; it may have expired. Upload the file again.")
        return path

    def discard(self, token):
        self.path(token).unlink(missing_ok=True)

    forget_old = Exports.forget_old

    def _plan(self, store, export):
        """What an import of `export` would do here: each bundle with how this
        version reads it and what is here already under its id."""
        listed = {a["sha256"]: a for a in export.manifest["assets"]}
        plan = []
        for entry in export.manifest["bundles"]:
            data = export.read(entry["file"], MAX_BUNDLE_FILE)
            loaded = schema.read_checked(data, entry["id"], entry["file"])
            reason = None
            if hashlib.sha256(data).hexdigest() != entry["sha256"]:
                reason = "The file is not what the manifest says (its SHA-256 differs)."
            elif not loaded.writable:
                reason = f"This version cannot import it: it {loaded.problem}." if loaded.readable else (
                    f"This version cannot read it: {loaded.problem}.")
            here = store.files_for_export([entry["id"]])[0]
            conflict = ("none" if here[1] is None else "unreadable" if not here[2].readable
                        else "trash" if here[2].deleted else "active")
            refs = sorted(loaded.refs or ()) if reason is None else []
            plan.append({"entry": entry, "data": data, "loaded": loaded, "reason": reason, "conflict": conflict,
                         "refs": refs, "missing": [s for s in refs if s not in listed and store.assets.path(s) is None]})
        return plan, listed

    def inspect(self, store, token, file_name=None):
        """The preview of an uploaded export: nothing in the library changes."""
        export = ExportFile(self.path(token))
        try:
            plan, listed = self._plan(store, export)
        finally:
            export.close()
        needed = {s for p in plan for s in p["refs"]}
        present = {s for s in needed if store.assets.path(s) is not None}
        new = {s for s in needed - present if s in listed}
        manifest = export.manifest
        return {
            "token": token, "file_name": file_name, "exported_at": manifest.get("exported_at"),
            "generator": manifest.get("generator"),
            "bundles": [{"id": p["entry"]["id"], "name": p["loaded"].bundle["name"] if p["loaded"].readable else p["entry"]["name"],
                         "category": p["entry"].get("category"), "importable": p["reason"] is None, "reason": p["reason"],
                         "conflict": p["conflict"], "missing_files": len(p["missing"]),
                         "tags": p["loaded"].bundle["tags"] if p["loaded"].readable else [],
                         "fields": len(p["loaded"].bundle["fields"]) if p["loaded"].readable else 0} for p in plan],
            "assets": {"new": len(new), "present": len(present), "missing": len(needed - present - new),
                       "bytes": sum(listed[s]["bytes"] for s in new)},
        }

    def apply(self, store, token, conflict, category):
        """Import the uploaded export: its files first (checked as uploads are),
        then the bundles that can come and whose files came, then their places."""
        if conflict not in CONFLICTS:
            raise invalid(f"conflict must be one of {', '.join(CONFLICTS)}.")
        if not isinstance(category, dict) or category.get("mode") not in CATEGORY_MODES:
            raise invalid(f"category must be {{\"mode\": {' | '.join(CATEGORY_MODES)}}}, with an id for \"one\".")
        if category["mode"] == "one":
            if not any(c["id"] == category.get("id") for c in store.categories()["categories"]):
                raise LibraryError(404, "not_found", f"Category not found: {category.get('id')}")
        path = self.path(token)
        export = ExportFile(path)
        try:
            plan, listed = self._plan(store, export)
            failed_files, stored, present = {}, 0, 0
            for sha in sorted({s for p in plan for s in p["refs"]}):
                if store.assets.path(sha) is not None:
                    present += 1
                    continue
                if sha not in listed:
                    continue  # missing from the export as well: the bundle comes, without it
                entry = listed[sha]
                temp = store.assets.temp_path()
                try:
                    got = export.extract(entry["file"], temp, store.assets.limits[entry["kind"]]["bytes"])
                    if got != sha:
                        raise LibraryError(400, "invalid_export", "the file is not what its name says (its SHA-256 differs)")
                    store.assets.finalize(temp, sha, None, entry["kind"])
                    stored += 1
                except LibraryError as e:
                    failed_files[sha] = e.message
                finally:
                    temp.unlink(missing_ok=True)
        finally:
            export.close()
        results, items = [], []
        for p in plan:
            source = p["entry"]["id"]
            broken = [failed_files[s] for s in p["refs"] if s in failed_files]
            if p["reason"] or broken:
                results.append({"id": source, "source": source, "ok": False, "changed": False,
                                "code": "not_importable" if p["reason"] else "file_failed",
                                "message": p["reason"] or f"A file it uses could not be imported: {broken[0]}"})
            else:
                items.append((source, p["data"], p["loaded"]))
        written, extra = store.import_bundles(items, conflict, {**category, "names": {
            p["entry"]["id"]: p["entry"].get("category") for p in plan}})
        by_source = {r["source"]: r for r in written}
        results += [by_source[i[0]] for i in items]
        order = [p["entry"]["id"] for p in plan]
        results.sort(key=lambda r: order.index(r["source"]))
        path.unlink(missing_ok=True)
        return {"results": results, **extra,
                "files": {"stored": stored, "present": present, "failed": [{"sha256": s, "reason": r} for s, r in failed_files.items()]},
                "imported": sum(1 for r in results if r["ok"] and r["as"] != "skipped"),
                "skipped": sum(1 for r in results if r["ok"] and r["as"] == "skipped"),
                "failed": sum(1 for r in results if not r["ok"])}
