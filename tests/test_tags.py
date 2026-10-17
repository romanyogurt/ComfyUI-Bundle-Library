import json
import os
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest import mock

from bundle_library import tags as tag_rules
from bundle_library.constants import MAX_TAGS
from bundle_library.model import LibraryError
from bundle_library.store import BundleStore


FIXTURE = Path(__file__).resolve().parent / "fixtures" / "tag_keys.json"


class TagRulesTest(unittest.TestCase):
    def test_tags_are_the_same_when_the_page_takes_them_for_the_same(self):
        # web/tags.js's tagKey() is held to the same pairs (tests/js/tags.test.mjs).
        for a, b, same in json.loads(FIXTURE.read_text(encoding="utf-8"))["pairs"]:
            with self.subTest(f"{a} / {b}"):
                self.assertEqual(tag_rules.key(a) == tag_rules.key(b), same)

    def test_a_tag_is_the_same_whatever_its_case(self):
        self.assertEqual(tag_rules.key("Straße"), tag_rules.key("STRASSE"))
        self.assertTrue(tag_rules.has(["Portrait", "x"], "portrait"))

    def test_added_and_removed(self):
        self.assertEqual(tag_rules.added(["a", "B"], ["b", "c", "C", "d"]), ["a", "B", "c", "d"])
        self.assertEqual(tag_rules.removed(["a", "B", "c"], ["b", "C"]), ["a"])

    def test_renamed_merges_where_the_first_was_spelled_as_the_new_name(self):
        self.assertEqual(tag_rules.renamed(["Flowers", "old"], "old", "flowers"), ["flowers"])
        self.assertEqual(tag_rules.renamed(["x", "old", "y", "new"], "old", "new"), ["x", "new", "y"])
        self.assertEqual(tag_rules.renamed(["portrait"], "portrait", "Portrait"), ["Portrait"])  # only the case
        self.assertEqual(tag_rules.renamed(["Flowers"], "old", "flowers"), ["Flowers"])  # no 'old': not touched


class StoreTagsTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.store = BundleStore(self.root)

    def make(self, name, tags=(), fields=None):
        return self.store.create({"name": name, "tags": list(tags),
                                  "fields": fields or [{"name": "prompt", "type": "text", "value": name}]})["id"]

    def path(self, bundle_id):
        return self.root / "bundles" / f"{bundle_id}.json"

    def stored(self, bundle_id):
        return json.loads(self.path(bundle_id).read_text(encoding="utf-8"))

    def rewrite(self, bundle_id, **changes):
        """Change a bundle file behind the store's back, as an older version or a newer one could have saved it."""
        data = {**self.stored(bundle_id), **changes}
        self.path(bundle_id).write_text(json.dumps(data), encoding="utf-8")
        return data

    def batch(self, action, ids, tags):
        return self.store.batch({"action": action, "ids": ids, "tags": tags})

    def outcome(self, answer):
        return [(r["ok"], r["changed"], r.get("code")) for r in answer["results"]]

    # ---- one action on the selected bundles ------------------------------------------------

    def test_add_and_remove_change_only_the_tags_and_skip_what_is_so_already(self):
        a, b = self.make("A", ["Portrait"]), self.make("B")
        before = self.path(a).read_bytes()
        answer = self.batch("add_tags", [a, b], ["portrait"])
        self.assertEqual(self.outcome(answer), [(True, False, None), (True, True, None)])
        self.assertEqual(self.path(a).read_bytes(), before, "a bundle that has it is not written")
        self.assertEqual((self.stored(b)["tags"], self.stored(b)["revision"]), (["portrait"], 2))
        answer = self.batch("remove_tags", [a, b], ["PORTRAIT"])
        self.assertEqual(self.outcome(answer), [(True, True, None), (True, True, None)])
        self.assertEqual((self.stored(a)["tags"], self.stored(b)["tags"]), ([], []))

    def test_each_bundle_is_its_own_result_and_a_failure_does_not_stop_the_rest(self):
        ok, locked, gone = self.make("Ok"), self.make("Locked"), str(uuid.uuid4())
        self.rewrite(locked, color="red")  # read-only: a key this version does not know
        trashed = self.make("Trashed")
        self.store.delete(trashed, 1)
        answer = self.batch("add_tags", [locked, gone, trashed, ok], ["x"])
        self.assertEqual(self.outcome(answer), [(False, False, "read_only"), (False, False, "not_found"),
                                                (False, False, "in_trash"), (True, True, None)])

    def test_the_request_is_checked_before_anything_is_written(self):
        a = self.make("A")
        before = self.path(a).read_bytes()
        for tags, why in [([], "empty"), ("x", "not a list"), (["a\nb"], "a line break"), (["x" * 41], "too long"),
                          ([5], "not a string"), (["x"] * 21, "too many")]:
            with self.subTest(why), self.assertRaises(LibraryError) as ctx:
                self.batch("add_tags", [a], tags)
            self.assertEqual(ctx.exception.code, "invalid")
        with self.assertRaises(LibraryError):
            self.store.batch({"action": "add_tags", "ids": [a]})
        self.assertEqual(self.path(a).read_bytes(), before)

    def test_a_bundle_does_not_get_more_tags_than_allowed_but_keeps_what_it_has(self):
        full = self.make("Full", [f"t{i}" for i in range(MAX_TAGS)])
        over = self.make("Over")
        self.rewrite(over, tags=[f"t{i}" for i in range(MAX_TAGS + 1)])  # saved under looser rules: a warning
        answer = self.batch("add_tags", [full, over], ["new"])
        self.assertEqual(self.outcome(answer), [(False, False, "too_many_tags"), (False, False, "too_many_tags")])
        answer = self.batch("remove_tags", [over], ["t0"])
        self.assertEqual(self.outcome(answer), [(True, True, None)])
        self.assertEqual(len(self.stored(over)["tags"]), MAX_TAGS)

    def test_values_outside_newer_rules_stay_exactly_as_stored(self):
        bundle_id = self.make("Old", fields=[{"name": "seed", "type": "int", "value": 1}])
        long_tag = "y" * 41
        self.rewrite(bundle_id, tags=["keep", long_tag],
                     fields=[{"name": "seed", "type": "int", "value": 2 ** 60}])  # both warnings now
        answer = self.batch("add_tags", [bundle_id], ["added"])
        self.assertEqual(self.outcome(answer), [(True, True, None)])
        stored = self.stored(bundle_id)
        self.assertEqual(stored["tags"], ["keep", long_tag, "added"])
        self.assertEqual(stored["fields"][0]["value"], 2 ** 60)
        self.assertEqual(self.outcome(self.batch("remove_tags", [bundle_id], [long_tag])), [(True, True, None)],
                         "a tag longer than the rules allow now can still be removed")
        self.assertEqual(self.stored(bundle_id)["tags"], ["keep", "added"])

    def test_a_version_1_file_is_written_as_version_2(self):
        bundle_id = self.make("V1")
        data = self.stored(bundle_id)
        v1 = {k: v for k, v in data.items() if k != "deleted_at"}
        self.path(bundle_id).write_text(json.dumps({**v1, "schema_version": 1}), encoding="utf-8")
        self.batch("add_tags", [bundle_id], ["x"])
        stored = self.stored(bundle_id)
        self.assertEqual((stored["schema_version"], stored["deleted_at"], stored["tags"]), (2, None, ["x"]))

    # ---- across the library ----------------------------------------------------------------------

    def test_rename_reaches_the_trash_merges_and_keeps_the_place(self):
        a = self.make("A", ["Flowers", "old"])
        b = self.make("B", ["x", "OLD"])
        c = self.make("C", ["Flowers"])  # no 'old': untouched
        self.store.delete(b, 1)
        before = self.path(c).read_bytes()
        result = self.store.rename_tag("old", "flowers")
        self.assertEqual((result["changed"], result["merged"]), (2, 1))
        self.assertEqual(self.stored(a)["tags"], ["flowers"])
        self.assertEqual(self.stored(b)["tags"], ["x", "flowers"])
        self.assertIsNotNone(self.stored(b)["deleted_at"], "still in the trash")
        self.assertEqual(self.path(c).read_bytes(), before)

    def test_a_rename_may_change_only_the_case_and_then_is_done(self):
        a = self.make("A", ["portrait"])
        b = self.make("B", ["Portrait"])
        before = self.path(b).read_bytes()
        result = self.store.rename_tag("PORTRAIT", "Portrait")
        self.assertEqual((result["changed"], result["merged"]), (1, 0))
        self.assertEqual(self.stored(a)["tags"], ["Portrait"])
        self.assertEqual(self.path(b).read_bytes(), before, "spelled so already: not written")
        self.assertEqual(self.store.rename_tag("portrait", "Portrait")["changed"], 0)

    def test_what_this_version_cannot_change_or_read_is_reported_apart(self):
        a = self.make("A", ["old"])
        locked = self.make("Locked", ["old"])
        self.rewrite(locked, color="red")
        broken = self.root / "bundles" / f"{uuid.uuid4()}.json"
        broken.write_text("{not json", encoding="utf-8")
        result = self.store.delete_tag("old")
        self.assertEqual(result["changed"], 1)
        self.assertEqual([(e["id"], e["code"]) for e in result["excluded"]], [(locked, "read_only")])
        self.assertEqual([u["file"] for u in result["unknown"]], [f"bundles/{broken.name}"])
        self.assertEqual(self.stored(a)["tags"], [])
        self.assertEqual(self.stored(locked)["tags"], ["old"])

    def test_names_follow_the_rules_of_saving_and_old_names_need_not(self):
        long_tag = "z" * 41
        a = self.make("A")
        self.rewrite(a, tags=[long_tag])
        for old, new, why in [("x", "y" * 41, "a new name over the limit"), ("x", "x", "the same name"),
                              ("", "y", "an empty name"), ("x", "a\nb", "a line break")]:
            with self.subTest(why), self.assertRaises(LibraryError) as ctx:
                self.store.rename_tag(old, new)
            self.assertEqual(ctx.exception.code, "invalid")
        self.assertEqual(self.store.rename_tag(long_tag, "short")["changed"], 1)
        self.assertEqual(self.stored(a)["tags"], ["short"])

    def test_a_failed_write_stops_only_that_bundle(self):
        ids = [self.make(name, ["old"]) for name in ("A", "B", "C")]
        real = BundleStore._save

        def save(store, bundle):
            if bundle["id"] == ids[1]:
                raise OSError(28, "No space left on device")
            return real(store, bundle)

        with mock.patch.object(BundleStore, "_save", save):
            result = self.store.delete_tag("old")
        self.assertEqual(result["changed"], 2)
        self.assertEqual([(e["id"], e["code"], e.get("retry")) for e in result["excluded"]], [(ids[1], "io_error", True)])
        self.assertEqual(self.stored(ids[1])["tags"], ["old"])

    def test_the_tags_of_the_library_by_name_with_their_counts(self):
        self.make("A", ["Portrait", "x"])
        self.make("B", ["portrait"])
        c = self.make("C", ["Portrait"])
        self.store.delete(c, 1)
        locked = self.make("Locked", ["x"])
        self.rewrite(locked, color="red")
        (self.root / "bundles" / f"{uuid.uuid4()}.json").write_text("[]", encoding="utf-8")
        listing = self.store.tags()
        self.assertEqual(listing["unreadable"], 1)
        by_name = {t["name"]: t for t in listing["tags"]}
        self.assertEqual(sorted(by_name), ["Portrait", "x"])
        self.assertEqual((by_name["Portrait"]["active"], by_name["Portrait"]["trash"],
                          by_name["Portrait"]["spellings"]), (2, 1, ["Portrait", "portrait"]))
        self.assertEqual((by_name["x"]["active"], by_name["x"]["protected"]), (2, 1))


if __name__ == "__main__":
    unittest.main()
