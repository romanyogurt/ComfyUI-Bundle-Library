import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { locale, plural, said, serverText, t, tn, useLocale } from "../../web/i18n.js";
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
const SERVER = new URL("../../bundle_library/", import.meta.url);
// The server's messages (bundle_library/text.py): Text("template", ...) and Word("word"), Python string literals,
// adjacent ones joined.
const PY_TEXT = /\b(?:Text|Word)\(((?:\s*(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'))+)/g;
const pyString = (literal) => (literal.startsWith("'")
    ? JSON.parse(`"${literal.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"')}"`) : JSON.parse(literal));

/** Every message of the server, with the files that make it. */
function serverNamed() {
    const found = new Map();
    for (const file of readdirSync(SERVER).filter((f) => f.endsWith(".py"))) {
        const code = readFileSync(new URL(file, SERVER), "utf8");
        for (const match of code.matchAll(PY_TEXT)) {
            const text = [...match[1].matchAll(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g)].map((m) => pyString(m[0])).join("");
            found.set(text, [...(found.get(text) ?? []), file]);
        }
    }
    return found;
}

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

test("the server's messages are found where they are made (Phase 9b)", () => {
    const server = serverNamed();
    assert.ok(server.size > 150, `${server.size}`);
    assert.ok(server.has("category must be {shape}, with an id for \"one\"."));
    assert.ok(server.has("saved by a newer Bundle Library (schema version {version}; this one reads up to {SCHEMA_VERSION})"));
    assert.ok(server.has("an audio"));
});

test("a message of the server in Korean: its template, a word in it, a message in it, a name as it is", () => {
    const wrong = { template: "Field '{name}': the file is {kind}, not {type}.",
        values: { name: "Text", kind: { word: "an audio" }, type: { word: "an image" } } };
    const nested = { template: "{label}: must be a string.", values: { label: { template: "Field '{name}'", values: { name: "Text" } } } };
    assert.equal(serverText("as it came", wrong), "Field 'Text': the file is an audio, not an image.");
    try {
        useLocale(() => "ko");
        assert.equal(serverText("", wrong), "필드 'Text': 파일이 이미지이(가) 아니라 오디오입니다."); // "Text" is a name: not translated
        assert.equal(serverText("", nested), "필드 'Text': 문자열이어야 합니다.");
        assert.equal(serverText("as it came", undefined), "as it came");
        assert.equal(said({ message: "In the trash.", message_i18n: { template: "In the trash.", values: {} } }, "message"), "휴지통에 있습니다.");
        assert.deepEqual(said({ warnings: ["a", "Tags: at most 20."], warnings_i18n: [null, { template: "Tags: at most {MAX_TAGS}.",
            values: { MAX_TAGS: 20 } }] }, "warnings"), ["a", "태그: 최대 20개입니다."]);
    } finally {
        useLocale(() => "en");
    }
});

test("every text the code shows has a Korean entry with the same places (Phase 9)", () => {
    const missing = [];
    const unlike = [];
    for (const [text, files] of [...named(), ...serverNamed()]) {
        if (!(text in KO)) missing.push(`${files[0]}: ${text}`);
        else if (JSON.stringify(places(KO[text])) !== JSON.stringify(places(text))) unlike.push(text);
    }
    assert.deepEqual(missing, []);
    assert.deepEqual(unlike, []);
});

test("no Korean entry is left that the code does not name", () => {
    const used = new Map([...named(), ...serverNamed()]);
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
