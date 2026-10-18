"""Choice fields with the real executor (0.2.0): what a choice output carries,
when it stops a run, and when ComfyUI's output cache keeps it (CH01, CH02, CH05).

- A choice whose source has it runs, as the source spells it, and comes from the
  cache the next time; one that does not stops the run with the reason when it
  is linked, and a node linked to it later when it is not.
- A choice with no source, or whose source this ComfyUI does not have, runs as
  it is.
- A path in a model folder's list (LoraLoader) written with the other slash goes
  out as the list spells it; when the spelling there changes, the nodes reading
  it run again, and a file added that it is not stays cached.
- A list that changes between the cache key and the run fails that run.

Runs ComfyUI's PromptExecutor in-process, in CPU mode, on a temporary library and
a temporary loras folder, so it can run beside the server:
    docker exec -w /opt/ComfyUI/custom_nodes/ComfyUI-Bundle-Library bundle-library-test python tests/e2e/choice_run.py
On Linux a file name may hold a backslash, which stands here for Windows's paths.
"""

import json
import os
import sys
import tempfile
from pathlib import Path

PACKAGE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.argv = [sys.argv[0], "--cpu"]
sys.path[:0] = [PACKAGE, "/opt/ComfyUI"]  # this package first: ComfyUI has a "tests" package too

import comfy.options  # noqa: E402

comfy.options.enable_args_parsing()

import folder_paths  # noqa: E402
import nodes  # noqa: E402
from comfy_extras.nodes_preview_any import PreviewAny  # noqa: E402

import bundle_library.nodes as bundle_nodes  # noqa: E402
from bundle_library.nodes import LoadBundle  # noqa: E402
from bundle_library.store import BundleStore  # noqa: E402
from tests.e2e.cache_race import LocalServer, Runner, check, racing, spec, RESULTS  # noqa: E402


LORA_LOADER = nodes.NODE_DISPLAY_NAME_MAPPINGS.get("LoraLoader", "LoraLoader")


def choice_bundle(name, value, source=None, name_of_field="pick"):
    field = {"name": name_of_field, "type": "choice", "value": value}
    if source:
        field["source"] = {"node": source[0], "input": source[1]}
    return {"name": name, "tags": [], "note": "", "fields": [field]}


def shows(node="2", source="1", slot=0):
    return {node: {"class_type": "PreviewAny", "inputs": {"source": [source, slot]}}}


def main():
    with tempfile.TemporaryDirectory(prefix="bundle-choice-") as folder:
        store = BundleStore(Path(folder) / "library")
        loras = Path(folder) / "loras"
        loras.mkdir()
        folder_paths.folder_names_and_paths["loras"] = ([str(loras)], folder_paths.supported_pt_extensions)
        bundle_nodes.get_store = lambda: store
        nodes.NODE_CLASS_MAPPINGS["BundleLibraryLoad"] = LoadBundle
        nodes.NODE_CLASS_MAPPINGS["PreviewAny"] = PreviewAny
        server = LocalServer()
        one = spec(("pick", "choice"))

        def loader(bundle):
            return {"1": {"class_type": "BundleLibraryLoad", "inputs": {"bundle_id": bundle["id"], "slot_spec": one}}}

        # ---- checked against the source's options (CH01) ---------------------------------------------
        good = store.create(choice_bundle("Euler", "euler", ("KSampler", "sampler_name")))
        prompt = {**loader(good), **shows()}
        runner = Runner(server)
        first, second = runner.run(prompt, ["2"]), runner.run(prompt, ["2"])
        check("a choice among its source's options runs, then comes from the cache",
              first["success"] and first["shown"] == {"2": "euler"} and second["success"]
              and {"1", "2"} <= set(second["cached"]), {"first": first, "second": second})
        bad = store.create(choice_bundle("Typo", "eulerr", ("KSampler", "sampler_name")))
        failed = Runner(server).run({**loader(bad), **shows()}, ["2"])
        check("one that is not stops the run with the reason when it is linked",
              not failed["success"] and "'pick' is 'eulerr', not one of KSampler's sampler_name here"
              in failed["errors"].get("1", ""), failed)
        two = spec(("pick", "choice"), ("other", "choice"))
        mixed = store.create({"name": "Mixed", "tags": [], "note": "", "fields": [
            {"name": "pick", "type": "choice", "value": "euler", "source": {"node": "KSampler", "input": "sampler_name"}},
            {"name": "other", "type": "choice", "value": "nope", "source": {"node": "KSampler", "input": "scheduler"}}]})
        unlinked = {"1": {"class_type": "BundleLibraryLoad", "inputs": {"bundle_id": mixed["id"], "slot_spec": two}},
                    **shows()}
        runner = Runner(server)
        alone = runner.run(unlinked, ["2"])
        later = runner.run({**unlinked, **shows("3", "1", 1)}, ["2", "3"])
        check("not linked, it lets the run go; a node linked to it later stops with the reason",
              alone["success"] and alone["shown"] == {"2": "euler"} and "1" in later["cached"]
              and "cannot fill the output 'other': it is 'nope', not one of KSampler's scheduler here"
              in later["errors"].get("3", ""), {"alone": alone, "later": later})

        # ---- what passes unchecked (CH06) --------------------------------------------------------------
        for label, bundle in (("typed freely", choice_bundle("Free", "anything at all")),
                              ("a source this ComfyUI does not have", choice_bundle("Elsewhere", "x", ("Gone Pack (x)", "model"))),
                              ("an input that is not a dropdown", choice_bundle("Seed", "4", ("KSampler", "seed")))):
            ran = Runner(server).run({**loader(store.create(bundle)), **shows()}, ["2"])
            check(f"{label}: runs as it is, unchecked", ran["success"] and ran["shown"] == {"2": bundle["fields"][0]["value"]}, ran)

        # ---- a model folder's paths (CH05) and the cache (CH02) ----------------------------------------
        (loras / "flux\\detail.safetensors").touch()  # how Windows lists flux/detail.safetensors
        (loras / "style.safetensors").touch()
        lora = store.create(choice_bundle("LoRA", "flux/detail.safetensors", ("LoraLoader", "lora_name")))
        prompt = {**loader(lora), **shows()}
        runner = Runner(server)
        spelled = runner.run(prompt, ["2"])
        check("a path written with the other slash goes out as the model folder's list spells it",
              spelled["success"] and spelled["shown"] == {"2": "flux\\detail.safetensors"}, spelled)
        (loras / "added.safetensors").touch()
        kept = runner.run(prompt, ["2"])
        check("a file added to the folder that it is not keeps the cache", kept["success"]
              and {"1", "2"} <= set(kept["cached"]), kept)
        (loras / "flux\\detail.safetensors").unlink()
        (loras / "flux").mkdir()
        (loras / "flux" / "detail.safetensors").touch()  # now the list spells it as the bundle does
        respelled = runner.run(prompt, ["2"])
        check("when the list spells it otherwise, the nodes reading it run again with that spelling",
              respelled["success"] and respelled["shown"] == {"2": "flux/detail.safetensors"}
              and "1" not in respelled["cached"], respelled)
        (loras / "flux\\detail.safetensors").touch()  # both spellings there now
        both = runner.run(prompt, ["2"])
        check("the same text is taken first, and keeps the cache", both["success"]
              and both["shown"] == {"2": "flux/detail.safetensors"} and {"1", "2"} <= set(both["cached"]), both)
        (loras / "a").mkdir()
        (loras / "a" / "b\\c.safetensors").touch()  # a/b\c.safetensors
        (loras / "a\\b").mkdir()
        (loras / "a\\b" / "c.safetensors").touch()  # a\b/c.safetensors
        ambiguous = store.create(choice_bundle("Ambiguous", "a/b/c.safetensors", ("LoraLoader", "lora_name")))
        clash = Runner(server).run({**loader(ambiguous), **shows()}, ["2"])
        check("two files it matches either way: neither is chosen, and the run stops with the reason",
              not clash["success"] and f"'pick' is 'a/b/c.safetensors', not one of {LORA_LOADER}'s lora_name here"
              in clash["errors"].get("1", ""), clash)

        # ---- a list that changes between the cache key and the run (CH01, CH02) ------------------------
        race = store.create(choice_bundle("Race", "style.safetensors", ("LoraLoader", "lora_name")))
        prompt = {**loader(race), **shows()}
        undo = racing(store, "1", lambda: (loras / "style.safetensors").unlink())
        raced = Runner(server).run(prompt, ["2"])
        undo()
        check("a list that changed between the cache key and the run fails that run",
              not raced["success"] and "changed while this run was starting, or the options its choices are checked "
              "against did. Run it again." in raced["errors"].get("1", ""), raced)
        again = Runner(server).run(prompt, ["2"])
        check("run again, it says the file is not there now",
              not again["success"] and f"'pick' is 'style.safetensors', not one of {LORA_LOADER}'s lora_name here"
              in again["errors"].get("1", ""), again)

    failed = RESULTS.count(False)
    print(f"\n{len(RESULTS) - failed}/{len(RESULTS)} passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
