import json
import re

import numpy as np
import torch

from comfy_api.latest import io

from . import spike_store
from .constants import COMFY_TYPES, POOL_SIZE

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")


def parse_slot_spec(text):
    """The (name, type) of each output, in output order. Empty text means no outputs."""
    if not text:
        return []
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise ValueError(f"JSON이 아닙니다 ({e.msg})") from None
    if not isinstance(data, dict) or data.get("v") != 1 or not isinstance(data.get("slots"), list):
        raise ValueError('{"v": 1, "slots": [...]} 형식이어야 합니다')
    slots = []
    for slot in data["slots"]:
        name = slot.get("name") if isinstance(slot, dict) else None
        field_type = slot.get("type") if isinstance(slot, dict) else None
        if not isinstance(name, str) or not name or field_type not in COMFY_TYPES:
            raise ValueError(f"잘못된 슬롯: {slot!r}")
        slots.append((name, field_type))
    if len(slots) > POOL_SIZE:
        raise ValueError(f"슬롯은 {POOL_SIZE}개까지입니다")
    return slots


def image_to_tensor(image):
    array = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
    return torch.from_numpy(array)[None,]


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
            return "번들이 선택되지 않았습니다."
        if not UUID_RE.match(bundle_id):
            return f"번들 ID 형식이 잘못되었습니다: {bundle_id}"
        try:
            parse_slot_spec(slot_spec)
        except ValueError as e:
            return f"slot_spec이 잘못되었습니다: {e}"
        if spike_store.get(bundle_id) is None:
            return f"번들을 찾을 수 없습니다: {bundle_id}"
        return True

    @classmethod
    def fingerprint_inputs(cls, bundle_id, slot_spec):
        bundle = spike_store.get(bundle_id)
        if bundle is None:
            return "missing"
        try:
            slots = parse_slot_spec(slot_spec)
        except ValueError:
            return "invalid"
        fields = {f["name"]: f for f in bundle["fields"]}
        for name, field_type in slots:
            if field_problem(fields.get(name), field_type):
                # Whether the slot is linked is not part of the cache key: a run
                # that passed while it was unlinked would hand its cached None to a
                # link made later. NaN never matches, so such a node always reruns.
                return float("nan")
        return f"{bundle_id}:{bundle['revision']}"

    @classmethod
    def execute(cls, bundle_id, slot_spec) -> io.NodeOutput:
        bundle = spike_store.get(bundle_id)
        fields = {f["name"]: f for f in bundle["fields"]}
        slots = parse_slot_spec(slot_spec)
        linked = linked_outputs(cls.hidden.prompt, cls.hidden.unique_id)
        problems = [
            f"'{name}' {problem}"
            for index, (name, field_type) in enumerate(slots)
            if index in linked and (problem := field_problem(fields.get(name), field_type))
        ]
        if problems:
            raise ValueError(
                f"'{bundle['name']}' 번들을 연결된 출력에 쓸 수 없습니다: {'; '.join(problems)}. "
                "다른 번들을 고르거나 연결을 확인하세요.")
        values = []
        for name, field_type in slots:
            field = fields.get(name)
            if field_problem(field, field_type):
                values.append(None)  # not linked, so nothing reads it
            elif field_type == "image":
                values.append(image_to_tensor(field["value"]))
            else:
                values.append(field["value"])
        values += [None] * (POOL_SIZE - len(values))
        return io.NodeOutput(*values)


def field_problem(field, field_type):
    """Why `field` cannot fill a slot of `field_type`, or None."""
    if field is None:
        return "필드가 없습니다"
    if field["type"] != field_type:
        return f"필드가 {field_type}이 아니라 {field['type']}입니다"
    if field_type == "image" and field["value"] is None:
        return "필드에 이미지가 없습니다"
    return None


def linked_outputs(prompt, unique_id):
    """Indices of this node's outputs that some node in the prompt reads."""
    linked = set()
    for node in (prompt or {}).values():
        for value in node.get("inputs", {}).values():
            if isinstance(value, list) and len(value) == 2 and str(value[0]) == str(unique_id):
                linked.add(value[1])
    return linked
