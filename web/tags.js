// Tags and names as the library compares them. Two tags are the same tag when
// they fold to the same text, as the server folds them (str.casefold in
// bundle_library/tags.py): "Straße" and "STRASSE" are one tag. Names, tags and
// categories shown in lists are ordered by compareText(). Pure functions: no
// DOM, so they run under `node --test` as well as in the browser.

/** The text two tags share when they are the same tag. */
export function tagKey(tag) {
    // Lower, upper, lower: as near to Unicode case folding as JavaScript gets
    // ("ß" and "ẞ" become "ss", a final "ς" becomes "σ"). The server decides
    // in what it changes; tests/fixtures/tag_keys.json holds both to the same cases.
    return tag.normalize("NFC").toLowerCase().toUpperCase().toLowerCase();
}

export const sameTag = (a, b) => tagKey(a) === tagKey(b);

/** The order of names in lists: by their letters regardless of case and accents, then exactly. */
export function compareText(a, b) {
    return a.localeCompare(b, undefined, { sensitivity: "base" }) || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * The tags of `bundles` (each with `tags`), one entry per tag whatever its
 * case: {key, name, count}, where `name` is the spelling most of them use and
 * `count` how many bundles have it. In the order of their names.
 */
export function tagCounts(bundles) {
    const found = new Map();
    for (const bundle of bundles) {
        const own = new Map(); // each tag once per bundle, as it first spells it
        for (const tag of bundle.tags) if (!own.has(tagKey(tag))) own.set(tagKey(tag), tag);
        for (const [key, tag] of own) {
            const entry = found.get(key) ?? { key, count: 0, spellings: new Map() };
            entry.count++;
            entry.spellings.set(tag, (entry.spellings.get(tag) ?? 0) + 1);
            found.set(key, entry);
        }
    }
    return [...found.values()].map(({ key, count, spellings }) => ({
        key, count, name: [...spellings].sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]))[0][0],
    })).sort((a, b) => compareText(a.name, b.name));
}
