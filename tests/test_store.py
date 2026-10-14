import hashlib
import json
import os
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path

from bundle_library.model import LibraryError
from bundle_library.store import BundleStore

from . import helpers


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.store = BundleStore(self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def upload(self, data):
        temp = self.store.assets.temp_path()
        temp.write_bytes(data)
        try:
            info, _ = self.store.assets.finalize(temp, hashlib.sha256(data).hexdigest(), "up.png")
        finally:
            temp.unlink(missing_ok=True)
        return info["sha256"]

    def data(self, name="Red Dress Girl", color="red", **changes):
        sha = self.upload(helpers.png(color))
        data = {
            "name": name,
            "tags": ["character"],
            "fields": [
                {"name": "prompt", "type": "text", "value": f"{name}\n\n 두 줄 "},
                {"name": "ref_1", "type": "image", "asset": {"sha256": sha, "original_name": "front.png"}},
                {"name": "ref_2", "type": "image", "asset": None},
                {"name": "use_bgm", "type": "boolean", "value": True},
            ],
        }
        data.update(changes)
        return data

    def refused(self, call, status, code):
        with self.assertRaises(LibraryError) as ctx:
            call()
        self.assertEqual((ctx.exception.status, ctx.exception.code), (status, code), ctx.exception.message)
        return ctx.exception

    def test_create_get_and_list(self):
        bundle = self.store.create(self.data())
        uuid.UUID(bundle["id"])
        self.assertEqual(bundle["revision"], 1)
        self.assertEqual(bundle["created_at"], bundle["updated_at"])
        self.assertEqual((bundle["format"], bundle["schema_version"]), ("comfyui-bundle-library/bundle", 1))
        asset = bundle["fields"][1]["asset"]
        self.assertEqual({k: asset[k] for k in ("ext", "width", "height", "original_name")},
                         {"ext": "png", "width": 64, "height": 48, "original_name": "front.png"})
        on_disk = json.loads((self.root / "bundles" / f"{bundle['id']}.json").read_text(encoding="utf-8"))
        self.assertEqual(on_disk, bundle)
        self.assertEqual(self.store.get(bundle["id"]), bundle)
        listing = self.store.list()
        self.assertEqual(listing["errors"], [])
        summary = listing["bundles"][0]
        self.assertEqual(summary["fields"][0], {"name": "prompt", "type": "text", "preview": "Red Dress Girl\n\n 두 줄 "})
        self.assertEqual(summary["fields"][1]["preview"], {"sha256": asset["sha256"], "width": 64, "height": 48})
        self.assertIsNone(summary["fields"][2]["preview"])

    def test_bundles_survive_a_new_store(self):
        bundle = self.store.create(self.data())
        reopened = BundleStore(self.root)
        self.assertEqual(reopened.get(bundle["id"]), bundle)
        self.assertEqual([b["id"] for b in reopened.list()["bundles"]], [bundle["id"]])

    def test_update_needs_the_current_revision(self):
        bundle = self.store.create(self.data())
        changed = self.store.update(bundle["id"], self.data(note="v2"), 1)
        self.assertEqual((changed["revision"], changed["note"], changed["created_at"]), (2, "v2", bundle["created_at"]))
        error = self.refused(lambda: self.store.update(bundle["id"], self.data(), 1), 409, "revision_conflict")
        self.assertEqual(error.details, {"current_revision": 2})
        self.refused(lambda: self.store.update(bundle["id"], self.data(), "2"), 400, "invalid")
        self.refused(lambda: self.store.update(str(uuid.uuid4()), self.data(), 1), 404, "not_found")

    def test_names_are_unique_regardless_of_case(self):
        red = self.store.create(self.data("Red"))
        blue = self.store.create(self.data("Blue", "blue"))
        self.refused(lambda: self.store.create(self.data("RED")), 409, "name_conflict")
        self.refused(lambda: self.store.update(blue["id"], self.data("red"), 1), 409, "name_conflict")
        self.assertEqual(self.store.update(red["id"], self.data("red"), 1)["name"], "red")

    def test_images_must_have_been_uploaded(self):
        data = self.data()
        data["fields"][1]["asset"] = {"sha256": "e" * 64}
        self.refused(lambda: self.store.create(data), 400, "unknown_asset")

    def test_client_cannot_set_image_metadata(self):
        data = self.data()
        data["fields"][1]["asset"].update(width=1, height=1, bytes=1, ext="webp")
        asset = self.store.create(data)["fields"][1]["asset"]
        self.assertEqual((asset["width"], asset["height"], asset["ext"]), (64, 48, "png"))
        self.assertGreater(asset["bytes"], 1)

    def test_delete_moves_the_file_to_trash(self):
        bundle = self.store.create(self.data())
        self.refused(lambda: self.store.delete(bundle["id"], 2), 409, "revision_conflict")
        self.store.delete(bundle["id"], 1)
        self.refused(lambda: self.store.get(bundle["id"]), 404, "not_found")
        self.assertEqual(self.store.list()["bundles"], [])
        trashed = list((self.root / "trash").iterdir())
        self.assertEqual(len(trashed), 1)
        self.assertTrue(trashed[0].name.startswith(bundle["id"] + "."))
        self.assertEqual(json.loads(trashed[0].read_text(encoding="utf-8"))["name"], bundle["name"])
        # its image stays
        self.assertIsNotNone(self.store.assets.path(bundle["fields"][1]["asset"]["sha256"]))

    def test_duplicate(self):
        source = self.store.create(self.data("Red"))
        copy = self.store.duplicate(source["id"])
        self.assertEqual(copy["name"], "Red copy")
        self.assertEqual(copy["fields"], source["fields"])
        self.assertNotEqual(copy["id"], source["id"])
        empty = self.store.duplicate(source["id"], "structure")
        self.assertEqual(empty["name"], "Red copy 2")
        self.assertEqual([(f["name"], f["type"]) for f in empty["fields"]],
                         [(f["name"], f["type"]) for f in source["fields"]])
        self.assertEqual(empty["fields"][0]["value"], "")
        self.assertIsNone(empty["fields"][1]["asset"])
        self.assertEqual(self.store.duplicate(source["id"], name="Blue")["name"], "Blue")
        self.refused(lambda: self.store.duplicate(source["id"], name="blue"), 409, "name_conflict")
        self.refused(lambda: self.store.duplicate(source["id"], "everything"), 400, "invalid")

    def test_unreadable_files_are_reported_not_fatal(self):
        good = self.store.create(self.data())
        broken_id = str(uuid.uuid4())
        (self.root / "bundles" / f"{broken_id}.json").write_text("{ not json", encoding="utf-8")
        mismatched_id = str(uuid.uuid4())
        mismatched = {**good, "id": str(uuid.uuid4())}
        (self.root / "bundles" / f"{mismatched_id}.json").write_text(json.dumps(mismatched), encoding="utf-8")
        (self.root / "bundles" / "notes.txt").write_text("ignored", encoding="utf-8")
        os.symlink(self.root / "bundles" / f"{good['id']}.json", self.root / "bundles" / f"{uuid.uuid4()}.json")
        listing = self.store.list()
        self.assertEqual([b["id"] for b in listing["bundles"]], [good["id"]])
        self.assertEqual(sorted(e["file"] for e in listing["errors"]),
                         sorted([f"{broken_id}.json", f"{mismatched_id}.json"]))
        error = self.refused(lambda: self.store.get(broken_id), 500, "corrupt_bundle")
        self.assertNotIn(str(self.root), error.message)
        self.assertEqual(self.store.health()["corrupt"], sorted([f"{broken_id}.json", f"{mismatched_id}.json"]))

    def test_files_changed_outside_are_picked_up(self):
        bundle = self.store.create(self.data("Before"))
        self.store.list()
        path = self.root / "bundles" / f"{bundle['id']}.json"
        path.write_text(json.dumps({**bundle, "name": "After edit by hand"}, ensure_ascii=False), encoding="utf-8")
        self.assertEqual([b["name"] for b in self.store.list()["bundles"]], ["After edit by hand"])
        path.unlink()
        self.assertEqual(self.store.list()["bundles"], [])

    def test_search_tag_and_sort(self):
        self.store.create(self.data("Banana", "yellow", tags=["fruit"]))
        apple = self.store.create(self.data("apple", "green", tags=["Fruit", "red"]))
        self.store.create(self.data("Car", "gray", tags=["vehicle"]))
        time.sleep(0.01)
        self.store.update(apple["id"], self.data("apple", "green", tags=["Fruit", "red"]), 1)
        names = lambda **kw: [b["name"] for b in self.store.list(**kw)["bundles"]]
        self.assertEqual(names(), ["apple", "Banana", "Car"])
        self.assertEqual(names(sort="updated")[0], "apple")
        self.assertEqual(names(tag="fruit"), ["apple", "Banana"])
        self.assertEqual(names(query="두 줄"), ["apple", "Banana", "Car"])  # text values are searched
        self.assertEqual(names(query="REF_1"), ["apple", "Banana", "Car"])  # so are field names
        self.assertEqual(names(query="ban"), ["Banana"])

    def test_temp_files_do_not_linger(self):
        leftover = self.root / "tmp" / "stale.json.part"
        leftover.write_text("from a crash")
        BundleStore(self.root)
        self.assertFalse(leftover.exists())
        bundle = self.store.create(self.data())
        self.store.update(bundle["id"], self.data(), 1)
        self.assertEqual(list((self.root / "tmp").iterdir()), [])

    def test_invalid_ids(self):
        for call in (lambda: self.store.get("../../etc/passwd"), lambda: self.store.delete("x", 1)):
            self.refused(call, 400, "invalid_id")

    def test_concurrent_creates_with_one_name(self):
        data = [self.data("Same") for _ in range(8)]
        results = []

        def create(d):
            try:
                results.append(self.store.create(d)["id"])
            except LibraryError as e:
                results.append(e.code)

        threads = [threading.Thread(target=create, args=(d,)) for d in data]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(results.count("name_conflict"), 7)
        self.assertEqual(len(self.store.list()["bundles"]), 1)


if __name__ == "__main__":
    unittest.main()
