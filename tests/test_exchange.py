import hashlib
import json
import os
import tempfile
import threading
import time
import unittest
import uuid
import zipfile
from pathlib import Path
from unittest import mock

from bundle_library import exchange, schema
from bundle_library import store as store_module
from bundle_library.exchange import EXPORT_TTL, FORMAT, Exports, Imports, file_name
from bundle_library.model import LibraryError
from bundle_library.store import UNSYNCED, BundleStore
from bundle_library.text import said
from tests import helpers


class ExportTest(unittest.TestCase):
    """A ZIP of bundles (Phase 8a): their files as stored, the files they use, and a manifest."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.store = BundleStore(self.root)
        self.exports = Exports(self.store.tmp_dir)
        self.red = self.upload(helpers.png("red"), "red.png")
        self.blue = self.upload(helpers.png("blue"), "blue.png")
        self.unused = self.upload(helpers.png("green"), "green.png")

    def upload(self, data, name):
        temp = self.store.assets.temp_path()
        temp.write_bytes(data)
        return self.store.assets.finalize(temp, hashlib.sha256(data).hexdigest(), name)[0]["sha256"]

    def make(self, name, *shas, category=None):
        fields = [{"name": f"ref_{i}", "type": "image", "asset": {"sha256": sha}} for i, sha in enumerate(shas)]
        return self.store.create({"name": name, "tags": ["t"], "fields": fields or [
            {"name": "prompt", "type": "text", "value": name}]}, category)["id"]

    def path(self, bundle_id):
        return self.root / "bundles" / f"{bundle_id}.json"

    def rewrite(self, bundle_id, **changes):
        data = {**json.loads(self.path(bundle_id).read_text(encoding="utf-8")), **changes}
        self.path(bundle_id).write_text(json.dumps(data), encoding="utf-8")

    def export(self, ids):
        answer = self.exports.create(self.store, ids)
        archive = zipfile.ZipFile(self.exports.path(answer["token"]))
        self.addCleanup(archive.close)
        return answer, archive, json.loads(archive.read("manifest.json"))

    def test_bundle_files_go_as_stored_with_the_files_they_use(self):
        shelf = self.store.create_category("Shelf")["id"]
        a = self.make("A", self.red, self.blue, category=shelf)
        b = self.make("B", self.red)
        self.rewrite(b, fields=[{"name": "seed", "type": "int", "value": 2 ** 60},  # outside the rules now: a warning
                                {"name": "ref_0", "type": "image", "asset": {"sha256": self.red}}])
        answer, archive, manifest = self.export([a, b, a])
        self.assertEqual((answer["bundles"], answer["assets"], answer["skipped"], answer["missing"]), (2, 2, [], []))
        self.assertEqual((manifest["format"], manifest["version"]), (FORMAT, 1))
        self.assertTrue(manifest["generator"].startswith("Bundle Library "))
        for entry in manifest["bundles"]:
            stored = self.path(entry["id"]).read_bytes()
            self.assertEqual(archive.read(entry["file"]), stored, "byte for byte, not as this version reads it")
            self.assertEqual(entry["sha256"], hashlib.sha256(stored).hexdigest())
        self.assertEqual([(e["id"], e["name"], e["category"]) for e in manifest["bundles"]], [(a, "A", "Shelf"), (b, "B", None)])
        self.assertIn('"value": 1152921504606846976', archive.read(f"bundles/{b}.json").decode())
        files = {e["sha256"]: e for e in manifest["assets"]}
        self.assertEqual(set(files), {self.red, self.blue}, "each file once; one no bundle uses stays out")
        for sha, entry in files.items():
            stored = self.store.assets.path(sha)
            self.assertEqual((entry["file"], entry["kind"], entry["bytes"]), (f"assets/{stored.name}", "image", stored.stat().st_size))
            self.assertEqual(archive.read(entry["file"]), stored.read_bytes())
        self.assertEqual(sorted(archive.namelist()), sorted(["manifest.json", *[e["file"] for e in manifest["bundles"]],
                                                            *[e["file"] for e in manifest["assets"]]]))
        kinds = {info.filename: info.compress_type for info in archive.infolist()}
        self.assertEqual(kinds["manifest.json"], zipfile.ZIP_DEFLATED)
        self.assertEqual(kinds[f"bundles/{a}.json"], zipfile.ZIP_DEFLATED)
        self.assertEqual(kinds[files[self.red]["file"]], zipfile.ZIP_STORED, "media are compressed already")

    def test_what_cannot_go_is_left_out_with_the_reason(self):
        kept = self.make("Kept")
        locked = self.make("Locked", self.red)
        self.rewrite(locked, color="red")  # read-only here: it still goes, as stored
        trashed = self.make("Trashed")
        self.store.delete(trashed, 1)
        broken = str(uuid.uuid4())
        self.path(broken).write_text("{not json", encoding="utf-8")
        gone = str(uuid.uuid4())
        answer, archive, manifest = self.export([kept, locked, trashed, broken, gone])
        self.assertEqual([b["id"] for b in manifest["bundles"]], [kept, locked])
        self.assertIn('"color": "red"', archive.read(f"bundles/{locked}.json").decode())
        self.assertEqual([(s["id"], s["code"]) for s in answer["skipped"]],
                         [(trashed, "in_trash"), (broken, "corrupt"), (gone, "not_found")])

    def test_a_file_missing_from_the_library_is_reported_and_left_out(self):
        a = self.make("A", self.red)
        missing = "f" * 64
        self.rewrite(a, fields=[{"name": "ref_0", "type": "image", "asset": {"sha256": self.red}},
                                {"name": "ref_1", "type": "image", "asset": {"sha256": missing}}])
        answer, _, manifest = self.export([a])
        self.assertEqual([e["sha256"] for e in manifest["assets"]], [self.red])
        self.assertEqual(answer["missing"], [{"sha256": missing, "bundles": ["A"]}])

    def test_requests_that_export_nothing_are_refused(self):
        trashed = self.make("Trashed")
        self.store.delete(trashed, 1)
        for ids, code in [([], "invalid"), ("x", "invalid"), (["../x"], "invalid_id"), ([trashed], "nothing_to_export")]:
            with self.subTest(code), self.assertRaises(LibraryError) as ctx:
                self.exports.create(self.store, ids)
            self.assertEqual(ctx.exception.code, code)

    def test_an_export_is_found_by_its_token_until_it_expires(self):
        answer = self.exports.create(self.store, [self.make("A")])
        path = self.exports.path(answer["token"])
        for token in ["../x", "a" * 21, None, "a" * 22]:
            with self.subTest(token), self.assertRaises(LibraryError):
                self.exports.path(token)
        old = time.time() - EXPORT_TTL - 1
        os.utime(path, (old, old))
        with self.assertRaises(LibraryError):
            self.exports.path(answer["token"])
        self.assertFalse(path.exists(), "an expired export is deleted")

    def test_the_name_it_is_downloaded_under(self):
        self.assertEqual(file_name(["Red dress / v2"]), "Red dress _ v2.zip")
        self.assertEqual(file_name(["한글 번들"]), "한글 번들.zip")
        self.assertEqual(file_name(["[test] A (v2)"]), "[test] A (v2).zip")
        self.assertEqual(file_name(['a<b>:c"d|e?f*']), "a_b__c_d_e_f_.zip")
        self.assertEqual(file_name(["../"]), "_.zip")
        self.assertRegex(file_name(["a", "b"], now=0), r"^bundle-library-\d{8}-\d{6}\.zip$")
        self.assertRegex(file_name(["..."]), r"^bundle-library-")


if __name__ == "__main__":
    unittest.main()


class ImportTest(unittest.TestCase):
    """Importing an export ZIP (Phase 8b): a preview first, then the files, the bundles and their places."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.source = BundleStore(self.root / "a")
        self.target = BundleStore(self.root / "b")
        self.red = self.upload(self.source, helpers.png("red"), "red.png")

    def upload(self, store, data, name, kind="image"):
        temp = store.assets.temp_path()
        temp.write_bytes(data)
        return store.assets.finalize(temp, hashlib.sha256(data).hexdigest(), name, kind)[0]["sha256"]

    def make(self, store, name, *shas, category=None, tags=("t",)):
        fields = [{"name": f"ref_{i}", "type": "image", "asset": {"sha256": sha}} for i, sha in enumerate(shas)]
        return store.create({"name": name, "tags": list(tags), "fields": fields or [
            {"name": "prompt", "type": "text", "value": name}]}, category)["id"]

    def bundle_file(self, store, bundle_id):
        return store.bundle_dir / f"{bundle_id}.json"

    def export(self, store, ids):
        exports = Exports(store.tmp_dir)
        return exports.path(exports.create(store, ids)["token"])

    def receive(self, store, path):
        """Put a ZIP where an upload would land; its token."""
        imports = Imports(store.tmp_dir)
        token, part = imports.new_part()
        part.write_bytes(Path(path).read_bytes())
        part.replace(part.with_suffix(".zip"))
        return token

    def run_import(self, store, path, conflict="skip", category=None):
        imports = Imports(store.tmp_dir)
        token = self.receive(store, path)
        preview = imports.inspect(store, token)
        return preview, imports.apply(store, token, conflict, category or {"mode": "zip"})

    def rewrite_zip(self, path, change):
        """A copy of the export at `path` with entries changed: change(name, data) -> data, or None to drop it."""
        out = self.root / f"changed-{uuid.uuid4().hex}.zip"
        with zipfile.ZipFile(path) as source, zipfile.ZipFile(out, "w") as target:
            for info in source.infolist():
                data = change(info.filename, source.read(info))
                if data is not None:
                    target.writestr(info.filename, data)
        return out

    def test_an_export_comes_into_another_library_byte_for_byte(self):
        shelf = self.source.create_category("Shelf")["id"]
        a = self.make(self.source, "A", self.red, category=shelf)
        b = self.make(self.source, "B")
        self.source.set_favorite(a, True)
        self.target.create_category("shelf")  # the same name, another case: used, not made again
        preview, result = self.run_import(self.target, self.export(self.source, [a, b]))
        self.assertEqual([(p["id"], p["conflict"], p["importable"]) for p in preview["bundles"]],
                         [(a, "none", True), (b, "none", True)])
        self.assertEqual(preview["assets"], {"new": 1, "present": 0, "missing": 0, "bytes": preview["assets"]["bytes"]})
        self.assertEqual([(r["id"], r["as"]) for r in result["results"]], [(a, "new"), (b, "new")])
        for bundle_id in (a, b):
            self.assertEqual(self.bundle_file(self.target, bundle_id).read_bytes(),
                             self.bundle_file(self.source, bundle_id).read_bytes())
        self.assertIsNotNone(self.target.assets.path(self.red))
        listing = {x["id"]: x for x in self.target.list()["bundles"]}
        self.assertEqual(listing[a]["category"], self.target.categories()["categories"][0]["id"])
        self.assertEqual(result["categories_created"], [])
        self.assertFalse(listing[a]["favorite"], "stars stay where they were set")
        self.assertIsNone(listing[b]["category"])

    def test_a_field_turned_off_travels_off(self):
        a = self.source.create({"name": "Off", "tags": [], "fields": [
            {"name": "on", "type": "text", "value": "a"}, {"name": "off", "type": "text", "value": "b", "enabled": False}]})["id"]
        path = self.export(self.source, [a])
        _, result = self.run_import(self.target, path)
        self.assertEqual(self.bundle_file(self.target, a).read_bytes(), self.bundle_file(self.source, a).read_bytes())
        self.assertEqual(json.loads(self.bundle_file(self.target, a).read_text(encoding="utf-8"))["schema_version"], 3)
        _, copied = self.run_import(self.target, path, "copy")
        copy = self.target.get(copied["results"][0]["id"])
        self.assertEqual([f.get("enabled", True) for f in copy["fields"]], [True, False])

    def test_bundles_here_already_are_skipped_overwritten_or_copied(self):
        a, b = self.make(self.source, "A"), self.make(self.source, "B")
        path = self.export(self.source, [a, b])
        self.source.update(a, {"name": "A changed", "tags": [], "note": "", "fields": []}, 1)
        self.source.delete(b, 1)
        before = self.bundle_file(self.source, a).read_bytes()
        _, skipped = self.run_import(self.source, path, "skip")
        self.assertEqual([r["as"] for r in skipped["results"]], ["skipped", "skipped"])
        self.assertEqual(self.bundle_file(self.source, a).read_bytes(), before)
        preview, overwritten = self.run_import(self.source, path, "overwrite")
        self.assertEqual([p["conflict"] for p in preview["bundles"]], ["active", "trash"])
        self.assertEqual([(r["as"], r["revision"], r["restored"]) for r in overwritten["results"]],
                         [("overwritten", 3, False), ("overwritten", 3, True)])
        stored = self.source.get(a)
        self.assertEqual((stored["name"], stored["revision"]), ("A", 3))
        self.assertIsNone(self.source.get(b)["deleted_at"], "back from the trash")
        _, copied = self.run_import(self.source, path, "copy")
        ids = [r["id"] for r in copied["results"]]
        self.assertEqual([r["as"] for r in copied["results"]], ["copied", "copied"])
        self.assertTrue(set(ids).isdisjoint({a, b}))
        self.assertEqual(sorted(x["name"] for x in self.source.list()["bundles"]), ["A", "A", "B", "B"])

    def test_categories_follow_the_file_go_into_one_or_none(self):
        shelf = self.source.create_category("Shelf")["id"]
        a = self.make(self.source, "A", category=shelf)
        path = self.export(self.source, [a])
        _, result = self.run_import(self.target, path, category={"mode": "zip"})
        made = self.target.list()["categories"]
        self.assertEqual(result["categories_created"], [{"id": made[0]["id"], "name": "Shelf"}])
        self.assertEqual(self.target.list()["bundles"][0]["category"], made[0]["id"])
        box = self.target.create_category("Box")["id"]
        _, result = self.run_import(self.target, path, "overwrite", {"mode": "one", "id": box})
        self.assertEqual(self.target.list()["bundles"][0]["category"], box)
        _, result = self.run_import(self.target, path, "overwrite", {"mode": "none"})
        self.assertIsNone(self.target.list()["bundles"][0]["category"])
        token = self.receive(self.target, path)
        with self.assertRaises(LibraryError) as ctx:
            Imports(self.target.tmp_dir).apply(self.target, token, "skip", {"mode": "one", "id": str(uuid.uuid4())})
        self.assertEqual(ctx.exception.code, "not_found")

    def test_what_this_version_cannot_write_is_left_out_with_the_reason(self):
        a, locked = self.make(self.source, "A"), self.make(self.source, "Locked")
        data = json.loads(self.bundle_file(self.source, locked).read_text(encoding="utf-8"))
        self.bundle_file(self.source, locked).write_text(json.dumps({**data, "color": "red"}), encoding="utf-8")
        preview, result = self.run_import(self.target, self.export(self.source, [a, locked]))
        self.assertEqual([(p["importable"], p["reason"] is None) for p in preview["bundles"]], [(True, True), (False, False)])
        self.assertIn("cannot import it", preview["bundles"][1]["reason"])
        self.assertEqual([(r["ok"], r.get("code")) for r in result["results"]], [(True, None), (False, "not_importable")])
        self.assertFalse(self.bundle_file(self.target, locked).exists())

    def test_a_bundle_or_file_not_as_the_manifest_says_stays_out(self):
        a = self.make(self.source, "A", self.red)
        b = self.make(self.source, "B")
        path = self.export(self.source, [a, b])
        tampered = self.rewrite_zip(path, lambda name, data: data.replace(b'"B"', b'"C"') if name == f"bundles/{b}.json"
                                    else helpers.png("blue") if name.startswith("assets/") else data)
        preview, result = self.run_import(self.target, tampered)
        self.assertIn("SHA-256", preview["bundles"][1]["reason"])
        self.assertEqual([(r["ok"], r.get("code")) for r in result["results"]], [(False, "file_failed"), (False, "not_importable")])
        self.assertEqual(len(result["files"]["failed"]), 1)
        self.assertIsNone(self.target.assets.path(self.red))

    def test_a_file_of_another_kind_than_listed_is_refused(self):
        a = self.make(self.source, "A", self.red)
        path = self.export(self.source, [a])
        with zipfile.ZipFile(path) as z:  # a video field, so the file itself is what is wrong
            bundle = z.read(f"bundles/{a}.json")
        bent = bundle.replace(b'"type": "image"', b'"type": "video"')
        self.assertNotEqual(bent, bundle)
        out = self.root / "kind.zip"
        with zipfile.ZipFile(path) as source, zipfile.ZipFile(out, "w") as target:
            for info in source.infolist():
                name, data = info.filename, source.read(info)
                if name == "manifest.json":  # the PNG listed, and named, as a video
                    manifest = json.loads(data)
                    manifest["assets"][0].update(kind="video", file=f"assets/{self.red}.mp4")
                    manifest["bundles"][0]["sha256"] = hashlib.sha256(bent).hexdigest()
                    data = json.dumps(manifest).encode()
                elif name == f"bundles/{a}.json":
                    data = bent
                elif name == f"assets/{self.red}.png":
                    name = f"assets/{self.red}.mp4"
                target.writestr(name, data)
        _, result = self.run_import(self.target, out)
        self.assertEqual([(r["ok"], r.get("code")) for r in result["results"]], [(False, "file_failed")])
        self.assertIsNone(self.target.assets.path(self.red), "checked as an upload of that kind would be")

    def test_zips_that_are_not_exports_are_refused_before_anything_is_written(self):
        a = self.make(self.source, "A", self.red)
        good = self.export(self.source, [a])
        not_zip = self.root / "x.zip"
        not_zip.write_bytes(b"not a zip")
        newer = self.rewrite_zip(good, lambda n, d: json.dumps({**json.loads(d), "version": 2}).encode()
                                 if n == "manifest.json" else d)
        other = self.rewrite_zip(good, lambda n, d: json.dumps({**json.loads(d), "format": "something else"}).encode()
                                 if n == "manifest.json" else d)
        no_manifest = self.rewrite_zip(good, lambda n, d: None if n == "manifest.json" else d)
        escaping = self.rewrite_zip(good, lambda n, d: d.replace(b'"bundles/', b'"../bundles/') if n == "manifest.json" else d)
        # zipfile writes no encrypted entries: mark them so in the central directory, where readers look.
        raw = bytearray(Path(good).read_bytes())
        at = raw.find(b"PK\x01\x02")
        while at != -1:
            raw[at + 8] |= 0x1  # general purpose flag, bit 0: encrypted
            at = raw.find(b"PK\x01\x02", at + 4)
        encrypted = self.root / "encrypted.zip"
        encrypted.write_bytes(bytes(raw))
        for path, code in [(not_zip, "invalid_export"), (newer, "newer_export"), (other, "invalid_export"),
                           (no_manifest, "invalid_export"), (escaping, "invalid_export"), (encrypted, "invalid_export")]:
            with self.subTest(path.name), self.assertRaises(LibraryError) as ctx:
                Imports(self.target.tmp_dir).inspect(self.target, self.receive(self.target, path))
            self.assertEqual(ctx.exception.code, code)
        self.assertEqual(self.target.list()["bundles"], [])

    def test_entries_the_manifest_does_not_name_are_ignored_and_limits_hold(self):
        a = self.make(self.source, "A")
        path = self.export(self.source, [a])
        extra = self.root / "extra.zip"
        with zipfile.ZipFile(path) as source, zipfile.ZipFile(extra, "w") as target:
            for info in source.infolist():
                target.writestr(info.filename, source.read(info))
            target.writestr("../../outside.txt", b"never written")
            target.writestr("bundles/stray.json", b"{}")
        _, result = self.run_import(self.target, extra)
        self.assertEqual([r["as"] for r in result["results"]], ["new"])
        self.assertFalse((self.root / "outside.txt").exists())
        with mock.patch.object(exchange, "MAX_UNPACKED", 10), self.assertRaises(LibraryError):
            Imports(self.target.tmp_dir).inspect(self.target, self.receive(self.target, path))
        with mock.patch.object(exchange, "MAX_ENTRIES", 1), self.assertRaises(LibraryError):
            Imports(self.target.tmp_dir).inspect(self.target, self.receive(self.target, path))

    def test_a_file_missing_from_the_export_and_here_lets_the_bundle_come_without_it(self):
        a = self.make(self.source, "A", self.red)
        path = self.export(self.source, [a])
        without = self.rewrite_zip(path, lambda n, d: json.dumps({**json.loads(d), "assets": []}).encode()
                                   if n == "manifest.json" else None if n.startswith("assets/") else d)
        preview, result = self.run_import(self.target, without)
        self.assertEqual((preview["bundles"][0]["missing_files"], preview["assets"]["missing"]), (1, 1))
        self.assertEqual([r["as"] for r in result["results"]], ["new"])

    def test_an_upload_waits_an_hour_and_goes_once_applied_or_discarded(self):
        a = self.make(self.source, "A")
        path = self.export(self.source, [a])
        imports = Imports(self.target.tmp_dir)
        token = self.receive(self.target, path)
        imports.apply(self.target, token, "skip", {"mode": "none"})
        with self.assertRaises(LibraryError):
            imports.path(token)
        token = self.receive(self.target, path)
        imports.discard(token)
        with self.assertRaises(LibraryError):
            imports.path(token)
        token = self.receive(self.target, path)
        stale = time.time() - EXPORT_TTL - 1
        os.utime(imports.folder / f"{token}.zip", (stale, stale))
        with self.assertRaises(LibraryError):
            imports.path(token)

    # -- 0.0.22 review: R22-01..05 ------------------------------------------------

    def bent_export(self):
        """An export of A (an image field) and W (an audio field) with A's field
        pointed at W's file: readable, but a reference of the wrong kind (R22-01).
        Also A's bytes as bent."""
        wav = self.upload(self.source, helpers.audio(), "tone.wav", "audio")
        a = self.make(self.source, "A", self.red)
        w = self.source.create({"name": "W", "tags": ["t"], "fields": [
            {"name": "sound", "type": "audio", "asset": {"sha256": wav}}]})["id"]
        path = self.export(self.source, [a, w])
        with zipfile.ZipFile(path) as z:
            bent = z.read(f"bundles/{a}.json").replace(self.red.encode(), wav.encode())

        def change(name, data):
            if name == f"bundles/{a}.json":
                return bent
            if name.startswith(f"assets/{self.red}"):
                return None
            if name == "manifest.json":
                manifest = json.loads(data)
                for entry in manifest["bundles"]:
                    if entry["id"] == a:
                        entry["sha256"] = hashlib.sha256(bent).hexdigest()
                manifest["assets"] = [x for x in manifest["assets"] if x["sha256"] != self.red]
                return json.dumps(manifest).encode()
            return data
        return a, w, wav, bent, self.rewrite_zip(path, change)

    def test_a_field_pointing_at_a_file_of_another_kind_stays_out(self):
        a, w, wav, bent, path = self.bent_export()
        for round_ in ("the file comes with the export", "the file is here already"):
            preview, result = self.run_import(self.target, path, "copy")
            rows = {p["id"]: p for p in preview["bundles"]}
            self.assertEqual((rows[a]["importable"], rows[a]["reason"]),
                             (False, "Field 'ref_0': the file is an audio, not an image."), round_)
            self.assertTrue(rows[w]["importable"], round_)
            self.assertEqual([(r["source"], r["ok"], r.get("code")) for r in result["results"]],
                             [(a, False, "not_importable"), (w, True, None)], round_)
        # Where the bundle is written, the same check again: new, overwritten and copied.
        loaded = schema.read_checked(bent, a)
        fresh = BundleStore(self.root / "c")
        self.upload(fresh, helpers.audio(), "tone.wav", "audio")
        self.run_import(self.target, self.export(self.source, [a]))  # the right A, here now
        for store, conflict in ((fresh, "skip"), (self.target, "overwrite"), (self.target, "copy")):
            written, _ = store.import_bundles([(a, bent, loaded, frozenset())], conflict, {"mode": "none", "names": {}})
            self.assertEqual([(r["ok"], r["code"]) for r in written], [(False, "wrong_kind")], conflict)
        self.assertEqual(self.target.get(a)["fields"][0]["asset"]["sha256"], self.red, "the bundle here stays")

    def test_files_come_only_for_the_bundles_written(self):
        a = self.make(self.source, "A")
        self.run_import(self.target, self.export(self.source, [a]))  # A here, using no file
        current = self.source.get(a)
        self.source.update(a, {"name": "A", "tags": ["t"], "note": "", "fields": [
            {"name": "ref_0", "type": "image", "asset": {"sha256": self.red}}]}, current["revision"])
        blue = self.upload(self.source, helpers.png("blue"), "blue.png")
        b = self.make(self.source, "B", self.red, blue)
        _, skipped = self.run_import(self.target, self.export(self.source, [a]), "skip")
        self.assertEqual((skipped["skipped"], skipped["files"]["stored"]), (1, 0))
        self.assertIsNone(self.target.assets.path(self.red), "a bundle left as it is brings no file")
        _, mixed = self.run_import(self.target, self.export(self.source, [a, b]), "skip")
        self.assertEqual([r["as"] for r in mixed["results"]], ["skipped", "new"])
        self.assertEqual(mixed["files"]["stored"], 2, "B's two files, the one A uses as well only once")

    def test_a_bundle_gone_meanwhile_is_not_written_without_its_file(self):
        a = self.make(self.source, "A")
        self.run_import(self.target, self.export(self.source, [a]))
        current = self.source.get(a)
        self.source.update(a, {"name": "A", "tags": ["t"], "note": "", "fields": [
            {"name": "ref_0", "type": "image", "asset": {"sha256": self.red}}]}, current["revision"])
        prepare = Imports._prepare

        def then_gone(imports, store, zip_path, conflict):
            prepared = prepare(imports, store, zip_path, conflict)  # A is here: its file is not brought
            here = store.get(a)
            store.delete(a, here["revision"])
            store.purge(a, expected_revision=here["revision"] + 1)
            return prepared
        with mock.patch.object(Imports, "_prepare", then_gone):
            _, result = self.run_import(self.target, self.export(self.source, [a]), "skip")
        self.assertEqual([(r["ok"], r.get("code")) for r in result["results"]], [(False, "file_missing")])
        self.assertEqual(self.target.list()["bundles"], [])

    def test_a_category_deleted_while_importing_is_said_not_dropped_silently(self):
        a = self.make(self.source, "A")
        box = self.target.create_category("Box")["id"]
        prepare = Imports._prepare

        def then_deleted(imports, store, zip_path, conflict):
            prepared = prepare(imports, store, zip_path, conflict)
            store.delete_category(box)
            return prepared
        with mock.patch.object(Imports, "_prepare", then_deleted):
            _, result = self.run_import(self.target, self.export(self.source, [a]), category={"mode": "one", "id": box})
        self.assertEqual(result["imported"], 1)
        self.assertIn("deleted while the import ran", result["placement_error"])
        self.assertIsNone(self.target.list()["bundles"][0]["category"])

    def test_one_import_runs_once_and_its_answer_is_kept(self):
        a = self.make(self.source, "A")
        self.run_import(self.target, self.export(self.source, [a]))  # A here: a copy makes a second one
        imports = Imports(self.target.tmp_dir)
        token = self.receive(self.target, self.export(self.source, [a]))
        inside, go_on = threading.Event(), threading.Event()
        prepare = Imports._prepare

        def held(imports_, store, zip_path, conflict):
            inside.set()
            go_on.wait(10)
            return prepare(imports_, store, zip_path, conflict)
        answers = []
        apply = lambda: imports.apply(self.target, token, "copy", {"mode": "none"})  # noqa: E731
        with mock.patch.object(Imports, "_prepare", held):
            first = threading.Thread(target=lambda: answers.append(apply()))
            first.start()
            self.assertTrue(inside.wait(10))
            for attempt in (apply, lambda: imports.discard(token)):
                with self.assertRaises(LibraryError) as ctx:
                    attempt()
                self.assertEqual((ctx.exception.status, ctx.exception.code), (409, "import_running"))
            go_on.set()
            first.join(10)
        self.assertEqual(answers[0]["imported"], 1)
        again = apply()
        self.assertEqual((again["replayed"], again["results"]), (True, answers[0]["results"]), "the answer it gave")
        self.assertEqual(len(self.target.list()["bundles"]), 2, "one copy, not two")
        imports.discard(token)
        with self.assertRaises(LibraryError) as ctx:
            apply()
        self.assertEqual(ctx.exception.status, 404)

    def test_a_finished_import_answers_again_whatever_its_choices_are_by_then(self):
        # R31-03: its category was deleted after it ran; a new import is still checked
        box = self.target.create_category("Box")["id"]
        a = self.make(self.source, "A")
        imports = Imports(self.target.tmp_dir)
        token = self.receive(self.target, self.export(self.source, [a]))
        choice = {"mode": "one", "id": box}
        first = imports.apply(self.target, token, "skip", choice)
        self.target.delete_category(box)
        for conflict, category in (("skip", choice), ("copy", {"mode": "none"})):
            again = imports.apply(self.target, token, conflict, category)
            self.assertEqual((again["replayed"], again["results"]), (True, said(first)["results"]))
        self.assertEqual(len(self.target.list()["bundles"]), 1, "it did not run again")
        token = self.receive(self.target, self.export(self.source, [a]))
        with self.assertRaises(LibraryError) as ctx:
            imports.apply(self.target, token, "skip", choice)
        self.assertEqual((ctx.exception.status, ctx.exception.code), (404, "not_found"))
        self.assertNotIn("replayed", imports.apply(self.target, token, "skip", {"mode": "none"}), "still ready")

    def test_a_replay_has_the_message_ids_of_the_first_answer(self):
        # R31-06: nested messages and warnings too; an answer kept by 0.0.31 (English only) still reads
        a, b = self.make(self.source, "A", self.red), self.make(self.source, "B")
        c = self.make(self.source, "C")
        tampered = self.rewrite_zip(self.export(self.source, [a, b, c]), lambda name, data: data.replace(
            b'"B"', b'"X"') if name == f"bundles/{b}.json" else helpers.png("blue") if name.startswith("assets/") else data)
        imports = Imports(self.target.tmp_dir)
        token = self.receive(self.target, tampered)
        write = store_module._write_file
        with mock.patch.object(store_module, "_write_file", lambda *args: write(*args) and False):
            first = said(imports.apply(self.target, token, "skip", {"mode": "zip"}))
        self.assertEqual([r["message_i18n"]["id"] for r in first["results"][:2]],
                         ["exchange.file_not_imported", "exchange.file_digest_manifest"])
        self.assertIn("warning_i18n", first["results"][2])
        self.assertIn("reason_i18n", first["files"]["failed"][0])
        again = said(imports.apply(self.target, token, "skip", {"mode": "zip"}))
        self.assertTrue(again.pop("replayed"))
        self.assertEqual(again, first)
        kept = imports.folder / f"{token}.json"
        kept.write_text(json.dumps({"results": [{"message": "English only"}]}), encoding="utf-8")
        self.assertEqual(imports.apply(self.target, token, "skip", {"mode": "zip"})["results"],
                         [{"message": "English only"}])

    def test_a_file_whose_folder_could_not_be_synced_warns_on_the_bundles_using_it(self):
        # 0.0.34: such a file is in place, but a power loss could undo it
        a, b = self.make(self.source, "A", self.red), self.make(self.source, "B")
        with mock.patch("bundle_library.assets.sync_folder", return_value=False):
            _, result = self.run_import(self.target, self.export(self.source, [a, b]))
        by_source = {r["source"]: r for r in result["results"]}
        self.assertEqual((by_source[a].get("warning"), "warning" in by_source[b]), (UNSYNCED, False))
        self.assertEqual(said(result)["results"][0]["warning_i18n"]["id"], "store.sync_warning")

    def test_an_import_cut_off_says_so_and_one_failing_early_can_run_again(self):
        a = self.make(self.source, "A", self.red)
        path = self.export(self.source, [a])
        imports = Imports(self.target.tmp_dir)
        token = self.receive(self.target, path)
        with mock.patch.object(type(self.target.assets), "finalize", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                imports.apply(self.target, token, "skip", {"mode": "zip"})
        self.assertEqual(imports.apply(self.target, token, "skip", {"mode": "zip"})["imported"], 1, "ready again")
        token = self.receive(self.target, path)
        (imports.folder / f"{token}.zip").rename(imports.folder / f"{token}.applying")  # as a stopped server leaves it
        with self.assertRaises(LibraryError) as ctx:
            imports.apply(self.target, token, "skip", {"mode": "zip"})
        self.assertEqual((ctx.exception.status, ctx.exception.code), (409, "import_interrupted"))
        imports.discard(token)
        self.assertFalse((imports.folder / f"{token}.applying").exists())

    def test_a_write_not_synced_says_so_on_its_result(self):
        shelf = self.source.create_category("Shelf")["id"]
        a = self.make(self.source, "A", category=shelf)
        write = store_module._write_file
        with mock.patch.object(store_module, "_write_file", lambda *args: write(*args) and False):
            _, result = self.run_import(self.target, self.export(self.source, [a]))
        self.assertTrue(result["results"][0]["warning"].startswith("Saved, but the library folder could not be synced"))
        self.assertEqual(result["warning"], result["results"][0]["warning"], "and the places")
