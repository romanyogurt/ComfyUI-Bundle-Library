import hashlib
import json
import os
import tempfile
import time
import unittest
import uuid
import zipfile
from pathlib import Path

from bundle_library.exchange import EXPORT_TTL, FORMAT, Exports, file_name
from bundle_library.model import LibraryError
from bundle_library.store import BundleStore
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
