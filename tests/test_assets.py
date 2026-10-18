import hashlib
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image, ImageStat

from bundle_library import assets as assets_module
from bundle_library.assets import AssetStore
from bundle_library.model import LibraryError

from . import helpers


class AssetStoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "tmp").mkdir()
        self.assets = AssetStore(self.root, self.root / "tmp", max_pixels=1_000_000)

    def tearDown(self):
        self.tmp.cleanup()

    def ingest(self, data, name="upload.png", store=None):
        store = store or self.assets
        temp = store.temp_path()
        temp.write_bytes(data)
        try:
            return store.finalize(temp, hashlib.sha256(data).hexdigest(), name)[:2]  # (info, created)
        finally:
            temp.unlink(missing_ok=True)

    def refused(self, data, status, code):
        with self.assertRaises(LibraryError) as ctx:
            self.ingest(data)
        self.assertEqual((ctx.exception.status, ctx.exception.code), (status, code))

    def test_images_are_kept_byte_for_byte_under_their_hash(self):
        for data, ext, mime, size in (
            (helpers.png(), "png", "image/png", (64, 48)),
            (helpers.jpeg_turned(), "jpg", "image/jpeg", (200, 300)),  # as displayed
            (helpers.webp(), "webp", "image/webp", (40, 30)),
        ):
            with self.subTest(ext=ext):
                info, created = self.ingest(data, f"source.{ext}")
                sha = hashlib.sha256(data).hexdigest()
                self.assertTrue(created)
                self.assertEqual(info, {"sha256": sha, "ext": ext, "mime": mime, "width": size[0],
                                        "height": size[1], "bytes": len(data), "original_name": f"source.{ext}"})
                path = self.assets.path(sha)
                self.assertEqual(path.name, f"{sha}.{ext}")
                self.assertEqual(path.read_bytes(), data)
                self.assertEqual(self.assets.info(sha), {k: v for k, v in info.items() if k != "original_name"})

    def test_a_new_file_is_on_the_disk_before_it_takes_its_place(self):
        # 0.0.34, as a bundle file: the file is synced, then its folder; a stored file only gets a new time
        synced = []
        real_fsync = os.fsync

        def fsync(fd):
            synced.append("folder" if stat.S_ISDIR(os.fstat(fd).st_mode) else "file")
            return real_fsync(fd)

        with mock.patch.object(assets_module.os, "fsync", fsync):
            info, created, ok = self.assets.finalize(*self.received(helpers.png("olive")), "a.png")
            self.assertEqual((created, ok, synced), (True, True, ["file", "folder"] if assets_module.SYNC_FOLDERS else ["file"]))
            synced.clear()
            _, created, ok = self.assets.finalize(*self.received(helpers.png("olive")), "a.png")
            self.assertEqual((created, ok, synced), (False, True, []))
        real_open = os.open

        def no_folder(path, flags, *args):
            if Path(path).is_dir():
                raise OSError(5, "Input/output error")
            return real_open(path, flags, *args)

        with mock.patch.object(assets_module.os, "open", no_folder), self.assertLogs(level="WARNING"):
            info, created, ok = self.assets.finalize(*self.received(helpers.png("navy")), "b.png")
        self.assertEqual((created, ok), (True, False))  # in place, but a power loss could undo it
        self.assertIsNotNone(self.assets.path(info["sha256"]))

    def received(self, data):
        """An upload as the route leaves it: (the file, its SHA-256)."""
        temp = self.assets.temp_path()
        temp.write_bytes(data)
        self.addCleanup(temp.unlink, missing_ok=True)
        return temp, hashlib.sha256(data).hexdigest()

    def test_same_content_is_stored_once(self):
        data = helpers.png("blue")
        first, created_first = self.ingest(data, "a.png")
        second, created_second = self.ingest(data, "b.png")
        self.assertEqual((created_first, created_second), (True, False))
        self.assertEqual(first["sha256"], second["sha256"])
        self.assertEqual(second["original_name"], "b.png")
        self.assertEqual(len(list((self.root / "assets").rglob("*.png"))), 1)

    def test_other_formats_are_refused(self):
        self.refused(helpers.gif(), 415, "unsupported_format")
        self.refused(b"not an image at all", 415, "unsupported_format")
        self.refused(helpers.encode(Image.new("RGB", (4, 4)), "BMP"), 415, "unsupported_format")

    def test_broken_image_is_refused(self):
        data = helpers.encode(Image.effect_noise((256, 256), 64).convert("RGB"), "PNG")
        self.refused(data[: len(data) // 2], 400, "corrupt_image")

    def test_pixel_limit(self):
        self.refused(helpers.png(size=(1001, 1000)), 413, "too_many_pixels")
        info, _ = self.ingest(helpers.png(size=(1000, 1000)))
        self.assertEqual((info["width"], info["height"]), (1000, 1000))

    def test_links_are_not_followed(self):
        secret = self.root / "secret.txt"
        secret.write_text("secret")
        sha = "b" * 64
        folder = self.root / "assets" / "sha256" / sha[:2]
        folder.mkdir(parents=True)
        try:
            os.symlink(secret, folder / f"{sha}.png")
        except OSError:
            self.skipTest("cannot make a link here (Windows makes them only in Developer Mode or for an administrator)")
        self.assertIsNone(self.assets.path(sha))
        self.assertIsNone(self.assets.thumbnail(sha, 256))

    def test_invalid_ids_are_refused(self):
        for bad in ("../../secret", "B" * 64, "a" * 65):
            with self.subTest(bad=bad), self.assertRaises(LibraryError):
                self.assets.path(bad)

    def test_thumbnails(self):
        turned, _ = self.ingest(helpers.jpeg_turned())
        path = self.assets.thumbnail(turned["sha256"], 128)
        self.assertEqual(path, self.assets.thumbnail(turned["sha256"], 128))  # made once
        with Image.open(path) as thumb:
            self.assertEqual(thumb.format, "WEBP")
            self.assertEqual(thumb.size, (85, 128))  # turned upright like the loader output
        deep, _ = self.ingest(helpers.png16())
        with Image.open(self.assets.thumbnail(deep["sha256"], 128)) as thumb:
            self.assertLess(ImageStat.Stat(thumb.convert("L")).mean[0], 200)  # scaled, not clipped white
        with self.assertRaises(LibraryError):
            self.assets.thumbnail(turned["sha256"], 300)
        self.assertIsNone(self.assets.thumbnail("c" * 64, 128))
        self.assertEqual(list((self.root / "tmp").iterdir()), [])


if __name__ == "__main__":
    unittest.main()
