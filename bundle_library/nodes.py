from comfy_api.latest import io
from comfy_execution.graph_utils import ExecutionBlocker

from .choices import ComfyProvider
from .constants import MEDIA_TYPES, POOL_SIZE
from .convert import load_audio, load_image, load_video
from .library import get_store
from .model import LibraryError
from .slots import linked_outputs, output_fingerprint, parse_slot_spec, resolve_slots, slot_problems

# The fingerprint each node's cache key was made with in the run going on, by
# (node id, bundle id, slot_spec): execute() checks that what it reads is
# still that. A run fingerprints its nodes before it executes any, and runs go
# one at a time; an entry left by a node that came from the cache is replaced
# the next time the node is fingerprinted.
_keyed = {}


class LoadBundle(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="BundleLibraryLoad",
            display_name="Load Bundle",
            category="Bundle Library",
            description="Loads a bundle from the Bundle Library. The outputs follow the selected "
                        "bundle's fields; outputs with the same field name keep their links when "
                        "another bundle is selected.",
            search_aliases=["bundle", "library", "multimodal", "preset", "character"],
            is_experimental=True,
            inputs=[
                io.String.Input("bundle_id", default="", advanced=True,
                                tooltip="UUID of the selected bundle. Chosen with the bundle selector."),
                io.String.Input("slot_spec", default="", advanced=True, socketless=True,
                                tooltip="Which field each output carries, in output order. Kept by the node's UI."),
            ],
            outputs=[io.AnyType.Output(f"field_{i:02d}") for i in range(1, POOL_SIZE + 1)],
            hidden=[io.Hidden.prompt, io.Hidden.unique_id],
        )

    @classmethod
    def validate_inputs(cls, bundle_id, slot_spec):
        if not bundle_id:
            return "No bundle selected."
        try:
            parse_slot_spec(slot_spec)
        except ValueError as e:
            return f"Invalid slot_spec: {e}"
        try:
            get_store().get(bundle_id)
        except LibraryError as e:
            return e.message
        return True

    @classmethod
    def fingerprint_inputs(cls, bundle_id, slot_spec):
        store = get_store()
        try:
            bundle = store.get(bundle_id)
            slots = parse_slot_spec(slot_spec)
        except (LibraryError, ValueError):
            return float("nan")  # validation reports it
        fields = {f["name"]: f for f in bundle["fields"]}
        # Only what the outputs carry, and why a slot cannot be filled: a
        # renamed bundle or a new note keeps the cache of every node downstream,
        # and so does a bundle with an empty image field. A bundle in the trash
        # fails before this, in get() (here and in validate_inputs). Choices
        # are checked against their sources' options as they are now, outside
        # the store's lock: execute() reads them again.
        resolved = resolve_slots(slots, fields, ComfyProvider())
        fingerprint = output_fingerprint(slots, fields, slot_problems(store, slots, fields, resolved), resolved)
        _keyed[(cls.hidden.unique_id, bundle_id, slot_spec)] = fingerprint
        return fingerprint

    @classmethod
    def execute(cls, bundle_id, slot_spec) -> io.NodeOutput:
        store = get_store()
        bundle = store.get(bundle_id)  # one read: every output comes from the same revision
        fields = {f["name"]: f for f in bundle["fields"]}
        slots = parse_slot_spec(slot_spec)
        resolved = resolve_slots(slots, fields, ComfyProvider())
        problems = slot_problems(store, slots, fields, resolved)
        keyed = _keyed.pop((cls.hidden.unique_id, bundle_id, slot_spec), None)
        if keyed is not None and keyed != output_fingerprint(slots, fields, problems, resolved):
            # The bundle (or the options a choice is checked against) changed
            # after this run made its cache key: the outputs would be kept under
            # a key that does not describe them. Files a node makes while the
            # run goes on are not waited for.
            sourced = any(r.lookup is not None for r in resolved.values())
            raise ValueError(f"Bundle '{bundle['name']}' changed while this run was starting"
                             f"{', or the options its choices are checked against did' if sourced else ''}. Run it again.")
        linked = linked_outputs(cls.hidden.prompt, cls.hidden.unique_id)
        connected = [f"'{slots[index][0]}' {problem}" for index, problem in problems.items() if index in linked]
        if connected:
            raise ValueError(
                f"Bundle '{bundle['name']}' cannot fill the connected outputs: {'; '.join(connected)}. "
                "Pick another bundle or check the connections.")
        values = []
        for index, (name, field_type) in enumerate(slots):
            field = fields.get(name)
            if index in problems:
                # Nothing in this prompt reads it. These outputs may be cached:
                # a node linked to it later stops with the reason, not with None.
                values.append(ExecutionBlocker(
                    f"Bundle '{bundle['name']}' cannot fill the output '{name}': it {problems[index]}. "
                    "Pick another bundle or check the connections."))
            elif field_type in MEDIA_TYPES:
                load = {"image": load_image, "video": load_video, "audio": load_audio}[field_type]
                try:
                    values.append(load(store.assets.path(field["asset"]["sha256"])))
                except ValueError as e:
                    raise ValueError(f"Bundle '{bundle['name']}', field '{name}': {e}") from e
            elif index in resolved:
                values.append(resolved[index].output)  # as the source's options spell it
            else:
                values.append(field["value"])
        values += [None] * (POOL_SIZE - len(values))
        return io.NodeOutput(*values)
