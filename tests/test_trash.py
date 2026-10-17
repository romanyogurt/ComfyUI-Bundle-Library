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
    """The trash (restore, delete for good), the cleanup of unused files, and the
    stored files a media field can take (0.0.29)."""

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
        self.store.delete(bundle["id"], 1)
        [entry] = self.store.trash()["trash"]
        self.assertEqual((entry["id"], entry["name"], len(entry["fields"])), (bundle["id"], "Red", 2))
        self.assertEqual(entry["fields"][1]["preview"]["sha256"], sha)
        self.assertRegex(entry["deleted_at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")
        self.assertEqual(self.store.health()["trash"], 1)

    def test_restore_keeps_the_id_and_the_name(self):
        bundle = self.make("Blue")
        self.store.delete(bundle["id"], 1)
        self.make("Blue")  # another bundle may have the name meanwhile
        restored = self.store.restore(bundle["id"])
        self.assertEqual((restored["id"], restored["name"], restored["revision"], restored["deleted_at"]),
                         (bundle["id"], "Blue", 3, None))
        self.assertEqual(self.store.get(bundle["id"])["fields"], bundle["fields"])
        self.assertEqual(self.store.trash(), {"trash": [], "errors": []})
        self.refused(lambda: self.store.restore(bundle["id"]), 409, "not_in_trash")
        self.refused(lambda: self.store.restore(str(uuid.uuid4())), 404, "not_found")

    def test_restore_keeps_a_name_longer_than_the_rule(self):
        bundle = self.make("Long")
        path = self.root / "bundles" / f"{bundle['id']}.json"
        stored = json.loads(path.read_text(encoding="utf-8"))
        path.write_text(json.dumps({**stored, "name": "n" * 121}), encoding="utf-8")  # saved under a wider rule
        self.store.delete(bundle["id"], 1)
        self.assertEqual(self.store.restore(bundle["id"])["name"], "n" * 121)
        self.assertEqual(self.store.get(bundle["id"])["name"], "n" * 121)

    def test_delete_for_good_and_empty_the_trash(self):
        ids = [self.make(f"B{i}")["id"] for i in range(4)]
        for bundle_id in ids[:3]:
            self.store.delete(bundle_id, 1)
        self.refused(lambda: self.store.purge(ids[3]), 409, "not_in_trash")  # in use
        self.store.purge(ids[0])
        self.refused(lambda: self.store.purge(ids[0]), 404, "not_found")
        self.assertEqual(len(self.store.trash()["trash"]), 2)
        self.assertEqual(self.store.empty_trash({ids[1]: 2, ids[2]: 2})["deleted"], 2)
        self.assertEqual(self.store.trash(), {"trash": [], "errors": []})
        self.assertEqual([b["id"] for b in self.store.list()["bundles"]], [ids[3]])

    def test_ids_are_checked_before_any_file_is_touched(self):
        for bad in ("../bundles/x", "x", "A" * 36, None):
            with self.subTest(bad=bad):
                self.refused(lambda: self.store.restore(bad), 400, "invalid_id")
                self.refused(lambda: self.store.purge(bad), 400, "invalid_id")

    def test_files_this_version_cannot_read_are_kept_unless_asked(self):
        broken = str(uuid.uuid4())
        (self.root / "bundles" / f"{broken}.json").write_text("{ broken", encoding="utf-8")
        (self.root / "bundles" / "notes.txt").write_text("not the library's", encoding="utf-8")
        listing = self.store.trash()
        self.assertEqual((listing["trash"], [(e["id"], e["code"]) for e in listing["errors"]]),
                         ([], [(broken, "corrupt")]))
        self.refused(lambda: self.store.restore(broken), 500, "corrupt_bundle")
        self.assertEqual(self.store.empty_trash({broken: 1})["deleted"], 0)  # whether it is in the trash cannot be told
        self.refused(lambda: self.store.purge(broken), 409, "unreadable_file")
        self.store.purge(broken, unreadable=True)
        self.assertFalse((self.root / "bundles" / f"{broken}.json").exists())
        self.assertTrue((self.root / "bundles" / "notes.txt").exists())

    # ---- stored files a media field can take (0.0.29) -----------------------------

    def named(self, name, *uses, deleted=False):
        """A bundle whose image fields use (sha256, original name) pairs."""
        fields = [{"name": f"ref_{i}", "type": "image", "asset": {"sha256": sha, "original_name": original}}
                  for i, (sha, original) in enumerate(uses, 1)]
        bundle = self.store.create({"name": name, "tags": [], "fields": fields})
        if deleted:
            self.store.delete(bundle["id"], 1)
        return bundle

    def test_stored_files_of_a_kind_newest_first_with_their_names_and_uses(self):
        red, blue, green = (self.upload(helpers.png(c)) for c in ("red", "blue", "green"))
        video = self.upload(helpers.video("mp4", "libx264"), "video")
        for i, sha in enumerate((red, blue, green)):  # stored one after another
            os.utime(self.store.assets.path(sha), (OLD + i * 60, OLD + i * 60))
        zed = self.named("Zed", (red, "red.png"))
        abe = self.named("Abe", (red, "red.png"), (blue, "sky.png"), (red, "r.png"))
        old = self.named("Old", (blue, "blue.png"), deleted=True)
        listing = self.store.stored_assets("image")["assets"]
        self.assertEqual([a["sha256"] for a in listing], [green, blue, red])
        newest, middle, oldest = listing
        self.assertEqual((newest["names"], newest["used_by"]), ([], []))  # stored, used by no bundle
        self.assertEqual((newest["ext"], newest["mime"], newest["width"], newest["height"]), ("png", "image/png", 64, 48))
        self.assertEqual(newest["bytes"], self.store.assets.path(green).stat().st_size)
        self.assertRegex(newest["stored_at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")  # as the cleanup lists it
        self.assertEqual(middle["used_by"], [{"id": abe["id"], "name": "Abe", "field": "ref_2", "deleted": False},
                                             {"id": old["id"], "name": "Old", "field": "ref_1", "deleted": True}])
        self.assertEqual(middle["names"], ["sky.png", "blue.png"])
        self.assertEqual(oldest["names"], ["red.png", "r.png"])  # the name given most first
        self.assertEqual([(u["name"], u["field"]) for u in oldest["used_by"]], [("Abe", "ref_1"), ("Abe", "ref_3"), ("Zed", "ref_1")])
        [clip] = self.store.stored_assets("video")["assets"]
        self.assertEqual((clip["sha256"], clip["ext"], clip["used_by"]), (video, "mp4", []))
        self.assertIn("duration", clip)
        self.assertEqual(self.store.stored_assets("audio")["assets"], [])
        self.assertEqual(zed["fields"][0]["asset"]["sha256"], red)
        self.refused(lambda: self.store.stored_assets("text"), 400, "invalid")
        self.refused(lambda: self.store.stored_assets(""), 400, "invalid")

    def test_taking_a_stored_file_restarts_its_grace_time(self):
        sha = self.upload(helpers.png("teal"))
        self.age(sha)
        self.assertEqual([a["sha256"] for a in self.store.unused_assets()["assets"]], [sha])
        info = self.store.keep_asset(sha)  # a draft takes it from the library
        self.assertEqual((info["sha256"], info["ext"], info["width"]), (sha, "png", 64))
        listing = self.store.unused_assets()
        self.assertEqual((listing["assets"], listing["recent"]), ([], 1))
        self.assertEqual(self.store.delete_unused_assets([sha])["deleted"], 0)
        self.assertIsNotNone(self.store.assets.path(sha))
        self.refused(lambda: self.store.keep_asset("0" * 64), 404, "not_found")
        self.refused(lambda: self.store.keep_asset("not-a-digest"), 400, "invalid_id")

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

    def test_recent_unused_files_come_apart_and_go_only_when_asked(self):
        # 0.0.31: the files within the grace time are listed apart, and deleted only with recent=True
        old, a, b = (self.upload(helpers.png(c)) for c in ("red", "blue", "green"))
        self.age(old)
        listing = self.store.unused_assets()
        self.assertEqual(([x["sha256"] for x in listing["assets"]], listing["recent"]), ([old], 2))
        self.assertEqual(sorted(x["sha256"] for x in listing["recent_assets"]), sorted([a, b]))
        self.assertEqual(set(listing["recent_assets"][0]), {"sha256", "kind", "ext", "bytes", "stored_at"})
        report = self.store.delete_unused_assets([old, a, b])
        self.assertEqual((report["deleted"], report["kept"]), (1, 2))  # the grace time holds without being asked
        self.assertIsNotNone(self.store.assets.path(a))
        used = self.upload(helpers.png("white"))
        self.make("Uses white now", used)  # in use since the list was shown
        report = self.store.delete_unused_assets([a, b, used], recent=True)
        self.assertEqual((report["deleted"], report["kept"]), (2, 1))
        self.assertIsNone(self.store.assets.path(a))
        self.assertIsNotNone(self.store.assets.path(used))
        self.assertEqual(self.store.unused_assets()["recent_assets"], [])
        for value in ("yes", 1, None):
            with self.subTest(value):
                self.refused(lambda: self.store.delete_unused_assets([], recent=value), 400, "invalid")

    def test_videos_and_audio_are_cleaned_up_too(self):
        video = self.upload(helpers.video("mp4", "libx264"), "video")
        audio = self.upload(helpers.audio(), "audio")
        self.age(video, audio)
        self.assertEqual({a["kind"] for a in self.store.unused_assets()["assets"]}, {"video", "audio"})
        self.assertEqual(self.store.delete_unused_assets([video, audio])["deleted"], 2)

    def test_cleanup_stops_while_a_bundle_file_cannot_be_fully_read(self):
        sha = self.upload(helpers.png("red"))
        self.age(sha)
        cases = {
            "not JSON": lambda base: "{ broken",
            "a newer version": lambda base: {**base, "schema_version": 99, "resources": [{"sha256": sha}]},
            "another format": lambda base: {**base, "format": "someone-else/bundle"},
            "unknown keys": lambda base: {**base, "extra": {"sha256": sha}},
        }
        for label, make in cases.items():
            with self.subTest(label):
                bundle_id = str(uuid.uuid4())
                base = {"format": "comfyui-bundle-library/bundle", "schema_version": 2, "id": bundle_id,
                        "revision": 1, "name": "x", "fields": [], "created_at": "t", "updated_at": "t",
                        "deleted_at": None}
                content = make(base)
                broken = self.root / "bundles" / f"{bundle_id}.json"
                broken.write_text(content if isinstance(content, str) else json.dumps(content), encoding="utf-8")
                error = self.refused(self.store.unused_assets, 409, "unreadable_bundles")
                self.assertEqual(error.details["files"], [f"bundles/{broken.name}"])
                self.refused(lambda: self.store.delete_unused_assets([sha]), 409, "unreadable_bundles")
                broken.unlink()
        self.assertEqual(self.store.delete_unused_assets([sha])["deleted"], 1)

    def test_a_broken_bundle_of_a_known_version_still_keeps_its_files(self):
        sha = self.upload(helpers.png("red"))
        self.age(sha)
        bundle_id = str(uuid.uuid4())
        field = {"name": "ref", "type": "image", "asset": {"sha256": sha}}
        broken = {"format": "comfyui-bundle-library/bundle", "schema_version": 1, "id": bundle_id, "revision": 1,
                  "name": "Odd", "fields": [field, field], "created_at": "t", "updated_at": "t"}  # a repeated field name
        (self.root / "bundles" / f"{bundle_id}.json").write_text(json.dumps(broken), encoding="utf-8")
        self.assertEqual(self.store.list()["errors"][0]["code"], "corrupt")
        self.assertEqual(self.store.unused_assets()["assets"], [])  # its fields still show the file

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
