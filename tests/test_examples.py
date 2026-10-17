"""The examples that come with the pack (0.0.33): the bundles of web/examples/ import whole, and every
workflow of workflows/ runs with any of them, so switching bundles keeps its links."""

import json
import tempfile
import unittest
from pathlib import Path

from bundle_library.constants import MEDIA_TYPES
from bundle_library.exchange import Imports
from bundle_library.slots import parse_slot_spec
from bundle_library.store import BundleStore

ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = ROOT / "web" / "examples" / "example-bundles.zip"
WORKFLOWS = sorted((ROOT / "workflows").glob("*.json"))


def load_bundle_nodes(workflow):
    """Every Load Bundle node of a workflow, those in its subgraphs too."""
    nodes = list(workflow.get("nodes", []))
    for subgraph in workflow.get("definitions", {}).get("subgraphs", []):
        nodes += subgraph.get("nodes", [])
    return [node for node in nodes if node.get("type") == "BundleLibraryLoad"]


class ExamplesTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.store = BundleStore(Path(tmp.name))
        imports = Imports(self.store.tmp_dir)
        token, part = imports.new_part()
        part.write_bytes(EXAMPLES.read_bytes())
        part.replace(part.with_suffix(".zip"))
        self.preview = imports.inspect(self.store, token)
        self.answer = imports.apply(self.store, token, "skip", {"mode": "zip"})
        self.bundles = {b["id"]: self.store.get(b["id"]) for b in self.store.list()["bundles"]}

    def test_the_example_bundles_import_whole(self):
        self.assertTrue(all(b["importable"] for b in self.preview["bundles"]), self.preview["bundles"])
        self.assertEqual(self.preview["assets"]["missing"], 0)
        self.assertEqual((self.answer["imported"], self.answer["failed"], self.answer["files"]["failed"]),
                         (len(self.preview["bundles"]), 0, []))
        self.assertEqual(len(self.bundles), len(self.preview["bundles"]))
        for bundle in self.bundles.values():
            for field in bundle["fields"]:
                if field["type"] in MEDIA_TYPES:  # a linked media field without a file stops the run
                    self.assertIsNotNone(field["asset"], f"{bundle['name']}: '{field['name']}' has no file")
                    self.assertIsNotNone(self.store.assets.path(field["asset"]["sha256"]))

    def test_each_workflow_runs_with_any_example_bundle(self):
        self.assertTrue(WORKFLOWS)
        for path in WORKFLOWS:
            with self.subTest(path.name):
                workflow = json.loads(path.read_text(encoding="utf-8"))
                nodes = load_bundle_nodes(workflow)
                self.assertTrue(nodes, "no Load Bundle node")
                for node in nodes:
                    bundle_id, slot_spec = node["widgets_values"][:2]
                    self.assertIn(bundle_id, self.bundles, "the node's bundle is not an example")
                    self.assertEqual(node["properties"].get("bundle_name"), self.bundles[bundle_id]["name"])
                    slots = parse_slot_spec(slot_spec)
                    for bundle in self.bundles.values():
                        fields = {f["name"]: f["type"] for f in bundle["fields"] if f.get("enabled", True)}
                        for name, field_type in slots:
                            self.assertEqual(fields.get(name), field_type, f"'{name}' in {bundle['name']}")
                self.assertTrue(path.with_suffix(".jpg").is_file(), "no thumbnail beside it")


if __name__ == "__main__":
    unittest.main()
