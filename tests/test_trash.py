import hashlib
import json
import os
import tempfile
import time
import unittest
import uuid
from pathlib import Path

from bundle_library.constants import ASSET_GRACE_SECONDS
from bundle_library.model import LibraryError
from bundle_library.store import BundleStore

from . import helpers

OLD = time.time() - ASSET_GRACE_SECONDS - 3600  # stored before the grace time began


class TrashTest(unittest.TestCase):
    """The trash (restore, delete for good) and the cleanup of unused files."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.store = BundleStore(self.root)

    def upload(self, data, kind="image"):
        temp = self.store.assets.temp_path()
        temp.write_bytes(data)
        try:
            return self.store.assets.finalize(temp, hashlib.sha256(data).hexdigest(), "up", kind)[0]["sha256"]
        finally:
            temp.unlink(missing_ok=True)

    def make(self, name, *shas, kind="image"):
        fields = [{"name": "prompt", "type": "text", "value": name}]
        fields += [{"name": f"ref_{i}", "type": kind, "asset": {"sha256": sha}} for i, sha in enumerate(shas, 1)]
        return self.store.create({"name": name, "tags": ["t"], "fields": fields})

    def age(self, *shas):
        for sha in shas:
            os.utime(self.store.assets.path(sha), (OLD, OLD))

    def refused(self, call, status, code):
        with self.assertRaises(LibraryError) as ctx:
            call()
        self.assertEqual((ctx.exception.status, ctx.exception.code), (status, code), ctx.exception.message)
        return ctx.exception

    # ---- the trash -----------------------------------------------------------

    def test_deleted_bundles_are_listed_in_the_trash(self):
        sha = self.upload(helpers.png("red"))
        bundle = self.make("Red", sha)
        trash_id = self.store.delete(bundle["id"], 1)
        self.assertRegex(trash_id, rf"^{bundle['id']}\.\d{{8}}T\d{{6}}Z$")
        [entry] = self.store.trash()["trash"]
        self.assertEqual((entry["trash_id"], entry["id"], entry["name"], len(entry["fields"])),
                         (trash_id, bundle["id"], "Red", 2))
        self.assertEqual(entry["fields"][1]["preview"]["sha256"], sha)
        self.assertRegex(entry["deleted_at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")

    def test_restore_brings_the_bundle_back_under_its_id(self):
        bundle = self.make("Blue")
        trash_id = self.store.delete(bundle["id"], 1)
        restored = self.store.restore(trash_id)
        self.assertEqual((restored["id"], restored["name"], restored["revision"]), (bundle["id"], "Blue", 2))
        self.assertEqual(self.store.get(bundle["id"])["fields"], bundle["fields"])
        self.assertEqual(self.store.trash(), {"trash": [], "errors": []})
        self.refused(lambda: self.store.restore(trash_id), 404, "not_found")

    def test_restore_numbers_a_taken_name(self):
        trash_id = self.store.delete(self.make("Green")["id"], 1)
        self.make("GREEN")  # names are unique regardless of case
        self.assertEqual(self.store.restore(trash_id)["name"], "Green (2)")

    def test_a_second_copy_of_a_restored_bundle_gets_a_new_id(self):
        bundle = self.make("Twin")
        trash_id = self.store.delete(bundle["id"], 1)
        (self.root / "trash" / f"{trash_id}-2.json").write_bytes((self.root / "trash" / f"{trash_id}.json").read_bytes())
        self.assertEqual(self.store.restore(trash_id)["id"], bundle["id"])
        second = self.store.restore(f"{trash_id}-2")
        self.assertNotEqual(second["id"], bundle["id"])
        self.assertEqual(second["name"], "Twin (2)")
        self.assertEqual(len(self.store.list()["bundles"]), 2)

    def test_delete_for_good_and_empty_the_trash(self):
        trash_ids = [self.store.delete(self.make(f"B{i}")["id"], 1) for i in range(3)]
        self.store.purge(trash_ids[0])
        self.refused(lambda: self.store.purge(trash_ids[0]), 404, "not_found")
        self.assertEqual(len(self.store.trash()["trash"]), 2)
        self.assertEqual(self.store.empty_trash(), 2)
        self.assertEqual(self.store.trash(), {"trash": [], "errors": []})

    def test_trash_ids_are_checked_before_any_file_is_touched(self):
        some = str(uuid.uuid4())
        for bad in ("../bundles/x", "x", some, f"{some}.20261015T000000Z.json", f"{some.upper()}.20261015T000000Z",
                    f"{some}.20261015T000000Z-0", f"{some}.2026-10-15", None):
            with self.subTest(bad=bad):
                self.refused(lambda: self.store.restore(bad), 400, "invalid_id")
                self.refused(lambda: self.store.purge(bad), 400, "invalid_id")

    def test_unreadable_trash_files_are_reported_and_can_go(self):
        trash_id = f"{uuid.uuid4()}.20261015T000000Z"
        (self.root / "trash" / f"{trash_id}.json").write_text("{ broken", encoding="utf-8")
        (self.root / "trash" / "notes.txt").write_text("not the library's", encoding="utf-8")
        listing = self.store.trash()
        self.assertEqual((listing["trash"], [e["trash_id"] for e in listing["errors"]]), ([], [trash_id]))
        self.refused(lambda: self.store.restore(trash_id), 500, "corrupt_bundle")
        self.assertEqual(self.store.empty_trash(), 1)
        self.assertTrue((self.root / "trash" / "notes.txt").exists())

    # ---- unused files ----------------------------------------------------------

    def test_only_files_that_nothing_uses_are_unused(self):
        used, trashed, loose, recent = (self.upload(helpers.png(c)) for c in ("red", "blue", "green", "white"))
        self.make("Uses red", used)
        self.store.delete(self.make("Uses blue", trashed)["id"], 1)  # restorable, so its file stays
        self.age(used, trashed, loose)
        listing = self.store.unused_assets()
        self.assertEqual([a["sha256"] for a in listing["assets"]], [loose])
        self.assertEqual((listing["recent"], listing["grace_hours"]), (1, 24))
        self.assertEqual((listing["assets"][0]["kind"], listing["assets"][0]["ext"]), ("image", "png"))
        self.assertEqual(listing["bytes"], self.store.assets.path(loose).stat().st_size)

    def test_cleanup_deletes_what_is_still_unused(self):
        a, b, c = (self.upload(helpers.png(color)) for color in ("red", "blue", "green"))
        self.age(a, b, c)
        self.store.assets.thumbnail(a, 128)
        shown = [asset["sha256"] for asset in self.store.unused_assets()["assets"]]
        self.assertEqual(sorted(shown), sorted([a, b, c]))
        self.make("Uses blue now", b)  # saved after the list was shown
        report = self.store.delete_unused_assets(shown)
        self.assertEqual((report["deleted"], report["kept"]), (2, 1))
        self.assertIsNone(self.store.assets.path(a))
        self.assertIsNotNone(self.store.assets.path(b))
        self.assertEqual(list((self.root / "thumbs").rglob(f"{a}_*")), [])
        self.assertEqual(self.store.delete_unused_assets([a])["deleted"], 0)  # already gone

    def test_uploading_a_file_again_restarts_its_grace_time(self):
        data = helpers.png("teal")
        sha = self.upload(data)
        self.age(sha)
        self.assertEqual(len(self.store.unused_assets()["assets"]), 1)
        self.upload(data)  # chosen again in the editor
        listing = self.store.unused_assets()
        self.assertEqual((listing["assets"], listing["recent"]), ([], 1))
        self.assertEqual(self.store.delete_unused_assets([sha])["deleted"], 0)
        self.assertIsNotNone(self.store.assets.path(sha))

    def test_videos_and_audio_are_cleaned_up_too(self):
        video = self.upload(helpers.video("mp4", "libx264"), "video")
        audio = self.upload(helpers.audio(), "audio")
        self.age(video, audio)
        self.assertEqual({a["kind"] for a in self.store.unused_assets()["assets"]}, {"video", "audio"})
        self.assertEqual(self.store.delete_unused_assets([video, audio])["deleted"], 2)

    def test_cleanup_stops_while_a_bundle_file_cannot_be_read(self):
        sha = self.upload(helpers.png("red"))
        self.age(sha)
        for folder in ("bundles", "trash"):
            with self.subTest(folder=folder):
                broken = self.root / folder / f"{uuid.uuid4()}.json"
                broken.write_text("{ broken", encoding="utf-8")
                error = self.refused(self.store.unused_assets, 409, "unreadable_bundles")
                self.assertEqual(error.details["files"], [f"{folder}/{broken.name}"])
                self.refused(lambda: self.store.delete_unused_assets([sha]), 409, "unreadable_bundles")
                broken.unlink()
        self.assertEqual(self.store.delete_unused_assets([sha])["deleted"], 1)

    def test_a_bundle_failing_other_checks_still_keeps_its_files(self):
        sha = self.upload(helpers.png("red"))
        self.age(sha)
        odd = {"name": "Odd", "fields": [{"name": "seed", "type": "int", "value": 2 ** 60},
                                         {"name": "ref", "type": "image", "asset": {"sha256": sha}}]}
        (self.root / "bundles" / f"{uuid.uuid4()}.json").write_text(json.dumps(odd), encoding="utf-8")
        self.assertEqual(self.store.unused_assets()["assets"], [])

    def test_stray_thumbnails_go_and_foreign_files_stay(self):
        stray = self.root / "thumbs" / "ab" / f"ab{'0' * 62}_128.webp"
        stray.parent.mkdir(parents=True)
        stray.write_bytes(b"x")
        foreign = self.root / "assets" / "sha256" / "zz" / "readme.txt"
        foreign.parent.mkdir(parents=True)
        foreign.write_text("not the library's", encoding="utf-8")
        self.assertEqual(self.store.delete_unused_assets([])["thumbnails"], 1)
        self.assertFalse(stray.exists())
        self.assertTrue(foreign.exists())
        self.assertEqual(self.store.unused_assets()["assets"], [])
        self.refused(lambda: self.store.delete_unused_assets("abc"), 400, "invalid")
        self.refused(lambda: self.store.delete_unused_assets(["../x"]), 400, "invalid_id")


if __name__ == "__main__":
    unittest.main()
