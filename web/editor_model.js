// What the bundle editor holds, apart from how it is drawn: the bundle as
// stored, the draft, the text of each number box (also while it does not
// parse), the uploads, and one answer to whether leaving would lose something.
// The editor draws from it; nothing here touches the DOM, so it runs under
// `node --test` as well as in the browser.
import { sourceKey } from "./choices.js";
import { said, t } from "./i18n.js";
import { sameTag } from "./tags.js";

export const MEDIA_TYPES = new Set(["image", "video", "audio"]);
const BLANK = { text: "", boolean: false, int: 0, float: 0, choice: "" };
const TEXT_PREVIEW = 200; // characters of a text field in a list summary (bundle_library/store.py)
const LARGEST = Number.MAX_SAFE_INTEGER.toLocaleString("en-US");

/** Why a whole number cannot be kept as it is. */
export const tooLarge = () => t("editor.int_range", { max: LARGEST });

let lastKey = 0;

/** The editable part of a bundle, as the API takes it. */
export function editable(bundle) {
    return {
        name: bundle.name,
        tags: [...bundle.tags],
        note: bundle.note ?? "",
        fields: bundle.fields.map((f) => {
            const off = f.enabled === false ? { enabled: false } : {}; // turned off (0.0.30); on is not written
            if (f.type === "choice") { // with the dropdown its options come from (0.2.0): a change of its own
                const source = f.source ? { source: { node: f.source.node, input: f.source.input } } : {};
                return { name: f.name, type: f.type, value: f.value, ...source, ...off };
            }
            if (!MEDIA_TYPES.has(f.type)) return { name: f.name, type: f.type, value: f.value, ...off };
            const asset = f.asset && { sha256: f.asset.sha256, ...(f.asset.original_name ? { original_name: f.asset.original_name } : {}) };
            return { name: f.name, type: f.type, asset: asset || null, ...off };
        }),
    };
}

/** Why `text` (a number box's) is not a value of `type` ("int" or "float"), or null. */
export function numberProblem(type, text) {
    const blank = text.trim() === "";
    const value = Number(text);
    if (!blank && Number.isFinite(value) && (type !== "int" || Number.isSafeInteger(value))) return null;
    if (type !== "int") return t("editor.enter_number");
    return !blank && Number.isInteger(value) ? tooLarge() : t("editor.enter_integer");
}

/**
 * A field of the draft. Each has a key of its own (the editor draws a card
 * per key) and remembers the name it was saved under (`origin`, null for a
 * new one). A number field also holds its box's text: `text` as typed,
 * `problem` while it is not a value, and what it started as (`original`,
 * `originalValue`). A whole number saved under a wider range comes with its
 * exact text (`value_text`), which a browser number would round: that text
 * is shown, and the bundle cannot be saved until it is changed.
 */
function draftField(field, origin = field.name) {
    const { value_text: exact, ...rest } = structuredClone(field);
    const draft = { ...rest, key: ++lastKey, origin };
    if (draft.type === "int" || draft.type === "float") {
        draft.text = exact ?? String(draft.value);
        draft.original = draft.text;
        draft.originalValue = draft.value;
        draft.problem = exact ? t("editor.int_range_fix", { max: LARGEST }) : null;
    }
    return draft;
}

/** A bundle's summary as the list gives it (bundle_library/store.py `_summary`): what the picker hands to a node. */
export function summaryOf(bundle) {
    const preview = (f) => {
        if (MEDIA_TYPES.has(f.type)) return f.asset ? { ...f.asset } : null;
        if (f.type === "text") return f.value.slice(0, TEXT_PREVIEW);
        if (f.type === "choice") return f.value; // whole: the node checks it against the options
        return f.value_text ?? f.value;
    };
    return {
        id: bundle.id,
        name: bundle.name,
        tags: [...bundle.tags],
        revision: bundle.revision,
        updated_at: bundle.updated_at,
        fields: bundle.fields.map((f) => ({ name: f.name, type: f.type, preview: preview(f),
            ...(f.source ? { source: { ...f.source } } : {}), ...(f.enabled === false ? { enabled: false } : {}) })),
        ...(bundle.warnings ? { warnings: bundle.warnings, warnings_i18n: bundle.warnings_i18n } : {}),
        ...(bundle.read_only ? { read_only: bundle.read_only, read_only_i18n: bundle.read_only_i18n } : {}),
    };
}

export class EditorModel {
    /** `bundle`: the stored bundle to edit, or null for a new one called `newName`. */
    constructor(bundle, newName = t("common.new_bundle")) {
        // Uploads running, by field key: {controller, name, sent}. Only the file
        // chosen last for a field counts; an earlier upload is stopped.
        this.uploads = new Map();
        // What was asked of a choice's source, by field key: {ticket, answer, failure}.
        // Not part of the draft: reading options changes nothing to save (CH07).
        this.lookups = new Map();
        this.load(bundle, newName);
    }

    /** Edit `bundle` (as stored) from now on, or a new one: the draft starts over, and running uploads stop. */
    load(bundle, newName = t("common.new_bundle")) {
        this.stopUploads();
        this.lookups.clear(); // answers still on their way are for the draft that went
        this.saved = bundle;
        this.pendingCategory = null; // where a new bundle goes when first saved (an id, or null)
        this.draft = bundle
            ? { name: bundle.name, tags: [...bundle.tags], note: bundle.note ?? "", fields: bundle.fields.map((f) => draftField(f)) }
            : { name: newName, tags: [], note: "", fields: [] };
        this.blank = bundle ? null : JSON.stringify(editable(this.draft)); // a new draft as it started
    }

    /** Drop the changes: the stored bundle as it is. */
    revert() {
        if (this.saved) this.load(this.saved);
    }

    /** Why this version must not change the bundle (it holds data this version does not know), or null. */
    get readOnly() {
        return this.saved?.read_only ? said(this.saved, "read_only") : null;
    }

    field(key) {
        return this.draft.fields.find((f) => f.key === key) ?? null;
    }

    /** Whether the draft, as it would be saved, differs from the stored bundle (always, for a new one). */
    get dirty() {
        return !this.saved || JSON.stringify(editable(this.draft)) !== JSON.stringify(editable(this.saved));
    }

    /** The number fields whose box holds text the user typed that is not a value (the text a field came with does not count). */
    get typed() {
        return this.draft.fields.filter((f) => f.problem && f.text !== f.original);
    }

    /**
     * Whether leaving now would lose something: a change to the draft, a
     * number typed that does not parse, or an upload in progress. A warning
     * the stored bundle came with is not a change. The state shown, Revert,
     * Duplicate and the window's lock all go by this.
     */
    get changed() {
        return this.dirty || this.uploads.size > 0 || this.typed.length > 0;
    }

    /** A new draft nobody has touched yet: it goes without asking. */
    get untouched() {
        return !this.saved && !this.pendingCategory && this.uploads.size === 0 && this.typed.length === 0
            && JSON.stringify(editable(this.draft)) === this.blank;
    }

    /** What each card says about its field's name, by key: {problem, renamed}, each a sentence or null. */
    nameNotes() {
        const counts = new Map();
        for (const field of this.draft.fields) counts.set(field.name.trim(), (counts.get(field.name.trim()) ?? 0) + 1);
        const notes = new Map();
        for (const field of this.draft.fields) {
            const name = field.name.trim();
            const problem = !name ? t("editor.field_name_required")
                : counts.get(name) > 1 ? t("editor.field_name_taken", { name })
                    : name.startsWith("@") ? t("editor.field_name_reserved") : null;
            const renamed = field.origin && field.origin !== name
                ? t("editor.renamed_from", { origin: field.origin }) : null;
            notes.set(field.key, { problem, renamed });
        }
        return notes;
    }

    /** Why the draft cannot be saved as it is, or null. */
    get blocker() {
        if (this.readOnly) return t("editor.locked");
        if (this.uploads.size > 0) return t("editor.wait_upload");
        if (!this.draft.name.trim()) return t("editor.name_required");
        if ([...this.nameNotes().values()].some((n) => n.problem)) return t("editor.fix_field_names");
        if (this.draft.fields.some((f) => f.problem)) return t("editor.fix_values");
        return null;
    }

    /** The summary the list would give for the stored bundle, or null for a new one. */
    summary() {
        return this.saved ? summaryOf(this.saved) : null;
    }

    // -- changes to the draft --------------------------------------------------

    /** The text of a number field's box changed. Typing back the text it came with brings its value back too. */
    setNumber(field, text) {
        field.text = text;
        field.problem = numberProblem(field.type, text);
        if (!field.problem) field.value = Number(text);
        else if (text === field.original) field.value = field.originalValue;
    }

    /** Add a field of `type` at the end, named `<type>_<n>`; returns it. */
    addField(type) {
        const taken = new Set(this.draft.fields.map((f) => f.name));
        let n = 1;
        while (taken.has(`${type}_${n}`)) n++;
        const name = `${type}_${n}`;
        const field = draftField(MEDIA_TYPES.has(type) ? { name, type, asset: null } : { name, type, value: BLANK[type] }, null);
        this.draft.fields.push(field);
        return field;
    }

    removeField(field) {
        this.stopUpload(field);
        this.lookups.delete(field.key);
        this.draft.fields = this.draft.fields.filter((f) => f !== field);
    }

    /** Move a field up (-1) or down (+1); whether it moved. */
    moveField(field, delta) {
        const index = this.draft.fields.indexOf(field);
        return index >= 0 && this.moveFieldTo(field, index + delta);
    }

    /** Move a field to `index` among the fields (the place it is dropped at, 0.0.28); whether it moved. */
    moveFieldTo(field, index) {
        const fields = this.draft.fields;
        const from = fields.indexOf(field);
        if (from < 0 || index < 0 || index >= fields.length || index === from) return false;
        fields.splice(from, 1);
        fields.splice(index, 0, field);
        return true;
    }

    /** Add a tag unless it is blank or already there (regardless of case); whether it was added. */
    addTag(text) {
        const tag = text.trim();
        if (!tag || this.draft.tags.some((t) => sameTag(t, tag))) return false;
        this.draft.tags.push(tag);
        return true;
    }

    removeTag(index) {
        this.draft.tags.splice(index, 1);
    }

    /** Turn a field off (kept with its value, but no node outputs it) or on again (0.0.30); whether it is on now. */
    toggleField(field) {
        if (field.enabled === false) delete field.enabled;
        else field.enabled = false;
        return field.enabled !== false;
    }

    /** Take a file the library already keeps (picked from it, 0.0.29); an upload running for the field stops. */
    takeAsset(field, asset) {
        this.stopUpload(field);
        field.asset = asset;
        field.fileError = null;
    }

    clearAsset(field) {
        field.asset = null;
        field.fileError = null;
    }

    // -- a choice's source (0.2.0) -------------------------------------------

    /** Check a choice against the options of `source` ({node, input}), or against none (null). Its value stays. */
    setSource(field, source) {
        if (source) field.source = { node: source.node, input: source.input };
        else delete field.source;
        this.lookups.delete(field.key);
    }

    /**
     * Ask for the options of the field's source: a ticket for the answer.
     * Only the field's latest ask counts (another source chosen, the field
     * removed, another bundle opened: the answer is dropped).
     */
    askOptions(field) {
        const ticket = { key: field.key, source: sourceKey(field.source) };
        this.lookups.set(field.key, { ticket, answer: null, failure: null });
        return ticket;
    }

    /** The answer to `ticket`: what was read (`answer`), or why nothing was (`failure`). Whether it was taken. */
    answerOptions(ticket, { answer = null, failure = null }) {
        const entry = this.lookups.get(ticket.key);
        const field = this.field(ticket.key);
        if (!entry || entry.ticket !== ticket || !field || sourceKey(field.source) !== ticket.source) return false;
        entry.answer = answer;
        entry.failure = failure;
        return true;
    }

    /** What is known of the field's source now: {answer, failure, asked}; asked is false until it is asked for. */
    options(field) {
        const entry = this.lookups.get(field.key);
        if (!entry || entry.ticket.source !== sourceKey(field.source)) return { answer: null, failure: null, asked: false };
        return { answer: entry.answer, failure: entry.failure, asked: true };
    }

    // -- uploads ---------------------------------------------------------------

    /** A file named `name` starts uploading into `field`; an earlier upload for it stops. */
    startUpload(field, name) {
        this.stopUpload(field);
        const transfer = { controller: new AbortController(), name, sent: 0 };
        this.uploads.set(field.key, transfer);
        field.fileError = null;
        return transfer;
    }

    /** The upload `transfer` ended: with `asset`, or with `error` (a message). Whether it was still the field's upload (only then is it applied). */
    endUpload(field, transfer, { asset = null, error = null }) {
        if (this.uploads.get(field.key) !== transfer) return false; // stopped: another file, Cancel, or the field went
        this.uploads.delete(field.key);
        if (asset) field.asset = asset;
        field.fileError = error;
        return true;
    }

    /** Stop the field's upload, if one runs: its answer will be ignored. The transfer stopped, or null. */
    stopUpload(field) {
        const transfer = this.uploads.get(field.key);
        if (!transfer) return null;
        this.uploads.delete(field.key);
        transfer.controller.abort();
        return transfer;
    }

    stopUploads() {
        for (const transfer of this.uploads.values()) transfer.controller.abort();
        this.uploads.clear();
    }
}
