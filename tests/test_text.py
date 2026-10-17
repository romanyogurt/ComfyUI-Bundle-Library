import ast
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from bundle_library import text
from bundle_library.text import ENGLISH, Text, catalogs, language, said

PACKAGE = Path(__file__).resolve().parents[1] / "bundle_library"


class TextTest(unittest.TestCase):
    """Messages a page can say in its own language: the English from its catalog, and the id and values (0.0.27)."""

    def test_a_text_is_its_english_and_remembers_its_id_and_values(self):
        label = Text("check.field_label", name="ref")
        message = Text("check.string", label=label)
        self.assertEqual(message, "Field 'ref': must be a string.")
        self.assertIsInstance(message, str)
        self.assertEqual(message.info(), {"id": "check.string", "values": {
            "label": {"id": "check.field_label", "values": {"name": "ref"}}}})
        wrong = Text("store.wrong_kind", name="ref", kind=Text("kind.an_audio"), type=Text("kind.an_image"))
        self.assertEqual(wrong, "Field 'ref': the file is an audio, not an image.")
        self.assertEqual(wrong.info()["values"]["kind"], {"id": "kind.an_audio", "values": {}})
        self.assertEqual(Text("exchange.not_zip", e=ValueError("bad")).info()["values"], {"e": "bad"})
        self.assertEqual(Text("no.such_message"), "no.such_message")
        self.assertEqual(Text("category.not_found", id="c1").info(), {"id": "category.not_found", "values": {"id": "c1"}})

    def test_english_takes_the_form_for_the_count(self):
        self.assertEqual(Text("file.minutes", count=1), "1 minute")
        self.assertEqual(Text("file.minutes", count=5), "5 minutes")
        self.assertEqual(Text("file.seconds", count=1.5), "1.5 seconds")
        self.assertEqual(Text("file.audio_too_large", count=1, rate="48", length="1:00"),
                         "The audio is too large to load: with 1 channel at 48 kHz it may last at most 1:00.")
        self.assertEqual(Text("file.audio_too_large", count=6, rate="48", length="1:00"),
                         "The audio is too large to load: with 6 channels at 48 kHz it may last at most 1:00.")

    def test_an_answer_carries_each_text_beside_it(self):
        answer = said({"results": [{"id": "a", "message": Text("exchange.in_trash"), "name": "plain"}],
                       "warnings": [Text("check.tags_max", MAX_TAGS=20), "plain"], "count": 3})
        self.assertEqual(answer["results"][0]["message_i18n"], {"id": "exchange.in_trash", "values": {}})
        self.assertNotIn("name_i18n", answer["results"][0])
        self.assertEqual(answer["warnings_i18n"], [{"id": "check.tags_max", "values": {"MAX_TAGS": 20}}, None])
        self.assertEqual(json.loads(json.dumps(answer))["results"][0]["message"], "In the trash.")
        self.assertEqual(answer["warnings"][0], "Tags: at most 20.")

    def test_a_code_finds_its_language(self):
        languages = ["en", "ko", "zh", "zh-TW"]
        self.assertEqual(language("ko-KR", languages), "ko")
        self.assertEqual(language("zh-tw", languages), "zh-TW")
        self.assertEqual(language("zh_TW", languages), "zh-TW")
        self.assertEqual(language("zh-HK", languages), "zh")
        self.assertIsNone(language("fr", languages))
        self.assertIsNone(language("", languages))

    def test_the_catalogs_are_read_now_and_a_bad_one_is_left_out(self):
        self.assertIn("count.bundles", ENGLISH)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for lang, data in [("en", {"a.b": "A {x}"}), ("ko", {"a.b": {"en": "A {x}", "text": "가 {x}"}, "a.c": "plain"})]:
                (root / lang).mkdir()
                (root / lang / "bundle_library.json").write_text(json.dumps(data), encoding="utf-8")
            (root / "fr").mkdir()
            (root / "fr" / "bundle_library.json").write_text("{not json", encoding="utf-8")
            (root / "nodeDefs").mkdir()  # a folder without a catalog is no language
            with mock.patch.object(text, "LOCALES", root):
                self.assertEqual(catalogs("ko"), {"languages": ["en", "fr", "ko"],
                                                  "messages": {"en": {"a.b": "A {x}"}, "ko": {"a.b": "가 {x}"}}})
                with self.assertLogs(level="WARNING"):
                    self.assertEqual(catalogs("fr")["messages"], {"en": {"a.b": "A {x}"}})

    def test_every_text_gives_the_values_its_english_has_places_for(self):
        import re
        wrong = []
        for path in sorted(PACKAGE.glob("*.py")):
            for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
                if not (isinstance(node, ast.Call) and getattr(node.func, "id", None) == "Text" and node.args
                        and isinstance(node.args[0], ast.Constant)) or any(k.arg is None for k in node.keywords):
                    continue  # values given as **values are checked where they are made
                message = ENGLISH.get(node.args[0].value)
                if message is None:
                    wrong.append(f"{path.name}:{node.lineno}: no message {node.args[0].value}")
                    continue
                places = set(re.findall(r"\{(\w+)\}", json.dumps(message)))
                if places != {k.arg for k in node.keywords}:
                    wrong.append(f"{path.name}:{node.lineno}: {sorted(places)} != {sorted(k.arg for k in node.keywords)}")
        self.assertEqual(wrong, [])

    def test_every_message_the_server_raises_is_a_text(self):
        def written(value):  # a str in the code, not a Text
            return isinstance(value, (ast.JoinedStr, ast.BinOp)) or (
                isinstance(value, ast.Constant) and isinstance(value.value, str))
        plain = []
        for path in sorted(PACKAGE.glob("*.py")):
            for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
                # What is wrong with a file, which the page shows (0.0.32); not a node's error at run
                # time (slots.field_problem), which ComfyUI shows as it is.
                if isinstance(node, ast.FunctionDef) and node.name.endswith("_problem") and node.name != "field_problem":
                    plain += [f"{path.name}:{r.lineno}" for r in ast.walk(node) if isinstance(r, ast.Return)
                              and written(r.value)]
                if not isinstance(node, ast.Call):
                    continue
                name = getattr(node.func, "id", getattr(node.func, "attr", None))
                message = (node.args[2] if name == "LibraryError" and len(node.args) > 2
                           else node.args[0] if name in ("invalid", "_bad") and node.args else None)
                if isinstance(message, (ast.Constant, ast.JoinedStr, ast.BinOp)):
                    plain.append(f"{path.name}:{node.lineno}")
                problems = [k.value for k in node.keywords if k.arg == "problem"]
                place = {"Loaded": 2, "Organization": 1}.get(name)
                if place is not None and len(node.args) > place:
                    problems.append(node.args[place])
                plain += [f"{path.name}:{node.lineno}" for problem in problems if written(problem)]
        self.assertEqual(plain, [], "a message the page cannot translate: make it a Text (bundle_library/text.py)")
