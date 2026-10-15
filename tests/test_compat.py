"""The compatibility contract, against the fixtures of tests/fixtures/compat
(see its README): files written by released versions and hand-made files at
the edges of the format."""

import hashlib
import json
import os
import shutil
import tempfile
import time
import unittest
import uuid
import zipfile
from pathlib import Path
from unittest import mock

from bundle_library import schema
from bundle_library.constants import ASSET_GRACE_SECONDS
from bundle_library.model import LibraryError
from bundle_library.slots import parse_slot_spec
from bundle_library.store import BundleStore

COMPAT = Path(__file__).parent / "fixtures" / "compat"
EXPECTED = json.loads((COMPAT / "handmade" / "expected.json").read_text(encoding="utf-8"))
RELEASES = ("0.0.2-phase1", "0.0.8-phase6", "0.0.10")


def snapshot(root):
    """Every file under `root` with its bytes, to show that reading wrote nothing."""
    return {p.relative_to(root): p.read_bytes() for p in sorted(root.rglob("*")) if p.is_file()}


class CompatTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)

    def library(self, *folders):
        """A library made of fixture folders (copied, so the fixtures stay as they are)."""
        root = self.tmp / f"lib-{uuid.uuid4().hex[:8]}"
        root.mkdir()
        for folder in folders:
            shutil.copytree(COMPAT / folder, root, dirs_exist_ok=True)
        return root

    def handmade(self, *keys):
        """A library holding these hand-made files, each named by its id."""
        root = self.tmp / f"hand-{uuid.uuid4().hex[:8]}"
        (root / "bundles").mkdir(parents=True)
        shutil.copytree(COMPAT / "0.0.2-phase1" / "assets", root / "assets")
        names = {}
        for key in keys:
            file_id = EXPECTED[key]["id"] or str(uuid.uuid4())
            names[key] = f"{file_id}.json"
            shutil.copy(COMPAT / "handmade" / f"{key}.json", root / "bundles" / names[key])
        return root, names

    def refused(self, call, code):
        with self.assertRaises(LibraryError) as ctx:
            call()
        self.assertEqual(ctx.exception.code, code, ctx.exception.message)

    # ---- files written by released versions ---------------------------------

    def test_released_libraries_are_read_as_they_are(self):
        for release in RELEASES:
            with self.subTest(release=release):
                root = self.library(release)
                active_files = {p.name: p.read_bytes() for p in (root / "bundles").iterdir()}
                store = BundleStore(root)
                listing = store.list()
                self.assertEqual(listing["errors"], [])
                self.assertTrue(listing["bundles"] and all("warnings" not in b for b in listing["bundles"]))
                for summary in listing["bundles"]:
                    bundle = store.get(summary["id"])
                    self.assertIsNone(bundle["deleted_at"])
                    for field in bundle["fields"]:
                        if field.get("asset"):
                            self.assertIsNotNone(store.assets.path(field["asset"]["sha256"]), field["name"])
                # The version-1 files were read, not written.
                self.assertEqual({name: (root / "bundles" / name).read_bytes() for name in active_files}, active_files)

    def test_values_survive_from_0_0_2(self):
        store = BundleStore(self.library("0.0.2-phase1"))
        [summary] = store.list()["bundles"]
        values = {f["name"]: f.get("value", f.get("asset")) for f in store.get(summary["id"])["fields"]}
        self.assertEqual(values["prompt"], "A red dress.\n\n  Two blank lines and spaces kept.  ")
        self.assertEqual((values["ref_2"], values["use_bgm"], values["steps"], values["cfg"]), (None, True, 42, 4.5))

    def test_the_0_0_10_trash_folder_moves_into_the_bundles(self):
        root = self.library("0.0.10")
        [old] = list((root / "trash").iterdir())
        bundle_id, stamp = old.stem.split(".")
        store = BundleStore(root)
        self.assertFalse((root / "trash").exists())
        [entry] = store.trash()["trash"]
        self.assertEqual((entry["id"], entry["name"]), (bundle_id, "Trashed in 0.0.10"))
        self.assertEqual(entry["deleted_at"], f"{stamp[:4]}-{stamp[4:6]}-{stamp[6:8]}T{stamp[9:11]}:{stamp[11:13]}:"
                                              f"{stamp[13:15]}.000Z")
        moved = json.loads((root / "bundles" / f"{bundle_id}.json").read_text(encoding="utf-8"))
        self.assertEqual((moved["schema_version"], moved["revision"]), (2, 1))
        restored = store.restore(bundle_id)
        self.assertEqual((restored["name"], restored["deleted_at"]), ("Trashed in 0.0.10", None))

    def test_a_restored_0_0_10_backup_moves_its_trash_too(self):
        root = self.tmp / "restored"
        with zipfile.ZipFile(COMPAT / "backup-0.0.10.zip") as archive:
            archive.extractall(self.tmp / "unzipped")
        shutil.move(self.tmp / "unzipped" / "bundle_library", root)
        store = BundleStore(root)
        self.assertEqual((store.health()["bundles"], store.health()["trash"]), (1, 1))
        self.assertFalse((root / "trash").exists())

    def test_the_0_0_10_workflow_outputs_parse(self):
        workflow = json.loads((COMPAT / "0.0.10-workflow" / "workflow.json").read_text(encoding="utf-8"))
        [node] = [n for n in workflow["nodes"] if n["type"] == "BundleLibraryLoad"]
        self.assertEqual(parse_slot_spec(node["widgets_values"][1]),
                         [("prompt", "text"), ("ref", "image"), ("seed", "int"), ("flag", "boolean")])
        unknown = json.loads((COMPAT / "0.0.10-workflow" / "workflow-unknown-slot-type.json").read_text(encoding="utf-8"))
        [node] = [n for n in unknown["nodes"] if n["type"] == "BundleLibraryLoad"]
        with self.assertRaisesRegex(ValueError, "newer Bundle Library"):
            parse_slot_spec(node["widgets_values"][1])

    # ---- hand-made files ------------------------------------------------------

    def test_hand_made_files_land_in_their_states(self):
        root, names = self.handmade(*EXPECTED)
        before = snapshot(root)
        store = BundleStore(root)
        listing = store.list()
        errors = {e["file"]: e["code"] for e in listing["errors"]}
        listed = {b["id"] for b in listing["bundles"]}
        for key, expected in EXPECTED.items():
            with self.subTest(key):
                path = root / "bundles" / names[key]
                loaded = schema.read_file(path, path.stem)
                self.assertEqual(loaded.state, expected["state"], loaded.problem)
                self.assertEqual(errors.get(f"bundles/{names[key]}"), expected["error_code"])
                in_use = expected["state"] in schema.READABLE and not loaded.deleted
                self.assertEqual(path.stem in listed, in_use)
        store.health()
        store.trash()
        for key in EXPECTED:
            try:
                store.get(names[key][:-5])
            except LibraryError:
                pass
        self.assertEqual(snapshot(root), before)  # reading wrote nothing

    def test_warnings_are_listed_and_large_ints_kept_exactly(self):
        root, names = self.handmade("int-2p53-plus-1", "int-2p60", "int-int64-max", "name-121")
        store = BundleStore(root)
        listing = {b["id"]: b for b in store.list()["bundles"]}
        for key, value in (("int-2p53-plus-1", 2 ** 53 + 1), ("int-2p60", 2 ** 60), ("int-int64-max", 2 ** 63 - 1)):
            with self.subTest(key):
                bundle_id = names[key][:-5]
                self.assertEqual(len(listing[bundle_id]["warnings"]), 1)
                seed = next(f for f in store.get(bundle_id)["fields"] if f["name"] == "seed")
                self.assertEqual(seed["value"], value)
                self.assertEqual([f["preview"] for f in listing[bundle_id]["fields"] if f["name"] == "seed"], [str(value)])
        self.assertEqual(store.get(names["name-121"][:-5])["name"], "n" * 121)

    def test_files_not_fully_understood_are_never_written(self):
        keys = [k for k, e in EXPECTED.items() if e["state"] not in schema.WRITABLE]
        root, names = self.handmade(*keys)
        store = BundleStore(root)
        before = snapshot(root)
        data = {"name": "x", "fields": []}
        for key in keys:
            bundle_id = names[key][:-5]
            with self.subTest(key):
                for call in (lambda: store.update(bundle_id, data, 3), lambda: store.delete(bundle_id, 3),
                             lambda: store.duplicate(bundle_id), lambda: store.restore(bundle_id),
                             lambda: store.purge(bundle_id)):
                    with self.assertRaises(LibraryError):
                        call()
        self.assertEqual(store.empty_trash(), 0)
        self.assertEqual(snapshot(root), before)

    def test_cleanup_stops_for_a_newer_file_that_points_elsewhere(self):
        root, names = self.handmade("v3-other-references")
        white = COMPAT / "0.0.10" / "assets" / "sha256" / "9e"
        shutil.copytree(white, root / "assets" / "sha256" / "9e")
        old = time.time() - ASSET_GRACE_SECONDS - 3600
        for path in (root / "assets").rglob("*.png"):
            os.utime(path, (old, old))
        store = BundleStore(root)
        self.refused(store.unused_assets, "unreadable_bundles")
        self.refused(lambda: store.delete_unused_assets([path.stem for path in (root / "assets").rglob("*.png")]),
                     "unreadable_bundles")
        self.assertEqual(len(list((root / "assets").rglob("*.png"))), 2)

    def test_bundles_may_share_a_name(self):
        root, names = self.handmade("same-name-1", "same-name-2")
        listed = BundleStore(root).list()["bundles"]
        self.assertEqual([b["name"] for b in listed], ["Same name", "Same name"])
        self.assertEqual(sorted(b["id"] for b in listed), sorted(n[:-5] for n in names.values()))

    # ---- the old trash folder ------------------------------------------------

    def test_the_old_trash_folder_moves_only_what_is_safe(self):
        root = self.library("legacy-trash")
        expected = json.loads((root / "expected.json").read_text(encoding="utf-8"))
        store = BundleStore(root)
        trashed = {entry["id"]: entry for entry in store.trash()["trash"]}
        self.assertIn(expected["moved"][0], trashed)
        twice = expected["moved_twice_trashed"]
        self.assertEqual(json.loads((root / "bundles" / f"{twice['id']}.json").read_text(encoding="utf-8"))["note"],
                         "newer copy")  # the copy deleted last
        self.assertEqual(sorted(p.name for p in (root / "trash").iterdir()), sorted(expected["left"]))
        self.assertEqual(sorted(store.health()["legacy_trash"]), sorted(expected["left"]))
        reported = [e for e in store.trash()["errors"] if e["code"] == "legacy_trash"]
        self.assertEqual(sorted(e["file"] for e in reported), sorted(f"trash/{n}" for n in expected["left"]))
        self.refused(store.unused_assets, "unreadable_bundles")  # one of them cannot be read

    # ---- migrations -----------------------------------------------------------

    def test_a_migration_step_runs_in_memory_and_repeats_the_same(self):
        root = self.library("0.0.2-phase1")
        [path] = (root / "bundles").iterdir()
        before = path.read_bytes()
        step = lambda data: {**data, "schema_version": 3, "rating": 0}  # noqa: E731 - a test-only version 3
        with mock.patch.object(schema, "SCHEMA_VERSION", 3), \
                mock.patch.dict(schema.MIGRATIONS, {2: step}), \
                mock.patch.dict(schema.TOP_KEYS, {3: schema.TOP_KEYS[2] | {"rating"}}):
            first = schema.read_file(path, path.stem)
            second = schema.read_file(path, path.stem)
        self.assertEqual(first.state, schema.OK)
        self.assertEqual((first.bundle["schema_version"], first.bundle["rating"], first.bundle["deleted_at"]), (3, 0, None))
        self.assertEqual(first.bundle, second.bundle)
        self.assertEqual(path.read_bytes(), before)

    def test_writes_use_the_current_version(self):
        root = self.library("0.0.2-phase1")
        store = BundleStore(root)
        [summary] = store.list()["bundles"]
        store.delete(summary["id"], summary["revision"])
        stored = json.loads((root / "bundles" / f"{summary['id']}.json").read_text(encoding="utf-8"))
        self.assertEqual(stored["schema_version"], schema.SCHEMA_VERSION)
        self.assertEqual(hashlib.sha256(json.dumps(stored["fields"], sort_keys=True).encode()).hexdigest(),
                         hashlib.sha256(json.dumps(store.restore(summary["id"])["fields"], sort_keys=True)
                                        .encode()).hexdigest())


if __name__ == "__main__":
    unittest.main()
