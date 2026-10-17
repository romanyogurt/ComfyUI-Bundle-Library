import json
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest import mock

from bundle_library import store as store_module
from bundle_library.model import LibraryError
from bundle_library.store import BundleStore


class BatchTest(unittest.TestCase):
    """One action on many bundles (POST /bundles/batch)."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.store = BundleStore(self.root)
        self.org_file = self.root / "organization.json"
        self.heroes = self.store.create_category("Heroes")["id"]
        self.ids = [self.make(name)["id"] for name in ("Red", "Blue", "Green")]

    def make(self, name):
        return self.store.create({"name": name, "fields": [{"name": "prompt", "type": "text", "value": name}]})

    def batch(self, **data):
        return self.store.batch(data)

    def refused(self, data, status, code):
        with self.assertRaises(LibraryError) as ctx:
            self.store.batch(data)
        self.assertEqual((ctx.exception.status, ctx.exception.code), (status, code), ctx.exception.message)

    def outcome(self, answer):
        return [(r["ok"], r["changed"], r.get("code")) for r in answer["results"]]

    def org_revision(self):
        return json.loads(self.org_file.read_text(encoding="utf-8"))["revision"]

    # ---- the request as a whole ---------------------------------------------------

    def test_the_request_is_checked_before_anything_is_written(self):
        before = self.org_file.read_bytes()
        cases = [
            ({"action": "set_favorite", "ids": [], "favorite": True}, 400, "invalid"),
            ({"action": "set_favorite", "ids": "nope", "favorite": True}, 400, "invalid"),
            ({"action": "set_favorite", "ids": [self.ids[0], "../x"], "favorite": True}, 400, "invalid_id"),
            ({"action": "set_favorite", "ids": self.ids, "favorite": "yes"}, 400, "invalid"),
            ({"action": "explode", "ids": self.ids}, 400, "invalid"),
            ({"action": "add_tags", "ids": self.ids}, 400, "invalid"),
            ({"action": "add_tags", "ids": self.ids, "tags": ["x" * 41]}, 400, "invalid"),
            ({"action": "remove_tags", "ids": self.ids, "tags": []}, 400, "invalid"),
            ({"action": "set_category", "ids": self.ids, "category": "../x"}, 400, "invalid_id"),
            ({"action": "set_category", "ids": self.ids, "category": str(uuid.uuid4())}, 404, "not_found"),
            ({"action": "trash", "ids": self.ids}, 400, "invalid"),
            ({"action": "trash", "ids": self.ids, "expected_revisions": {self.ids[0]: 1}}, 400, "invalid"),
            ({"action": "trash", "ids": self.ids[:1], "expected_revisions": {self.ids[0]: True}}, 400, "invalid"),
        ]
        for data, status, code in cases:
            with self.subTest(data=data):
                self.refused(data, status, code)
        with mock.patch.object(store_module, "MAX_BATCH", 2):
            self.refused({"action": "set_favorite", "ids": self.ids, "favorite": True}, 400, "invalid")
        self.assertEqual(self.org_file.read_bytes(), before)
        self.assertEqual(len(self.store.list()["bundles"]), 3)

    # ---- categories and favorites ---------------------------------------------------------

    def test_categories_and_favorites_are_written_once(self):
        revision = self.org_revision()
        missing = str(uuid.uuid4())
        answer = self.batch(action="set_category", ids=[self.ids[0], missing, self.ids[1], self.ids[0]],
                            category=self.heroes)
        self.assertEqual([r["id"] for r in answer["results"]], [self.ids[0], missing, self.ids[1]])  # once each, in order
        self.assertEqual(self.outcome(answer), [(True, True, None), (False, False, "not_found"), (True, True, None)])
        self.assertEqual((answer["changed"], answer["unchanged"], answer["failed"]), (2, 0, 1))
        self.assertEqual(self.org_revision(), revision + 1)
        again = self.batch(action="set_category", ids=self.ids, category=self.heroes)
        self.assertEqual(self.outcome(again), [(True, False, None), (True, False, None), (True, True, None)])
        stars = self.batch(action="set_favorite", ids=self.ids[:2], favorite=True)
        self.assertEqual(stars["changed"], 2)
        listed = {b["id"]: (b["category"], b["favorite"]) for b in self.store.list()["bundles"]}
        self.assertEqual(listed, {self.ids[0]: (self.heroes, True), self.ids[1]: (self.heroes, True),
                                  self.ids[2]: (self.heroes, False)})
        self.assertEqual(self.org_revision(), revision + 3)
        out = self.batch(action="set_category", ids=self.ids, category=None)
        self.assertEqual(out["changed"], 3)
        bundle = json.loads((self.root / "bundles" / f"{self.ids[0]}.json").read_text(encoding="utf-8"))
        self.assertEqual(bundle["revision"], 1)  # the bundles themselves are not written

    def test_nothing_to_change_writes_nothing(self):
        self.batch(action="set_favorite", ids=self.ids, favorite=False)  # no star to take away
        before = self.org_file.read_bytes()
        answer = self.batch(action="set_favorite", ids=self.ids, favorite=False)
        self.assertEqual((answer["changed"], answer["unchanged"]), (0, 3))
        self.assertEqual(self.org_file.read_bytes(), before)

    def test_a_bundle_this_version_cannot_change_can_still_be_placed(self):
        path = self.root / "bundles" / f"{self.ids[0]}.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        path.write_text(json.dumps({**data, "color": "red"}), encoding="utf-8")  # read-only: an unknown key
        before = path.read_bytes()
        answer = self.batch(action="set_favorite", ids=self.ids[:1], favorite=True)
        self.assertEqual(self.outcome(answer), [(True, True, None)])
        self.assertEqual(path.read_bytes(), before)

    def test_an_organization_this_version_cannot_write_is_refused_whole(self):
        self.org_file.write_text(json.dumps({"format": "comfyui-bundle-library/organization", "schema_version": 2}),
                                 encoding="utf-8")
        before = self.org_file.read_bytes()
        self.refused({"action": "set_favorite", "ids": self.ids, "favorite": True}, 409, "organization_unwritable")
        self.assertEqual(self.org_file.read_bytes(), before)

    def test_when_organization_json_cannot_be_written_no_change_is_reported_done(self):
        self.batch(action="set_favorite", ids=self.ids[:1], favorite=True)
        before = self.org_file.read_bytes()
        real = store_module._write_json

        def failing(path, data, tmp_dir):
            if Path(path).name == "organization.json":
                raise OSError(28, "No space left on device")
            return real(path, data, tmp_dir)

        with mock.patch.object(store_module, "_write_json", failing):
            answer = self.batch(action="set_favorite", ids=self.ids, favorite=True)
        self.assertEqual(self.outcome(answer), [(True, False, None), (False, False, "io_error"), (False, False, "io_error")])
        self.assertTrue(all(r.get("retry") for r in answer["results"] if not r["ok"]))
        self.assertNotIn("/", answer["results"][1]["message"].split(":", 1)[1])  # no path in the message
        self.assertEqual(self.org_file.read_bytes(), before)

    # ---- the trash -------------------------------------------------------------------------

    def test_the_trash_checks_each_revision(self):
        self.store.update(self.ids[1], {"name": "Blue", "fields": [{"name": "prompt", "type": "text", "value": "b"}]}, 1)
        answer = self.batch(action="trash", ids=self.ids, expected_revisions={i: 1 for i in self.ids})
        self.assertEqual(self.outcome(answer), [(True, True, None), (False, False, "revision_conflict"), (True, True, None)])
        self.assertEqual(answer["results"][0]["revision"], 2)
        self.assertEqual(sorted(e["id"] for e in self.store.trash()["trash"]), sorted([self.ids[0], self.ids[2]]))
        again = self.batch(action="trash", ids=self.ids[:1], expected_revisions={self.ids[0]: 1})
        self.assertEqual(self.outcome(again), [(True, False, None)])  # in the trash already: nothing to do

    def test_the_trash_leaves_files_this_version_cannot_change(self):
        path = self.root / "bundles" / f"{self.ids[0]}.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        path.write_text(json.dumps({**data, "color": "red"}), encoding="utf-8")
        newer = self.root / "bundles" / f"{self.ids[1]}.json"
        newer.write_text(json.dumps({**data, "id": self.ids[1], "schema_version": 9}), encoding="utf-8")
        before = (path.read_bytes(), newer.read_bytes())
        missing = str(uuid.uuid4())
        answer = self.batch(action="trash", ids=[self.ids[0], self.ids[1], missing],
                            expected_revisions={self.ids[0]: 1, self.ids[1]: 1, missing: 1})
        self.assertEqual(self.outcome(answer), [(False, False, "read_only"), (False, False, "newer_version"),
                                                (False, False, "not_found")])
        self.assertEqual((path.read_bytes(), newer.read_bytes()), before)

    def test_a_failed_write_stops_only_that_bundle(self):
        real = BundleStore._save
        failing_id = self.ids[1]

        def save(store, bundle):
            if bundle["id"] == failing_id:
                raise OSError(5, "Input/output error")
            return real(store, bundle)

        with mock.patch.object(BundleStore, "_save", save):
            answer = self.batch(action="trash", ids=self.ids, expected_revisions={i: 1 for i in self.ids})
        self.assertEqual(self.outcome(answer), [(True, True, None), (False, False, "io_error"), (True, True, None)])
        self.assertTrue(answer["results"][1]["retry"])
        self.assertEqual(sorted(e["id"] for e in self.store.trash()["trash"]), sorted([self.ids[0], self.ids[2]]))
        self.assertEqual([b["id"] for b in self.store.list()["bundles"]], [failing_id])


if __name__ == "__main__":
    unittest.main()
