import unicodedata
import unittest

from bundle_library.constants import (
    MAX_BUNDLE_NAME, MAX_FIELD_NAME, MAX_FIELDS, MAX_NOTE, MAX_TAG_LENGTH, MAX_TAGS, MAX_TEXT_BYTES,
)
from bundle_library.model import LibraryError, check_bundle_id, check_sha256, empty_value, normalize_bundle

SHA = "a" * 64


def bundle(**changes):
    data = {
        "name": "Red Dress Girl",
        "tags": ["character"],
        "note": "",
        "fields": [
            {"name": "prompt", "type": "text", "value": "line 1\n\n  spaced  "},
            {"name": "ref_1", "type": "image", "asset": {"sha256": SHA, "original_name": "front.png"}},
            {"name": "ref_2", "type": "image", "asset": None},
            {"name": "use_bgm", "type": "boolean", "value": True},
            {"name": "seed", "type": "int", "value": 42},
            {"name": "cfg", "type": "float", "value": 4},
        ],
    }
    data.update(changes)
    return data


def with_field(**field):
    return bundle(fields=[{"name": "x", **field}])


class NormalizeBundleTest(unittest.TestCase):
    def assertRefused(self, data, code="invalid"):
        with self.assertRaises(LibraryError) as ctx:
            normalize_bundle(data)
        self.assertEqual((ctx.exception.status, ctx.exception.code), (400, code), ctx.exception.message)
        return ctx.exception.message

    def test_valid_bundle_keeps_values_exactly(self):
        out = normalize_bundle(bundle())
        self.assertEqual(out["fields"][0]["value"], "line 1\n\n  spaced  ")
        self.assertEqual(out["fields"][1]["asset"], {"sha256": SHA, "original_name": "front.png"})
        self.assertIsNone(out["fields"][2]["asset"])
        self.assertIs(out["fields"][3]["value"], True)
        self.assertEqual(out["fields"][4]["value"], 42)
        self.assertIsInstance(out["fields"][5]["value"], float)
        self.assertEqual([f["name"] for f in out["fields"]], ["prompt", "ref_1", "ref_2", "use_bgm", "seed", "cfg"])

    def test_names_are_trimmed_and_composed(self):
        decomposed = unicodedata.normalize("NFD", "  빨간 드레스  ")
        self.assertEqual(normalize_bundle(bundle(name=decomposed))["name"], "빨간 드레스")

    def test_bundle_name_rules(self):
        for name in ("", "   ", "a" * (MAX_BUNDLE_NAME + 1), "two\nlines", "tab\tname", "spoof‮ed", None, 3):
            with self.subTest(name=name):
                self.assertRefused(bundle(name=name))
        self.assertEqual(normalize_bundle(bundle(name="a" * MAX_BUNDLE_NAME))["name"], "a" * MAX_BUNDLE_NAME)

    def test_field_names_are_unique_and_not_reserved(self):
        twice = [{"name": "p", "type": "text", "value": ""}, {"name": "p", "type": "int", "value": 1}]
        self.assertIn("Duplicate field name", self.assertRefused(bundle(fields=twice)))
        self.assertRefused(with_field(name="@name", type="text", value=""))
        # Different case is a different field: the loader matches names exactly.
        both = [{"name": "Ref", "type": "text", "value": ""}, {"name": "ref", "type": "text", "value": ""}]
        self.assertEqual(len(normalize_bundle(bundle(fields=both))["fields"]), 2)

    def test_length_limits_and_characters(self):
        long_name = "f" * MAX_FIELD_NAME
        self.assertEqual(normalize_bundle(with_field(name=long_name, type="int", value=1))["fields"][0]["name"], long_name)
        self.assertRefused(with_field(name=long_name + "f", type="int", value=1))
        for name in ("two\nlines", "spoof\u202eed", "nul\x00"):
            with self.subTest(name=name):
                self.assertRefused(with_field(name=name, type="int", value=1))
        self.assertEqual(normalize_bundle(bundle(tags=["t" * MAX_TAG_LENGTH]))["tags"], ["t" * MAX_TAG_LENGTH])
        self.assertRefused(bundle(tags=["t" * (MAX_TAG_LENGTH + 1)]))
        self.assertEqual(len(normalize_bundle(bundle(note="n" * MAX_NOTE))["note"]), MAX_NOTE)
        self.assertRefused(bundle(note="n" * (MAX_NOTE + 1)))

    def test_unknown_types_are_refused(self):
        self.assertRefused(with_field(type="video", value=None), code="unsupported_type")
        self.assertRefused(with_field(type=None, value=None), code="unsupported_type")

    def test_values_must_match_their_type(self):
        refused = [
            dict(type="text", value=3),
            dict(type="text", value="가" * (MAX_TEXT_BYTES // 3 + 1)),
            dict(type="boolean", value=1),
            dict(type="int", value=True),
            dict(type="int", value=1.5),
            dict(type="int", value=2 ** 63),
            dict(type="float", value="1"),
            dict(type="float", value=float("nan")),
            dict(type="float", value=float("inf")),
            dict(type="text"),
        ]
        for field in refused:
            with self.subTest(field=field):
                self.assertRefused(with_field(**field))
        self.assertEqual(normalize_bundle(with_field(type="int", value=-(2 ** 63)))["fields"][0]["value"], -(2 ** 63))
        self.assertEqual(normalize_bundle(with_field(type="text", value=""))["fields"][0]["value"], "")

    def test_tags_are_deduplicated_and_limited(self):
        out = normalize_bundle(bundle(tags=["Character", " character ", "h3"]))
        self.assertEqual(out["tags"], ["Character", "h3"])
        self.assertRefused(bundle(tags=[f"t{i}" for i in range(MAX_TAGS + 1)]))
        self.assertRefused(bundle(tags="character"))

    def test_field_count_is_limited(self):
        fields = [{"name": f"f{i}", "type": "int", "value": i} for i in range(MAX_FIELDS + 1)]
        self.assertRefused(bundle(fields=fields))

    def test_asset_references(self):
        self.assertRefused(with_field(type="image", asset={"sha256": "../../etc/passwd"}))
        self.assertRefused(with_field(type="image", asset={"sha256": SHA.upper()}))
        self.assertRefused(with_field(type="image", asset="a.png"))
        out = normalize_bundle(with_field(type="image", asset={
            "sha256": SHA, "ext": "exe", "width": -1, "height": 10, "original_name": "bad\x00name.png"}))
        self.assertEqual(out["fields"][0]["asset"], {"sha256": SHA, "height": 10, "original_name": "badname.png"})

    def test_empty_value_keeps_name_and_type(self):
        fields = normalize_bundle(bundle())["fields"]
        self.assertEqual([empty_value(f) for f in fields], [
            {"name": "prompt", "type": "text", "value": ""},
            {"name": "ref_1", "type": "image", "asset": None},
            {"name": "ref_2", "type": "image", "asset": None},
            {"name": "use_bgm", "type": "boolean", "value": False},
            {"name": "seed", "type": "int", "value": 0},
            {"name": "cfg", "type": "float", "value": 0.0},
        ])


class IdTest(unittest.TestCase):
    def test_ids(self):
        self.assertEqual(check_bundle_id("9bb2ab40-712f-4a7f-98ac-c3a99b8fd42e"), "9bb2ab40-712f-4a7f-98ac-c3a99b8fd42e")
        self.assertEqual(check_sha256(SHA), SHA)
        for bad in ("", "../x", "9BB2AB40-712F-4A7F-98AC-C3A99B8FD42E", "9bb2ab40712f4a7f98acc3a99b8fd42e", None):
            with self.subTest(bad=bad), self.assertRaises(LibraryError):
                check_bundle_id(bad)
        for bad in ("", "a" * 63, "g" * 64, "a" * 63 + "/", None):
            with self.subTest(bad=bad), self.assertRaises(LibraryError):
                check_sha256(bad)


if __name__ == "__main__":
    unittest.main()
