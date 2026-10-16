import assert from "node:assert/strict";
import test from "node:test";

import {
    COMFY_TYPES, POOL_SIZE, misplacedOutputs, parseSpec, planChanges, planSlots, serializeSpec, slotStatuses,
} from "../../web/reconcile.js";

const A = [
    { name: "prompt", type: "text" },
    { name: "ref_1", type: "image" },
    { name: "ref_2", type: "image" },
    { name: "use_bgm", type: "boolean" },
];
const linked = (fields, names) => fields.map((f) => ({ ...f, linked: names.includes(f.name) }));

test("first selection follows the bundle order", () => {
    const { slots, overflow } = planSlots([], A);
    assert.deepEqual(slots.map((s) => [s.name, s.from, s.status]), [
        ["prompt", null, "ok"], ["ref_1", null, "ok"], ["ref_2", null, "ok"], ["use_bgm", null, "ok"],
    ]);
    assert.equal(overflow, 0);
});

test("a bundle with the same fields changes nothing", () => {
    const { slots } = planSlots(linked(A, ["prompt", "ref_1"]), A);
    assert.deepEqual(slots.map((s) => [s.name, s.type, s.from, s.status]),
        A.map((f, i) => [f.name, f.type, i, "ok"]));
});

test("a linked slot the bundle lacks stays, marked missing; an unlinked one goes", () => {
    const C = [{ name: "prompt", type: "text" }, { name: "ref_1", type: "image" }, { name: "seed", type: "int" }];
    const { slots } = planSlots(linked(A, ["prompt", "ref_2"]), C);
    assert.deepEqual(slots.map((s) => [s.name, s.from, s.status]), [
        ["prompt", 0, "ok"], ["ref_1", 1, "ok"], ["ref_2", 2, "missing"], ["seed", null, "ok"],
    ]);
});

test("a linked slot keeps its type when the field changed type; an unlinked one follows", () => {
    const D = A.map((f) => (f.name === "ref_2" || f.name === "use_bgm" ? { ...f, type: "text" } : f));
    const { slots } = planSlots(linked(A, ["ref_2"]), D);
    const byName = Object.fromEntries(slots.map((s) => [s.name, s]));
    assert.deepEqual([byName.ref_2.type, byName.ref_2.status], ["image", "type_mismatch"]);
    assert.deepEqual([byName.use_bgm.type, byName.use_bgm.status], ["text", "ok"]);
});

test("switching back restores the missing slot without moving links", () => {
    const C = [{ name: "prompt", type: "text" }, { name: "ref_1", type: "image" }, { name: "seed", type: "int" }];
    const onC = planSlots(linked(A, ["ref_2"]), C).slots.map((s) => ({ ...s, linked: s.name === "ref_2" }));
    const backToA = planSlots(onC, A).slots;
    assert.deepEqual(backToA.map((s) => [s.name, s.from, s.status]), [
        ["prompt", 0, "ok"], ["ref_1", 1, "ok"], ["ref_2", 2, "ok"], ["use_bgm", null, "ok"],
    ]);
});

test("fields beyond the pool are counted, not added", () => {
    const many = Array.from({ length: POOL_SIZE + 3 }, (_, i) => ({ name: `f${i}`, type: "text" }));
    const { slots, overflow } = planSlots([], many);
    assert.equal(slots.length, POOL_SIZE);
    assert.equal(overflow, 3);
});

test("slot_spec round-trips and rejects malformed text", () => {
    assert.deepEqual(parseSpec(serializeSpec(A)), A);
    assert.deepEqual(parseSpec(""), []);
    assert.equal(serializeSpec([]), "");
    assert.equal(parseSpec("{"), null);
    assert.equal(parseSpec(JSON.stringify({ v: 2, slots: [] })), null);
    assert.equal(parseSpec(JSON.stringify({ v: 1, slots: [{ name: "x", type: "mesh" }] })), null);
    assert.equal(parseSpec(JSON.stringify({ v: 1, slots: [{ name: "", type: "text" }] })), null);
});

test("linked outputs saved under another field or type than slot_spec are found (N10)", () => {
    const slots = [{ name: "prompt", type: "text" }, { name: "ref", type: "image" }, { name: "seed", type: "int" }];
    const out = (label, type, links = [1]) => ({ name: "field_01", label, type, links });
    assert.deepEqual(misplacedOutputs([out("prompt", "STRING"), out("ref", "IMAGE"), out("seed", "INT")], slots), []);
    assert.deepEqual(misplacedOutputs([out("ref", "IMAGE"), out("prompt", "STRING"), out("seed", "INT")], slots), [
        { index: 0, was: "ref", now: "prompt" }, { index: 1, was: "prompt", now: "ref" }]);
    assert.deepEqual(misplacedOutputs([out("prompt", "STRING"), out("ref", "IMAGE"), out("seed", "FLOAT")], slots),
        [{ index: 2, was: "seed", now: "seed" }], "another type at the same name");
    assert.deepEqual(misplacedOutputs([out("ref", "IMAGE", []), out("prompt", "STRING", null)], slots), [],
        "an output nothing is linked to carries nothing wrong");
    assert.deepEqual(misplacedOutputs([out("field_01", "*"), { name: "field_02", type: "*", links: [1] }], slots), [],
        "outputs never shown as fields");
    assert.deepEqual(misplacedOutputs(undefined, slots), []);
});

test("slot_spec takes only the types themselves, not what every object has (R15-11)", () => {
    for (const type of ["constructor", "toString", "__proto__", "hasOwnProperty", 1, null, ["text"]]) {
        assert.equal(parseSpec(JSON.stringify({ v: 1, slots: [{ name: "x", type }] })), null, String(type));
    }
    assert.deepEqual(parseSpec('{"v": 1.0, "slots": [{"name": "x", "type": "text"}]}'), [{ name: "x", type: "text" }],
        "1.0 reads as 1 here; the server takes it too");
});

test("changes list what an update would do, and nothing for linked misfits", () => {
    const none = { added: [], removed: [], retyped: [] };
    assert.deepEqual(planChanges(linked(A, ["prompt"]), A), none);
    const grown = [...A, { name: "ref_3", type: "image" }];
    assert.deepEqual(planChanges(linked(A, []), grown), { ...none, added: ["ref_3"] });
    const changed = [{ name: "prompt", type: "text" }, { name: "ref_1", type: "text" }, { name: "ref_2", type: "image" }];
    assert.deepEqual(planChanges(linked(A, ["ref_2"]), changed), { added: [], removed: ["use_bgm"], retyped: ["ref_1"] });
    // linked and missing: kept as is, so not offered as a change
    assert.deepEqual(planChanges(linked(A, ["use_bgm"]), A.slice(0, 3)), none);
});

test("statuses compare names and types", () => {
    assert.deepEqual(slotStatuses(A, [{ name: "prompt", type: "text" }, { name: "ref_1", type: "text" }]),
        ["ok", "type_mismatch", "missing", "missing"]);
});

test("video and audio fields become VIDEO and AUDIO slots; a linked one keeps its type", () => {
    assert.equal(COMFY_TYPES.video, "VIDEO");
    assert.equal(COMFY_TYPES.audio, "AUDIO");
    const media = [{ name: "clip", type: "video" }, { name: "bgm", type: "audio" }];
    assert.deepEqual(parseSpec(serializeSpec(planSlots([], media).slots)), media);
    const swapped = [{ name: "clip", type: "audio" }, { name: "bgm", type: "video" }];
    const { slots } = planSlots(linked(media, ["clip"]), swapped);
    assert.deepEqual(slots.map((s) => [s.name, s.type, s.status]), [["clip", "video", "type_mismatch"], ["bgm", "video", "ok"]]);
});
