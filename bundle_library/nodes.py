import hashlib
import json

from comfy_api.latest import io

from .constants import COMFY_TYPES, MEDIA_TYPES, POOL_SIZE
from .convert import load_audio, load_image, load_video
from .library import get_store
from .model import LibraryError


def parse_slot_spec(text):
    """The (name, type) of each output, in output order. Empty text means no outputs."""
    if not text:
        return []
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise ValueError(f"not JSON ({e.msg})") from None
    if not isinstance(data, dict) or data.get("v") != 1 or not isinstance(data.get("slots"), list):
        raise ValueError('expected {"v": 1, "slots": [...]}')
    slots = []
    for slot in data["slots"]:
        name = slot.get("name") if isinstance(slot, dict) else None
        field_type = slot.get("type") if isinstance(slot, dict) else None
        if not isinstance(name, str) or not name or field_type not in COMFY_TYPES:
            raise ValueError(f"invalid slot {slot!r}")
        slots.append((name, field_type))
    if len(slots) > POOL_SIZE:
        raise ValueError(f"at most {POOL_SIZE} slots")
    return slots


def field_problem(store, field, field_type):
    """Why `field` cannot fill a slot of `field_type`, or None."""
    if field is None:
        return "is missing from the bundle"
    if field["type"] != field_type:
        return f"is {field['type']}, not {field_type}"
    if field_type in MEDIA_TYPES:
        if field["asset"] is None:
            return f"has no {field_type}"
        if store.assets.path(field["asset"]["sha256"]) is None:
            return f"has {'an' if field_type in ('image', 'audio') else 'a'} {field_type} file that is missing from the library"
    return None


def linked_outputs(prompt, unique_id):
    """Indices of this node's outputs that some node in the prompt reads."""
    linked = set()
    for node in (prompt or {}).values():
        for value in node.get("inputs", {}).values():
            if isinstance(value, list) and len(value) == 2 and str(value[0]) == str(unique_id):
                linked.add(value[1])
    return linked


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
                values.append(load(store.assets.path(field["asset"]["sha256"])))
            else:
                values.append(field["value"])
        values += [None] * (POOL_SIZE - len(values))
        return io.NodeOutput(*values)
