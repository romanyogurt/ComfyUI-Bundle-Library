"""What a Load Bundle node's outputs carry, and whether a bundle can fill them.
Imports nothing from ComfyUI, so the tests can use it on their own."""

import json

from .constants import COMFY_TYPES, MEDIA_TYPES, POOL_SIZE


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
