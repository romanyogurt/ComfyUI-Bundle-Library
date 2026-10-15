import { test } from "node:test";
import assert from "node:assert/strict";

import { compactGroups, groupBundles, groupLabel } from "../../web/groups.js";

const heroes = { id: "c1", name: "Heroes" };
const villains = { id: "c2", name: "Villains" };
const red = { id: "b1", name: "Red", category: "c1", favorite: true };
const blue = { id: "b2", name: "Blue", category: null, favorite: false };
const odd = { id: "b3", name: "Odd", category: "c1", favorite: false, warnings: ["Bundle name: at most 120 characters."] };
const lost = { id: "b4", name: "Lost", category: "gone", favorite: false }; // its category was deleted

const summary = (groups) => groups.map((g) => [g.key, g.bundles.map((b) => b.id), g.errors.length]);

test("groups come in order; a starred bundle shows twice", () => {
    assert.deepEqual(summary(groupBundles([red, blue, lost], [heroes, villains])), [
        ["favorites", ["b1"], 0],
        ["category:c1", ["b1"], 0],
        ["category:c2", [], 0],
        ["uncategorized", ["b2", "b4"], 0],
    ]);
});

test("needs attention appears with warnings or files that cannot be read", () => {
    const groups = groupBundles([red, odd], [heroes], [{ file: "bundles/x.json", code: "corrupt" }]);
    assert.deepEqual(summary(groups)[0], ["attention", ["b3"], 1]);
    assert.deepEqual(summary(groupBundles([], [], [{ file: "bundles/x.json" }])).map((g) => g[0]),
        ["attention", "favorites", "uncategorized"]);
});

test("while filtering only groups with matches are left, without the errors", () => {
    const groups = groupBundles([blue], [heroes, villains], [{ file: "bundles/x.json" }], { filtering: true });
    assert.deepEqual(summary(groups), [["uncategorized", ["b2"], 0]]);
});

test("a short list leaves out empty groups and needs attention, and plain lists need no headings", () => {
    assert.deepEqual(summary(compactGroups([red, blue, odd], [heroes, villains])), [
        ["favorites", ["b1"], 0],
        ["category:c1", ["b1", "b3"], 0],
        ["uncategorized", ["b2"], 0],
    ]);
    assert.equal(compactGroups([blue, lost], [heroes]), null);
    assert.deepEqual(compactGroups([], [heroes]), []);
    assert.deepEqual(groupBundles([red], [heroes]).map(groupLabel), ["★ Favorites", "Heroes", "Uncategorized"]);
});
