import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { locale, plural, t, tn, useLocale } from "../../web/i18n.js";
import KO from "../../web/locales/ko.js";

const WEB = new URL("../../web/", import.meta.url);
// A text to translate: string literals, joined by + over lines if long.
const TEXT = String.raw`"(?:[^"\\]|\\.)*"(?:\s*\+\s*"(?:[^"\\]|\\.)*")*`;
// Where the code names text to translate: t("…"), msg("…"), around("…", place), tn(n, "one", "other") (the entry is under "other")
// and plural(n, "word"). The text must be written out at the call, so it can be found here.
const CALLS = [
    new RegExp(String.raw`\b(?:t|msg|around)\(\s*(${TEXT})`, "g"),
    new RegExp(String.raw`\btn\([^,()]+(?:\([^()]*\))?[^,()]*,\s*(${TEXT}),\s*(${TEXT})`, "g"),
    new RegExp(String.raw`\bplural\([^,()]+(?:\([^()]*\))?[^,()]*,\s*(${TEXT})`, "g"),
];
const join = (source) => [...source.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`)).join("");
const places = (text) => [...new Set(text.match(/\{\w+\}/g) ?? [])].sort();

/** Every text the code names, with the files that name it. */
function named() {
    const found = new Map();
    for (const file of readdirSync(WEB).filter((f) => f.endsWith(".js"))) {
        const code = readFileSync(new URL(file, WEB), "utf8");
        assert.ok(!/\b(?:t|tn|msg)\(\s*`/.test(code), `${file}: text to translate is a template literal`);
        for (const pattern of CALLS) {
            for (const match of code.matchAll(pattern)) {
                const text = join(match[match.length - 1]);
                found.set(text, [...(found.get(text) ?? []), file]);
            }
        }
    }
    return found;
}

test("every text the code shows has a Korean entry with the same places (Phase 9)", () => {
    const missing = [];
    const unlike = [];
    for (const [text, files] of named()) {
        if (!(text in KO)) missing.push(`${files[0]}: ${text}`);
        else if (JSON.stringify(places(KO[text])) !== JSON.stringify(places(text))) unlike.push(text);
    }
    assert.deepEqual(missing, []);
    assert.deepEqual(unlike, []);
});

test("no Korean entry is left that the code does not name", () => {
    const used = named();
    assert.deepEqual(Object.keys(KO).filter((text) => !used.has(text)), []);
});

test("English as written, Korean from its dictionary, places filled; other languages fall back to English", () => {
    try {
        assert.equal(locale(), "en");
        assert.equal(t("Upload failed: HTTP {status}", { status: 500 }), "Upload failed: HTTP 500");
        assert.equal(plural(1, "file"), "1 file");
        assert.equal(plural(3, "file"), "3 files");
        useLocale(() => "ko-KR");
        assert.equal(locale(), "ko");
        assert.equal(t("Upload failed: HTTP {status}", { status: 500 }), "업로드 실패: HTTP 500");
        assert.equal(plural(3, "file"), "파일 3개");
        assert.equal(t("Text no dictionary has"), "Text no dictionary has");
        useLocale(() => "fr");
        assert.equal(t("Upload cancelled."), "Upload cancelled.");
        useLocale(() => { throw new Error("not ready"); });
        assert.equal(locale(), "en");
    } finally {
        useLocale(() => "en");
    }
    assert.equal(tn(1, "{count} file", "{count} files"), "1 file");
});
