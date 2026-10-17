import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { compareText, sameTag, tagCounts, tagKey } from "../../web/tags.js";

const FIXTURE = JSON.parse(readFileSync(new URL("../fixtures/tag_keys.json", import.meta.url), "utf8"));
const CASEFOLD = JSON.parse(readFileSync(new URL("../fixtures/casefold.json", import.meta.url), "utf8"));

test("tags are the same when the server takes them for the same (tests/fixtures/tag_keys.json, N47)", () => {
    for (const [a, b, same] of FIXTURE.pairs) {
        assert.equal(tagKey(a) === tagKey(b), same, `${a} / ${b}`);
        assert.equal(sameTag(a, b), same);
    }
});

test("every character with a case folds as the server's Python folds it (R19-04)", () => {
    const wrong = Object.entries(CASEFOLD.chars).filter(([c, folded]) => tagKey(c) !== folded);
    assert.deepEqual(wrong.slice(0, 5).map(([c, folded]) => [c.codePointAt(0).toString(16), tagKey(c), folded]), []);
    assert.ok(Object.keys(CASEFOLD.chars).length > 2000);
});

test("names are ordered by their letters, then exactly", () => {
    const names = ["b", "Á", "a", "B", "ä", "Zebra", "apple"];
    // a, Á and ä are one letter: together, then in a fixed order
    assert.deepEqual([...names].sort(compareText), ["a", "Á", "ä", "apple", "B", "b", "Zebra"]);
});

test("tag counts: one entry per tag whatever its case, spelled as most bundles spell it", () => {
    const bundles = [{ tags: ["Portrait", "x"] }, { tags: ["portrait"] }, { tags: ["Portrait"] }, { tags: [] }];
    assert.deepEqual(tagCounts(bundles), [
        { key: "portrait", name: "Portrait", count: 3 },
        { key: "x", name: "x", count: 1 },
    ]);
});
