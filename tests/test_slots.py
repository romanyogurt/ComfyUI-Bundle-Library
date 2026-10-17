import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from bundle_library.constants import POOL_SIZE
from bundle_library.slots import field_problem, linked_outputs, output_fingerprint, parse_slot_spec, slot_problems
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
            "what every object has, in the frontend": spec(("prompt", "constructor")),
            "a type that is not a string": json.dumps({"v": 1, "slots": [{"name": "x", "type": ["text"]}]}),
            "a type that is an object": json.dumps({"v": 1, "slots": [{"name": "x", "type": {}}]}),
            "a version that is true": json.dumps({"v": True, "slots": []}),
            "more slots than outputs": spec(*[(f"f{i}", "text") for i in range(POOL_SIZE + 1)]),
        }
        for label, text in refused.items():
            with self.subTest(label), self.assertRaises(ValueError):
                parse_slot_spec(text)

    def test_the_version_reads_as_the_frontend_reads_it(self):
        # JavaScript's JSON reads 1.0 as 1: a spec the frontend takes is taken here too.
        self.assertEqual(parse_slot_spec('{"v": 1.0, "slots": [{"name": "x", "type": "text"}]}'), [("x", "text")])


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
            ({"name": "prompt", "type": "text", "value": "x", "enabled": False}, "text", "is turned off in the bundle"),
            ({"name": "ref", "type": "image", "asset": {"sha256": MISSING}, "enabled": False}, "video",
             "is turned off in the bundle"),  # off says it first: turning it on is the way out
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

    def test_the_slots_a_bundle_cannot_fill_by_index(self):
        fields = {"ref": {"name": "ref", "type": "image", "asset": {"sha256": self.sha}},
                  "empty": {"name": "empty", "type": "image", "asset": None}}
        slots = [("ref", "image"), ("empty", "image"), ("gone", "text"), ("ref", "video")]
        self.assertEqual(slot_problems(self.store, slots, fields),
                         {1: "has no image", 2: "is missing from the bundle", 3: "is image, not video"})


class OutputFingerprintTest(unittest.TestCase):
    SLOTS = [("prompt", "text"), ("ref", "image"), ("seed", "int")]

    def fields(self, **changes):
        fields = {"prompt": {"name": "prompt", "type": "text", "value": "a red dress"},
                  "ref": {"name": "ref", "type": "image", "asset": {"sha256": "a" * 64, "original_name": "a.png",
                                                                    "width": 64}},
                  "seed": {"name": "seed", "type": "int", "value": 7},
                  "note_like": {"name": "unused", "type": "text", "value": "not an output"}}
        for name, change in changes.items():
            fields[name] = {**fields[name], **change}
        return fields

    def test_only_what_the_outputs_carry_counts(self):
        base = output_fingerprint(self.SLOTS, self.fields())
        same = [
            self.fields(ref={"asset": {"sha256": "a" * 64, "original_name": "renamed.png", "width": 64}}),
            self.fields(note_like={"value": "changed, but no output reads it"}),
        ]
        for fields in same:
            self.assertEqual(output_fingerprint(self.SLOTS, fields), base)
        different = [
            self.fields(prompt={"value": "a blue dress"}),
            self.fields(ref={"asset": {"sha256": "b" * 64}}),
            self.fields(seed={"value": 8}),
        ]
        for fields in different:
            self.assertNotEqual(output_fingerprint(self.SLOTS, fields), base)
        self.assertNotEqual(output_fingerprint(self.SLOTS[:2], self.fields()), base)  # another set of outputs

    def test_a_slot_that_cannot_be_filled_counts_by_its_reason(self):
        # No NaN: the same bundle gives the same fingerprint, so it is cached like any other (N16).
        slots = [*self.SLOTS, ("bgm", "audio")]
        fields = self.fields()
        base = output_fingerprint(slots, fields, {3: "is missing from the bundle"})
        self.assertEqual(output_fingerprint(slots, fields, {3: "is missing from the bundle"}), base)
        self.assertNotEqual(output_fingerprint(slots, fields, {3: "has no audio"}), base)
        filled = {**fields, "bgm": {"name": "bgm", "type": "audio", "asset": {"sha256": "c" * 64}}}
        self.assertNotEqual(output_fingerprint(slots, filled), base)
        # a text that reads like a reason is still a value
        self.assertNotEqual(output_fingerprint(self.SLOTS, self.fields(prompt={"value": "has no audio"})),
                            output_fingerprint(self.SLOTS, self.fields(), {0: "has no audio"}))


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
