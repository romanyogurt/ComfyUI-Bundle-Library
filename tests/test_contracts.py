"""The server's contracts made explicit in Phase 7.8s-1: what a write reports
when it fails before or after the file is replaced, a main change that stands
when organization.json cannot be written, files classified one by one whatever
they hold, read errors kept apart from damage, one implementation for single
and batch commands, and permanent deletes limited to what the user saw."""

import json
import os
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest import mock

from bundle_library import schema
from bundle_library import store as store_module
from bundle_library.constants import MAX_JSON_DEPTH
from bundle_library.model import LibraryError
from bundle_library.store import UNSYNCED, BundleStore


class ContractsTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.store = BundleStore(self.root)
        self.org_file = self.root / "organization.json"
        self.heroes = self.store.create_category("Heroes")["id"]

    def make(self, name, **extra):
        return self.store.create({"name": name, "fields": [{"name": "prompt", "type": "text", "value": name}], **extra})

    def path(self, bundle):
        return self.root / "bundles" / f"{bundle['id']}.json"

    def refused(self, call, status, code):
        with self.assertRaises(LibraryError) as ctx:
            call()
        self.assertEqual((ctx.exception.status, ctx.exception.code), (status, code), ctx.exception.message)
        return ctx.exception

    def rewrite(self, bundle, change):
        """Edit a bundle file by hand (as another tool or an older version would)."""
        path = self.path(bundle)
        data = json.loads(path.read_text(encoding="utf-8"))
        change(data)
        path.write_text(json.dumps(data), encoding="utf-8")

    # ---- writes: before and after the file is replaced --------------------------------

    def test_a_folder_that_cannot_be_synced_after_the_replace_is_a_write_done(self):
        red, blue = self.make("Red"), self.make("Blue")
        real_open = os.open

        def no_folder_sync(path, flags, *args):
            if Path(path).is_dir():
                raise OSError(5, "Input/output error")
            return real_open(path, flags, *args)

        # As where folders are synced: Windows never tries (assets.SYNC_FOLDERS), so nothing fails there.
        with mock.patch("bundle_library.assets.SYNC_FOLDERS", True), mock.patch.object(store_module.os, "open", no_folder_sync), \
                self.assertLogs(level="WARNING") as logs:
            starred = self.store.batch({"action": "set_favorite", "ids": [red["id"]], "favorite": True})
            trashed = self.store.batch({"action": "trash", "ids": [blue["id"]], "expected_revisions": {blue["id"]: 1}})
            updated = self.store.update(red["id"], {"name": "Red 2", "fields": []}, 1)
            # Every single command says so too (0.0.34): a write done, but a power loss could undo it
            singles = {
                "create": self.store.create({"name": "Green", "fields": []}),
                "create in a category": self.store.create({"name": "Teal", "fields": []}, self.heroes),
                "duplicate": self.store.duplicate(red["id"]),
                "restore": self.store.restore(blue["id"]),
                "star": self.store.set_favorite(blue["id"], True),
                "move": self.store.set_category(blue["id"], self.heroes),
                "new category": self.store.create_category("Villains"),
                "rename category": self.store.rename_category(self.heroes, "Allies"),
            }
            singles["delete category"] = self.store.delete_category(singles["new category"]["id"])
        for answer in (starred, trashed):
            self.assertEqual((answer["changed"], answer["failed"], answer["results"][0]["warning"]), (1, 0, UNSYNCED))
        self.assertEqual((updated["name"], updated["warning"]), ("Red 2", UNSYNCED))  # done: the file is the new one
        for what, answer in singles.items():
            self.assertEqual(answer.get("warning"), UNSYNCED, what)
        self.assertNotIn("placement_error", singles["create in a category"])
        listed = {b["id"]: b for b in self.store.list()["bundles"]}
        self.assertTrue(listed[red["id"]]["favorite"])
        self.assertEqual((listed[blue["id"]]["favorite"], listed[blue["id"]]["category"]), (True, self.heroes))
        self.assertTrue(any("could not be synced" in line for line in logs.output))

    def test_a_failure_after_the_file_is_in_place_is_no_failure_of_the_save(self):
        # 0.0.34: noting how the file reads failed after it was written; the answer once was io_error, and a
        # client that tried again made the bundle twice
        written, real_write, real_stat = set(), store_module._write_json, Path.stat

        def write(path, data, tmp_dir):
            synced = real_write(path, data, tmp_dir)
            written.add(path)  # the first look at it after the write fails
            return synced

        def stat(path, *args, **kwargs):
            if path in written:
                written.discard(path)
                raise OSError(5, "Input/output error")
            return real_stat(path, *args, **kwargs)

        red = self.make("Red")
        with mock.patch.object(store_module, "_write_json", write), mock.patch.object(Path, "stat", stat):
            made = self.store.create({"name": "Green", "fields": []})
            updated = self.store.update(red["id"], {"name": "Red 2", "fields": []}, 1)
        self.assertEqual((made["revision"], updated["revision"]), (1, 2))
        listed = {b["name"]: b for b in self.store.list()["bundles"]}
        self.assertEqual(sorted(listed), ["Green", "Red 2"])  # each once, as saved
        self.assertEqual(self.store.get(made["id"])["name"], "Green")
        self.assertEqual(list((self.root / "tmp").iterdir()), [])

    def test_a_write_that_fails_before_the_replace_changes_nothing_and_says_so(self):
        red = self.make("Red")
        org_before, bundle_before = self.org_file.read_bytes(), self.path(red).read_bytes()
        with mock.patch.object(store_module.os, "replace", side_effect=OSError(28, "No space left on device")):
            answer = self.store.batch({"action": "set_favorite", "ids": [red["id"]], "favorite": True})
            error = self.refused(lambda: self.store.set_favorite(red["id"], True), 500, "io_error")
            with self.assertRaises(OSError):  # the route answers io_error with retry
                self.store.update(red["id"], {"name": "Red 2", "fields": []}, 1)
        result = answer["results"][0]
        self.assertEqual((result["ok"], result["changed"], result["code"], result["retry"]), (False, False, "io_error", True))
        self.assertEqual(error.details, {"retry": True})
        self.assertNotIn("/", result["message"])  # names no paths
        self.assertEqual((self.org_file.read_bytes(), self.path(red).read_bytes()), (org_before, bundle_before))

    def test_the_main_change_stands_when_organization_json_cannot_be_written(self):
        real = store_module._write_json

        def no_organization(path, data, tmp_dir):
            if Path(path).name == "organization.json":
                raise OSError(28, "No space left on device")
            return real(path, data, tmp_dir)

        with mock.patch.object(store_module, "_write_json", no_organization):
            made = self.store.create({"name": "Red", "fields": []}, self.heroes)
        self.assertIn("could not be written", made["placement_error"])
        self.assertEqual([b["id"] for b in self.store.list()["bundles"]], [made["id"]])  # made once: retry the place
        self.store.set_category(made["id"], self.heroes)
        self.store.set_favorite(made["id"], True)
        self.store.delete(made["id"], 1)
        with mock.patch.object(store_module, "_write_json", no_organization), self.assertLogs(level="WARNING"):
            self.store.purge(made["id"], expected_revision=2)  # deleted, although its place could not be dropped
        self.assertFalse(self.path(made).exists())
        self.assertIn(made["id"], json.loads(self.org_file.read_text(encoding="utf-8"))["placement"])
        self.store.set_favorite(self.make("Blue")["id"], True)  # the next write drops the stale entries
        self.assertNotIn(made["id"], json.loads(self.org_file.read_text(encoding="utf-8"))["placement"])

    # ---- files classified one by one ------------------------------------------------------

    def test_a_file_with_unusable_values_is_damaged_alone(self):
        good = self.make("Good")
        # Stored file details are refreshed from the file on save: odd ones are dropped, not fatal (R15-04).
        details = self.make("Odd details")
        self.rewrite(details, lambda d: d["fields"].extend([
            {"name": "ref", "type": "image", "asset": {"sha256": "a" * 64, "ext": []}},
            {"name": "clip", "type": "video", "asset": {"sha256": "b" * 64, "duration": 10 ** 400}}]))
        cases = {"an int too large for a float": lambda d: d["fields"].append(
            {"name": "cfg", "type": "float", "value": 10 ** 400})}
        broken = {}
        for label, change in cases.items():
            bundle = self.make(label)
            self.rewrite(bundle, change)
            broken[bundle["id"]] = label
        surrogate = self.make("surrogate")
        self.path(surrogate).write_text(self.path(surrogate).read_text(encoding="utf-8").replace(
            '"value": "surrogate"', '"value": "\\ud800"'), encoding="utf-8")
        broken[surrogate["id"]] = "a lone surrogate"
        for label, depth in (("deep nesting", 100000), ("one level too deep", MAX_JSON_DEPTH)):
            nested = self.make(label)
            text = self.path(nested).read_text(encoding="utf-8")
            self.path(nested).write_text(text.replace('"note": ""', '"note": "", "extra": ' + "[" * depth + "]" * depth),
                                         encoding="utf-8")
            broken[nested["id"]] = label
        listing = BundleStore(self.root).list()  # read afresh, as after a restart
        self.assertEqual(sorted(b["id"] for b in listing["bundles"]), sorted([good["id"], details["id"]]))
        kept = next(b for b in listing["bundles"] if b["id"] == details["id"])
        self.assertEqual([f["name"] for f in kept["fields"]], ["prompt", "ref", "clip"])
        codes = {e["id"]: e["code"] for e in listing["errors"]}
        for bundle_id, label in broken.items():
            with self.subTest(label):
                self.assertEqual(codes.get(bundle_id), "corrupt", label)
        self.assertEqual(BundleStore(self.root).health()["bundles"], 2)

    def test_an_unexpected_failure_while_checking_a_file_is_logged_and_kept_to_that_file(self):
        good, odd = self.make("Good"), self.make("Odd")
        real = schema.read_bundle_content

        def fails_for_odd(data):
            if data.get("name") == "Odd":
                raise KeyError("a fault in the checker")
            return real(data)

        with mock.patch.object(schema, "read_bundle_content", fails_for_odd), self.assertLogs(level="ERROR"):
            listing = BundleStore(self.root).list()  # read afresh, as after a restart
        self.assertEqual([b["id"] for b in listing["bundles"]], [good["id"]])
        [error] = listing["errors"]
        self.assertEqual((error["id"], error["code"], error["error"]), (odd["id"], "corrupt", "could not be checked (KeyError)"))

    def test_organization_json_that_cannot_be_used_is_reported_not_raised(self):
        red = self.make("Red")
        for label, text in {"deep nesting": '{"categories": ' + "[" * 100000 + "]" * 100000 + "}",
                            "a lone surrogate": json.dumps({"format": "comfyui-bundle-library/organization",
                                                            "schema_version": 1, "revision": 1, "categories": [
                                                                {"id": str(uuid.uuid4()), "name": "x", "parent": None}],
                                                            "placement": {}, "favorites": []}).replace('"x"', '"\\ud800"')}.items():
            with self.subTest(label):
                self.org_file.write_text(text, encoding="utf-8")
                listing = self.store.list()
                self.assertEqual(listing["organization"]["state"], "corrupt")
                self.assertEqual([b["id"] for b in listing["bundles"]], [red["id"]])
                self.refused(lambda: self.store.set_favorite(red["id"], True), 409, "organization_unwritable")

    @unittest.skipIf(os.name == "nt", "Windows reads a file whatever its mode")
    @unittest.skipIf(hasattr(os, "geteuid") and os.geteuid() == 0, "root reads any file")
    def test_a_file_that_cannot_be_read_is_not_taken_for_damaged_nor_remembered(self):
        red = self.make("Red")
        path = self.path(red)
        path.chmod(0)
        try:
            [error] = self.store.list()["errors"]
            self.assertEqual((error["code"], error["id"]), ("read_error", None))  # no Delete forever on offer
            self.assertIn("could not be read", error["error"])
        finally:
            path.chmod(0o644)
        self.assertEqual([b["id"] for b in self.store.list()["bundles"]], [red["id"]])  # read again, not cached
        self.org_file.chmod(0)
        try:
            listing = self.store.list()
            self.assertIn("read_error", [e["code"] for e in listing["errors"] if e["file"] == "organization.json"])
        finally:
            self.org_file.chmod(0o644)
        self.assertEqual(self.store.list()["organization"]["state"], "ok")

    def test_a_read_error_right_after_a_save_is_not_remembered_either(self):
        # R19-03: the save itself succeeds; only reading the file back fails, once.
        red = self.make("Red")
        real_read, real_write = schema.read_file, store_module._write_json
        written, failed = [], []

        def write(*args):
            result = real_write(*args)
            written.append(args[0])
            return result

        def flaky(path, file_id=None):
            if written and not failed:  # the first read after the write
                failed.append(path)
                return schema.Loaded(schema.CORRUPT, problem="could not be read (Input/output error)", io_error=True)
            return real_read(path, file_id)

        with mock.patch.object(store_module, "_write_json", write), mock.patch.object(schema, "read_file", flaky):
            self.store.update(red["id"], {"name": "Changed", "tags": [], "note": "",
                                          "fields": [{"name": "prompt", "type": "text", "value": "x"}]}, 1)
        self.assertEqual(failed, written, "the read after the save is the one that failed")
        listing = self.store.list()
        self.assertEqual(([b["name"] for b in listing["bundles"]], listing["errors"]), (["Changed"], []))

    # ---- one implementation for single and batch commands ----------------------------------------

    def test_single_commands_follow_the_batch_rules(self):
        red = self.make("Red")
        self.store.set_favorite(red["id"], True)
        revision = json.loads(self.org_file.read_text(encoding="utf-8"))["revision"]
        self.store.set_favorite(red["id"], True)  # already so: nothing is written
        self.store.set_category(red["id"], None)
        self.assertEqual(json.loads(self.org_file.read_text(encoding="utf-8"))["revision"], revision)
        self.store.delete(red["id"], 1)
        self.assertEqual(self.store.delete(red["id"], 1), {"id": red["id"], "ok": True, "changed": False})
        self.refused(lambda: self.store.set_favorite(str(uuid.uuid4()), True), 404, "not_found")
        blue = self.make("Blue")
        answer = self.store.batch({"action": "trash", "ids": [blue["id"]], "expected_revisions": {blue["id"]: 9}})
        self.assertEqual(answer["results"][0]["current_revision"], 1)  # the details stay with the failure

    def test_requests_say_what_they_mean_before_anything_is_written(self):
        red = self.make("Red")
        self.store.set_category(red["id"], self.heroes)
        self.refused(lambda: self.store.batch({"action": "set_category", "ids": [red["id"]]}), 400, "invalid")
        self.assertEqual(self.store.list()["bundles"][0]["category"], self.heroes)  # not taken for null
        self.refused(lambda: self.store.create({"name": "Blue", "fields": []}, "oops"), 400, "invalid_id")
        self.assertEqual(len(self.store.list()["bundles"]), 1)  # nothing was written

    # ---- deleting for good only what the user saw ---------------------------------------------------

    def test_only_what_the_user_saw_in_the_trash_is_deleted_for_good(self):
        red, blue, green = self.make("Red"), self.make("Blue"), self.make("Green")
        for bundle in (red, blue):
            self.store.delete(bundle["id"], 1)
        shown = {red["id"]: 2, blue["id"]: 2}  # the trash as the page showed it
        self.store.restore(blue["id"])  # meanwhile, in another tab: restored and deleted again
        self.store.delete(blue["id"], 3)
        self.store.delete(green["id"], 1)  # and another bundle put in the trash
        answer = self.store.empty_trash(shown)
        outcome = {r["id"]: (r["ok"], r.get("code")) for r in answer["results"]}
        self.assertEqual((answer["deleted"], outcome), (1, {red["id"]: (True, None), blue["id"]: (False, "revision_conflict")}))
        self.assertEqual(sorted(e["id"] for e in self.store.trash()["trash"]), sorted([blue["id"], green["id"]]))
        self.refused(lambda: self.store.purge(blue["id"], expected_revision=2), 409, "revision_conflict")
        self.store.purge(blue["id"], expected_revision=4)

    def test_a_read_only_bundle_is_deleted_for_good_only_from_the_trash_and_on_purpose(self):
        red = self.make("Red")
        self.rewrite(red, lambda d: d.update(color="red"))  # unknown to this version: read-only
        self.refused(lambda: self.store.purge(red["id"], unreadable=True), 409, "not_in_trash")
        self.rewrite(red, lambda d: d.update(deleted_at="2026-10-17T00:00:00.000Z"))
        self.refused(lambda: self.store.purge(red["id"]), 409, "unreadable_file")
        self.assertEqual(self.store.empty_trash({red["id"]: 1})["deleted"], 0)  # emptying leaves it
        self.store.purge(red["id"], unreadable=True)
        self.assertFalse(self.path(red).exists())


if __name__ == "__main__":
    unittest.main()
