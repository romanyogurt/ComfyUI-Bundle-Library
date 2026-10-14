import hashlib
import json

from comfy_api.latest import io

from .constants import MEDIA_TYPES, POOL_SIZE
from .convert import load_audio, load_image, load_video
from .library import get_store
from .model import LibraryError
from .slots import field_problem, linked_outputs, parse_slot_spec


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
        if any(field_problem(store, fields.get(name), field_type) for name, field_type in slots):
            # Whether the slot is linked is not part of the cache key: a run
            # that passed while it was unlinked would hand its cached None to a
            # link made later. NaN never matches, so such a node always reruns.
            return float("nan")
        # Files are stored under their hash, so the bundle JSON pins every output.
        return hashlib.sha256(json.dumps(bundle, sort_keys=True).encode()).hexdigest()

    @classmethod
    def execute(cls, bundle_id, slot_spec) -> io.NodeOutput:
        store = get_store()
        bundle = store.get(bundle_id)  # one read: every output comes from the same revision
        fields = {f["name"]: f for f in bundle["fields"]}
        slots = parse_slot_spec(slot_spec)
        linked = linked_outputs(cls.hidden.prompt, cls.hidden.unique_id)
        problems = [
            f"'{name}' {problem}"
            for index, (name, field_type) in enumerate(slots)
            if index in linked and (problem := field_problem(store, fields.get(name), field_type))
        ]
        if problems:
            raise ValueError(
                f"Bundle '{bundle['name']}' cannot fill the connected outputs: {'; '.join(problems)}. "
                "Pick another bundle or check the connections.")
        values = []
        for name, field_type in slots:
            field = fields.get(name)
            if field_problem(store, field, field_type):
                values.append(None)  # not linked, so nothing reads it
            elif field_type in MEDIA_TYPES:
                load = {"image": load_image, "video": load_video, "audio": load_audio}[field_type]
                try:
                    values.append(load(store.assets.path(field["asset"]["sha256"])))
                except ValueError as e:
                    raise ValueError(f"Bundle '{bundle['name']}', field '{name}': {e}") from e
            else:
                values.append(field["value"])
        values += [None] * (POOL_SIZE - len(values))
        return io.NodeOutput(*values)
