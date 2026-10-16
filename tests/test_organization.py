import json
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest import mock

from bundle_library import organization
from bundle_library.model import LibraryError
from bundle_library.store import BundleStore


class OrganizationTest(unittest.TestCase):
    """Categories and favorites (organization.json)."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.store = BundleStore(self.root)
        self.org_file = self.root / "organization.json"

    def make(self, name, category=None):
        return self.store.create({"name": name, "fields": [{"name": "prompt", "type": "text", "value": name}]},
                                 category)

    def refused(self, call, status, code):
        with self.assertRaises(LibraryError) as ctx:
            call()
        self.assertEqual((ctx.exception.status, ctx.exception.code), (status, code), ctx.exception.message)
        return ctx.exception

    def listed(self):
        return {b["name"]: (b["category"], b["favorite"]) for b in self.store.list()["bundles"]}

    def bundle_bytes(self, bundle):
        return (self.root / "bundles" / f"{bundle['id']}.json").read_bytes()

    # ---- the file -----------------------------------------------------------

    def test_a_library_without_the_file_has_everything_uncategorized(self):
        self.make("Red")
        listing = self.store.list()
        self.assertEqual((listing["categories"], listing["organization"]), ([], {"revision": 0, "state": "missing"}))
        self.assertEqual(self.listed(), {"Red": (None, False)})
        self.assertEqual(self.store.health()["organization"], "missing")
        self.assertFalse(self.org_file.exists())  # reading wrote nothing

    def test_categories_are_made_renamed_and_deleted(self):
        heroes = self.store.create_category("  Heroes ")
        self.assertEqual((heroes["name"], heroes["parent"]), ("Heroes", None))
        villains = self.store.create_category("Villains")
        red = self.make("Red", heroes["id"])
        self.make("Blue", villains["id"])
        self.assertEqual([c["name"] for c in self.store.categories()["categories"]], ["Heroes", "Villains"])
        self.assertEqual(self.store.rename_category(heroes["id"], "Allies")["name"], "Allies")
        self.assertEqual(self.store.delete_category(villains["id"]), 1)
        self.assertEqual(self.listed(), {"Red": (heroes["id"], False), "Blue": (None, False)})
        stored = json.loads(self.org_file.read_text(encoding="utf-8"))
        self.assertEqual((stored["format"], stored["schema_version"]), (organization.FORMAT, 1))
        self.assertEqual(stored["placement"], {red["id"]: heroes["id"]})
        self.assertEqual(self.store.categories()["revision"], stored["revision"])

    def test_category_names_follow_the_rules(self):
        self.store.create_category("Heroes")
        self.refused(lambda: self.store.create_category("HEROES"), 409, "category_conflict")
        for bad in ("", "  ", "a" * 61, "line\nbreak", "Favorites", "uncategorized", "Needs Attention", None):
            with self.subTest(bad=bad):
                self.refused(lambda: self.store.create_category(bad), 400, "invalid")
        self.assertEqual(len(self.store.create_category("b" * 60)["name"]), 60)
        with mock.patch.object(organization, "MAX_CATEGORIES", 2):
            self.refused(lambda: self.store.create_category("Third"), 400, "invalid")

    def test_categories_do_not_nest_yet(self):
        parent = self.store.create_category("Parent")
        self.refused(lambda: self.store.create_category("Child", parent["id"]), 400, "nesting_not_supported")

    def test_moving_and_starring_leave_the_bundle_alone(self):
        heroes = self.store.create_category("Heroes")
        red = self.make("Red")
        before = self.bundle_bytes(red)
        self.store.set_category(red["id"], heroes["id"])
        self.store.set_favorite(red["id"], True)
        self.assertEqual(self.listed(), {"Red": (heroes["id"], True)})
        self.assertEqual(self.bundle_bytes(red), before)  # no new revision, no node cache change
        self.store.set_category(red["id"], None)
        self.store.set_favorite(red["id"], False)
        self.assertEqual(self.listed(), {"Red": (None, False)})
        self.refused(lambda: self.store.set_category(str(uuid.uuid4()), heroes["id"]), 404, "not_found")
        self.refused(lambda: self.store.set_category(red["id"], str(uuid.uuid4())), 404, "not_found")
        self.refused(lambda: self.store.set_category(red["id"], "../x"), 400, "invalid_id")
        self.refused(lambda: self.store.set_favorite(red["id"], "yes"), 400, "invalid")

    def test_search_finds_the_category_name(self):
        heroes = self.store.create_category("Heroes")
        self.make("Red", heroes["id"])
        self.make("Blue")
        self.assertEqual([b["name"] for b in self.store.list(query="hero")["bundles"]], ["Red"])

    # ---- the bundles' life ----------------------------------------------------

    def test_the_trash_keeps_the_place_and_the_star(self):
        heroes = self.store.create_category("Heroes")
        red = self.make("Red", heroes["id"])
        self.store.set_favorite(red["id"], True)
        self.store.delete(red["id"], 1)
        [entry] = self.store.trash()["trash"]
        self.assertEqual((entry["category"], entry["favorite"]), (heroes["id"], True))
        blue = self.make("Blue")
        self.store.set_favorite(blue["id"], True)  # another change must not drop the trashed bundle's entries
        self.store.restore(red["id"])
        self.assertEqual(self.listed()["Red"], (heroes["id"], True))

    def test_deleting_for_good_forgets_the_bundle(self):
        heroes = self.store.create_category("Heroes")
        red, blue = self.make("Red", heroes["id"]), self.make("Blue", heroes["id"])
        for bundle in (red, blue):
            self.store.set_favorite(bundle["id"], True)
            self.store.delete(bundle["id"], 1)
        self.store.purge(red["id"])
        stored = json.loads(self.org_file.read_text(encoding="utf-8"))
        self.assertEqual((list(stored["placement"]), stored["favorites"]), ([blue["id"]], [blue["id"]]))
        self.store.empty_trash({blue["id"]: 2})
        stored = json.loads(self.org_file.read_text(encoding="utf-8"))
        self.assertEqual((stored["placement"], stored["favorites"]), ({}, []))

    def test_a_copy_goes_beside_its_source_without_the_star(self):
        heroes = self.store.create_category("Heroes")
        red = self.make("Red", heroes["id"])
        self.store.set_favorite(red["id"], True)
        copy = self.store.duplicate(red["id"])
        self.assertNotIn("placement_error", copy)
        self.assertEqual(self.listed()["Red copy"], (heroes["id"], False))

    def test_unreadable_bundle_files_keep_their_place(self):
        heroes = self.store.create_category("Heroes")
        red = self.make("Red", heroes["id"])
        path = self.root / "bundles" / f"{red['id']}.json"
        path.write_text("{ broken", encoding="utf-8")
        self.store.set_favorite(self.make("Blue")["id"], True)
        self.assertEqual(json.loads(self.org_file.read_text(encoding="utf-8"))["placement"], {red["id"]: heroes["id"]})

    def test_a_failed_placement_keeps_the_bundle_made(self):
        made = self.make("Red", str(uuid.uuid4()))  # a category that does not exist
        self.assertIn("Category not found", made["placement_error"])
        self.assertEqual(len(self.store.list()["bundles"]), 1)
        heroes = self.store.create_category("Heroes")
        self.store.set_category(made["id"], heroes["id"])  # place it again; nothing is made twice
        self.assertEqual(self.listed(), {"Red": (heroes["id"], False)})

    # ---- a file this version cannot fully use -----------------------------------

    def test_an_organization_this_version_cannot_write_is_kept(self):
        base = {"format": organization.FORMAT, "schema_version": 1, "revision": 4, "categories": [],
                "placement": {}, "favorites": []}
        cases = {
            "corrupt": ("{ broken", "corrupt", False),
            "newer_version": (json.dumps({**base, "schema_version": 2}), "newer_version", False),
            "unsupported": (json.dumps({**base, "format": "someone-else/organization"}), "unsupported", False),
            "nested": (json.dumps({**base, "categories": [{"id": str(uuid.uuid4()), "name": "A",
                                                            "parent": str(uuid.uuid4())}]}), "corrupt", False),
            "read_only": (json.dumps({**base, "colors": {}, "categories": [{"id": str(uuid.uuid4()), "name": "A",
                                                                             "parent": None}]}), "read_only", True),
        }
        red = self.make("Red")
        for label, (text, state, shown) in cases.items():
            with self.subTest(label):
                self.org_file.write_text(text, encoding="utf-8")
                before = self.org_file.read_bytes()
                listing = self.store.list()
                self.assertEqual(listing["organization"]["state"], state)
                self.assertEqual(len(listing["categories"]), 1 if shown else 0)
                self.assertEqual([e["code"] for e in listing["errors"] if e["file"] == "organization.json"], [state])
                for call in (lambda: self.store.create_category("New"), lambda: self.store.set_favorite(red["id"], True),
                             lambda: self.store.set_category(red["id"], None)):
                    self.refused(call, 409, "organization_unwritable")
                blue = self.make("Blue", str(uuid.uuid4()))  # bundles are still made, without a place
                self.assertIn("placement_error", blue)
                self.store.delete(blue["id"], 1)
                self.store.purge(blue["id"])
                self.assertEqual(self.org_file.read_bytes(), before)

    def test_entries_for_things_that_are_gone_are_ignored_then_dropped(self):
        red = self.make("Red")
        heroes = str(uuid.uuid4())
        gone_bundle, gone_category = str(uuid.uuid4()), str(uuid.uuid4())
        self.org_file.write_text(json.dumps({
            "format": organization.FORMAT, "schema_version": 1, "revision": 1,
            "categories": [{"id": heroes, "name": "Heroes", "parent": None}],
            "placement": {red["id"]: gone_category, gone_bundle: heroes}, "favorites": [gone_bundle]}), encoding="utf-8")
        self.assertEqual(self.listed(), {"Red": (None, False)})
        self.assertEqual(self.store.list()["categories"][0]["count"], 0)
        self.store.set_favorite(red["id"], True)
        stored = json.loads(self.org_file.read_text(encoding="utf-8"))
        self.assertEqual((stored["placement"], stored["favorites"], stored["revision"]), ({}, [red["id"]], 2))


if __name__ == "__main__":
    unittest.main()
