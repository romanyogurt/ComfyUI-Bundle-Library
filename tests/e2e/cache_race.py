"""Load Bundle and ComfyUI's output cache, with the real executor (Phase 7.8s-3).

- A bundle changed after a run made its cache key, before the node ran, fails
  that run; the next run is not served what the changed bundle held (R15-01).
  Each loader is checked on its own; a renamed bundle keeps the cache.
- A bundle with an empty image field is cached like any other (N16).
- A slot the bundle cannot fill fails Load Bundle when the prompt links it; when
  it does not, a node linked to it after a cached run stops with the reason
  instead of reading None.

Runs ComfyUI's PromptExecutor in-process, in CPU mode, on a temporary library,
so it can run beside the server:
    docker exec -w /opt/ComfyUI/custom_nodes/ComfyUI-Bundle-Library bundle-library-test python tests/e2e/cache_race.py
"""

import copy
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

import execution  # noqa: E402
import nodes  # noqa: E402
from comfy_extras.nodes_preview_any import PreviewAny  # noqa: E402

import bundle_library.nodes as bundle_nodes  # noqa: E402
from bundle_library.nodes import LoadBundle  # noqa: E402
from bundle_library.store import BundleStore  # noqa: E402

RESULTS = []


def check(label, ok, detail=None):
    RESULTS.append(bool(ok))
    print(f"{'PASS' if ok else 'FAIL'}  {label}" + (f"  {json.dumps(detail, default=str)}" if detail is not None else ""))


class LocalServer:
    """What the executor reports to, kept in a list."""
    client_id = None
    last_node_id = None
    sockets_metadata = {}

    def __init__(self):
        self.events = []

    def send_sync(self, event, data, sid=None):
        self.events.append((event, data))

    def queue_updated(self):
        pass


def spec(*slots):
    return json.dumps({"v": 1, "slots": [{"name": name, "type": kind} for name, kind in slots]})


def text_bundle(name, value):
    return {"name": name, "tags": [], "note": "", "fields": [{"name": "prompt", "type": "text", "value": value}]}


class Runner:
    def __init__(self, server):
        self.server = server
        self.executor = execution.PromptExecutor(server, execution.CacheType.CLASSIC, {"ram": 0, "ram_inactive": 0})
        self.count = 0

    def run(self, prompt, outputs):
        """Run `prompt` for `outputs`: whether it succeeded, the text each preview showed, the nodes taken from the
        cache, and the error messages by node."""
        self.count += 1
        prompt_id = f"cache-check-{self.count}"
        self.server.events.clear()
        self.executor.execute(copy.deepcopy(prompt), prompt_id, {"client_id": "cache-check"}, outputs)
        result = copy.deepcopy(self.executor.history_result)
        events = [(e, d) for e, d in self.server.events if isinstance(d, dict) and d.get("prompt_id") == prompt_id]
        return {
            "success": self.executor.success,
            "shown": {node: out.get("text", [None])[0] for node, out in result.get("outputs", {}).items()},
            "cached": sorted({n for e, d in events if e == "execution_cached" for n in d.get("nodes", [])}),
            "errors": {d.get("node_id"): d.get("exception_message", "") for e, d in events if e == "execution_error"},
        }


def racing(store, node_id, change):
    """Make Load Bundle node `node_id` change its bundle (`change()`) just before it first executes."""
    original = LoadBundle.execute.__func__
    done = []

    def execute(cls, bundle_id, slot_spec):
        if not done and str(cls.hidden.unique_id) == node_id:
            done.append(1)
            change()
        return original(cls, bundle_id, slot_spec)

    LoadBundle.execute = classmethod(execute)
    return lambda: setattr(LoadBundle, "execute", classmethod(original))


def main():
    with tempfile.TemporaryDirectory(prefix="bundle-cache-") as folder:
        store = BundleStore(Path(folder))
        bundle_nodes.get_store = lambda: store
        nodes.NODE_CLASS_MAPPINGS["BundleLibraryLoad"] = LoadBundle
        nodes.NODE_CLASS_MAPPINGS["PreviewAny"] = PreviewAny
        server = LocalServer()

        # ---- a bundle changed between the cache key and execute (R15-01) --------------------------
        t = store.create(text_bundle("Text T", "A"))
        u = store.create(text_bundle("Text U", "U1"))
        one = spec(("prompt", "text"))
        prompt = {
            "1": {"class_type": "BundleLibraryLoad", "inputs": {"bundle_id": t["id"], "slot_spec": one}},
            "2": {"class_type": "PreviewAny", "inputs": {"source": ["1", 0]}},
            "3": {"class_type": "BundleLibraryLoad", "inputs": {"bundle_id": u["id"], "slot_spec": one}},
            "4": {"class_type": "PreviewAny", "inputs": {"source": ["3", 0]}},
        }
        runner = Runner(server)
        first = runner.run(prompt, ["2", "4"])
        check("a first run shows both bundles", first["success"] and first["shown"] == {"2": "A", "4": "U1"}, first)

        def to(bundle_id, value):
            return lambda: store.update(bundle_id, text_bundle(store.get(bundle_id)["name"], value),
                                        store.get(bundle_id)["revision"])

        to(t["id"], "A2")()  # a new key for loader 1; loader 3 stays cached
        undo = racing(store, "1", to(t["id"], "B"))
        raced = runner.run(prompt, ["2", "4"])
        undo()
        message = raced["errors"].get("1", "")
        check("a bundle changed after the run made its cache key fails that run (R15-01)",
              not raced["success"] and "changed while this run was starting" in message, raced)
        to(t["id"], "A2")()  # back to the content the failed run's key was made from
        after = runner.run(prompt, ["2", "4"])
        check("the next run shows what the bundle holds now, not what it held while it changed",
              after["success"] and after["shown"].get("2") == "A2" and "1" not in after["cached"], after)
        again = runner.run(prompt, ["2", "4"])
        check("an unchanged bundle then comes from the cache", again["success"] and {"1", "2", "3", "4"} <= set(again["cached"]),
              again)
        undo = racing(store, "3", to(u["id"], "U3"))
        to(u["id"], "U2")()
        raced = runner.run(prompt, ["2", "4"])
        undo()
        check("each loader is checked on its own: the one whose bundle changed fails",
              not raced["success"] and "changed while this run was starting" in raced["errors"].get("3", "")
              and "1" not in raced["errors"], raced)
        renamed = store.get(t["id"])
        store.update(t["id"], {**text_bundle("Text T renamed", "A2")}, renamed["revision"])
        kept = runner.run(prompt, ["2", "4"])
        check("a renamed bundle keeps the cache of its loader and what reads it",
              kept["success"] and {"1", "2"} <= set(kept["cached"]), kept)

        # ---- a slot the bundle cannot fill (N16, the hybrid rule) ----------------------------------
        e = store.create({"name": "Empty E", "tags": [], "note": "",
                          "fields": [{"name": "prompt", "type": "text", "value": "e"},
                                     {"name": "ref", "type": "image", "asset": None}]})
        two = spec(("prompt", "text"), ("ref", "image"))
        unlinked = {
            "1": {"class_type": "BundleLibraryLoad", "inputs": {"bundle_id": e["id"], "slot_spec": two}},
            "2": {"class_type": "PreviewAny", "inputs": {"source": ["1", 0]}},
        }
        runner = Runner(server)
        first = runner.run(unlinked, ["2"])
        second = runner.run(unlinked, ["2"])
        check("a bundle with an empty image field runs, then comes from the cache like any other (N16)",
              first["success"] and first["shown"] == {"2": "e"} and second["success"] and {"1", "2"} <= set(second["cached"]),
              {"first": first, "second": second})
        later = {**unlinked, "3": {"class_type": "PreviewAny", "inputs": {"source": ["1", 1]}}}
        linked_later = runner.run(later, ["2", "3"])
        blocked = linked_later["errors"].get("3", "")
        check("a node linked later to that slot, after a cached run, stops with the reason instead of reading None",
              "1" in linked_later["cached"] and "3" not in linked_later["shown"]
              and "cannot fill the output 'ref': it has no image" in blocked, linked_later)
        fresh = Runner(server).run(later, ["2", "3"])
        check("a slot the prompt links fails Load Bundle at once, as before",
              not fresh["success"] and "cannot fill the connected outputs: 'ref' has no image" in fresh["errors"].get("1", ""),
              fresh)

    failed = RESULTS.count(False)
    print(f"\n{len(RESULTS) - failed}/{len(RESULTS)} passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
