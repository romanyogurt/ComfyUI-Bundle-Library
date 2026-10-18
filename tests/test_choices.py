import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from bundle_library import choices
from bundle_library.choices import ComfyProvider, Lookup, classify, resolve
from bundle_library.slots import field_problem, output_fingerprint, resolve_slots, slot_problems
from bundle_library.store import BundleStore

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "choices.json"
SAMPLERS = ["euler", "euler_ancestral", "dpmpp_2m"]
PT = {".safetensors", ".ckpt", ".pt"}


class ClassifyTest(unittest.TestCase):
    """Which inputs a choice can take its options from (CH04): one choice among text options."""

    def test_one_choice_among_text_options(self):
        cases = {
            "an old node's list": ((SAMPLERS,), SAMPLERS),
            "with its settings": ((SAMPLERS, {"default": "euler", "tooltip": "x"}), SAMPLERS),
            "a model folder's list": ((["a.safetensors", "flux/b.safetensors"],), ["a.safetensors", "flux/b.safetensors"]),
            "a tuple": ((tuple(SAMPLERS), {}), SAMPLERS),
            # V3 Combo.Input.as_dict(): "multiselect": false is said by every one
            "a V3 dropdown": (("COMBO", {"multiselect": False, "options": SAMPLERS, "default": "euler"}), SAMPLERS),
            "an image upload's list": ((["a.png", "b.png"], {"image_upload": True}), ["a.png", "b.png"]),
        }
        for label, (spec, options) in cases.items():
            with self.subTest(label):
                self.assertEqual(classify(spec), (choices.READ, tuple(options), ""))

    def test_an_empty_list_is_read(self):
        self.assertEqual(classify(([],)), (choices.READ, (), ""))  # no LoRAs here: nothing is one of them
        self.assertEqual(classify(("COMBO", {"multiselect": False, "options": []})), (choices.READ, (), ""))

    def test_what_is_not_one_choice_among_text_options_says_why(self):
        cases = {
            "numbers (a Combo of ints)": ((["1", 2, 4],), choices.NOT_TEXT),
            "only numbers": (("COMBO", {"multiselect": False, "options": [1, 2, 4]}), choices.NOT_TEXT),
            "true and false": (([True, False],), choices.NOT_TEXT),
            "text and numbers": ((["auto", 5, 10],), choices.NOT_TEXT),
            "several to choose (V3 MultiCombo)": (("COMBO", {"multiselect": True, "options": SAMPLERS, "multi_select": {}}),
                                                  choices.MULTISELECT),
            "several, by the page's settings only": ((SAMPLERS, {"multi_select": {"placeholder": "Pick"}}), choices.MULTISELECT),
            "several, with no settings": ((SAMPLERS, {"multi_select": {}}), choices.MULTISELECT),
            "options fetched by the page": (("COMBO", {"remote": {"route": "/voices", "refresh_button": True}}), choices.REMOTE),
            "a list fetched again by the page": ((SAMPLERS, {"remote": {"route": "/x"}}), choices.REMOTE),
            "a dropdown without options": (("COMBO", {"multiselect": False}), choices.REMOTE),
            "inputs that come with a choice": (("COMFY_DYNAMICCOMBO_V3", {"options": [{"key": "a", "inputs": {}}]}), choices.DYNAMIC),
            "a number": (("INT", {"default": 0}), choices.NOT_COMBO),
            "a text": (("STRING", {"multiline": True}), choices.NOT_COMBO),
            "a model": (("MODEL",), choices.NOT_COMBO),
            "nothing": ((), choices.NOT_COMBO),
            "not a definition": ("COMBO", choices.NOT_COMBO),
        }
        for label, (spec, reason) in cases.items():
            with self.subTest(label):
                self.assertEqual(classify(spec), (choices.UNSUPPORTED, None, reason))

    def test_numbers_stay_numbers(self):
        # "1" is not 1: a list of numbers is not taken as their text.
        state, options, _ = classify((["1", "2"],))
        self.assertEqual((state, options), (choices.READ, ("1", "2")))
        self.assertEqual(classify(([1, 2],))[0], choices.UNSUPPORTED)


class ResolveTest(unittest.TestCase):
    def test_the_cases_the_page_resolves_alike(self):
        # tests/js/choices.test.mjs resolves the same cases.
        cases = json.loads(FIXTURE.read_text(encoding="utf-8"))["resolve"]
        for case in cases:
            with self.subTest(case["case"]):
                found = case["lookup"]
                lookup = None if found is None else Lookup(found["state"], tuple(found.get("options", ())),
                                                           found.get("paths", False), found.get("reason", ""))
                source = {"node": "N", "input": "i"} if case["source"] else None
                resolved = resolve(case["value"], source, lookup)
                self.assertEqual((resolved.output, resolved.state), (case["output"], case["state"]))

    def test_every_state_of_a_lookup_is_in_the_cases(self):
        cases = json.loads(FIXTURE.read_text(encoding="utf-8"))["resolve"]
        self.assertEqual({c["state"] for c in cases},
                         {choices.NO_SOURCE, choices.OK, choices.MISMATCH, choices.NOT_FOUND, choices.UNSUPPORTED,
                          choices.ERROR})

    def test_a_lookup_as_the_api_answers_it(self):
        self.assertEqual(Lookup(choices.READ, ("a",), True, label="Load LoRA").answer(),
                         {"state": "read", "label": "Load LoRA", "options": ["a"], "paths": True})
        self.assertEqual(Lookup(choices.NOT_FOUND, reason=choices.NO_NODE, label="X").answer(),
                         {"state": "not_found", "label": "X", "reason": "no_node"})


def fake_comfy(classes, display=None, folders=None):
    """Stand-ins for ComfyUI's `nodes` and `folder_paths`: `classes` by id
    give their INPUT_TYPES() (a dict, or an exception to raise); `folders`
    give (extensions, files). They count what they are asked."""
    calls = {"inputs": [], "folders": []}

    def node_class(node, types):
        def input_types():
            calls["inputs"].append(node)
            if isinstance(types, Exception):
                raise types
            return types
        return SimpleNamespace(INPUT_TYPES=input_types, CATEGORY="loaders" if "Load" in node else "sampling")

    nodes = SimpleNamespace(NODE_CLASS_MAPPINGS={node: node_class(node, types) for node, types in classes.items()},
                            NODE_DISPLAY_NAME_MAPPINGS=display or {})
    folders = folders or {}

    def get_filename_list(folder):
        calls["folders"].append(folder)
        return list(folders[folder][1])

    folder_paths = SimpleNamespace(folder_names_and_paths={f: ([f"/models/{f}"], ext) for f, (ext, _) in folders.items()},
                                   get_filename_list=get_filename_list)
    return nodes, folder_paths, calls


LORAS = ["flux\\detail.safetensors", "style.safetensors"]
CLASSES = {
    "LoraLoader": {"required": {"model": ("MODEL",), "lora_name": (LORAS,), "strength_model": ("FLOAT", {})}},
    "KSamplerSelect": {"required": {"sampler_name": ("COMBO", {"multiselect": False, "options": SAMPLERS})}},
    "KSampler": {"required": {"sampler_name": (SAMPLERS,), "scheduler": (["normal", "karras"],), "seed": ("INT", {})},
                 "optional": {"extra": (["a", 1],)}},
    "VAELoader": {"required": {"vae_name": (["a.safetensors", "pixel_space"],)}},
    "OneLoraLoader": {"required": {"lora_name": (["style.safetensors"],)}},
    "Broken": RuntimeError("cannot list its models"),
    "Odd": {"required": {"voices": ("COMBO", {"remote": {"route": "/voices"}}), "tags": (["a", "b"], {"multi_select": {}})}},
    "NoCombo": {"required": {"text": ("STRING", {})}},
}
FOLDERS = {"loras": (PT, LORAS), "vae": (PT, ["a.safetensors"]), "custom_nodes": (set(), ["x/__init__.py"]),
           "configs": ({".yaml"}, ["v1.yaml"])}


class ComfyProviderTest(unittest.TestCase):
    def provider(self, classes=None, folders=None):
        nodes, folder_paths, self.calls = fake_comfy(CLASSES if classes is None else classes,
                                                     {"LoraLoader": "Load LoRA", "KSamplerSelect": "KSamplerSelect"},
                                                     FOLDERS if folders is None else folders)
        return ComfyProvider(nodes, folder_paths)

    def test_the_options_of_an_input(self):
        provider = self.provider()
        self.assertEqual(provider.lookup("KSamplerSelect", "sampler_name"),
                         Lookup(choices.READ, tuple(SAMPLERS), False, label="KSamplerSelect"))
        self.assertEqual(provider.lookup("KSampler", "scheduler"), Lookup(choices.READ, ("normal", "karras"), False, label="KSampler"))
        self.assertEqual(provider.lookup("KSampler", "extra").reason, choices.NOT_TEXT)  # optional inputs are read too

    def test_a_model_folders_list_is_a_list_of_paths(self):
        # CH05: only a list that is exactly a model folder's files takes "/" for "\"
        provider = self.provider()
        self.assertEqual(provider.lookup("LoraLoader", "lora_name"), Lookup(choices.READ, tuple(LORAS), True, label="Load LoRA"))
        self.assertFalse(provider.lookup("VAELoader", "vae_name").paths)  # more than the vae folder's files
        self.assertFalse(provider.lookup("OneLoraLoader", "lora_name").paths)  # some of the loras folder's files
        self.assertFalse(provider.lookup("KSampler", "sampler_name").paths)
        self.assertNotIn("custom_nodes", self.calls["folders"])  # never listed: not models, and every file of every pack
        self.assertNotIn("configs", self.calls["folders"])  # .yaml files only: these options are none
        self.assertEqual(sorted(self.calls["folders"]), ["loras", "vae"])  # each listed once by a provider

    def test_what_cannot_be_read_says_why(self):
        provider = self.provider()
        cases = {
            ("Gone", "x"): (choices.NOT_FOUND, choices.NO_NODE, "Gone"),
            ("LoraLoader", "gone"): (choices.NOT_FOUND, choices.NO_INPUT, "Load LoRA"),
            ("LoraLoader", "model"): (choices.UNSUPPORTED, choices.NOT_COMBO, "Load LoRA"),
            ("Odd", "voices"): (choices.UNSUPPORTED, choices.REMOTE, "Odd"),
            ("Odd", "tags"): (choices.UNSUPPORTED, choices.MULTISELECT, "Odd"),
            ("Broken", "x"): (choices.ERROR, choices.FAILED, "Broken"),
        }
        for (node, name), (state, reason, label) in cases.items():
            with self.subTest(f"{node}.{name}"), self.assertNoLogs() if node != "Broken" else self.assertLogs(level="WARNING"):
                lookup = provider.lookup(node, name)
                self.assertEqual((lookup.state, lookup.reason, lookup.label, lookup.options), (state, reason, label, ()))

    def test_each_class_is_asked_once_and_its_failure_stays_with_it(self):
        provider = self.provider()
        with self.assertLogs(level="WARNING") as logs:
            for _ in range(3):
                provider.lookup("KSampler", "sampler_name")
                provider.lookup("KSampler", "scheduler")
                provider.lookup("Broken", "x")
        self.assertEqual(sorted(self.calls["inputs"]), ["Broken", "KSampler"])
        self.assertEqual(len(logs.output), 1)
        self.assertEqual(provider.lookup("LoraLoader", "lora_name").state, choices.READ)

    def test_a_new_provider_reads_again(self):
        # one per judgement: lists change (a model added, ComfyUI's refresh)
        nodes, folder_paths, calls = fake_comfy(CLASSES, folders=FOLDERS)
        for _ in range(2):
            provider = ComfyProvider(nodes, folder_paths)
            provider.lookup("LoraLoader", "lora_name")
            provider.lookup("LoraLoader", "lora_name")
        self.assertEqual((calls["inputs"], calls["folders"]), (["LoraLoader"] * 2, ["loras"] * 2))

    def test_the_inputs_a_choice_can_take_options_from(self):
        with self.assertLogs(level="WARNING"):
            catalog = self.provider().catalog()
        by_node = {entry["node"]: entry for entry in catalog}
        self.assertEqual([e["node"] for e in catalog], sorted(by_node))
        self.assertNotIn("Broken", by_node)  # its failure leaves the others listed
        self.assertNotIn("NoCombo", by_node)
        self.assertEqual(by_node["LoraLoader"], {"node": "LoraLoader", "label": "Load LoRA", "category": "loaders",
                                                 "inputs": [{"input": "lora_name", "supported": True, "count": 2}]})
        self.assertEqual(by_node["KSampler"]["inputs"], [
            {"input": "sampler_name", "supported": True, "count": 3},
            {"input": "scheduler", "supported": True, "count": 2},
            {"input": "extra", "supported": False, "reason": choices.NOT_TEXT},
        ])
        self.assertEqual(by_node["Odd"]["inputs"], [{"input": "voices", "supported": False, "reason": choices.REMOTE},
                                                    {"input": "tags", "supported": False, "reason": choices.MULTISELECT}])


class Options:
    """A provider of fixed lookups, by (node, input), that counts what it is asked."""

    def __init__(self, **lookups):
        self.lookups = {tuple(key.split(".")): value for key, value in lookups.items()}
        self.asked = []

    def lookup(self, node, input_name):
        self.asked.append((node, input_name))
        return self.lookups.get((node, input_name), Lookup(choices.NOT_FOUND, reason=choices.NO_NODE, label=node))


def read(options, paths=False, label="Load LoRA"):
    return Lookup(choices.READ, tuple(options), paths, label=label)


def choice(value, node="LoraLoader", input_name="lora_name", **more):
    field = {"name": "lora", "type": "choice", "value": value, **more}
    if node is not None:
        field["source"] = {"node": node, "input": input_name}
    return field


class ChoiceSlotsTest(unittest.TestCase):
    SLOTS = [("prompt", "text"), ("lora", "choice")]

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.store = BundleStore(Path(tmp.name))

    def fields(self, lora):
        return {"prompt": {"name": "prompt", "type": "text", "value": "a red dress"}, "lora": lora}

    def judge(self, lora, provider):
        """(problems, outputs, fingerprint) as Load Bundle makes them."""
        fields = self.fields(lora)
        resolved = resolve_slots(self.SLOTS, fields, provider)
        problems = slot_problems(self.store, self.SLOTS, fields, resolved)
        outputs = {index: r.output for index, r in resolved.items()}
        return problems, outputs, output_fingerprint(self.SLOTS, fields, problems, resolved)

    def test_a_value_not_among_its_sources_options_cannot_fill_its_slot(self):
        problems, outputs, _ = self.judge(choice("gone.safetensors"), Options(**{"LoraLoader.lora_name": read(LORAS, True)}))
        self.assertEqual(problems, {1: "is 'gone.safetensors', not one of Load LoRA's lora_name here"})
        self.assertEqual(outputs, {1: "gone.safetensors"})
        self.assertIsNone(field_problem(self.store, choice("gone.safetensors"), "choice"))  # not resolved: not checked

    def test_what_passes_unchecked(self):
        cases = {
            "typed freely": (choice("anything", node=None), Options()),
            "the source is not here": (choice("x.safetensors"), Options()),
            "the source cannot be read": (choice("x"), Options(**{"LoraLoader.lora_name": Lookup(choices.ERROR, reason=choices.FAILED)})),
            "the source is not one choice among text": (choice("4"), Options(**{"LoraLoader.lora_name": Lookup(choices.UNSUPPORTED, reason=choices.NOT_TEXT)})),
        }
        for label, (field, provider) in cases.items():
            with self.subTest(label):
                problems, outputs, _ = self.judge(field, provider)
                self.assertEqual((problems, outputs), ({}, {1: field["value"]}))
        no_source = Options()
        self.judge(choice("anything", node=None), no_source)
        self.assertEqual(no_source.asked, [])  # nothing to look up

    def test_the_other_problems_come_first_and_are_not_looked_up(self):
        provider = Options(**{"LoraLoader.lora_name": read(LORAS, True)})
        self.assertEqual(self.judge(choice("gone", enabled=False), provider)[0], {1: "is turned off in the bundle"})
        self.assertEqual(self.judge({"name": "lora", "type": "text", "value": "style.safetensors"}, provider)[0],
                         {1: "is text, not choice"})
        self.assertEqual(provider.asked, [])
        slots = [("lora", "text")]
        fields = {"lora": choice("style.safetensors")}
        self.assertEqual(slot_problems(self.store, slots, fields, resolve_slots(slots, fields, provider)),
                         {0: "is choice, not text"})

    def test_a_choice_carries_its_value_as_its_source_spells_it(self):
        _, outputs, _ = self.judge(choice("flux/detail.safetensors"), Options(**{"LoraLoader.lora_name": read(LORAS, True)}))
        self.assertEqual(outputs, {1: "flux\\detail.safetensors"})
        problems, outputs, _ = self.judge(choice("flux/detail.safetensors", node="Styles", input_name="style"),
                                          Options(**{"Styles.style": read(LORAS, False, "Styles")}))
        self.assertEqual(problems, {1: "is 'flux/detail.safetensors', not one of Styles's style here"})

    def test_the_fingerprint_follows_what_the_output_carries(self):
        # CH02: the stored value is the same in each case; what is carried, or whether it can be, differs.
        value = choice("flux/detail.safetensors")

        def fingerprint(options, paths=True, field=value):
            return self.judge(field, Options(**{"LoraLoader.lora_name": read(options, paths)}))[2]

        valid = fingerprint(["flux/detail.safetensors", "style.safetensors"])
        invalid = fingerprint(["style.safetensors"])
        self.assertNotEqual(valid, invalid)  # valid -> invalid, and back
        self.assertEqual(fingerprint(["style.safetensors"]), invalid)
        self.assertNotEqual(fingerprint(["flux\\detail.safetensors", "style.safetensors"]), valid)  # only the spelling
        # options it does not take: added, in another order, or removed
        self.assertEqual(fingerprint(["new.safetensors", "style.safetensors", "flux/detail.safetensors"]), valid)
        self.assertEqual(fingerprint(["flux/detail.safetensors"]), valid)
        # another source: a fingerprint of what it carries, not of where it is checked
        other = self.judge(choice("flux/detail.safetensors", node="UNETLoader", input_name="unet_name"),
                           Options(**{"UNETLoader.unet_name": read(["flux\\detail.safetensors"], True, "Load Diffusion Model")}))[2]
        self.assertNotEqual(other, valid)
        same = self.judge(choice("flux/detail.safetensors", node="UNETLoader", input_name="unet_name"),
                          Options(**{"UNETLoader.unet_name": read(["flux/detail.safetensors"], True, "Load Diffusion Model")}))[2]
        self.assertEqual(same, valid)
        # not checked: as it is stored, the same as one that is one of the options
        self.assertEqual(self.judge(value, Options())[2], valid)

    def test_a_choice_and_a_text_of_the_same_value_carry_different_types(self):
        text = output_fingerprint([("lora", "text")], {"lora": {"name": "lora", "type": "text", "value": "a"}})
        chosen = output_fingerprint([("lora", "choice")], {"lora": choice("a", node=None)},
                                    resolved=resolve_slots([("lora", "choice")], {"lora": choice("a", node=None)}, Options()))
        self.assertNotEqual(text, chosen)


if __name__ == "__main__":
    unittest.main()
