import hashlib
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from bundle_library.assets import AssetStore
from bundle_library.model import LibraryError

from . import helpers


class MediaTest(unittest.TestCase):
    """Video and audio files in the asset store (PyAV)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "tmp").mkdir()
        self.assets = AssetStore(self.root, self.root / "tmp")

    def tearDown(self):
        self.tmp.cleanup()

    def ingest(self, data, kind, name="upload"):
        temp = self.assets.temp_path()
        temp.write_bytes(data)
        try:
            return self.assets.finalize(temp, hashlib.sha256(data).hexdigest(), name, kind)[0]
        finally:
            temp.unlink(missing_ok=True)

    def refused(self, data, kind, status, code):
        with self.assertRaises(LibraryError) as ctx:
            self.ingest(data, kind)
        self.assertEqual((ctx.exception.status, ctx.exception.code), (status, code), ctx.exception.message)
        return ctx.exception.message

    def test_videos_are_kept_with_their_metadata(self):
        cases = {
            "mp4": (helpers.video("mp4", "libx264", audio_codec="aac"), "video/mp4", "h264", True),
            "mov": (helpers.video("mov", "libx264"), "video/mp4", "h264", False),  # served as MP4
            "webm": (helpers.video("webm", "libvpx-vp9", audio_codec="libopus"), "video/webm", "vp9", True),
        }
        for ext, (data, mime, codec, has_audio) in cases.items():
            with self.subTest(ext=ext):
                info = self.ingest(data, "video", f"clip.{ext}")
                self.assertEqual((info["ext"], info["mime"], info["codec"], info["has_audio"]), (ext, mime, codec, has_audio))
                self.assertEqual((info["width"], info["height"], info["fps"], info["bytes"]), (64, 48, 12.0, len(data)))
                self.assertAlmostEqual(info["duration"], 1.0, delta=0.05)
                self.assertEqual(self.assets.path(info["sha256"]).read_bytes(), data)
                self.assertEqual(self.assets.kind(info["sha256"]), "video")
                again = AssetStore(self.root, self.root / "tmp").info(info["sha256"])  # read back from the file
                self.assertEqual(again, {k: v for k, v in info.items() if k != "original_name"})

    def test_audio_files_are_kept_with_their_metadata(self):
        cases = {
            "wav": (helpers.audio(), "audio/wav", "pcm_s16le", 8000),
            "flac": (helpers.audio("flac", "flac"), "audio/flac", "flac", 8000),
            "mp3": (helpers.audio("mp3", "libmp3lame", rate=44100), "audio/mpeg", "mp3", 44100),
            "ogg": (helpers.audio("ogg", "libopus", rate=48000), "audio/ogg", "opus", 48000),
            "m4a": (helpers.audio("ipod", "aac", rate=48000), "audio/mp4", "aac", 48000),
        }
        for ext, (data, mime, codec, rate) in cases.items():
            with self.subTest(ext=ext):
                info = self.ingest(data, "audio", f"tone.{ext}")
                self.assertEqual((info["ext"], info["mime"], info["codec"], info["sample_rate"], info["channels"]),
                                 (ext, mime, codec, rate, 2))
                self.assertAlmostEqual(info["duration"], 1.0, delta=0.05)
                self.assertEqual(self.assets.kind(info["sha256"]), "audio")
                self.assertIsNone(self.assets.thumbnail(info["sha256"], 128))  # nothing to show

    def test_album_art_does_not_make_a_video(self):
        data = helpers.mp3_with_cover()
        self.assertEqual(self.ingest(data, "audio", "song.mp3")["ext"], "mp3")
        self.assertIn("no video", self.refused(data, "video", 415, "unsupported_format"))

    def test_files_must_be_of_the_field_kind(self):
        self.assertIn("is a video", self.refused(
            helpers.video("mp4", "libx264", audio_codec="aac"), "audio", 415, "unsupported_format"))
        self.assertIn("no video", self.refused(helpers.audio(), "video", 415, "unsupported_format"))
        self.refused(helpers.png(), "video", 415, "unsupported_format")  # PyAV reads it as a one-frame stream
        self.refused(helpers.video("matroska", "libx264"), "video", 415, "unsupported_format")  # not WebM codecs
        self.refused(b"not media at all" * 100, "audio", 415, "unsupported_format")
        self.refused(helpers.video("mp4", "libx264"), "image", 415, "unsupported_format")

    def test_damaged_video_is_refused(self):
        data = helpers.video("mp4", "libx264", frames=24)
        with self.assertRaises(LibraryError) as ctx:
            self.ingest(data[: len(data) // 2], "video")  # the index at the end is gone
        self.assertIn(ctx.exception.code, ("unsupported_format", "corrupt_media"))

    def test_limits(self):
        self.assets.limits["video"]["pixels"] = 64 * 48 - 1
        self.assertIn("64×48", self.refused(helpers.video("mp4", "libx264"), "video", 413, "too_many_pixels"))
        self.assets.limits["audio"]["seconds"] = 120
        self.assertAlmostEqual(self.ingest(helpers.audio(seconds=120), "audio")["duration"], 120, delta=0.1)
        message = self.refused(helpers.audio(seconds=121), "audio", 413, "too_long")
        self.assertIn("(2:01); the limit is 2 minutes", message)

    def test_video_poster(self):
        info = self.ingest(helpers.video("mp4", "libx264", size=(320, 240), frames=24, fps=24), "video")
        path = self.assets.thumbnail(info["sha256"], 128)
        self.assertEqual(path, self.assets.thumbnail(info["sha256"], 128))  # made once
        with Image.open(path) as thumb:
            self.assertEqual((thumb.format, thumb.size), ("WEBP", (128, 96)))
        self.assertEqual(list((self.root / "tmp").iterdir()), [])


if __name__ == "__main__":
    unittest.main()
