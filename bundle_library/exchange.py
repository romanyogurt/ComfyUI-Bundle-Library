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
from datetime import datetime, timezone
from pathlib import Path

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
