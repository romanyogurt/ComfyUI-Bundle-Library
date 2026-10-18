// Choice fields (0.2.0): a value for another node's dropdown, and maybe its
// source, the input whose options it is checked against. What the editor and
// the node say of one, apart from how it is drawn: no DOM here, and the graph
// is read only by what its objects hold, so it runs under `node --test` too.
import { msg, t } from "./i18n.js";

/**
 * What a choice carries, as bundle_library/choices.py resolve() says: its
 * value as the source's options spell it ({output, state}). `lookup` is what
 * GET /choices/options answered for the source: {state, options, paths}. Only
 * a list that holds a model folder's files (`paths`) takes a path written with
 * the other slash, and only one matching that way. tests/fixtures/choices.json
 * holds both to the same cases.
 */
export function resolveChoice(value, source, lookup) {
    if (!source) return { output: value, state: "no_source" };
    if (!lookup) return { output: value, state: "pending" }; // not answered yet
    if (lookup.state !== "read") return { output: value, state: lookup.state };
    if (lookup.options.includes(value)) return { output: value, state: "ok" };
    if (lookup.paths) {
        const plain = (text) => text.replaceAll("\\", "/");
        const matches = lookup.options.filter((option) => plain(option) === plain(value));
        if (matches.length === 1) return { output: matches[0], state: "ok" };
    }
    return { output: value, state: "mismatch" };
}

/** The key a source is known by (as a Map key). */
export const sourceKey = (source) => (source ? `${source.node}\n${source.input}` : "");

/**
 * What the page knows of each source's options, for everything that shows
 * choices: each source is read once, and again after refresh(), when its list
 * may have changed (ComfyUI read its node definitions again, the library
 * changed). Until the new answer comes, the last one stays, so nothing
 * flickers; an answer to an ask made before the latest refresh is dropped,
 * whenever it comes. `read(source)` asks the server; `changed()` is told when an
 * answer was taken.
 */
export class SourceOptions {
    constructor(read, changed) {
        this.read = read;
        this.changed = changed;
        this.entries = new Map(); // by sourceKey(): {done, answer, failure, asked (the refresh it was asked in)}
        this.refreshes = 0;
    }

    /** What is known of `source`: {done, answer, failure}. Not read since the last refresh, it is asked for. */
    get(source) {
        const key = sourceKey(source);
        let entry = this.entries.get(key);
        if (!entry) {
            entry = { done: false, answer: null, failure: null, asked: -1 };
            this.entries.set(key, entry);
        }
        if (entry.asked !== this.refreshes) {
            const asked = this.refreshes;
            entry.asked = asked;
            Promise.resolve().then(() => this.read(source))
                .then((answer) => ({ answer, failure: null }), (error) => ({ answer: null, failure: error.message }))
                .then((result) => {
                    if (entry.asked !== asked || this.entries.get(key) !== entry) return; // asked again since
                    Object.assign(entry, result, { done: true });
                    this.changed();
                });
        }
        return entry;
    }

    /** The lists may have changed: each source is read again when it is next shown. */
    refresh() {
        this.refreshes += 1;
    }
}

/** A source as people read it: the node's display name (when this ComfyUI has it) and the input. */
export function sourceLabel(source, lookup = null) {
    return t("choice.source", { node: lookup?.label || source.node, input: source.input });
}

const REASONS = {
    not_combo: msg("choice.reason_not_combo"), multiselect: msg("choice.reason_multiselect"),
    remote: msg("choice.reason_remote"), dynamic: msg("choice.reason_dynamic"), not_text: msg("choice.reason_not_text"),
};

/** Why an input is not one a choice can take its options from, in words. */
export const reasonText = (reason) => t(REASONS[reason] ?? REASONS.not_combo);

/**
 * Why a value cannot be checked against its source here, in words, or null
 * when it can (or has no source). `failure` is the error of a request that
 * did not get an answer.
 */
export function uncheckedText(source, lookup, failure = null) {
    if (!source) return null;
    if (failure) return t("choice.unchecked_failed", { reason: failure });
    if (!lookup || lookup.state === "read") return null;
    if (lookup.state === "not_found" && lookup.reason === "no_input") {
        return t("choice.unchecked_no_input", { node: lookup.label || source.node, input: source.input });
    }
    if (lookup.state === "not_found") return t("choice.unchecked_no_node", { node: source.node });
    if (lookup.state === "unsupported") {
        return t("choice.unchecked_unsupported", { source: sourceLabel(source, lookup), reason: reasonText(lookup.reason) });
    }
    return t("choice.unchecked_error", { node: lookup.label || source.node });
}

const linkOf = (graph, id) => graph?.links?.get?.(id) ?? graph?.links?.[id] ?? null;
const isReroute = (node) => node?.type === "Reroute"; // the old Reroute node; the canvas's own reroutes are not nodes

/** The options of a node's dropdown input as the page has them: a list, or null when it has none to tell. */
function optionsOf(node, input) {
    const widget = node.widgets?.find((w) => w.name === (input?.widget?.name ?? input?.name));
    const values = widget?.options?.values;
    return Array.isArray(values) ? values : null;
}

/**
 * Every input that output `slot` of `node` reaches in `graph`: through a
 * subgraph's input to the nodes inside (at any depth) and through the old
 * Reroute node. Each is {node, input, options}, `options` null when the input
 * has none the page can tell; {unknown: true} stands for a link that cannot
 * be followed (out of a subgraph, a node gone).
 */
export function choiceTargets(graph, node, slot) {
    const found = [];
    const seen = new Set();
    const follow = (graph, ids) => {
        for (const id of ids ?? []) {
            const link = linkOf(graph, id);
            if (!link || seen.has(link)) continue;
            seen.add(link);
            const target = graph.getNodeById?.(link.target_id);
            if (!target) {
                found.push({ unknown: true });
            } else if (target.isSubgraphNode?.() && target.subgraph) {
                const inner = target.subgraph;
                follow(inner, inner.inputs?.[link.target_slot]?.linkIds);
            } else if (isReroute(target)) {
                follow(graph, target.outputs?.[0]?.links);
            } else {
                const input = target.inputs?.[link.target_slot];
                found.push({ node: target, input: input?.name ?? "", options: optionsOf(target, input) });
            }
        }
    };
    follow(graph, node.outputs?.[slot]?.links);
    return found;
}

/**
 * What a choice output means for each input it reaches: "ok", "mismatch" (not
 * one of its options), "unchecked" (an input with no options to tell, such as
 * one that takes anything) or "unknown" (a link that cannot be followed).
 */
export function targetVerdicts(output, targets) {
    return targets.map((target) => (target.unknown ? "unknown" : !target.options ? "unchecked"
        : target.options.includes(output) ? "ok" : "mismatch"));
}
