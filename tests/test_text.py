import ast
import json
import unittest
from pathlib import Path

from bundle_library.text import Text, Word, said

PACKAGE = Path(__file__).resolve().parents[1] / "bundle_library"


class TextTest(unittest.TestCase):
    """Messages a page can say in its own language (Phase 9b): the English as before, and its template and values."""

    def test_a_text_is_its_english_and_remembers_how_it_was_made(self):
        label = Text("Field '{name}'", name="ref")
        message = Text("{label}: the file is {kind}, not {type}.", label=label, kind=Word("an audio"), type=Word("an image"))
        self.assertEqual(message, "Field 'ref': the file is an audio, not an image.")
        self.assertIsInstance(message, str)
        self.assertEqual(message.info(), {"template": "{label}: the file is {kind}, not {type}.", "values": {
            "label": {"template": "Field '{name}'", "values": {"name": "ref"}},
            "kind": {"word": "an audio"}, "type": {"word": "an image"}}})
        self.assertEqual(Text("not a ZIP file ({e})", e=ValueError("bad")).info()["values"], {"e": "bad"})

    def test_an_answer_carries_each_text_beside_it(self):
        answer = said({"results": [{"id": "a", "message": Text("In the trash."), "name": "plain"}],
                       "warnings": [Text("Tags: at most {n}.", n=20), "plain"], "count": 3})
        self.assertEqual(answer["results"][0]["message_i18n"], {"template": "In the trash.", "values": {}})
        self.assertNotIn("name_i18n", answer["results"][0])
        self.assertEqual(answer["warnings_i18n"], [{"template": "Tags: at most {n}.", "values": {"n": 20}}, None])
        self.assertEqual(json.loads(json.dumps(answer))["results"][0]["message"], "In the trash.")

    def test_every_message_the_server_raises_is_a_text(self):
        plain = []
        for path in sorted(PACKAGE.glob("*.py")):
            for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
                if not isinstance(node, ast.Call):
                    continue
                name = getattr(node.func, "id", getattr(node.func, "attr", None))
                message = (node.args[2] if name == "LibraryError" and len(node.args) > 2
                           else node.args[0] if name in ("invalid", "_bad") and node.args else None)
                if isinstance(message, (ast.Constant, ast.JoinedStr, ast.BinOp)):
                    plain.append(f"{path.name}:{node.lineno}")
        self.assertEqual(plain, [], "a message the page cannot translate: make it a Text (bundle_library/text.py)")
