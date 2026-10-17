"""What a Load Bundle node's outputs carry, and whether a bundle can fill them.
Imports nothing from ComfyUI, so the tests can use it on their own."""

import hashlib
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
    version = data.get("v") if isinstance(data, dict) else None
    if type(version) is float and version == 1:
        version = 1  # JSON's 1.0: JavaScript reads it as 1, so the frontend takes it too
    if type(version) is int and version > 1:
        raise ValueError(f"version {version} of the outputs is from a newer Bundle Library")
    if version != 1 or type(version) is not int or not isinstance(data.get("slots"), list):
        raise ValueError('expected {"v": 1, "slots": [...]}')
    slots = []
    for slot in data["slots"]:
        name = slot.get("name") if isinstance(slot, dict) else None
        field_type = slot.get("type") if isinstance(slot, dict) else None
        if isinstance(name, str) and name and isinstance(field_type, str) and field_type and field_type not in COMFY_TYPES:
            raise ValueError(f"output '{name}' has the type '{field_type}', unknown to this version "
                             "(saved by a newer Bundle Library?)")
        if not isinstance(name, str) or not name or not isinstance(field_type, str) or field_type not in COMFY_TYPES:
            raise ValueError(f"invalid slot {slot!r}")
        slots.append((name, field_type))
    if len(slots) > POOL_SIZE:
        raise ValueError(f"at most {POOL_SIZE} slots")
    return slots


def field_problem(store, field, field_type):
    """Why `field` cannot fill a slot of `field_type`, or None."""
    if field is None:
        return "is missing from the bundle"
    if field.get("enabled") is False:
        return "is turned off in the bundle"
    if field["type"] != field_type:
        return f"is {field['type']}, not {field_type}"
    if field_type in MEDIA_TYPES:
        if field["asset"] is None:
            return f"has no {field_type}"
        if store.assets.path(field["asset"]["sha256"]) is None:
            return f"has {'an' if field_type in ('image', 'audio') else 'a'} {field_type} file that is missing from the library"
    return None


def slot_problems(store, slots, fields):
    """Why the bundle cannot fill each slot it cannot fill, by slot index."""
    return {index: problem for index, (name, field_type) in enumerate(slots)
            if (problem := field_problem(store, fields.get(name), field_type))}


def output_fingerprint(slots, fields, problems=None):
    """A hash of what the outputs carry: for each slot (name, type) its field's
    value, the SHA-256 of its file (files never change under a hash), or why the
    bundle cannot fill it (`problems`, by slot index, from slot_problems()).
    Everything else about the bundle (its name, note, tags, revision, times,
    category) leaves it unchanged, so editing those does not re-run the nodes
    that read the outputs. The same bundle gives the same hash, also when it
    cannot fill some slot: an empty image field is cached like any other."""
    problems = problems or {}
    content = []
    for index, (name, field_type) in enumerate(slots):
        if index in problems:
            carried = {"problem": problems[index]}
        elif field_type in MEDIA_TYPES:
            carried = fields[name]["asset"]["sha256"]
        else:
            carried = fields[name]["value"]
        content.append([name, field_type, carried])
    return hashlib.sha256(json.dumps(content, sort_keys=True).encode()).hexdigest()


def linked_outputs(prompt, unique_id):
    """Indices of this node's outputs that some node in the prompt reads."""
    linked = set()
    for node in (prompt or {}).values():
        for value in node.get("inputs", {}).values():
            if isinstance(value, list) and len(value) == 2 and str(value[0]) == str(unique_id):
                linked.add(value[1])
    return linked
