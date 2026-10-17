// The text this pack shows, in the language ComfyUI is set to (Phase 9; by id
// since 0.0.27). Every message has an id ("trash.empty_confirm"), and each
// language a catalog of them: locales/<language>/bundle_library.json in the
// pack, English included. t(id, values) is the message in the current language
// with its {places} filled from `values`. A message a language does not have,
// or whose places differ from the English, shows in English. A message with
// forms for counts ({"one": …, "other": …}: the categories of Intl.PluralRules)
// takes the form for `values.count`. User data (the names of bundles, tags,
// fields and categories) is never translated.
// The page gets the catalogs from the server (GET /bundle-library/v1/messages
// through useLoader(); main.js waits for them before anything is drawn). The
// language is read whenever text is made (useLocale(); main.js passes ComfyUI's
// Language setting): a language chosen later is fetched when first used and
// shows from what is drawn after it came. Catalogs that could not be had are
// asked for again until they come (0.0.32), and onCatalogs() listeners draw
// again what they keep on screen. No DOM and no ComfyUI import: it runs under
// `node --test`, with catalogs given by useCatalogs().

const catalogs = {}; // language -> {id: text, or {category: text}}
let languages = ["en"]; // the languages the server has a catalog for
let readLocale = () => "en";
let loader = null;
const asking = {}; // language code -> the promise of its first tries, until its catalogs are in
const came = new Set(); // the codes whose catalogs are in
const listeners = new Set();
const rules = {};
// After the n-th failure the catalogs are asked for again this many milliseconds later; after the
// last, every that many on (0.0.32). The first two are the page's start (QUICK, within main.js's 5 seconds).
const WAITS = [500, 1500, 5000, 15000, 30000, 60000];
const QUICK = 2;
let pause = (ms) => new Promise((done) => setTimeout(done, ms));

/** Where the language comes from: a function returning a code such as "ko" or "en-US". */
export function useLocale(read) {
    readLocale = read;
}

/** Catalogs as the server answers GET /messages: {languages, messages: {language: {id: text}}}. */
export function useCatalogs(answer) {
    if (Array.isArray(answer?.languages)) languages = answer.languages;
    Object.assign(catalogs, answer?.messages ?? {});
}

/**
 * Where catalogs come from: `load(code)` resolves to the server's answer for
 * a language code. Asks for the language set now; resolves when that answer
 * is in, or when it could not be had in its first tries (English, or the ids,
 * are shown then, and it is asked for again later). `sleep(ms)`, a promise,
 * is how a wait between tries is made (the tests make it short).
 */
export function useLoader(load, sleep = pause) {
    loader = load;
    pause = sleep;
    return ask(code()) ?? Promise.resolve();
}

/** Call `listener` whenever catalogs come, so that what is on screen can be drawn again in their language. */
export function onCatalogs(listener) {
    listeners.add(listener);
}

/** Whether the English catalog is in: without it the page shows message ids. */
export function hasEnglish() {
    return "en" in catalogs;
}

/**
 * The catalogs for `wanted`, asked for until they come: one request at a
 * time, and after a failure again only when its wait is over, not whenever
 * text is made. The promise of the first tries, or null when they are in.
 */
function ask(wanted) {
    const key = wanted.toLowerCase();
    if (!loader || came.has(key)) return null;
    return (asking[key] ??= new Promise((started) => void fetchCatalogs(key, started)));
}

async function fetchCatalogs(key, started) {
    for (let failures = 0; ;) {
        try {
            const answer = await loader(key);
            if (!answer?.messages?.en) throw new Error("the answer has no English catalog");
            useCatalogs(answer);
            break;
        } catch (error) {
            failures += 1;
            console.warn(`[Bundle Library] no messages for '${key}' (try ${failures}):`, error?.message ?? error);
            if (failures > QUICK) started();
            await pause(WAITS[Math.min(failures, WAITS.length) - 1]);
        }
    }
    came.add(key);
    delete asking[key];
    started();
    for (const listener of listeners) {
        try {
            listener();
        } catch (error) {
            console.error("[Bundle Library] could not draw again in the new language:", error);
        }
    }
}

function code() {
    try {
        return String(readLocale() ?? "en");
    } catch {
        return "en"; // the setting cannot be read yet
    }
}

/** The language with a catalog for a code such as "ko-KR" or "zh-TW": the same code, its base language, or "en". */
export function language(wanted) {
    const lower = String(wanted).toLowerCase().replace("_", "-");
    return languages.find((name) => name.toLowerCase() === lower)
        ?? languages.find((name) => name.toLowerCase() === lower.split("-")[0]) ?? "en";
}

/** The language text is made in: the one set, once its catalog is here; else "en". */
export function locale() {
    const wanted = code();
    const chosen = language(wanted);
    if (!(chosen in catalogs) || !("en" in catalogs)) void ask(wanted);
    return chosen in catalogs ? chosen : "en";
}

/** Whether `id` is a message of this page's English catalog. */
export function has(id) {
    return catalogs.en?.[id] != null;
}

const PLACE = /\{(\w+)\}/g;

/** The places of a message, all its forms together. */
function places(message) {
    const texts = typeof message === "string" ? [message] : Object.values(message ?? {});
    return [...new Set(texts.flatMap((text) => [...String(text).matchAll(PLACE)].map((match) => match[1])))].sort().join();
}

function fill(text, values) {
    return text.replace(PLACE, (place, name) => (name in values ? String(values[name]) : place));
}

function form(message, lang, count) {
    if (typeof message === "string") return message;
    let category = "other";
    if (typeof count === "number") {
        try {
            category = (rules[lang] ??= new Intl.PluralRules(lang)).select(count);
        } catch {
            category = count === 1 ? "one" : "other";
        }
    }
    return message[category] ?? message.other ?? "";
}

/** The message `id` in the current language, its {places} filled from `values`; the id itself if there is none. */
export function t(id, values = {}) {
    const lang = locale();
    const english = catalogs.en?.[id];
    const own = lang === "en" ? null : catalogs[lang]?.[id];
    if (own != null && (english == null || places(own) === places(english))) return fill(form(own, lang, values.count), values);
    return english == null ? id : fill(form(english, "en", values.count), values);
}

/**
 * The message `id` translated and split at its one {place}: [before, after],
 * for text around elements (such as names set in code) that a language orders its own way.
 */
export function around(id, place, values = {}) {
    const [before, after = ""] = t(id, values).split(`{${place}}`);
    return [before, after];
}

/** Whether a message of the server, and every message among its values, is in this page's catalog. */
function known(info) {
    return has(info.id) && Object.values(info.values ?? {}).every((value) => !value || typeof value !== "object" || known(value));
}

/**
 * A message of the server in the current language: `text` is its English as
 * it came, `info` its id and values ("<key>_i18n" beside it,
 * bundle_library/text.py). A value is a name (shown as it is), a number, or
 * another message ({id, values}). A message this page does not know (a server
 * of another version) shows as it came.
 */
export function serverText(text, info) {
    if (!info?.id || !known(info)) return text;
    const values = {};
    for (const [name, value] of Object.entries(info.values ?? {})) {
        values[name] = value && typeof value === "object" ? serverText("", value) : value;
    }
    return t(info.id, values);
}

/** `object[key]`, a message of the server, in the current language; a list of them as a list. */
export function said(object, key) {
    const value = object?.[key];
    const info = object?.[`${key}_i18n`];
    return Array.isArray(value) ? value.map((text, i) => serverText(text, info?.[i])) : serverText(value, info);
}

/** Marks the id of a message kept to be shown later (in a table): t() shows it then. Lets the catalog check find it. */
export const msg = (id) => id;
