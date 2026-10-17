// The editor for one bundle inside the library modal. What it edits is an
// EditorModel (editor_model.js): the stored bundle, the draft, the number
// boxes' text and the uploads. This draws it, card by card: a change to one
// field draws that card again, so the focus stays where it is. It talks to
// the API only on Save, Duplicate and Delete (and file uploads), each as a
// command that holds the window until its answer is in. Its category and
// star are not part of the draft: the modal saves them at once.
import {
    MEDIA, assetURL, createBundle, deleteBundle, duplicateBundle, fileProblem, getBundle,
    thumbnailURL, updateBundle, uploadAsset,
} from "./api.js";
import { button, el, formatBytes, formatDuration, icon, iconButton, menu } from "./dom.js";
import { EditorModel, MEDIA_TYPES, editable } from "./editor_model.js";
import { msg, said, t, tn } from "./i18n.js";
import { POOL_SIZE } from "./reconcile.js";

const TYPES = [["text", msg("Text")], ["image", msg("Image")], ["video", msg("Video")], ["audio", msg("Audio")],
    ["boolean", msg("Boolean")], ["int", msg("Integer")], ["float", msg("Float")]];
// A field's type on its badge: the type's own name in English.
const BADGE = { text: msg("text"), image: msg("image"), video: msg("video"), audio: msg("audio"), boolean: msg("boolean"),
    int: msg("int"), float: msg("float") };
// What a media field says, by its kind: whole sentences, so each language says them its own way.
const MEDIA_TEXT = {
    image: { choose: msg("Choose an image…"), drop: msg("Drop or paste an image here, or "),
        replace: msg("Drop or paste an image to replace it."), uploaded: msg("Uploaded the image.") },
    video: { choose: msg("Choose a video…"), drop: msg("Drop a video here, or "), replace: msg("Drop a video to replace it."),
        uploaded: msg("Uploaded the video.") },
    audio: { choose: msg("Choose an audio file…"), drop: msg("Drop an audio file here, or "),
        replace: msg("Drop an audio file to replace it."), uploaded: msg("Uploaded the audio.") },
};
const MAX_TEXT_HEIGHT = 320;
const NEW_CATEGORY = "new"; // the "New category…" choice of the category select (ids are UUIDs)
// What the editor says while one of its commands is out.
const BUSY = {
    save: [msg("Saving…"), msg("Wait until the bundle is saved.")],
    duplicate: [msg("Duplicating…"), msg("Wait until the copy is made.")],
    delete: [msg("Moving to the trash…"), msg("Wait until the bundle is in the trash.")],
};

/** One line about a stored file: size, length, format. */
function describeAsset(kind, asset) {
    const size = formatBytes(asset.bytes);
    if (kind === "image") return `${asset.width} × ${asset.height} · ${size}`;
    const time = asset.duration != null ? formatDuration(asset.duration) : null;
    if (kind === "video") {
        const sound = asset.has_audio ? (asset.audio_codec ?? t("sound")) : t("no sound");
        return [`${asset.width} × ${asset.height}`, asset.fps && `${asset.fps} fps`, time, size,
            `${asset.codec} + ${sound}`].filter(Boolean).join(" · ");
    }
    const channels = asset.channels === 1 ? t("mono") : asset.channels === 2 ? t("stereo")
        : t("{count} channels", { count: asset.channels });
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
        this.model = new EditorModel(bundle, newName);
        this.busy = null; // the command of the editor that is out: "save", "duplicate" or "delete"
        this.cards = new Map(); // by field key
        this.tagText = ""; // a tag typed but not entered yet; kept when the tags are drawn again
        this.root = el("div", "bl-editor");
        this.render();
    }

    // What the modal reads.
    get saved() {
        return this.model.saved;
    }

    get draft() {
        return this.model.draft;
    }

    /** Whether leaving now would lose something (see EditorModel.changed). */
    get changed() {
        return this.model.changed;
    }

    get untouched() {
        return this.model.untouched;
    }

    get blocker() {
        return this.model.blocker;
    }

    get readOnly() {
        return this.model.readOnly;
    }

    /** Draw everything from the model: when it holds another draft (opened, saved, reverted). */
    render() {
        const place = this.focusPlace();
        this.cards.clear();
        this.fieldsBox = el("div", "bl-fields");
        for (const field of this.draft.fields) {
            const card = this.renderField(field);
            this.cards.set(field.key, card);
            this.fieldsBox.append(card.root);
        }
        if (!this.draft.fields.length) this.fieldsBox.append(this.noFields());
        const meta = this.renderMeta();
        const add = this.renderAdd();
        if (this.readOnly) this.fieldsBox.inert = add.inert = true; // renderMeta() keeps the category free
        this.root.replaceChildren(...[this.renderHead(), this.renderNotes(), meta, this.fieldsBox, add].filter(Boolean));
        for (const area of this.root.querySelectorAll("textarea.bl-value-text")) requestAnimationFrame(() => autosize(area));
        this.restoreFocus(place);
        this.modal.keepFocus(); // the focused element may have been replaced
        this.organizationChanged();
        this.refreshMoves();
        this.refreshWarnings();
        this.refreshState();
    }

    noFields() {
        return el("div", "bl-empty-state bl-no-fields", t("No fields yet. Add one below."));
    }

    /** Where the focus is in the editor: which card (by position) or none, which element, and the selection in it. */
    focusPlace() {
        const active = document.activeElement;
        if (!this.root.contains(active) || active === this.root || !active.className) return null;
        const card = active.closest(".bl-field");
        const place = { index: card ? [...card.parentElement.children].indexOf(card) : null,
            selector: active === card ? null : `.${active.className.trim().split(/\s+/).join(".")}` }; // null: the card itself
        try {
            place.range = [active.selectionStart, active.selectionEnd];
        } catch {
            // a number box or a button has no text selection
        }
        return place;
    }

    /** Focus the same place after the editor was drawn again, if it is there. */
    restoreFocus(place) {
        if (!place) return;
        const scope = place.index === null ? this.root : this.fieldsBox.children[place.index];
        const target = place.selector ? scope?.querySelector(place.selector) : scope;
        if (!target || target.disabled) return;
        target.focus({ preventScroll: true });
        if (place.range?.[0] != null) {
            try {
                target.setSelectionRange(...place.range);
            } catch {
                // not a text box after all
            }
        }
    }

    renderHead() {
        const head = el("div", "bl-editor-head");
        this.starButton = button("☆", "bl-btn icon bl-star");
        this.starButton.addEventListener("click", () => {
            if (this.saved) void this.modal.toggleFavorite(this.saved.id);
        });
        this.nameInput = el("input", "bl-input bl-name-input");
        this.nameInput.value = this.draft.name;
        this.nameInput.placeholder = t("Bundle name");
        this.nameInput.maxLength = 120;
        this.nameInput.readOnly = !!this.readOnly; // a change could not be saved
        this.nameInput.addEventListener("input", () => {
            this.draft.name = this.nameInput.value;
            this.refreshState();
        });
        this.stateMark = el("span", "bl-state");
        // Icons in the head (0.0.26): less to read. The words stay as the buttons' names and tooltips.
        this.saveButton = iconButton("save", t("Save"), "primary bl-save");
        this.saveButton.title = t("Save (Ctrl+S)");
        this.saveButton.addEventListener("click", () => void this.save());
        this.revertButton = iconButton("undo", t("Revert"), "bl-revert");
        this.revertButton.addEventListener("click", () => this.revert());
        const face = el("span", "bl-icon-menu");
        face.append(icon("copy"), " ▾");
        const duplicate = menu(face, [
            [t("Duplicate with values"), () => void this.duplicate("values")],
            [t("Duplicate structure only"), () => void this.duplicate("structure")],
        ], { className: "bl-btn icon bl-duplicate", title: t("Duplicate"), label: t("Duplicate") });
        this.duplicateButton = duplicate.opener;
        this.exportButton = button("", "bl-btn icon bl-export");
        this.exportButton.setAttribute("aria-label", t("Export this bundle as a ZIP"));
        this.exportButton.append(icon("download"));
        this.exportButton.addEventListener("click", () => {
            const summary = this.model.summary();
            if (summary && !this.changed) void this.modal.runExport([summary]); // the bundle as saved
        });
        this.deleteButton = iconButton("trash", t("Delete"), "danger bl-delete");
        this.deleteButton.addEventListener("click", () => void this.remove());
        head.append(this.starButton, this.nameInput, this.stateMark, this.saveButton, this.revertButton, duplicate.root,
            this.exportButton, this.deleteButton);
        return head;
    }

    /** The bundle's category, or the one a new bundle goes in: an id, or null. */
    get category() {
        return this.saved ? (this.modal.summary(this.saved.id)?.category ?? null) : this.model.pendingCategory;
    }

    /**
     * Show the category and star as the list has them now. The modal calls this
     * when they change; the draft is left as it is, saved or not.
     */
    organizationChanged() {
        const summary = this.saved && this.modal.summary(this.saved.id);
        const why = this.modal.organizeBlocker;
        const favorite = !!summary?.favorite;
        this.starButton.textContent = favorite ? "★" : "☆";
        this.starButton.classList.toggle("on", favorite);
        this.starButton.setAttribute("aria-pressed", String(favorite));
        this.starButton.disabled = !summary || !!why;
        this.starButton.title = !this.saved ? t("Save the bundle to add it to the favorites")
            : why ?? (favorite ? t("Remove from the favorites") : t("Add to the favorites"));
        const pending = this.model.pendingCategory;
        if (pending && !this.modal.categories.some((c) => c.id === pending)) {
            this.model.pendingCategory = null; // deleted meanwhile
        }
        const options = [["", t("No category")], ...this.modal.categories.map((c) => [c.id, c.name])];
        if (!why) options.push([NEW_CATEGORY, t("New category…")]);
        const signature = JSON.stringify(options);
        if (this.categorySelect.dataset.options !== signature) { // rebuilding closes an open dropdown
            this.categorySelect.dataset.options = signature;
            this.categorySelect.replaceChildren(...options.map(([value, label]) => {
                const option = el("option", null, label);
                option.value = value;
                return option;
            }));
        }
        this.categorySelect.value = this.category ?? "";
        // A new bundle's category is part of what its first save does, so it can be chosen even then.
        this.categorySelect.disabled = !!why && !!this.saved;
        this.categorySelect.title = this.saved ? (why ?? "") : t("The category the bundle goes in when saved");
    }

    /** A choice in the category select: move the saved bundle at once, or remember it for the first save. */
    async chooseCategory(value) {
        let category = value || null;
        if (value === NEW_CATEGORY) {
            this.categorySelect.value = this.category ?? ""; // until the new one exists
            category = (await this.modal.newCategory())?.id;
            if (!category) return;
        }
        if (this.saved) {
            await this.modal.moveBundle(this.saved.id, category);
        } else {
            this.model.pendingCategory = category;
            this.organizationChanged();
            this.refreshState(); // a chosen category makes a new draft one to keep
        }
    }

    /** Why the stored bundle cannot be saved as it is: data this version does not
     * know, or values outside rules tightened since it was saved. */
    renderNotes() {
        if (!this.saved) return null;
        const notes = [];
        if (this.readOnly) {
            notes.push(t("This bundle {reason}. It can be used in workflows, but this version of Bundle Library does not change "
                + "it, so that nothing is lost. Update the node pack to edit it.", { reason: this.readOnly }));
        }
        for (const warning of said(this.saved, "warnings") ?? []) {
            notes.push(t("{warning} (allowed when it was saved). Fix this before saving.", { warning }));
        }
        if (!notes.length) return null;
        const box = el("div", "bl-editor-notes");
        box.append(...notes.map((text) => el("div", "bl-warn", text)));
        return box;
    }

    renderMeta() {
        const meta = el("div", "bl-editor-meta");
        // No labels in view (0.0.23): the select reads "No category" or a name, and the tags speak for themselves.
        const place = el("div", "bl-category-row");
        this.categorySelect = el("select", "bl-input bl-category-select");
        this.categorySelect.setAttribute("aria-label", t("Category"));
        this.categorySelect.title = t("Category");
        this.categorySelect.addEventListener("change", () => void this.chooseCategory(this.categorySelect.value));
        place.append(this.categorySelect);
        const tags = el("div", "bl-tags");
        tags.setAttribute("role", "group");
        tags.setAttribute("aria-label", t("Tags"));
        const renderTags = (focus) => {
            const input = el("input", "bl-input bl-tag-input");
            input.placeholder = t("+ tag");
            input.setAttribute("aria-label", t("Add a tag"));
            input.maxLength = 40;
            input.value = this.tagText;
            input.addEventListener("input", () => {
                this.tagText = input.value;
            });
            input.addEventListener("keydown", (e) => {
                if (e.isComposing || (e.key !== "Enter" && e.key !== ",")) return;
                e.preventDefault();
                this.model.addTag(input.value);
                this.tagText = "";
                renderTags(true);
                this.refreshState();
            });
            tags.replaceChildren(...this.draft.tags.map((tag, i) => {
                const chip = el("span", "bl-chip", tag);
                const remove = button("×", "bl-chip-x", t("Remove the tag '{tag}'", { tag }));
                remove.addEventListener("click", () => {
                    this.model.removeTag(i);
                    renderTags(true);
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
        note.placeholder = t("Note (optional)");
        note.value = this.draft.note;
        note.addEventListener("input", () => {
            this.draft.note = note.value;
            this.refreshState();
        });
        if (this.readOnly) tags.inert = note.inert = true; // its place in the list is not part of the bundle
        meta.append(place, tags, note);
        return meta;
    }

    /** A field's card: its name and the buttons that move or remove it, notes about the name, its value, and an error. */
    renderField(field) {
        const root = el("div", "bl-field");
        root.dataset.field = field.name;
        const head = el("div", "bl-field-head");
        const name = el("input", "bl-input bl-field-name");
        name.value = field.name;
        name.placeholder = t("Field name");
        name.maxLength = 64;
        name.addEventListener("input", () => {
            field.name = name.value;
            root.dataset.field = field.name;
            this.refreshWarnings();
            this.refreshState();
        });
        const up = button("▲", "bl-btn icon bl-move-up", t("Move up"));
        up.addEventListener("click", () => this.move(field, -1));
        const down = button("▼", "bl-btn icon bl-move-down", t("Move down"));
        down.addEventListener("click", () => this.move(field, 1));
        const remove = button("✕", "bl-btn icon danger", t("Remove the field"));
        remove.addEventListener("click", () => void this.removeField(field));
        head.append(name, el("span", "bl-badge", field.type in BADGE ? t(BADGE[field.type]) : field.type), up, down, remove);
        const warning = el("div", "bl-warn");
        const error = el("div", "bl-error");
        error.hidden = true;
        const body = el("div", "bl-field-body");
        root.append(head, warning, body, error);
        const card = { root, field, name, up, down, warning, body, error, bar: null };
        if (MEDIA_TYPES.has(field.type)) this.takeFiles(card);
        body.append(this.valueEditor(card));
        this.showError(card);
        return card;
    }

    /** Draw a card's value again (an upload started or ended, a file cleared); the focus stays on the card. */
    refreshField(field) {
        const card = this.cards.get(field.key);
        if (!card) return;
        const hadFocus = card.body.contains(document.activeElement);
        card.body.replaceChildren(this.valueEditor(card));
        this.showError(card);
        if (hadFocus) card.root.focus({ preventScroll: true });
    }

    /** The card's error: why its number does not parse, or why its file was refused. */
    showError(card) {
        const message = card.field.problem ?? card.field.fileError ?? null;
        card.error.textContent = message ?? "";
        card.error.hidden = !message;
    }

    valueEditor(card) {
        const { field } = card;
        if (field.type === "text") {
            const area = el("textarea", "bl-textarea bl-value-text");
            area.value = field.value;
            area.rows = 3;
            area.spellcheck = false;
            const count = el("div", "bl-count");
            const counted = () => {
                count.textContent = `${tn(field.value.length, "{count} character", "{count} characters")} · `
                    + tn(field.value.split("\n").length, "{count} line", "{count} lines");
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
            input.value = field.text; // as typed, also when it does not parse
            input.addEventListener("input", () => {
                this.model.setNumber(field, input.value);
                this.showError(card);
                this.refreshState();
            });
            return input;
        }
        return this.mediaEditor(card);
    }

    /** The card body of an image, video or audio field: a preview of the file and ways to replace it. */
    mediaEditor(card) {
        const { field } = card;
        const kind = field.type;
        const box = el("div", `bl-media bl-media-${kind}`);
        const picker = el("input");
        picker.type = "file";
        picker.accept = MEDIA[kind].accept;
        picker.hidden = true;
        picker.addEventListener("change", () => {
            if (picker.files[0]) void this.setFile(field, picker.files[0]);
            picker.value = "";
        });
        const choose = button(field.asset ? t("Replace…") : t(MEDIA_TEXT[kind].choose));
        choose.addEventListener("click", () => picker.click());
        const upload = this.uploadStatus(card);
        if (field.asset) {
            const meta = el("div", "bl-media-meta");
            meta.append(el("div", null, describeAsset(kind, field.asset)));
            if (field.asset.original_name) meta.append(el("div", "bl-dim", field.asset.original_name));
            const clear = button(t("Clear"));
            clear.addEventListener("click", () => {
                this.model.clearAsset(field);
                this.refreshField(field);
                this.refreshState();
            });
            const actions = el("div", "bl-row-buttons");
            actions.append(choose, clear);
            meta.append(actions, upload ?? el("div", "bl-hint", t(MEDIA_TEXT[kind].replace)));
            box.append(this.mediaPreview(field), meta);
        } else if (upload) {
            box.append(upload);
        } else {
            const drop = el("div", "bl-drop", t(MEDIA_TEXT[kind].drop));
            drop.append(choose);
            box.append(drop);
        }
        box.append(picker);
        return box;
    }

    /** A media card takes drops and, once focused (click it), pastes. */
    takeFiles(card) {
        const { root, field } = card;
        root.tabIndex = 0;
        root.addEventListener("dragover", (e) => {
            if (![...(e.dataTransfer?.types ?? [])].includes("Files")) return;
            e.preventDefault();
            root.classList.add("drop-target");
        });
        root.addEventListener("dragleave", () => root.classList.remove("drop-target"));
        root.addEventListener("drop", (e) => {
            e.preventDefault();
            root.classList.remove("drop-target");
            const file = e.dataTransfer?.files?.[0];
            if (file) void this.setFile(field, file);
        });
        root.addEventListener("paste", (e) => {
            const file = e.clipboardData?.files?.[0];
            if (!file) return;
            e.preventDefault();
            void this.setFile(field, file);
        });
    }

    /** The field's upload in progress, with a Cancel button, or null when none runs. */
    uploadStatus(card) {
        const transfer = this.model.uploads.get(card.field.key);
        if (!transfer) return null;
        const status = el("div", "bl-upload");
        const bar = el("progress", "bl-progress");
        bar.max = 1;
        bar.value = transfer.sent;
        card.bar = bar; // progress goes to the bar shown now
        const cancel = button(t("Cancel upload"));
        cancel.addEventListener("click", () => this.cancelUpload(card.field));
        status.append(el("div", null, t("Uploading {name}…", { name: transfer.name })), bar, cancel);
        return status;
    }

    mediaPreview(field) {
        const { asset } = field;
        if (field.type === "image") {
            const img = el("img", "bl-image-thumb");
            img.src = thumbnailURL(asset.sha256, 256);
            img.alt = field.name;
            img.title = t("Show at full size");
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

    async setFile(field, file) {
        const kind = field.type;
        const problem = fileProblem(file, kind);
        if (problem) {
            field.fileError = problem;
            const card = this.cards.get(field.key);
            if (card) this.showError(card);
            this.modal.status(problem, "error");
            return;
        }
        const name = file.name || (kind === "image" ? "pasted.png" : kind);
        const transfer = this.model.startUpload(field, name);
        this.refreshField(field);
        this.refreshState();
        this.modal.status(t("Uploading {name}…", { name }));
        let asset = null;
        let error = null;
        try {
            asset = await uploadAsset(file, kind, {
                name,
                signal: transfer.controller.signal,
                onProgress: (sent) => {
                    transfer.sent = sent;
                    const bar = this.cards.get(field.key)?.bar;
                    if (bar) bar.value = sent;
                },
            });
        } catch (e) {
            error = e.message;
        }
        if (!this.model.endUpload(field, transfer, { asset, error })) return; // stopped: another file, Cancel, or the field went
        this.refreshField(field);
        this.refreshState();
        if (error) this.modal.status(error, "error");
        else this.modal.status(asset.original_name ? t("Uploaded {name}.", { name: asset.original_name }) : t(MEDIA_TEXT[kind].uploaded));
    }

    cancelUpload(field) {
        const transfer = this.model.stopUpload(field);
        if (!transfer) return;
        this.refreshField(field);
        this.refreshState();
        this.modal.status(t("Cancelled the upload of {name}.", { name: transfer.name }));
    }

    /** Stop everything still running; the modal calls this when it drops the editor. */
    dispose() {
        this.model.stopUploads();
    }

    renderAdd() {
        const add = menu(t("+ Add field ▾"), TYPES.map(([type, label]) => [t(label), () => this.addField(type)]));
        this.addButton = add.opener;
        const row = el("div", "bl-add-field");
        row.append(add.root);
        this.refreshAdd();
        return row;
    }

    refreshAdd() {
        const full = this.draft.fields.length >= POOL_SIZE;
        this.addButton.disabled = full;
        this.addButton.title = full ? t("A bundle has {max} fields at most.", { max: POOL_SIZE }) : "";
    }

    addField(type) {
        const field = this.model.addField(type);
        const card = this.renderField(field);
        this.cards.set(field.key, card);
        this.fieldsBox.querySelector(".bl-no-fields")?.remove();
        this.fieldsBox.append(card.root);
        this.fieldsChanged();
        card.name.focus();
        card.name.select();
    }

    async removeField(field) {
        if (field.origin) {
            const confirmed = await this.modal.confirm(
                t("Remove the field '{name}'?", { name: field.name }),
                t("Workflows connected to '{origin}' will fail when they run, until they are reconnected. "
                    + "Nothing changes until you save.", { origin: field.origin }),
                t("Remove"), { danger: true });
            if (!confirmed) return;
        }
        const index = this.draft.fields.indexOf(field);
        if (index < 0) return;
        this.model.removeField(field);
        this.cards.get(field.key)?.root.remove();
        this.cards.delete(field.key);
        if (!this.draft.fields.length) this.fieldsBox.append(this.noFields());
        this.fieldsChanged();
        const next = this.draft.fields[index] ?? this.draft.fields[index - 1];
        (next ? this.cards.get(next.key).name : this.addButton).focus({ preventScroll: true });
    }

    move(field, delta) {
        const index = this.draft.fields.indexOf(field);
        if (!this.model.moveField(field, delta)) return;
        const card = this.cards.get(field.key);
        const other = this.cards.get(this.draft.fields[index].key); // the neighbour, now where the field was
        // Move the neighbour, not this card: an element moved in the page loses the focus.
        if (delta < 0) card.root.after(other.root);
        else card.root.before(other.root);
        this.fieldsChanged();
        const pressed = delta < 0 ? card.up : card.down;
        if (pressed.disabled) (delta < 0 ? card.down : card.up).focus({ preventScroll: true }); // it reached the end
    }

    /** Fields were added, removed or moved: what depends on their number and order. */
    fieldsChanged() {
        this.refreshMoves();
        this.refreshWarnings();
        this.refreshAdd();
        this.refreshState();
    }

    refreshMoves() {
        const last = this.draft.fields.length - 1;
        this.draft.fields.forEach((field, i) => {
            const card = this.cards.get(field.key);
            card.up.disabled = i === 0;
            card.down.disabled = i === last;
        });
    }

    /** Name problems and rename notices for every card; duplicates involve two cards at once. */
    refreshWarnings() {
        const notes = this.model.nameNotes();
        for (const card of this.cards.values()) {
            const { problem = null, renamed = null } = notes.get(card.field.key) ?? {};
            const text = [problem, renamed].filter(Boolean).join(" ");
            card.warning.textContent = text;
            card.warning.hidden = !text;
        }
    }

    refreshState() {
        const { changed, dirty, blocker } = this.model;
        this.stateMark.textContent = this.busy ? t(BUSY[this.busy][0])
            : !this.saved ? t("● New, not saved yet") : changed ? t("● Unsaved changes") : t("Saved");
        this.stateMark.classList.toggle("clean", !!this.saved && !changed && !this.busy);
        this.saveButton.disabled = !dirty || !!blocker || !!this.busy;
        this.saveButton.title = blocker ?? t("Save (Ctrl+S)");
        this.revertButton.disabled = !changed || !!this.busy;
        const revert = this.saved ? t("Revert") : t("Discard");
        if (this.revertButton.getAttribute("aria-label") !== revert) {
            this.revertButton.replaceChildren(icon(this.saved ? "undo" : "times"));
            this.revertButton.setAttribute("aria-label", revert);
        }
        this.revertButton.title = revert;
        this.duplicateButton.disabled = !this.saved || changed || !!this.readOnly || !!this.busy;
        this.duplicateButton.title = this.readOnly ? blocker : changed ? t("Save or revert your changes first") : t("Duplicate");
        this.exportButton.disabled = !this.saved || changed || !!this.busy;
        this.exportButton.title = changed && this.saved ? t("Save or revert your changes first") : t("Export this bundle as a ZIP");
        this.deleteButton.disabled = !this.saved || !!this.readOnly || !!this.busy;
        this.deleteButton.title = this.readOnly ? blocker : t("Delete");
        this.modal.editorChanged();
    }

    /**
     * While a command of the editor is out, the editor takes no input: its
     * answer replaces the draft or the editor. The focus goes back where it
     * was afterwards, as far as that is still there.
     */
    setBusy(kind) {
        if (kind) {
            this.focusBefore = this.focusPlace();
            if (this.root.contains(document.activeElement)) this.modal.dialog.focus({ preventScroll: true });
        }
        this.busy = kind;
        this.root.inert = !!kind;
        this.root.classList.toggle("saving", kind === "save");
        this.root.classList.toggle("busy", !!kind);
        this.refreshState();
        if (!kind && this.focusBefore && this.root.isConnected
            && (document.activeElement === this.modal.dialog || document.activeElement === document.body)) {
            this.restoreFocus(this.focusBefore);
        }
        if (!kind) this.focusBefore = null;
    }

    /** Run one of the editor's commands, holding the window; refused (undefined) while another holds it. */
    command(kind, work) {
        return this.modal.commands.hold({ kind, wait: t(BUSY[kind][1]) }, async (ticket) => {
            this.setBusy(kind);
            try {
                return await work(ticket);
            } finally {
                this.setBusy(null);
            }
        });
    }

    /**
     * Save the draft. Whether it was saved as it is and nothing about it needs
     * the user's attention (Close → Save closes only then).
     */
    async save() {
        if (this.busy || !this.changed) return false; // a second Ctrl+S would conflict with the first
        if (this.blocker) {
            this.modal.status(this.blocker, "error");
            return false;
        }
        const data = editable(this.draft);
        const created = !this.saved;
        const outcome = await this.command("save", async (ticket) => {
            try {
                const saved = this.saved
                    ? await updateBundle(this.saved.id, data, this.saved.revision)
                    : await createBundle(data, this.model.pendingCategory);
                if (!this.modal.commands.owns(ticket)) { // not shown any more: only the list learns of it
                    await this.modal.reload();
                    return false;
                }
                await this.adopt(saved, t("Saved."), { reveal: created }); // a new row: the list shows where it went
                if (saved.placement_error) {
                    // The bundle is made; only putting it in its category failed. Choosing it again retries that.
                    this.modal.status(t("Saved, but not put in its category: {reason} Choose the category again.",
                        { reason: said(saved, "placement_error") }), "error");
                    return false;
                }
                return true;
            } catch (error) {
                if (error.code === "revision_conflict") return this.resolveConflict(data, error.details.current_revision);
                this.modal.status(error.message, "error");
                return false;
            }
        });
        return outcome === true;
    }

    /** The draft is now `saved`: draw it, and let the list catch up before the window is free again. */
    async adopt(saved, message, { reveal = false } = {}) {
        this.model.load(saved);
        this.render();
        await this.modal.bundleSaved(saved, { reveal });
        this.modal.status(message);
    }

    /** A save met a newer revision: Overwrite (true), Reload (the draft is dropped) or Cancel (it stays). */
    async resolveConflict(data, currentRevision) {
        const choice = await this.modal.choose(
            t("This bundle was changed elsewhere"),
            t("It was saved again (revision {revision}) after you opened it. Overwrite it with your version, or reload it and "
                + "lose your changes? Overwriting puts back everything your version has, its tags too (a tag renamed or deleted "
                + "elsewhere comes back).", { revision: currentRevision }),
            [[t("Overwrite"), "overwrite", "danger"], [t("Reload"), "reload"], [t("Cancel"), null]]);
        try {
            if (choice === "overwrite") {
                await this.adopt(await updateBundle(this.saved.id, data, currentRevision), t("Saved over the other change."));
                return true;
            }
            if (choice === "reload") {
                this.model.load(await getBundle(this.saved.id));
                this.render();
                await this.modal.reload(); // the list and what "Use this bundle" hands over follow it
                this.modal.status(t("Reloaded the saved version."));
            }
        } catch (error) {
            this.modal.status(error.message, "error");
        }
        return false;
    }

    /** Show `bundle` as saved in place of a draft without changes: it was saved again elsewhere. */
    showSaved(bundle) {
        this.model.load(bundle);
        this.render();
    }

    revert() {
        if (!this.saved) {
            this.modal.discardDraft();
            return;
        }
        this.model.revert(); // also stops the uploads for the dropped draft
        this.tagText = "";
        this.render();
        this.modal.status(t("Changes discarded."));
    }

    async duplicate(mode) {
        if (this.changed || !this.saved) return; // the copy is made from the stored bundle
        await this.command("duplicate", async (ticket) => {
            try {
                const copy = await duplicateBundle(this.saved.id, mode);
                if (!this.modal.commands.owns(ticket)) {
                    await this.modal.reload();
                    return;
                }
                await this.modal.bundleSaved(copy, { open: true, reveal: true });
                if (copy.placement_error) {
                    this.modal.status(t("Created '{name}', but not put in the category of the original: {reason} Choose the "
                        + "category again.", { name: copy.name, reason: said(copy, "placement_error") }), "error");
                } else {
                    this.modal.status(t("Created '{name}'.", { name: copy.name }));
                }
            } catch (error) {
                this.modal.status(error.message, "error");
            }
        });
    }

    async remove() {
        const confirmed = await this.modal.confirm(
            t("Delete '{name}'?", { name: this.saved.name }),
            t("The bundle moves to the trash, from where it can be restored. Until then, workflows that use it report it as missing."),
            t("Delete"), { danger: true });
        if (!confirmed) return;
        await this.command("delete", async (ticket) => {
            try {
                const answer = await deleteBundle(this.saved.id, this.saved.revision);
                if (this.modal.commands.owns(ticket)) await this.modal.bundleDeleted(this.saved, answer);
                else await this.modal.reload();
            } catch (error) {
                this.modal.status(error.code === "revision_conflict"
                    ? t("The bundle changed elsewhere. Reopen it before deleting.") : error.message, "error");
            }
        });
    }
}
