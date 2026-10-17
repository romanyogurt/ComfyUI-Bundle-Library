// The text this pack shows, in the language ComfyUI is set to (Phase 9). The
// English text is the key: in English it shows as written, in another language
// as its entry in that language's dictionary (web/locales/ko.js), with its
// {places} filled from `values`. A sentence with no entry shows in English. User data (the
// names of bundles, tags, fields and categories) is never translated.
// The language is read whenever text is made (useLocale(); main.js passes
// ComfyUI's Language setting), so a changed setting shows in what is drawn
// next. No DOM and no ComfyUI import: it runs under `node --test`, in English.
import KO from "./locales/ko.js";

const DICTIONARIES = { ko: KO };
let readLocale = () => "en";

/** Where the language comes from: a function returning a code such as "ko" or "en-US". */
export function useLocale(read) {
    readLocale = read;
}

/** The language text is made in: one with a dictionary ("ko"), or "en". */
export function locale() {
    let code = "en";
    try {
        code = String(readLocale() ?? "en");
    } catch {
        // the setting cannot be read yet: English
    }
    const base = code.toLowerCase().split(/[-_]/)[0];
    return base in DICTIONARIES ? base : "en";
}

function fill(text, values) {
    return text.replace(/\{(\w+)\}/g, (place, name) => (name in values ? String(values[name]) : place));
}

/** `text` in the current language, with its {places} filled from `values`. */
export function t(text, values = {}) {
    return fill(DICTIONARIES[locale()]?.[text] ?? text, values);
}

/**
 * A sentence about `count` things: English takes `one` for 1 and `other`
 * otherwise; another language has one entry, under `other`. {count} is filled.
 */
export function tn(count, one, other, values = {}) {
    return fill(DICTIONARIES[locale()]?.[other] ?? (count === 1 ? one : other), { count, ...values });
}

/** "3 bundles" in English, "번들 3개" in Korean: `word` is an English noun with a dictionary entry. */
export function plural(count, word) {
    if (locale() === "en") return `${count} ${word}${count === 1 ? "" : "s"}`;
    return t("{count} {things}", { count, things: t(word) });
}

/**
 * `text` translated and split at its one {place}: [before, after], for text
 * around elements (such as names set in code) that a language orders its own way.
 */
export function around(text, place, values = {}) {
    const [before, after = ""] = t(text, values).split(`{${place}}`);
    return [before, after];
}

/** Marks text kept to be shown later (in a table): t() shows it then. Lets the dictionary check find it. */
export const msg = (text) => text;
