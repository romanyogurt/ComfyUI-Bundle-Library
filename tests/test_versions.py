"""The version number and the constants the browser scripts copy from Python
must agree: pyproject.toml is the source of the version, constants.py of the
rest. A release that changes one place only fails here."""

import json
import re
import unittest
from pathlib import Path

from bundle_library import constants, model, store

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"


def js(file):
    return (WEB / file).read_text(encoding="utf-8")


def evaluate(expression):
    """A JS number expression made of integers, * and spaces (like 50 * 1024 * 1024)."""
    if not re.fullmatch(r"[\d\s*]+", expression):
        raise ValueError(expression)
    value = 1
    for part in expression.split("*"):
        value *= int(part)
    return value


class VersionTest(unittest.TestCase):
    def test_one_version_everywhere(self):
        pyproject = re.search(r'^version = "([^"]+)"$', (ROOT / "pyproject.toml").read_text(encoding="utf-8"), re.M)
        web = re.search(r'^export const VERSION = "([^"]+)";$', js("version.js"), re.M)
        self.assertEqual((constants.VERSION, web.group(1)), (pyproject.group(1), pyproject.group(1)))

    def test_slot_constants_match(self):
        source = js("reconcile.js")
        self.assertEqual(int(re.search(r"export const POOL_SIZE = (\d+);", source).group(1)), constants.POOL_SIZE)
        types = re.search(r"export const COMFY_TYPES = (\{.*?\});", source, re.S).group(1)
        self.assertEqual(json.loads(re.sub(r"(\w+):", r'"\1":', types).replace(",\n}", "\n}")), constants.COMFY_TYPES)

    def test_upload_limits_match(self):
        source = js("api.js")
        found = dict(re.findall(r"(image|video|audio): \{ bytes: ([\d\s*]+),", source))
        self.assertEqual({kind: evaluate(value) for kind, value in found.items()},
                         {"image": constants.MAX_IMAGE_BYTES, "video": constants.MAX_VIDEO_BYTES,
                          "audio": constants.MAX_AUDIO_BYTES})

    def test_int_range_and_text_preview_match(self):
        self.assertEqual((model.INT_MIN, model.INT_MAX), (-(2 ** 53 - 1), 2 ** 53 - 1))  # Number.MAX_SAFE_INTEGER
        self.assertIn("Number.MAX_SAFE_INTEGER", js("editor_model.js"))
        for name in ("loader_node.js", "editor_model.js"):  # the node's preview, and the summary the picker hands over
            preview = re.search(r"const TEXT_PREVIEW = (\d+);", js(name)).group(1)
            self.assertEqual(int(preview), store.TEXT_PREVIEW, name)


if __name__ == "__main__":
    unittest.main()
