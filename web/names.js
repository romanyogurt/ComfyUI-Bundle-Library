// Bundle names are for display only and may repeat (bundles are told apart by
// id). Pure functions: they run under `node --test` as well as in the browser.

/**
 * The label to show for each bundle, by id: its name, or, when another of
 * `bundles` has the same name, the name with the start of its id, as long as
 * needed to tell them apart ("Hero · a31f").
 */
export function displayNames(bundles) {
    const byName = new Map();
    for (const bundle of bundles) {
        if (!byName.has(bundle.name)) byName.set(bundle.name, []);
        const ids = byName.get(bundle.name);
        if (!ids.includes(bundle.id)) ids.push(bundle.id); // the same bundle listed twice is one bundle
    }
    const labels = new Map();
    for (const [name, ids] of byName) {
        if (ids.length === 1) {
            labels.set(ids[0], name);
            continue;
        }
        const plain = ids.map((id) => id.replaceAll("-", ""));
        let length = 4;
        while (length < 32 && new Set(plain.map((id) => id.slice(0, length))).size < ids.length) length += 2;
        ids.forEach((id, i) => labels.set(id, `${name} · ${plain[i].slice(0, length)}`));
    }
    return labels;
}
