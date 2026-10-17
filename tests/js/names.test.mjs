import { test } from "node:test";
import assert from "node:assert/strict";

import "./english.mjs"; // the English catalog, as the page has it
import { displayNames } from "../../web/names.js";

test("a name of its own is shown as it is", () => {
    const labels = displayNames([{ id: "a1", name: "Hero" }, { id: "b2", name: "Villain" }]);
    assert.deepEqual([...labels], [["a1", "Hero"], ["b2", "Villain"]]);
});

test("repeated names get the start of the id", () => {
    const labels = displayNames([
        { id: "a31f0000-1111-4000-8000-000000000000", name: "Hero" },
        { id: "c8420000-2222-4000-8000-000000000000", name: "Hero" },
        { id: "d0000000-3333-4000-8000-000000000000", name: "hero" }, // another case: another name
    ]);
    assert.equal(labels.get("a31f0000-1111-4000-8000-000000000000"), "Hero · a31f");
    assert.equal(labels.get("c8420000-2222-4000-8000-000000000000"), "Hero · c842");
    assert.equal(labels.get("d0000000-3333-4000-8000-000000000000"), "hero");
});

test("ids that start alike are shown longer", () => {
    const labels = displayNames([
        { id: "abcd1234-0000-4000-8000-000000000000", name: "Twin" },
        { id: "abcd5678-0000-4000-8000-000000000000", name: "Twin" },
    ]);
    assert.deepEqual([...labels.values()], ["Twin · abcd12", "Twin · abcd56"]);
});

test("the same bundle listed twice is not a repeated name", () => {
    const bundle = { id: "a1", name: "Hero" };
    assert.equal(displayNames([bundle, bundle]).get("a1"), "Hero");
});
