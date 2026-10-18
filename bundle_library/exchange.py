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
import logging
import os
import re
import secrets
import threading
import time
import unicodedata
import zipfile
import zlib
from datetime import datetime, timezone
from pathlib import Path

from . import schema
from .assets import replace
from .constants import VERSION
from .model import LibraryError, check_bundle_id, invalid
from .store import UNSYNCED, kind_problem
from .text import Text, said

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
            raise LibraryError(404, "not_found", Text("exchange.no_such_export"))
        path = self.folder / f"{token}.zip"
        if not path.is_file():
            raise LibraryError(404, "not_found", Text("exchange.export_expired"))
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
            raise invalid(Text("common.ids_required"))
        ids = list(dict.fromkeys(check_bundle_id(bundle_id) for bundle_id in ids))
        if len(ids) > MAX_EXPORT:
            raise invalid(Text("exchange.export_max", MAX_EXPORT=MAX_EXPORT))
        self.forget_old()
        bundles, skipped = [], []
        for bundle_id, data, loaded, category in store.files_for_export(ids):
            reason = (("not_found", Text("exchange.gone")) if data is None
                      else ("read_error" if loaded.io_error else loaded.state, loaded.problem) if not loaded.readable
                      else ("in_trash", Text("exchange.in_trash")) if loaded.deleted else None)
            if reason:
                skipped.append({"id": bundle_id, "code": reason[0], "reason": reason[1]})
            else:
                bundles.append((bundle_id, data, loaded, category))
        if not bundles:
            raise LibraryError(409, "nothing_to_export", Text("exchange.nothing_exportable"), skipped=skipped)
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
            replace(part, path)
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


# The imports this process is applying now, by token (R22-02). The files of
# tmp/imports/ say the rest: .zip ready, .applying taken, .json done.
_APPLYING = set()
_APPLYING_LOCK = threading.Lock()


def _running():
    return LibraryError(409, "import_running", Text("exchange.import_running"))


def _check_token(token):
    if not isinstance(token, str) or not TOKEN_RE.match(token):
        raise LibraryError(404, "not_found", Text("exchange.no_such_import"))


def _check_choices(store, conflict, category):
    if conflict not in CONFLICTS:
        raise invalid(Text("exchange.conflict_choice", list=', '.join(CONFLICTS)))
    if not isinstance(category, dict) or category.get("mode") not in CATEGORY_MODES:
        raise invalid(Text("exchange.category_shape", shape='{"mode": ' + " | ".join(CATEGORY_MODES) + "}"))
    if category["mode"] == "one":
        if not any(c["id"] == category.get("id") for c in store.categories()["categories"]):
            raise LibraryError(404, "not_found", Text("category.not_found", id=category.get('id')))


def _keep(path, answer):
    """Write an import's answer for a request that asks again (not synced: it is only a convenience),
    with the ids of its messages, so that the page says it in its language again (R31-06)."""
    part = path.with_name(path.name + ".part")
    part.write_text(json.dumps(said(answer)), encoding="utf-8")
    replace(part, path)


def _bad(message):
    return LibraryError(400, "invalid_export", Text("exchange.not_readable_export", message=message))


class ExportFile:
    """An export ZIP opened for an import, with its manifest checked. Entries
    are read only under the names the manifest gives, and their bytes are
    counted as they come (what the ZIP declares is not trusted)."""

    def __init__(self, path):
        try:
            self.zip = zipfile.ZipFile(path)
        except (zipfile.BadZipFile, OSError) as e:
            raise _bad(Text("exchange.not_zip", e=e)) from None
        infos = self.zip.infolist()
        if len(infos) > MAX_ENTRIES:
            raise _bad(Text("exchange.zip_too_many_entries", MAX_ENTRIES=MAX_ENTRIES))
        if any(info.flag_bits & 0x1 for info in infos):
            raise _bad(Text("exchange.encrypted"))
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
            raise _bad(Text("exchange.cannot_unpack", name=name, e=e)) from None
        if len(data) > limit:
            raise _bad(Text("exchange.file_too_large_mb", name=name, n=limit // (1024 * 1024)))
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
                        raise LibraryError(413, "too_large", Text("exchange.file_too_large_kind", name=name))
                    self._count(len(chunk))
                    digest.update(chunk)
                    target.write(chunk)
        except (zipfile.BadZipFile, zlib.error, EOFError, NotImplementedError) as e:
            raise _bad(Text("exchange.cannot_unpack", name=name, e=e)) from None
        return digest.hexdigest()

    def _count(self, size):
        self.unpacked += size
        if self.unpacked > MAX_UNPACKED:
            raise _bad(Text("exchange.zip_too_large", n=MAX_UNPACKED // 1024 ** 3))

    def _manifest(self):
        if "manifest.json" not in self.entries:
            raise _bad(Text("exchange.manifest_missing"))
        try:
            data = json.loads(self.read("manifest.json", MAX_MANIFEST))
        except (ValueError, RecursionError):
            raise _bad(Text("exchange.manifest_not_json")) from None
        if not isinstance(data, dict) or data.get("format") != FORMAT:
            raise _bad(Text("exchange.manifest_not_format"))
        version = data.get("version")
        if type(version) is not int:
            raise _bad(Text("exchange.manifest_no_version"))
        if version > FORMAT_VERSION:
            raise LibraryError(400, "newer_export", Text("exchange.newer_format", version=version))
        bundles, assets = data.get("bundles"), data.get("assets")
        if not isinstance(bundles, list) or not isinstance(assets, list) or len(bundles) > MAX_EXPORT:
            raise _bad(Text("exchange.manifest_bundles_max", MAX_EXPORT=MAX_EXPORT))
        seen = set()
        for entry in bundles:
            ok = (isinstance(entry, dict) and isinstance(entry.get("id"), str) and isinstance(entry.get("name"), str)
                  and isinstance(entry.get("sha256"), str) and SHA_RE.match(entry["sha256"])
                  and (entry.get("category") is None or isinstance(entry.get("category"), str)))
            if not ok:
                raise _bad(Text("exchange.manifest_bad_bundle"))
            check_bundle_id(entry["id"])
            if entry.get("file") != f"bundles/{entry['id']}.json" or entry["id"] in seen:
                raise _bad(Text("exchange.manifest_bundle_misplaced", id=entry['id']))
            if entry["file"] not in self.entries:
                raise _bad(Text("exchange.missing_in_zip", file=entry['file']))
            seen.add(entry["id"])
        from .assets import KINDS  # noqa: PLC0415 — the extensions and kinds the library stores
        shas = set()
        for entry in assets:
            ok = (isinstance(entry, dict) and isinstance(entry.get("sha256"), str) and SHA_RE.match(entry["sha256"])
                  and isinstance(entry.get("file"), str) and entry["sha256"] not in shas)
            ext = entry["file"].rsplit(".", 1)[-1] if ok else None
            if not ok or entry["file"] != f"assets/{entry['sha256']}.{ext}" or KINDS.get(ext) != entry.get("kind"):
                raise _bad(Text("exchange.manifest_bad_file"))
            if entry["file"] not in self.entries:
                raise _bad(Text("exchange.missing_in_zip", file=entry['file']))
            shas.add(entry["sha256"])
        declared = sum(self.entries[e["file"]].file_size for e in [*bundles, *assets])
        if declared > MAX_UNPACKED:
            raise _bad(Text("exchange.zip_too_large", n=MAX_UNPACKED // 1024 ** 3))
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
        _check_token(token)
        path = self.folder / f"{token}.zip"
        if not path.is_file():
            raise LibraryError(404, "not_found", Text("exchange.import_expired_upload"))
        return path

    def discard(self, token):
        """Drop an upload, or the kept answer of an import that is done; not one that runs."""
        _check_token(token)
        with _APPLYING_LOCK:
            if token in _APPLYING:
                raise _running()
        found = False
        for suffix in (".zip", ".json", ".applying"):  # .applying: one cut off when the server stopped
            try:
                (self.folder / f"{token}{suffix}").unlink()
                found = True
            except FileNotFoundError:
                pass
        if not found:
            raise LibraryError(404, "not_found", Text("exchange.import_expired"))

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
                reason = Text("exchange.file_digest_manifest")
            elif not loaded.writable:
                reason = (Text("exchange.cannot_import", problem=loaded.problem) if loaded.readable
                          else Text("exchange.cannot_read", problem=loaded.problem))
            elif wrong := kind_problem(loaded.bundle["fields"],
                                       lambda s: store.assets.kind(s) or listed.get(s, {}).get("kind")):
                reason = wrong.message  # R22-01: readable, but a field points at a file of another kind
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
        """Import an uploaded export, once (R22-02). The first request takes it:
        its ZIP becomes <token>.applying. A request while it runs is refused
        (409 import_running); one after it is done gets the answer it gave,
        kept as <token>.json for an hour, without running again ("replayed"),
        whatever its choices are by then (R31-03: its category may be gone).
        Its files come first, then the bundles that can come and whose files
        came, then their places. A failure before any bundle is written leaves
        it ready to apply again; one cut off after that (the server stopped)
        is told so (409 import_interrupted)."""
        _check_token(token)
        self.forget_old()
        ready, taken = self.folder / f"{token}.zip", self.folder / f"{token}.applying"
        with _APPLYING_LOCK:
            if token in _APPLYING:
                raise _running()
            if not ready.exists():
                return self._after(token)
            _APPLYING.add(token)
        try:
            _check_choices(store, conflict, category)
            try:
                ready.rename(taken)  # atomic: one request takes it
            except FileNotFoundError:
                return self._after(token)
            os.utime(taken)  # its hour runs from now: forget_old() must not take it while it is read
            try:
                prepared = self._prepare(store, taken, conflict)
            except BaseException:
                try:
                    taken.rename(ready)  # only content-addressed files were written: it can be applied again
                except OSError:
                    pass  # gone meanwhile: the error below still says what happened
                raise
            answer = self._write(store, prepared, conflict, category)
            try:
                _keep(self.folder / f"{token}.json", answer)
            except OSError:
                logging.exception("[Bundle Library] could not keep the answer of import %s", token)
            taken.unlink(missing_ok=True)
            return answer
        finally:
            with _APPLYING_LOCK:
                _APPLYING.discard(token)

    def _after(self, token):
        """What became of an import that is not ready to apply: the answer it gave, or why there is none."""
        try:
            return {**json.loads((self.folder / f"{token}.json").read_text(encoding="utf-8")), "replayed": True}
        except (OSError, ValueError):
            pass
        if (self.folder / f"{token}.applying").exists():
            raise LibraryError(409, "import_interrupted", Text("exchange.import_interrupted"))
        raise LibraryError(404, "not_found", Text("exchange.import_expired_upload"))

    def _prepare(self, store, path, conflict):
        """The plan of an import, with the files of the bundles it will write
        brought in (R22-04: not those of bundles a skip leaves as they are),
        checked as uploads are. Writes nothing but content-addressed files."""
        export = ExportFile(path)
        try:
            plan, listed = self._plan(store, export)
            wanted = {s for p in plan if p["reason"] is None and (conflict != "skip" or p["conflict"] == "none")
                      for s in p["refs"]}
            failed, stored, present, unsynced = {}, 0, 0, set()
            for sha in sorted(wanted):
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
                        raise LibraryError(400, "invalid_export", Text("exchange.file_digest_name"))
                    _, _, synced = store.assets.finalize(temp, sha, None, entry["kind"])
                    stored += 1
                    if not synced:
                        unsynced.add(sha)
                except LibraryError as e:
                    failed[sha] = e.message
                finally:
                    temp.unlink(missing_ok=True)
        finally:
            export.close()
        return {"plan": plan, "failed": failed, "stored": stored, "present": present, "unsynced": unsynced}

    def _write(self, store, prepared, conflict, category):
        """Write the bundles of a prepared import, then their places; the answer."""
        plan, failed_files = prepared["plan"], prepared["failed"]
        results, items = [], []
        for p in plan:
            source = p["entry"]["id"]
            broken = [failed_files[s] for s in p["refs"] if s in failed_files]
            if p["reason"] or broken:
                results.append({"id": source, "source": source, "ok": False, "changed": False,
                                "code": "not_importable" if p["reason"] else "file_failed",
                                "message": p["reason"] or Text("exchange.file_not_imported",
                                                               reason=broken[0])})
            else:
                items.append((source, p["data"], p["loaded"], frozenset(p["missing"])))
        written, extra = store.import_bundles(items, conflict, {**category, "names": {
            p["entry"]["id"]: p["entry"].get("category") for p in plan}})
        by_source = {r["source"]: r for r in written}
        for p in plan:  # a bundle written with a file whose folder could not be synced says so (0.0.34)
            result = by_source.get(p["entry"]["id"])
            if result and result["ok"] and result["as"] != "skipped" and prepared["unsynced"] & set(p["refs"]):
                result.setdefault("warning", UNSYNCED)
        results += [by_source[i[0]] for i in items]
        order = [p["entry"]["id"] for p in plan]
        results.sort(key=lambda r: order.index(r["source"]))
        return {"results": results, **extra,
                "files": {"stored": prepared["stored"], "present": prepared["present"],
                          "failed": [{"sha256": s, "reason": r} for s, r in failed_files.items()]},
                "imported": sum(1 for r in results if r["ok"] and r["as"] != "skipped"),
                "skipped": sum(1 for r in results if r["ok"] and r["as"] == "skipped"),
                "failed": sum(1 for r in results if not r["ok"])}
