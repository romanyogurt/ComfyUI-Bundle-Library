"""Phase 0 stand-in for the bundle store: a few fixed bundles kept in memory.

The bundles cover the cases the loader has to handle: two interchangeable
bundles (A, B), one missing a field (C), one whose field changed type (D) and
one with an empty image (E). Phase 1 replaces this module with the file store.
"""

import io

from PIL import Image, ImageDraw, ImageFont


def _image(color, label):
    image = Image.new("RGB", (512, 768), color)
    draw = ImageDraw.Draw(image)
    draw.text((32, 32), label, fill="white", font=ImageFont.load_default(size=72))
    return image


def _bundle(suffix, name, fields):
    return {
        "id": f"5a1e0000-0000-4000-8000-0000000000{suffix}",
        "name": name,
        "revision": 1,
        "fields": [{"name": n, "type": t, "value": v} for n, t, v in fields],
    }


_PROMPT_A = "Red dress girl\n\n  두 줄 공백과 앞뒤 공백을 그대로 둔다  \n"

BUNDLES = {
    b["id"]: b
    for b in (
        _bundle("a1", "Spike A (red)", [
            ("prompt", "text", _PROMPT_A),
            ("ref_1", "image", _image("#b3261e", "A ref_1")),
            ("ref_2", "image", _image("#e8710a", "A ref_2")),
            ("use_bgm", "boolean", True),
        ]),
        _bundle("b2", "Spike B (blue)", [
            ("prompt", "text", "Blue shirt girl"),
            ("ref_1", "image", _image("#1a56db", "B ref_1")),
            ("ref_2", "image", _image("#0e7490", "B ref_2")),
            ("use_bgm", "boolean", False),
        ]),
        _bundle("c3", "Spike C (no ref_2)", [
            ("prompt", "text", "Cat mascot"),
            ("ref_1", "image", _image("#15803d", "C ref_1")),
            ("seed", "int", 42),
        ]),
        _bundle("d4", "Spike D (ref_2 is text)", [
            ("prompt", "text", "Type mismatch case"),
            ("ref_1", "image", _image("#6d28d9", "D ref_1")),
            ("ref_2", "text", "not an image"),
            ("use_bgm", "boolean", True),
        ]),
        _bundle("e5", "Spike E (empty ref_2)", [
            ("prompt", "text", "Empty image case"),
            ("ref_1", "image", _image("#374151", "E ref_1")),
            ("ref_2", "image", None),
            ("use_bgm", "boolean", True),
            ("cfg", "float", 4.5),
        ]),
    )
}


def get(bundle_id):
    return BUNDLES.get(bundle_id)


def _preview(field):
    value = field["value"]
    if field["type"] == "image":
        return None if value is None else {"width": value.width, "height": value.height}
    if field["type"] == "text":
        return value[:200]
    return value


def summaries():
    return [
        {
            "id": b["id"],
            "name": b["name"],
            "revision": b["revision"],
            "fields": [
                {"name": f["name"], "type": f["type"], "preview": _preview(f)}
                for f in b["fields"]
            ],
        }
        for b in BUNDLES.values()
    ]


def thumbnail_png(bundle_id, field_name, size=256):
    bundle = BUNDLES.get(bundle_id)
    field = next((f for f in bundle["fields"] if f["name"] == field_name), None) if bundle else None
    if field is None or field["type"] != "image" or field["value"] is None:
        return None
    thumb = field["value"].copy()
    thumb.thumbnail((size, size))
    out = io.BytesIO()
    thumb.save(out, "PNG")
    return out.getvalue()
