// How the library list is grouped (Phase 7.6): Needs attention, Favorites,
// the categories by name, Uncategorized. Pure functions: they run under
// `node --test` as well as in the browser.

import { t } from "./i18n.js";

export const ATTENTION = "attention";
export const FAVORITES = "favorites";
export const CATEGORY = "category";
export const UNCATEGORIZED = "uncategorized";

/**
 * The groups of the library window's list, in order: {key, kind, name,
 * category?, bundles, errors}. `bundles` are the summaries to show (filtered
 * and sorted already), `categories` all categories (by name), `errors` the
 * files this version cannot use. A bundle sits in one category (or
 * Uncategorized) and is shown again under Favorites when starred, and under
 * Needs attention when it has warnings or cannot be changed.
 * - Favorites is always there, empty or not: a place to drop a bundle on.
 * - Categories are there even when empty, except with `filtering` (a search
 *   or a tag), which leaves only the categories with matches.
 * - Needs attention and Uncategorized are there only when they have something.
 *   With `filtering` the errors are left out: they match no search.
 */
export function groupBundles(bundles, categories, errors = [], { filtering = false } = {}) {
    const known = new Set(categories.map((c) => c.id));
    const groups = [
        { key: ATTENTION, kind: ATTENTION, name: "Needs attention",
            bundles: bundles.filter((b) => b.read_only || b.warnings), errors: filtering ? [] : errors },
        { key: FAVORITES, kind: FAVORITES, name: "Favorites", bundles: bundles.filter((b) => b.favorite), errors: [] },
        ...categories.map((category) => ({ key: `${CATEGORY}:${category.id}`, kind: CATEGORY, name: category.name, category,
            bundles: bundles.filter((b) => b.category === category.id), errors: [] })),
        { key: UNCATEGORIZED, kind: UNCATEGORIZED, name: "Uncategorized",
            bundles: bundles.filter((b) => !known.has(b.category)), errors: [] },
    ];
    return groups.filter((g) => g.kind === FAVORITES || (g.kind === CATEGORY && !filtering)
        || g.bundles.length || g.errors.length);
}

/** The heading of a group. */
export function groupLabel(group) {
    if (group.kind === ATTENTION) return `⚠ ${t("Needs attention")}`;
    if (group.kind === FAVORITES) return `★ ${t("Favorites")}`;
    return group.kind === UNCATEGORIZED ? t("Uncategorized") : group.name; // a category's name is the user's
}

/**
 * The groups of a short list (the sidebar, a node's dropdown): Favorites, the
 * categories and Uncategorized, each only when it has bundles, and no Needs
 * attention (its bundles are in their own groups too). Null when the bundles
 * are all uncategorized and none is starred: such a list needs no headings.
 */
export function compactGroups(bundles, categories) {
    const groups = groupBundles(bundles, categories, [], { filtering: true })
        .filter((g) => g.kind !== ATTENTION && g.bundles.length);
    return groups.length === 1 && groups[0].kind === UNCATEGORIZED ? null : groups;
}
