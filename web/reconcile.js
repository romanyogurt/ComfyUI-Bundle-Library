// Output-slot planning for Load Bundle. Pure functions: no DOM, no litegraph,
// so they run under `node --test` as well as in the browser.

// Mirrors bundle_library/constants.py.
export const POOL_SIZE = 32;
export const COMFY_TYPES = {
    text: "STRING",
    image: "IMAGE",
    video: "VIDEO",
    audio: "AUDIO",
    boolean: "BOOLEAN",
    int: "INT",
    float: "FLOAT",
};

/**
 * The slots recorded in the node's `slot_spec` widget: [{name, type}] in
 * output order. Empty text means no slots; anything malformed gives null.
 */
export function parseSpec(text) {
    if (!text) return [];
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        return null;
    }
    if (data?.v !== 1 || !Array.isArray(data.slots)) return null;
    const slots = [];
    for (const slot of data.slots) {
        // Only the types themselves: `in` would also take what every object has ("constructor", "toString").
        if (typeof slot?.name !== "string" || !slot.name || typeof slot.type !== "string"
            || !Object.hasOwn(COMFY_TYPES, slot.type)) return null;
        slots.push({ name: slot.name, type: slot.type });
    }
    return slots.length <= POOL_SIZE ? slots : null;
}

/** The fields that are outputs: all but those turned off ("enabled": false, 0.0.30). */
const outputFields = (fields) => fields.filter((f) => f.enabled !== false);

/** The names of the fields turned off. */
const offNames = (fields) => new Set(fields.filter((f) => f.enabled === false).map((f) => f.name));

export function serializeSpec(slots) {
    if (!slots.length) return "";
    return JSON.stringify({ v: 1, slots: slots.map(({ name, type }) => ({ name, type })) });
}

/**
 * The outputs a node should have once `fields` (the newly selected bundle,
 * [{name, type, enabled?}] in bundle order) replaces what it shows now. A
 * field turned off is no output: for the node it is as if the bundle lacked it.
 *
 * `current` is [{name, type, linked}] in output order. A linked slot is never
 * dropped, moved or retyped: if the bundle lacks its field, has it turned off
 * or under another type, it stays and is marked, and the run fails only for
 * whatever uses it. Unlinked slots follow the bundle. Fields not shown yet are
 * added at the end, in bundle order, so existing links keep their output index.
 *
 * Returns {slots: [{name, type, from, status}], overflow}, where `from` is
 * the slot's current index (null for a new one), `status` is "ok",
 * "missing", "off" or "type_mismatch", and `overflow` counts fields left out
 * because the pool is full.
 */
export function planSlots(current, fields) {
    const byName = new Map(outputFields(fields).map((f) => [f.name, f]));
    const off = offNames(fields);
    const slots = [];
    current.forEach((slot, from) => {
        const field = byName.get(slot.name);
        if (field && field.type === slot.type) {
            slots.push({ name: slot.name, type: slot.type, from, status: "ok" });
        } else if (field) {
            slots.push(slot.linked
                ? { name: slot.name, type: slot.type, from, status: "type_mismatch" }
                : { name: slot.name, type: field.type, from, status: "ok" });
        } else if (slot.linked) {
            slots.push({ name: slot.name, type: slot.type, from, status: off.has(slot.name) ? "off" : "missing" });
        }
    });
    const shown = new Set(current.map((slot) => slot.name));
    let overflow = 0;
    for (const field of outputFields(fields)) {
        if (shown.has(field.name)) continue;
        if (slots.length < POOL_SIZE) {
            slots.push({ name: field.name, type: field.type, from: null, status: "ok" });
        } else {
            overflow++;
        }
    }
    return { slots, overflow };
}

/**
 * What applying planSlots() would change, by field name: slots added at the
 * end, unlinked slots removed, and unlinked slots retyped. Linked slots that
 * no longer fit stay as they are, so they are not changes.
 */
export function planChanges(current, fields) {
    const { slots } = planSlots(current, fields);
    const kept = new Set(slots.filter((s) => s.from !== null).map((s) => s.from));
    return {
        added: slots.filter((s) => s.from === null).map((s) => s.name),
        removed: current.filter((_, i) => !kept.has(i)).map((s) => s.name),
        retyped: slots.filter((s) => s.from !== null && s.type !== current[s.from].type).map((s) => s.name),
    };
}

/** "ok", "missing", "off" or "type_mismatch" for each slot against a bundle's fields. */
export function slotStatuses(slots, fields) {
    const byName = new Map(outputFields(fields).map((f) => [f.name, f]));
    const off = offNames(fields);
    return slots.map((slot) => {
        const field = byName.get(slot.name);
        if (!field) return off.has(slot.name) ? "off" : "missing";
        return field.type === slot.type ? "ok" : "type_mismatch";
    });
}

/**
 * The linked outputs a workflow saved under another field or type than the
 * node's `slot_spec` gives their place: [{index, was, now}]. The run reads
 * `slot_spec`, so a link on such an output carries the field it names, not
 * the one the link was drawn to. `saved` is the node's serialized outputs.
 * An output never shown as a field (still `field_NN`, or of type `*`) is not
 * counted against it.
 */
export function misplacedOutputs(saved, slots) {
    return slots.flatMap((slot, index) => {
        const out = saved?.[index];
        if (!out?.links?.length) return [];
        const label = out.label ?? out.name;
        const named = typeof label === "string" && !/^field_\d{2}$/.test(label);
        const typed = typeof out.type === "string" && out.type !== "*";
        const differs = (named && label !== slot.name) || (typed && out.type !== COMFY_TYPES[slot.type]);
        return differs ? [{ index, was: named ? label : slot.name, now: slot.name }] : [];
    });
}
