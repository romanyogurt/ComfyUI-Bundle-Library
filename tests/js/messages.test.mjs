// Getting the catalogs when the server does not give them at first (R31-02, 0.0.32). A file of its own:
// web/i18n.js starts here without the English catalog, as a page does.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { hasEnglish, onCatalogs, t, useLoader, useLocale } from "../../web/i18n.js";

const read = (lang) => JSON.parse(readFileSync(new URL(`../../locales/${lang}/bundle_library.json`, import.meta.url), "utf8"));
const ENGLISH = read("en");
const KOREAN = Object.fromEntries(Object.entries(read("ko")).map(([id, entry]) => [id, entry.text]));

// The server: the requests it was asked, and how many of the next ones fail, by language code
const asked = [];
const failing = {};
async function load(code) {
    asked.push(code);
    if (failing[code] > 0) {
        failing[code] -= 1;
        if (failing[code] % 2) return null; // a page in between answered: not the catalogs
        throw new Error("HTTP 503");
    }
    return { languages: ["en", "ko"], messages: { en: ENGLISH, ...(code.startsWith("ko") ? { ko: KOREAN } : {}) } };
}

// Waits as asked for, but short
const waits = [];
const sleep = (ms) => {
    waits.push(ms);
    return new Promise((done) => setImmediate(done));
};

let drawn = 0;
let onDrawn = () => {};
onCatalogs(() => {
    drawn += 1;
    onDrawn();
});
const drawnAgain = () => new Promise((done) => {
    onDrawn = done;
});

test("the start tries three times, then shows the ids and asks again later, not whenever text is made", async () => {
    failing.en = 4;
    useLocale(() => "en");
    const coming = drawnAgain();
    await useLoader(load, sleep);
    assert.deepEqual(asked, ["en", "en", "en"], "the first try and two more");
    assert.deepEqual(waits, [500, 1500, 5000], "0.5 and 1.5 seconds apart; the next in 5 seconds");
    assert.equal(hasEnglish(), false);
    assert.equal(t("trash.empty_confirm"), "trash.empty_confirm", "its id until the catalog comes");
    for (let i = 0; i < 5; i++) t("trash.empty_confirm");
    assert.equal(asked.length, 3, "one request at a time");
    await coming;
    assert.deepEqual(asked, ["en", "en", "en", "en", "en"]);
    assert.deepEqual(waits, [500, 1500, 5000, 15000]);
    assert.equal(drawn, 1, "told once, when it came");
    assert.equal(hasEnglish(), true);
    assert.equal(t("trash.empty_confirm"), "Empty the trash?");
});

test("a language chosen later comes the same way: tried again until it comes, every minute at last", async () => {
    asked.length = 0;
    waits.length = 0;
    failing["ko-kr"] = 7;
    useLocale(() => "ko-KR");
    const coming = drawnAgain();
    assert.equal(t("trash.empty_confirm"), "Empty the trash?", "English until Korean comes");
    for (let i = 0; i < 5; i++) t("trash.empty_confirm");
    assert.deepEqual(asked, ["ko-kr"]);
    await coming;
    assert.equal(asked.length, 8);
    assert.deepEqual(waits, [500, 1500, 5000, 15000, 30000, 60000, 60000]);
    assert.equal(drawn, 2);
    assert.equal(t("trash.empty_confirm"), "휴지통을 비울까요?");
    t("trash.empty_confirm");
    assert.equal(asked.length, 8, "in: not asked again");
});
