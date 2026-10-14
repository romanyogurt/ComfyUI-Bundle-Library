// The editor for one bundle inside the library modal. It works on a draft and
// talks to the API only on Save, Duplicate and Delete (and file uploads).
import {
    MEDIA, assetURL, createBundle, deleteBundle, duplicateBundle, fileProblem, getBundle,
    thumbnailURL, updateBundle, uploadAsset,
} from "./api.js";
import { button, el, formatBytes, formatDuration } from "./dom.js";
import { POOL_SIZE } from "./reconcile.js";

const TYPES = [["text", "Text"], ["image", "Image"], ["video", "Video"], ["audio", "Audio"],
    ["boolean", "Boolean"], ["int", "Integer"], ["float", "Float"]];
const BLANK = { text: "", boolean: false, int: 0, float: 0 };
const NOUN = { image: "an image", video: "a video", audio: "an audio file" };
const MAX_TEXT_HEIGHT = 320;

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** The editable part of a bundle, as the API takes it. */
function editable(bundle) {
    return {
        name: bundle.name,
        tags: [...bundle.tags],
        note: bundle.note ?? "",
        fields: bundle.fields.map((f) => {
            if (!(f.type in MEDIA)) return { name: f.name, type: f.type, value: f.value };
            const asset = f.asset && { sha256: f.asset.sha256, ...(f.asset.original_name ? { original_name: f.asset.original_name } : {}) };
            return { name: f.name, type: f.type, asset: asset || null };
        }),
    };
}

/** A working copy. Each field remembers the name it was saved under (`origin`). */
function draftOf(bundle) {
    return {
        name: bundle.name,
        tags: [...bundle.tags],
        note: bundle.note ?? "",
        fields: bundle.fields.map((f) => ({ ...structuredClone(f), origin: f.name })),
    };
}

/** One line about a stored file: size, length, format. */
function describeAsset(kind, asset) {
    const size = formatBytes(asset.bytes);
    if (kind === "image") return `${asset.width} × ${asset.height} · ${size}`;
    const time = asset.duration != null ? formatDuration(asset.duration) : null;
    if (kind === "video") {
        const sound = asset.has_audio ? (asset.audio_codec ?? "sound") : "no sound";
        return [`${asset.width} × ${asset.height}`, asset.fps && `${asset.fps} fps`, time, size,
            `${asset.codec} + ${sound}`].filter(Boolean).join(" · ");
    }
    const channels = { 1: "mono", 2: "stereo" }[asset.channels] ?? `${asset.channels} channels`;
    return [time, asset.sample_rate && `${asset.sample_rate / 1000} kHz`, channels, size, asset.codec]
        .filter(Boolean).join(" · ");
}

function autosize(area) {
    area.style.height = "auto";
    area.style.height = `${Math.min(area.scrollHeight + 2, MAX_TEXT_HEIGHT)}px`;
}

export class BundleEditor {
    /** `bundle` is the saved bundle to edit, or null for a new one called `newName`. */
    constructor(modal, bundle, newName) {
        this.modal = modal;
        this.saved = bundle;
        this.draft = bundle ? draftOf(bundle) : { name: newName, tags: [], note: "", fields: [] };
        this.uploads = 0;
        this.saving = false;
        this.cards = [];
        this.invalid = new Set(); // fields whose number input does not parse
        this.problems = 0; // fields with a name the server would refuse
        this.root = el("div", "bl-editor");
        // One listener for every popup menu the editor shows.
        this.root.addEventListener("pointerdown", (e) => {
            for (const menu of this.root.querySelectorAll(".bl-menu:not([hidden])")) {
                if (!menu.parentElement.contains(e.target)) menu.hidden = true;
            }
        });
        this.render();
    }

    get dirty() {
        return !this.saved || JSON.stringify(editable(this.draft)) !== JSON.stringify(editable(this.saved));
    }

    /** Why the draft cannot be saved as it is, or null. */
    get blocker() {
        if (this.uploads > 0) return "Wait for the upload to finish.";
        if (!this.draft.name.trim()) return "The bundle needs a name.";
        if (this.problems > 0) return "Fix the marked field names first.";
        if (this.invalid.size > 0) return "Fix the marked values first.";
        return null;
    }

    render() {
        this.invalid.clear(); // the inputs are rebuilt from the draft's (valid) values
        const fields = el("div", "bl-fields");
        this.cards = this.draft.fields.map((field, index) => this.renderField(field, index));
        fields.append(...this.cards.map((card) => card.root));
        if (!this.cards.length) fields.append(el("div", "bl-empty-state", "No fields yet. Add one below."));
        this.root.replaceChildren(this.renderHead(), this.renderMeta(), fields, this.renderAdd());
        for (const area of this.root.querySelectorAll("textarea.bl-value-text")) requestAnimationFrame(() => autosize(area));
        this.modal.keepFocus(); // the focused element may have been replaced
        this.refreshWarnings();
        this.refreshState();
    }

    menu(label, items, className = "bl-btn") {
        const root = el("span", "bl-menu-wrap");
        const opener = button(label, className);
        const menu = el("div", "bl-menu");
        menu.hidden = true;
        for (const [text, action] of items) {
            const item = button(text, "bl-menu-item");
            item.addEventListener("click", () => {
                menu.hidden = true;
                action();
            });
            menu.append(item);
        }
        opener.addEventListener("click", () => {
            menu.hidden = !menu.hidden;
            if (!menu.hidden) menu.scrollIntoView({ block: "nearest" }); // "+ Add field" sits at the bottom
        });
        root.append(opener, menu);
        return { root, opener };
    }

    renderHead() {
        const head = el("div", "bl-editor-head");
        this.nameInput = el("input", "bl-input bl-name-input");
        this.nameInput.value = this.draft.name;
        this.nameInput.placeholder = "Bundle name";
        this.nameInput.maxLength = 120;
        this.nameInput.addEventListener("input", () => {
            this.draft.name = this.nameInput.value;
            this.refreshState();
        });
        this.stateMark = el("span", "bl-state");
        this.saveButton = button("Save", "bl-btn primary", "Save (Ctrl+S)");
        this.saveButton.addEventListener("click", () => void this.save());
        this.revertButton = button("Revert", "bl-btn");
        this.revertButton.addEventListener("click", () => this.revert());
        const duplicate = this.menu("Duplicate ▾", [
            ["Duplicate with values", () => void this.duplicate("values")],
            ["Duplicate structure only", () => void this.duplicate("structure")],
        ]);
        this.duplicateButton = duplicate.opener;
        this.deleteButton = button("Delete", "bl-btn danger");
        this.deleteButton.addEventListener("click", () => void this.remove());
        head.append(this.nameInput, this.stateMark, this.saveButton, this.revertButton, duplicate.root, this.deleteButton);
        return head;
    }

    renderMeta() {
        const meta = el("div", "bl-editor-meta");
        const tags = el("div", "bl-tags");
        const renderTags = (focus) => {
            const input = el("input", "bl-input bl-tag-input");
            input.placeholder = "+ tag";
            input.maxLength = 40;
            input.addEventListener("keydown", (e) => {
                if (e.isComposing || (e.key !== "Enter" && e.key !== ",")) return;
                e.preventDefault();
                const tag = input.value.trim();
                if (tag && !this.draft.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) this.draft.tags.push(tag);
                renderTags(true);
                this.refreshState();
            });
            tags.replaceChildren(el("span", "bl-label", "Tags"), ...this.draft.tags.map((tag, i) => {
                const chip = el("span", "bl-chip", tag);
                const remove = button("×", "bl-chip-x", `Remove the tag '${tag}'`);
                remove.addEventListener("click", () => {
                    this.draft.tags.splice(i, 1);
                    renderTags();
                    this.refreshState();
                });
                chip.append(remove);
                return chip;
            }), input);
            if (focus) input.focus();
        };
        renderTags();
        const note = el("textarea", "bl-textarea bl-note-input");
        note.rows = 2;
        note.placeholder = "Note (optional)";
        note.value = this.draft.note;
        note.addEventListener("input", () => {
            this.draft.note = note.value;
            this.refreshState();
        });
        meta.append(tags, note);
        return meta;
    }

    renderField(field, index) {
        const root = el("div", "bl-field");
        root.dataset.field = field.name;
        const head = el("div", "bl-field-head");
        const name = el("input", "bl-input bl-field-name");
        name.value = field.name;
        name.placeholder = "Field name";
        name.maxLength = 64;
        name.addEventListener("input", () => {
            field.name = name.value;
            this.refreshWarnings();
            this.refreshState();
        });
        const up = button("▲", "bl-btn icon", "Move up");
        up.disabled = index === 0;
        up.addEventListener("click", () => this.move(index, -1));
        const down = button("▼", "bl-btn icon", "Move down");
        down.disabled = index === this.draft.fields.length - 1;
        down.addEventListener("click", () => this.move(index, 1));
        const remove = button("✕", "bl-btn icon danger", "Remove the field");
        remove.addEventListener("click", () => void this.removeField(index));
        head.append(name, el("span", "bl-badge", field.type), up, down, remove);
        const warning = el("div", "bl-warn");
        const error = el("div", "bl-error");
        error.hidden = true;
        const body = el("div", "bl-field-body");
        body.append(this.valueEditor(field, root, error));
        root.append(head, warning, body, error);
        return { root, field, warning, error };
    }

    valueEditor(field, card, error) {
        if (field.type === "text") {
            const area = el("textarea", "bl-textarea bl-value-text");
            area.value = field.value;
            area.rows = 3;
            area.spellcheck = false;
            const count = el("div", "bl-count");
            const counted = () => {
                count.textContent = `${plural(field.value.length, "character")} · ${plural(field.value.split("\n").length, "line")}`;
            };
            area.addEventListener("input", () => {
                field.value = area.value;
                counted();
                autosize(area);
                this.refreshState();
            });
            counted();
            const wrap = el("div", "bl-text-edit");
            wrap.append(area, count);
            return wrap;
        }
        if (field.type === "boolean") {
            const label = el("label", "bl-switch");
            const box = el("input");
            box.type = "checkbox";
            box.setAttribute("role", "switch");
            box.checked = field.value;
            const text = el("span", "bl-switch-text", String(field.value));
            box.addEventListener("change", () => {
                field.value = box.checked;
                text.textContent = String(box.checked);
                this.refreshState();
            });
            label.append(box, text);
            return label;
        }
        if (field.type === "int" || field.type === "float") {
            const input = el("input", "bl-input bl-number");
            input.type = "number";
            input.step = field.type === "int" ? "1" : "any";
            input.value = String(field.value);
            input.addEventListener("input", () => {
                const value = Number(input.value);
                const valid = input.value.trim() !== "" && Number.isFinite(value)
                    && (field.type !== "int" || Number.isSafeInteger(value));
                error.hidden = valid;
                if (valid) {
                    field.value = value;
                    this.invalid.delete(field);
                } else {
                    error.textContent = field.type === "int" ? "Enter a whole number." : "Enter a number.";
                    this.invalid.add(field);
                }
                this.refreshState();
            });
            return input;
        }
        return this.mediaEditor(field, card, error);
    }

    /** The card body of an image, video or audio field: a preview of the file and ways to replace it. */
    mediaEditor(field, card, error) {
        const kind = field.type;
        const box = el("div", `bl-media bl-media-${kind}`);
        const picker = el("input");
        picker.type = "file";
        picker.accept = MEDIA[kind].accept;
        picker.hidden = true;
        const progress = el("progress", "bl-progress");
        progress.max = 1;
        progress.hidden = true;
        picker.addEventListener("change", () => {
            if (picker.files[0]) void this.setFile(field, picker.files[0], error, progress);
            picker.value = "";
        });
        const choose = button(field.asset ? "Replace…" : `Choose ${NOUN[kind]}…`);
        choose.addEventListener("click", () => picker.click());
        const verb = kind === "image" ? "Drop or paste" : "Drop";
        if (field.asset) {
            const meta = el("div", "bl-media-meta");
            meta.append(el("div", null, describeAsset(kind, field.asset)));
            if (field.asset.original_name) meta.append(el("div", "bl-dim", field.asset.original_name));
            const clear = button("Clear");
            clear.addEventListener("click", () => {
                field.asset = null;
                this.render();
            });
            const actions = el("div", "bl-row-buttons");
            actions.append(choose, clear);
            meta.append(actions, progress, el("div", "bl-hint", `${verb} ${NOUN[kind]} to replace it.`));
            box.append(this.mediaPreview(field), meta);
        } else {
            const drop = el("div", "bl-drop", `${verb} ${NOUN[kind]} here, or `);
            drop.append(choose);
            box.append(drop, progress);
        }
        box.append(picker);
        // The card takes drops and, once focused (click it), pastes.
        card.tabIndex = 0;
        card.addEventListener("dragover", (e) => {
            if (![...(e.dataTransfer?.types ?? [])].includes("Files")) return;
            e.preventDefault();
            card.classList.add("drop-target");
        });
        card.addEventListener("dragleave", () => card.classList.remove("drop-target"));
        card.addEventListener("drop", (e) => {
            e.preventDefault();
            card.classList.remove("drop-target");
            const file = e.dataTransfer?.files?.[0];
            if (file) void this.setFile(field, file, error, progress);
        });
        card.addEventListener("paste", (e) => {
            const file = e.clipboardData?.files?.[0];
            if (!file) return;
            e.preventDefault();
            void this.setFile(field, file, error, progress);
        });
        return box;
    }

    mediaPreview(field) {
        const { asset } = field;
        if (field.type === "image") {
            const img = el("img", "bl-image-thumb");
            img.src = thumbnailURL(asset.sha256, 256);
            img.alt = field.name;
            img.title = "Show at full size";
            img.addEventListener("click", () => this.modal.viewImage(
                assetURL(asset.sha256), [field.name, asset.original_name].filter(Boolean).join(" · ")));
            return img;
        }
        const player = el(field.type, `bl-${field.type}`);
        player.controls = true;
        player.preload = "metadata";
        if (field.type === "video") player.poster = thumbnailURL(asset.sha256, 512);
        player.src = assetURL(asset.sha256);
        return player;
    }

    async setFile(field, file, error, progress) {
        const kind = field.type;
        error.hidden = true;
        const fail = (message) => {
            error.textContent = message;
            error.hidden = false;
            this.modal.status(message, "error");
        };
        const problem = fileProblem(file, kind);
        if (problem) return fail(problem);
        this.uploads++;
        this.refreshState();
        this.modal.status(`Uploading ${file.name || `the ${kind}`}…`);
        progress.value = 0;
        progress.hidden = false;
        try {
            field.asset = await uploadAsset(file, kind, (sent) => { progress.value = sent; },
                file.name || (kind === "image" ? "pasted.png" : kind));
            this.modal.status(`Uploaded ${field.asset.original_name ?? `the ${kind}`}.`);
            this.render();
        } catch (e) {
            progress.hidden = true;
            fail(e.message);
        } finally {
            this.uploads--;
            this.refreshState();
        }
    }

    renderAdd() {
        const add = this.menu("+ Add field ▾", TYPES.map(([type, label]) => [label, () => this.addField(type)]));
        add.opener.disabled = this.draft.fields.length >= POOL_SIZE;
        if (add.opener.disabled) add.opener.title = `A bundle has ${POOL_SIZE} fields at most.`;
        const row = el("div", "bl-add-field");
        row.append(add.root);
        return row;
    }

    addField(type) {
        const taken = new Set(this.draft.fields.map((f) => f.name));
        let n = 1;
        while (taken.has(`${type}_${n}`)) n++;
        const field = type in MEDIA
            ? { name: `${type}_${n}`, type, asset: null, origin: null }
            : { name: `${type}_${n}`, type, value: BLANK[type], origin: null };
        this.draft.fields.push(field);
        this.render();
        const name = this.cards.at(-1).root.querySelector(".bl-field-name");
        name.focus();
        name.select();
    }

    async removeField(index) {
        const field = this.draft.fields[index];
        if (field.origin) {
            const confirmed = await this.modal.confirm(
                `Remove the field '${field.name}'?`,
                `Workflows connected to '${field.origin}' will fail when they run, until they are reconnected. `
                + "Nothing changes until you save.",
                "Remove", { danger: true });
            if (!confirmed) return;
        }
        this.draft.fields.splice(index, 1);
        this.render();
    }

    move(index, delta) {
        const fields = this.draft.fields;
        [fields[index], fields[index + delta]] = [fields[index + delta], fields[index]];
        this.render();
    }

    /** Name problems and rename notices for every card; duplicates involve two cards at once. */
    refreshWarnings() {
        const counts = new Map();
        for (const field of this.draft.fields) counts.set(field.name.trim(), (counts.get(field.name.trim()) ?? 0) + 1);
        this.problems = 0;
        for (const { field, warning } of this.cards) {
            const name = field.name.trim();
            const notes = [];
            if (!name) notes.push("A field needs a name.");
            else if (counts.get(name) > 1) notes.push(`Another field is also named '${name}'.`);
            else if (name.startsWith("@")) notes.push("Names starting with '@' are reserved.");
            if (notes.length) this.problems++;
            if (field.origin && field.origin !== name) {
                notes.push(`Renamed from '${field.origin}': workflows connected to '${field.origin}' will show it as missing.`);
            }
            warning.textContent = notes.join(" ");
            warning.hidden = notes.length === 0;
        }
    }

    refreshState() {
        const dirty = this.dirty;
        const blocker = this.blocker;
        this.stateMark.textContent = !this.saved ? "● New, not saved yet" : dirty ? "● Unsaved changes" : "Saved";
        this.stateMark.classList.toggle("clean", !dirty);
        this.saveButton.disabled = !dirty || !!blocker || this.saving;
        this.saveButton.title = blocker ?? "Save (Ctrl+S)";
        this.revertButton.disabled = !dirty;
        this.revertButton.textContent = this.saved ? "Revert" : "Discard";
        this.duplicateButton.disabled = !this.saved || dirty;
        this.duplicateButton.title = dirty ? "Save or revert your changes first" : "";
        this.deleteButton.disabled = !this.saved;
        this.modal.editorChanged();
    }

    async save() {
        if (!this.dirty || this.saving) return; // a second Ctrl+S would conflict with the first
        if (this.blocker) {
            this.modal.status(this.blocker, "error");
            return;
        }
        const data = editable(this.draft);
        this.saving = true;
        this.saveButton.disabled = true;
        try {
            const saved = this.saved
                ? await updateBundle(this.saved.id, data, this.saved.revision)
                : await createBundle(data);
            await this.adopt(saved, "Saved.");
        } catch (error) {
            if (error.code === "revision_conflict") await this.resolveConflict(data, error.details.current_revision);
            else this.modal.status(error.message, "error");
        } finally {
            this.saving = false;
            this.refreshState();
        }
    }

    async adopt(saved, message) {
        this.saved = saved;
        this.draft = draftOf(saved);
        this.render();
        await this.modal.bundleSaved(saved);
        this.modal.status(message);
    }

    async resolveConflict(data, currentRevision) {
        const choice = await this.modal.choose(
            "This bundle was changed elsewhere",
            `It was saved again (revision ${currentRevision}) after you opened it. Overwrite it with your version, `
            + "or reload it and lose your changes?",
            [["Overwrite", "overwrite", "danger"], ["Reload", "reload"], ["Cancel", null]]);
        try {
            if (choice === "overwrite") {
                await this.adopt(await updateBundle(this.saved.id, data, currentRevision), "Saved over the other change.");
            } else if (choice === "reload") {
                const latest = await getBundle(this.saved.id);
                this.saved = latest;
                this.draft = draftOf(latest);
                this.render();
                this.modal.status("Reloaded the saved version.");
            }
        } catch (error) {
            this.modal.status(error.message, "error");
        }
    }

    revert() {
        if (!this.saved) {
            this.modal.discardDraft();
            return;
        }
        this.draft = draftOf(this.saved);
        this.render();
        this.modal.status("Changes discarded.");
    }

    async duplicate(mode) {
        try {
            const copy = await duplicateBundle(this.saved.id, mode);
            await this.modal.bundleSaved(copy, { open: true });
            this.modal.status(`Created '${copy.name}'.`);
        } catch (error) {
            this.modal.status(error.message, "error");
        }
    }

    async remove() {
        const confirmed = await this.modal.confirm(
            `Delete '${this.saved.name}'?`,
            "The bundle moves to the library's trash folder. Workflows that use it will report it as missing.",
            "Delete", { danger: true });
        if (!confirmed) return;
        try {
            await deleteBundle(this.saved.id, this.saved.revision);
            await this.modal.bundleDeleted(this.saved);
        } catch (error) {
            this.modal.status(error.code === "revision_conflict"
                ? "The bundle changed elsewhere. Reopen it before deleting." : error.message, "error");
        }
    }
}
