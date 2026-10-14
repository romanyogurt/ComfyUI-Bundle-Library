import assert from "node:assert/strict";
import test from "node:test";

import { POOL_SIZE, parseSpec, planSlots, serializeSpec, slotStatuses } from "../../web/reconcile.js";

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
    assert.equal(parseSpec(JSON.stringify({ v: 1, slots: [{ name: "x", type: "video" }] })), null);
    assert.equal(parseSpec(JSON.stringify({ v: 1, slots: [{ name: "", type: "text" }] })), null);
});

test("statuses compare names and types", () => {
    assert.deepEqual(slotStatuses(A, [{ name: "prompt", type: "text" }, { name: "ref_1", type: "text" }]),
        ["ok", "type_mismatch", "missing", "missing"]);
});
