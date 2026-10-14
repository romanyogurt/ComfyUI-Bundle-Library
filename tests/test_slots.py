import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from bundle_library.constants import POOL_SIZE
from bundle_library.slots import field_problem, linked_outputs, parse_slot_spec
from bundle_library.store import BundleStore

from . import helpers

MISSING = "0" * 64


def spec(*slots, v=1):
    return json.dumps({"v": v, "slots": [{"name": name, "type": kind} for name, kind in slots]})


class SlotSpecTest(unittest.TestCase):
    def test_outputs_come_in_order(self):
        self.assertEqual(parse_slot_spec(spec(("prompt", "text"), ("ref", "image"), ("bgm", "audio"))),
                         [("prompt", "text"), ("ref", "image"), ("bgm", "audio")])
        self.assertEqual(parse_slot_spec(""), [])
        self.assertEqual(parse_slot_spec(spec()), [])
        full = [(f"f{i}", "int") for i in range(POOL_SIZE)]
        self.assertEqual(parse_slot_spec(spec(*full)), full)

    def test_invalid_specs_are_refused(self):
        refused = {
            "not JSON": "{",
            "a list": "[]",
            "no version": json.dumps({"slots": []}),
            "another version": spec(v=2),
            "slots not a list": json.dumps({"v": 1, "slots": {}}),
            "slot not an object": json.dumps({"v": 1, "slots": ["prompt"]}),
            "empty name": spec(("", "text")),
            "name not a string": json.dumps({"v": 1, "slots": [{"name": 3, "type": "text"}]}),
            "unknown type": spec(("mesh", "mesh")),
            "a ComfyUI type, not a field type": spec(("prompt", "STRING")),
            "more slots than outputs": spec(*[(f"f{i}", "text") for i in range(POOL_SIZE + 1)]),
        }
        for label, text in refused.items():
            with self.subTest(label), self.assertRaises(ValueError):
                parse_slot_spec(text)


class FieldProblemTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.store = BundleStore(Path(tmp.name))
        data = helpers.png()
        temp = self.store.assets.temp_path()
        temp.write_bytes(data)
        self.sha = self.store.assets.finalize(temp, hashlib.sha256(data).hexdigest(), "ref.png")[0]["sha256"]

    def problem(self, field, slot_type):
        return field_problem(self.store, field, slot_type)

    def test_fields_that_fill_their_slot(self):
        self.assertIsNone(self.problem({"name": "ref", "type": "image", "asset": {"sha256": self.sha}}, "image"))
        self.assertIsNone(self.problem({"name": "prompt", "type": "text", "value": ""}, "text"))  # empty is a value
        self.assertIsNone(self.problem({"name": "flag", "type": "boolean", "value": False}, "boolean"))

    def test_why_a_field_cannot_fill_its_slot(self):
        cases = [
            (None, "text", "is missing from the bundle"),
            ({"name": "ref", "type": "text", "value": "x"}, "image", "is text, not image"),
            ({"name": "seed", "type": "float", "value": 1.0}, "int", "is float, not int"),
            ({"name": "ref", "type": "image", "asset": None}, "image", "has no image"),
            ({"name": "clip", "type": "video", "asset": None}, "video", "has no video"),
            ({"name": "bgm", "type": "audio", "asset": None}, "audio", "has no audio"),
            ({"name": "ref", "type": "image", "asset": {"sha256": MISSING}}, "image",
             "has an image file that is missing from the library"),
            ({"name": "clip", "type": "video", "asset": {"sha256": MISSING}}, "video",
             "has a video file that is missing from the library"),
            ({"name": "bgm", "type": "audio", "asset": {"sha256": MISSING}}, "audio",
             "has an audio file that is missing from the library"),
        ]
        for field, slot_type, expected in cases:
            with self.subTest(expected):
                self.assertEqual(self.problem(field, slot_type), expected)


class LinkedOutputsTest(unittest.TestCase):
    PROMPT = {
        "1": {"class_type": "BundleLibraryLoad", "inputs": {"bundle_id": "x", "slot_spec": ""}},
        "2": {"class_type": "PreviewImage", "inputs": {"images": ["1", 1]}},
        "3": {"class_type": "CLIPTextEncode", "inputs": {"text": ["1", 0], "clip": ["4", 0]}},
        "4": {"class_type": "Other", "inputs": {"a": ["10", 2], "b": [1, 3], "c": "1", "d": ["1", 5, 6]}},
        "5": {"class_type": "NoInputs"},
    }

    def test_outputs_that_other_nodes_read(self):
        self.assertEqual(linked_outputs(self.PROMPT, "1"), {0, 1, 3})
        self.assertEqual(linked_outputs(self.PROMPT, 1), {0, 1, 3})  # ids compare as text
        self.assertEqual(linked_outputs(self.PROMPT, "10"), {2})
        self.assertEqual(linked_outputs(self.PROMPT, "2"), set())

    def test_no_prompt_means_no_links(self):
        self.assertEqual(linked_outputs(None, "1"), set())
        self.assertEqual(linked_outputs({}, "1"), set())


if __name__ == "__main__":
    unittest.main()
