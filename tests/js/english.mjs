// The catalogs of locales/ for the tests under node: importing this gives
// web/i18n.js the English catalog, as the page has it from the server.
import { existsSync, readdirSync, readFileSync } from "node:fs";

import { useCatalogs } from "../../web/i18n.js";

const LOCALES = new URL("../../locales/", import.meta.url);
const file = (language) => new URL(`${language}/bundle_library.json`, LOCALES);

/** The catalog of `language` as it is in its file. */
export const read = (language) => JSON.parse(readFileSync(file(language), "utf8"));

/** Every language with a catalog. */
export const LANGUAGES = readdirSync(LOCALES).filter((name) => existsSync(file(name))).sort();

export const ENGLISH = read("en");

/** A translation as the server sends it (bundle_library/text.py): each message's text, without the English it was made from. */
export const sent = (catalog) => Object.fromEntries(Object.entries(catalog).map(([id, entry]) => [id, entry.text]));

useCatalogs({ languages: LANGUAGES, messages: { en: ENGLISH } });
