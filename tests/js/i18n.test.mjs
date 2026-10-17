import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { ENGLISH, LANGUAGES, read, sent } from "./english.mjs";
import { around, language, locale, said, serverText, t, useCatalogs, useLoader, useLocale } from "../../web/i18n.js";

// Languages kept complete with the pack: a message missing in them, or translated from an English that has
// changed since, fails here. In any other language it is reported, and English shows in its place.
const MAINTAINED = ["ko"];

const WEB = new URL("../../web/", import.meta.url);
const SERVER = new URL("../../bundle_library/", import.meta.url);
const ID = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/;
// Where the code names a message: t("id", …), msg("id") and around("id", …) in the page, Text("id", …) in the server.
// The id is written out at the call (a table keeps it with msg()), so it can be found here.
const CALLS = [[WEB, ".js", /(?<![\w.$])(?:t|msg|around)\(\s*(["'`])((?:(?!\1)[^\\]|\\.)*)\1/g],
    [SERVER, ".py", /(?<![\w.])Text\(\s*(["'])((?:(?!\1)[^\\]|\\.)*)\1/g]];

/** Every id the code names, with the files that name it; and what is named that is not an id. */
function named() {
    const found = new Map();
    const odd = [];
    for (const [dir, ext, pattern] of CALLS) {
        for (const file of readdirSync(dir).filter((f) => f.endsWith(ext) && f !== "i18n.js" && f !== "text.py")) {
            for (const match of readFileSync(new URL(file, dir), "utf8").matchAll(pattern)) {
                if (match[1] === "`" || !ID.test(match[2])) odd.push(`${file}: ${match[0]}`);
                else found.set(match[2], [...(found.get(match[2]) ?? []), file]);
            }
        }
    }
    return { found, odd };
}

const forms = (message) => (typeof message === "string" ? [message] : Object.values(message));
/** The places of a message, all its forms together. */
const places = (message) => [...new Set(forms(message).flatMap((text) => text.match(/\{\w+\}/g) ?? []))].sort().join();

/** What is wrong with the catalog of `lang` (structure), and what it lacks (missing, outdated). */
function check(lang) {
    const problems = [];
    const outdated = [];
    const categories = new Intl.PluralRules(lang).resolvedOptions().pluralCategories;
    const catalog = read(lang);
    for (const [id, entry] of Object.entries(catalog)) {
        const english = ENGLISH[id];
        if (english === undefined) {
            problems.push(`${id}: no such message in English`);
            continue;
        }
        if (!entry || typeof entry !== "object" || !("en" in entry) || !("text" in entry)) {
            problems.push(`${id}: not {"en": the English it was made from, "text": the translation}`);
            continue;
        }
        const { text } = entry;
        if (typeof english === "string" ? typeof text !== "string"
            : !(typeof text === "string" && categories.length === 1)
                && (typeof text !== "object" || [...Object.keys(text)].sort().join() !== [...categories].sort().join())) {
            problems.push(`${id}: forms are ${JSON.stringify(text)}; ${lang} takes ${typeof english === "string"
                ? "one text" : `${categories.join(", ")}`}`);
        } else if (places(text) !== places(english)) {
            problems.push(`${id}: places ${places(text)} differ from the English ${places(english)}`);
        }
        if (JSON.stringify(entry.en) !== JSON.stringify(english)) outdated.push(`${id}: was ${JSON.stringify(entry.en)}`);
    }
    const missing = Object.keys(ENGLISH).filter((id) => !(id in catalog));
    return { problems, outdated, missing };
}

test("the code names messages by id, and English has every one of them (0.0.27)", () => {
    const { found, odd } = named();
    assert.deepEqual(odd, [], "a message is named by its id, written out: t(\"area.name\")");
    assert.ok(found.size > 550, `${found.size}`);
    assert.deepEqual([...found].filter(([id]) => !(id in ENGLISH)).map(([id, files]) => `${files[0]}: ${id}`), []);
    assert.ok(found.get("store.bundle_not_found")?.includes("store.py"));
    assert.ok(found.get("trash.empty_confirm")?.includes("trash_panel.js"));
});

test("no English message is left that the code does not name", () => {
    const { found } = named();
    assert.deepEqual(Object.keys(ENGLISH).filter((id) => !found.has(id)), []);
});

test("English messages: a text, or forms for one and other; {name} places only", () => {
    const bad = [];
    for (const [id, message] of Object.entries(ENGLISH)) {
        if (!ID.test(id)) bad.push(`${id}: not an id`);
        if (typeof message !== "string" && Object.keys(message).join() !== "one,other") bad.push(`${id}: forms ${Object.keys(message)}`);
        else if (forms(message).some((text) => typeof text !== "string" || /[{}]/.test(text.replace(/\{\w+\}/g, "")))) {
            bad.push(`${id}: a brace that is not a place`);
        }
    }
    assert.deepEqual(bad, []);
    assert.ok(LANGUAGES.includes("en") && LANGUAGES.includes("ko"), `${LANGUAGES}`);
});

for (const lang of LANGUAGES.filter((l) => l !== "en")) {
    test(`the ${lang} catalog: known ids, the forms of ${lang}, the places of the English`, (t) => {
        const { problems, outdated, missing } = check(lang);
        assert.deepEqual(problems, []);
        if (missing.length) t.diagnostic(`${lang}: ${missing.length} not translated: ${missing.join(", ")}`);
        if (outdated.length) t.diagnostic(`${lang}: ${outdated.length} translated from an older English:\n  ${outdated.join("\n  ")}`);
        if (MAINTAINED.includes(lang)) {
            assert.deepEqual(missing, [], `${lang} is kept complete`);
            assert.deepEqual(outdated, [], `${lang}: translate again, then copy the English into "en"`);
        }
    });
}

test("an outdated translation is told apart: its English differs from the English now", () => {
    const ko = read("ko");
    assert.equal(JSON.stringify(ko["trash.empty_confirm"].en), JSON.stringify(ENGLISH["trash.empty_confirm"]));
    assert.equal(ko["count.bundles"].text, "번들 {count}개");
    assert.deepEqual(ko["count.bundles"].en, { one: "{count} bundle", other: "{count} bundles" });
});

test("English from its catalog: places filled, the form for the count, the id when there is none", () => {
    assert.equal(locale(), "en");
    assert.equal(t("upload.failed_http", { status: 500 }), "Upload failed: HTTP 500");
    assert.equal(t("count.files", { count: 1 }), "1 file");
    assert.equal(t("count.files", { count: 3 }), "3 files");
    assert.equal(t("count.files", { count: 0 }), "0 files");
    assert.equal(t("count.files"), "{count} files"); // no count: the "other" form
    assert.equal(t("no.such_message"), "no.such_message");
    assert.deepEqual(around("library.row_lacking", "fields"), ["⚠ no ", ""]);
});

test("Korean from its catalog; a message it lacks, or with other places, in English", () => {
    const ko = sent(read("ko"));
    try {
        useCatalogs({ messages: { ko: { ...ko, "upload.cancelled": undefined, "upload.failed_http": "업로드 실패: {code}" } } });
        useLocale(() => "ko-KR");
        assert.equal(locale(), "ko");
        assert.equal(t("trash.empty_confirm"), "휴지통을 비울까요?");
        assert.equal(t("count.bundles", { count: 1 }), "번들 1개"); // Korean has one form for any count
        assert.equal(t("count.bundles", { count: 3 }), "번들 3개");
        assert.equal(t("upload.cancelled"), "Upload cancelled.");
        assert.equal(t("upload.failed_http", { status: 500 }), "Upload failed: HTTP 500");
        useLocale(() => "fr");
        assert.equal(t("trash.empty_confirm"), "Empty the trash?");
        useLocale(() => { throw new Error("not ready"); });
        assert.equal(locale(), "en");
    } finally {
        useCatalogs({ messages: { ko } });
        useLocale(() => "en");
    }
});

test("a language's own forms for counts (Intl.PluralRules): Polish has one, few, many and other", () => {
    try {
        useCatalogs({ languages: [...LANGUAGES, "pl"], messages: { pl: { "count.files": {
            one: "{count} plik", few: "{count} pliki", many: "{count} plików", other: "{count} pliku" } } } });
        useLocale(() => "pl-PL");
        assert.deepEqual([1, 3, 5, 22, 1.5].map((count) => t("count.files", { count })),
            ["1 plik", "3 pliki", "5 plików", "22 pliki", "1.5 pliku"]);
        assert.equal(t("trash.empty_confirm"), "Empty the trash?");
    } finally {
        useCatalogs({ languages: LANGUAGES });
        useLocale(() => "en");
    }
});

test("a code finds its language: the same code, else its base language, else English", () => {
    try {
        useCatalogs({ languages: ["en", "ko", "zh", "zh-TW"] });
        assert.equal(language("ko-KR"), "ko");
        assert.equal(language("zh-TW"), "zh-TW");
        assert.equal(language("zh_tw"), "zh-TW");
        assert.equal(language("zh-HK"), "zh");
        assert.equal(language("fr"), "en");
    } finally {
        useCatalogs({ languages: LANGUAGES });
    }
});

test("a message of the server: its id and values, a message among them, a name as it is", () => {
    const wrong = { id: "store.wrong_kind", values: { name: "Text", kind: { id: "kind.an_audio", values: {} },
        type: { id: "kind.an_image", values: {} } } };
    const nested = { id: "check.string", values: { label: { id: "check.field_label", values: { name: "Text" } } } };
    assert.equal(serverText("as it came", wrong), "Field 'Text': the file is an audio, not an image.");
    assert.equal(serverText("as it came", { id: "server.newer_message", values: {} }), "as it came");
    assert.equal(serverText("as it came", { ...nested, values: { label: { id: "server.newer", values: {} } } }), "as it came");
    assert.equal(serverText("as it came", { template: "a 0.0.26 server" }), "as it came");
    try {
        useCatalogs({ messages: { ko: sent(read("ko")) } });
        useLocale(() => "ko");
        assert.equal(serverText("", wrong), "필드 'Text': 파일이 이미지이(가) 아니라 오디오입니다."); // "Text" is a name: not translated
        assert.equal(serverText("", nested), "필드 'Text': 문자열이어야 합니다.");
        assert.equal(serverText("as it came", undefined), "as it came");
        assert.equal(said({ message: "In the trash.", message_i18n: { id: "exchange.in_trash", values: {} } }, "message"), "휴지통에 있습니다.");
        assert.deepEqual(said({ warnings: ["a", "Tags: at most 20."], warnings_i18n: [null, { id: "check.tags_max",
            values: { MAX_TAGS: 20 } }] }, "warnings"), ["a", "태그: 최대 20개입니다."]);
        assert.equal(serverText("", { id: "file.minutes", values: { count: 1 } }), "1분");
    } finally {
        useLocale(() => "en");
    }
    assert.equal(serverText("", { id: "file.minutes", values: { count: 1 } }), "1 minute");
    assert.equal(serverText("", { id: "file.audio_too_large", values: { count: 2, rate: "48", length: "1:00" } }),
        "The audio is too large to load: with 2 channels at 48 kHz it may last at most 1:00.");
});

test("what is wrong with a file is said in the page's language too (R31-04, 0.0.32)", () => {
    // As tests/test_routes.py has the server send them
    const none = {};
    const cases = [
        [{ id: "check.not_empty", values: { label: { id: "category.name_label", values: none } } },
            "Category name: must not be empty.", "카테고리 이름: 비어 있으면 안 됩니다."],
        [{ id: "common.invalid_revision", values: none }, "invalid revision", "잘못된 revision"],
        [{ id: "store.organization_locked", values: { problem: { id: "common.not_json", values: none } } },
            "not valid JSON; categories and favorites cannot be changed", "올바른 JSON이 아님. 카테고리와 즐겨찾기를 바꿀 수 없음"],
        [{ id: "file.no_video_use_audio", values: none }, "This file has no video; use an audio field for it.",
            "이 파일에는 영상이 없습니다. 오디오 필드에 넣으세요."],
    ];
    for (const [info, english] of cases) assert.equal(serverText("", info), english);
    try {
        useCatalogs({ messages: { ko: sent(read("ko")) } });
        useLocale(() => "ko");
        for (const [info, , korean] of cases) assert.equal(serverText("", info), korean);
    } finally {
        useLocale(() => "en");
    }
});

// Last: the loader stays set for the rest of this file.
test("a language chosen later is fetched once when first used, and shows from then on", async () => {
    const asked = [];
    // As the server answers: the languages there are, and the catalog of the code's language (by its base here)
    const load = async (wanted) => {
        asked.push(wanted);
        const lang = wanted.split("-")[0];
        return { languages: [...LANGUAGES, "ja"], messages: { en: ENGLISH,
            ...(lang === "ja" ? { ja: { "trash.empty_confirm": "ゴミ箱を空にしますか?" } } : {}) } };
    };
    let code = "en";
    useLocale(() => code);
    try {
        await useLoader(load);
        assert.deepEqual(asked, ["en"]);
        code = "ja-JP";
        assert.equal(t("trash.empty_confirm"), "Empty the trash?"); // not here yet: English, and it is asked for
        assert.equal(t("trash.empty_confirm"), "Empty the trash?");
        await new Promise((done) => setTimeout(done, 10));
        assert.deepEqual(asked, ["en", "ja-jp"]);
        assert.equal(t("trash.empty_confirm"), "ゴミ箱を空にしますか?");
        code = "fr"; // no catalog: English, nothing asked
        assert.equal(t("trash.empty_confirm"), "Empty the trash?");
        assert.deepEqual(asked, ["en", "ja-jp"]);
    } finally {
        useLocale(() => "en");
    }
});
