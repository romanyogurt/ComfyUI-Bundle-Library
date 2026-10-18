// The editor for one bundle inside the library modal. What it edits is an
// EditorModel (editor_model.js): the stored bundle, the draft, the number
// boxes' text and the uploads. This draws it, card by card: a change to one
// field draws that card again, so the focus stays where it is. It talks to
// the API on Save, Duplicate and Delete, each as a command that holds the
// window until its answer is in, and for a field's file: an upload, or a file
// taken from the library. Its category and star are not part of the draft:
// the modal saves them at once.
import {
    MEDIA, assetURL, createBundle, deleteBundle, duplicateBundle, fileProblem, getBundle, getChoiceOptions,
    thumbnailURL, updateBundle, uploadAsset,
} from "./api.js";
import { pickStoredAsset } from "./asset_picker.js";
import { resolveChoice, sourceLabel, uncheckedText } from "./choices.js";
import { button, el, formatBytes, formatDuration, icon, iconButton, menu } from "./dom.js";
import { EditorModel, MEDIA_TYPES, editable } from "./editor_model.js";
import { msg, said, t } from "./i18n.js";
import { POOL_SIZE } from "./reconcile.js";
import { pickSource } from "./source_picker.js";

const TYPES = [["text", msg("editor.type_text")], ["image", msg("editor.type_image")], ["video", msg("editor.type_video")],
    ["audio", msg("editor.type_audio")], ["boolean", msg("editor.type_boolean")], ["int", msg("editor.type_integer")],
    ["float", msg("editor.type_float")], ["choice", msg("editor.type_choice")]];
const SHOWN_OPTIONS = 200; // a choice's options drawn at once; typing narrows them
let comboCount = 0; // ids for the options lists, which their boxes point at
// What a field card dragged by its grip carries (0.0.28): its key in the draft.
const FIELD_DRAG = "application/x-bundle-library-field";
// A field's type on its badge: the type's own name in English.
const BADGE = { text: msg("editor.badge_text"), image: msg("kind.image"), video: msg("kind.video"), audio: msg("kind.audio"),
    boolean: msg("editor.badge_boolean"), int: msg("editor.badge_int"), float: msg("editor.badge_float"),
    choice: msg("editor.badge_choice") };
// What a media field says, by its kind: whole sentences, so each language says them its own way.
const MEDIA_TEXT = {
    image: { choose: msg("editor.choose_image"), drop: msg("editor.drop_image"),
        replace: msg("editor.drop_image_replace"), uploaded: msg("editor.uploaded_image") },
    video: { choose: msg("editor.choose_video"), drop: msg("editor.drop_video"), replace: msg("editor.drop_video_replace"),
        uploaded: msg("editor.uploaded_video") },
    audio: { choose: msg("editor.choose_audio"), drop: msg("editor.drop_audio"),
        replace: msg("editor.drop_audio_replace"), uploaded: msg("editor.uploaded_audio") },
};
const MAX_TEXT_HEIGHT = 320;
const NEW_CATEGORY = "new"; // the "New category…" choice of the category select (ids are UUIDs)
// What the editor says while one of its commands is out.
const BUSY = {
    save: [msg("editor.saving"), msg("editor.wait_save")],
    duplicate: [msg("editor.duplicating"), msg("editor.wait_copy")],
    delete: [msg("editor.moving_to_trash"), msg("editor.wait_trash")],
};

/** One line about a stored file: size, length, format. */
function describeAsset(kind, asset) {
    const size = formatBytes(asset.bytes);
    if (kind === "image") return `${asset.width} × ${asset.height} · ${size}`;
    const time = asset.duration != null ? formatDuration(asset.duration) : null;
    if (kind === "video") {
        const sound = asset.has_audio ? (asset.audio_codec ?? t("editor.sound")) : t("editor.no_sound");
        return [`${asset.width} × ${asset.height}`, asset.fps && `${asset.fps} fps`, time, size,
            `${asset.codec} + ${sound}`].filter(Boolean).join(" · ");
    }
    const channels = asset.channels === 1 ? t("editor.mono") : asset.channels === 2 ? t("editor.stereo")
        : t("editor.channels", { count: asset.channels });
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
        this.dragged = null; // the field whose card is being dragged by its grip
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
        this.takeFieldDrops(this.fieldsBox);
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
        return el("div", "bl-empty-state bl-no-fields", t("editor.no_fields_yet"));
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
        this.nameInput.placeholder = t("common.bundle_name");
        this.nameInput.maxLength = 120;
        this.nameInput.readOnly = !!this.readOnly; // a change could not be saved
        this.nameInput.addEventListener("input", () => {
            this.draft.name = this.nameInput.value;
            this.refreshState();
        });
        this.stateMark = el("span", "bl-state");
        // Icons in the head (0.0.26): less to read. The words stay as the buttons' names and tooltips.
        this.saveButton = iconButton("save", t("common.save"), "primary bl-save");
        this.saveButton.title = t("editor.save_title");
        this.saveButton.addEventListener("click", () => void this.save());
        this.revertButton = iconButton("undo", t("editor.revert"), "bl-revert");
        this.revertButton.addEventListener("click", () => this.revert());
        const face = el("span", "bl-icon-menu");
        face.append(icon("copy"), " ▾");
        const duplicate = menu(face, [
            [t("editor.duplicate_values"), () => void this.duplicate("values")],
            [t("editor.duplicate_structure"), () => void this.duplicate("structure")],
        ], { className: "bl-btn icon bl-duplicate", title: t("editor.duplicate"), label: t("editor.duplicate") });
        this.duplicateButton = duplicate.opener;
        this.exportButton = button("", "bl-btn icon bl-export");
        this.exportButton.setAttribute("aria-label", t("editor.export_title"));
        this.exportButton.append(icon("download"));
        this.exportButton.addEventListener("click", () => {
            const summary = this.model.summary();
            if (summary && !this.changed) void this.modal.runExport([summary]); // the bundle as saved
        });
        this.deleteButton = iconButton("trash", t("editor.delete"), "danger bl-delete");
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
        this.starButton.title = !this.saved ? t("editor.favorite_needs_save")
            : why ?? (favorite ? t("common.favorite_remove") : t("common.favorite_add"));
        const pending = this.model.pendingCategory;
        if (pending && !this.modal.categories.some((c) => c.id === pending)) {
            this.model.pendingCategory = null; // deleted meanwhile
        }
        const options = [["", t("common.no_category")], ...this.modal.categories.map((c) => [c.id, c.name])];
        if (!why) options.push([NEW_CATEGORY, t("editor.new_category")]);
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
        this.categorySelect.title = this.saved ? (why ?? "") : t("editor.category_title");
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
            notes.push(t("editor.read_only_reason", { reason: this.readOnly }));
        }
        for (const warning of said(this.saved, "warnings") ?? []) {
            notes.push(t("editor.warning_fix_before_save", { warning }));
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
        this.categorySelect.setAttribute("aria-label", t("common.category"));
        this.categorySelect.title = t("common.category");
        this.categorySelect.addEventListener("change", () => void this.chooseCategory(this.categorySelect.value));
        place.append(this.categorySelect);
        const tags = el("div", "bl-tags");
        tags.setAttribute("role", "group");
        tags.setAttribute("aria-label", t("common.tags"));
        const renderTags = (focus) => {
            const input = el("input", "bl-input bl-tag-input");
            input.placeholder = t("editor.tag_add");
            input.setAttribute("aria-label", t("editor.add_tag"));
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
                const remove = button("×", "bl-chip-x", t("editor.remove_tag_title", { tag }));
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
        note.placeholder = t("editor.note_placeholder");
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
        name.placeholder = t("editor.field_name");
        name.maxLength = 64;
        name.addEventListener("input", () => {
            field.name = name.value;
            root.dataset.field = field.name;
            this.refreshWarnings();
            this.refreshState();
        });
        const up = button("▲", "bl-btn icon bl-move-up", t("editor.move_up"));
        up.addEventListener("click", () => this.move(field, -1));
        const down = button("▼", "bl-btn icon bl-move-down", t("editor.move_down"));
        down.addEventListener("click", () => this.move(field, 1));
        const remove = button("✕", "bl-btn icon danger", t("editor.remove_field_title"));
        remove.addEventListener("click", () => void this.removeField(field));
        const grip = this.grip(root, field);
        const off = el("span", "bl-badge bl-off-badge", t("editor.off_badge"));
        const toggle = iconButton("eye", t("editor.turn_off"), "bl-field-toggle");
        toggle.addEventListener("click", () => this.toggleField(field));
        head.append(grip, name, el("span", "bl-badge", field.type in BADGE ? t(BADGE[field.type]) : field.type), off, toggle,
            up, down, remove);
        const warning = el("div", "bl-warn");
        const error = el("div", "bl-error");
        error.hidden = true;
        const body = el("div", "bl-field-body");
        root.append(head, warning, body, error);
        const card = { root, field, grip, name, off, toggle, up, down, warning, body, error, bar: null };
        this.showOnOff(card);
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
                count.textContent = `${t("editor.characters", { count: field.value.length })} · `
                    + t("editor.lines", { count: field.value.split("\n").length });
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
        if (field.type === "choice") return this.choiceEditor(card);
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

    /**
     * The card body of a choice (0.2.0): its value, typed or chosen from its
     * source's options; the source; whether the value is one of the options.
     * Nothing here changes the value but the user: choosing a source or
     * reading its options again keeps it, also when it is not one of them.
     */
    choiceEditor(card) {
        const { field } = card;
        const box = el("div", "bl-choice");
        const combo = el("div", "bl-choice-combo");
        const input = el("input", "bl-input bl-choice-value");
        input.value = field.value;
        input.spellcheck = false;
        input.placeholder = t("editor.choice_placeholder");
        input.setAttribute("aria-label", t("editor.choice_value", { name: field.name }));
        const list = el("div", "bl-choice-list");
        list.id = `bl-choice-list-${++comboCount}`;
        list.setAttribute("role", "listbox");
        list.hidden = true;
        input.setAttribute("role", "combobox");
        input.setAttribute("aria-autocomplete", "list");
        input.setAttribute("aria-controls", list.id);
        input.setAttribute("aria-expanded", "false");
        const open = button("▾", "bl-btn icon bl-choice-open", t("editor.choice_show_options"));
        const source = el("div", "bl-choice-source");
        const status = el("div", "bl-choice-status");
        combo.append(input, open, list); // the list floats under the box: opening or closing it moves nothing
        box.append(combo, source, status);
        card.choice = { input, list, open, source, status, filtering: false, shown: [], active: -1 };
        input.addEventListener("input", () => {
            field.value = input.value;
            this.drawChoiceStatus(card);
            this.refreshState();
            if (list.hidden) this.openOptions(card, { all: false }); // the options with what is typed
            card.choice.filtering = true; // what was typed narrows the list from now on
            this.drawOptions(card);
        });
        input.addEventListener("keydown", (e) => this.choiceKey(card, e));
        box.addEventListener("keydown", (e) => {
            if (e.key !== "Escape" || e.isComposing || list.hidden) return;
            e.preventDefault();
            e.stopPropagation(); // closes the list only, not the library
            this.closeOptions(card);
        });
        open.addEventListener("click", () => {
            if (list.hidden) this.openOptions(card, { all: true });
            else this.closeOptions(card);
            input.focus({ preventScroll: true }); // typing narrows the list
        });
        box.addEventListener("focusout", (e) => {
            if (!box.contains(e.relatedTarget)) this.closeOptions(card);
        });
        this.drawSource(card);
        this.drawChoiceStatus(card);
        if (field.source && !this.model.options(field).asked) void this.readOptions(field);
        return box;
    }

    /** Show the source's options under the box: all of them (from ▾), or those with what was typed. */
    openOptions(card, { all = false } = {}) {
        const { choice } = card;
        if (choice.open.disabled) return;
        if (all) choice.filtering = false;
        choice.list.hidden = false;
        choice.input.setAttribute("aria-expanded", "true");
        this.drawOptions(card);
        choice.list.querySelector(".current")?.scrollIntoView({ block: "nearest" });
    }

    closeOptions(card) {
        const { choice } = card;
        if (!choice || choice.list.hidden) return;
        choice.list.hidden = true;
        choice.active = -1;
        choice.input.setAttribute("aria-expanded", "false");
        choice.input.removeAttribute("aria-activedescendant");
    }

    drawOptions(card) {
        const { field, choice } = card;
        const { answer } = this.model.options(field);
        const options = answer?.state === "read" ? answer.options : [];
        const query = choice.filtering ? field.value.trim().toLowerCase() : "";
        const matching = query ? options.filter((option) => option.toLowerCase().includes(query)) : options;
        choice.shown = matching.slice(0, SHOWN_OPTIONS);
        choice.active = Math.min(choice.active, choice.shown.length - 1);
        choice.list.replaceChildren(...choice.shown.map((option, i) => {
            const item = el("div", "bl-choice-option", option);
            item.id = `${choice.list.id}-${i}`;
            item.setAttribute("role", "option");
            item.setAttribute("aria-selected", String(option === field.value));
            item.classList.toggle("current", option === field.value);
            item.classList.toggle("active", i === choice.active);
            item.addEventListener("mousedown", (e) => e.preventDefault()); // the focus stays in the box
            item.addEventListener("click", () => this.chooseOption(card, option));
            return item;
        }));
        if (!matching.length) {
            choice.list.append(el("div", "bl-hint", options.length ? t("editor.choice_no_match") : t("editor.choice_no_options")));
        } else if (matching.length > choice.shown.length) {
            choice.list.append(el("div", "bl-hint", t("editor.choice_more", { count: matching.length - choice.shown.length })));
        }
        if (choice.active >= 0) choice.input.setAttribute("aria-activedescendant", `${choice.list.id}-${choice.active}`);
        else choice.input.removeAttribute("aria-activedescendant");
    }

    chooseOption(card, option) {
        const { field, choice } = card;
        field.value = option;
        choice.input.value = option;
        this.closeOptions(card);
        this.drawChoiceStatus(card);
        this.refreshState();
        choice.input.focus({ preventScroll: true });
    }

    /** The keys of a choice's box: ↓↑ go through the options and Enter takes one (Escape: choiceEditor()). */
    choiceKey(card, e) {
        const { choice } = card;
        if (e.isComposing) return;
        const shown = choice.shown.length;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (choice.list.hidden) {
                this.openOptions(card); // narrowed by what was typed, if anything was
                return;
            }
            if (!shown) return;
            choice.active = ((choice.active < 0 && e.key === "ArrowUp" ? shown : choice.active)
                + (e.key === "ArrowDown" ? 1 : -1) + shown) % shown;
            this.drawOptions(card);
            choice.list.querySelector(".active")?.scrollIntoView({ block: "nearest" });
        } else if (e.key === "Enter" && !choice.list.hidden && choice.active >= 0) {
            e.preventDefault();
            this.chooseOption(card, choice.shown[choice.active]);
        }
    }

    /** Where a choice's options come from: the source, to change or clear, or a way to choose one. */
    drawSource(card) {
        const { field, choice } = card;
        if (!field.source) {
            const pick = button(t("editor.choice_source_pick"), "bl-btn bl-choice-pick");
            pick.title = t("editor.choice_source_pick_title");
            pick.addEventListener("click", () => void this.chooseSource(field));
            choice.source.replaceChildren(pick);
            return;
        }
        const { answer } = this.model.options(field);
        const chip = el("span", "bl-chip bl-source-chip", sourceLabel(field.source, answer));
        chip.title = t("editor.choice_source_title", { node: field.source.node, input: field.source.input });
        const clear = button("×", "bl-chip-x", t("editor.choice_source_clear"));
        clear.addEventListener("click", () => this.setSource(field, null));
        chip.append(clear);
        const change = button(t("editor.choice_source_change"), "bl-btn bl-choice-pick");
        change.addEventListener("click", () => void this.chooseSource(field));
        const reload = button("↻", "bl-btn icon bl-choice-reload", t("editor.choice_reload"));
        reload.addEventListener("click", () => void this.readOptions(field));
        choice.source.replaceChildren(el("span", "bl-dim", t("editor.choice_from")), chip, change, reload);
    }

    /** Whether the value is one of the source's options here, or why that cannot be told. Saving is never held back. */
    drawChoiceStatus(card) {
        const { field, choice } = card;
        const { answer, failure, asked } = this.model.options(field);
        const read = answer?.state === "read";
        const resolved = resolveChoice(field.value, field.source, answer);
        let text;
        let bad = false;
        if (!field.source) {
            text = t("editor.choice_free");
        } else if (failure || (answer && !read)) {
            text = uncheckedText(field.source, answer, failure);
        } else if (!asked || !answer) {
            text = t("editor.choice_reading");
        } else if (resolved.state === "mismatch") {
            bad = true;
            text = answer.options.length ? t("editor.choice_not_listed", { source: sourceLabel(field.source, answer) })
                : t("editor.choice_none_here", { source: sourceLabel(field.source, answer) });
        } else if (resolved.output !== field.value) {
            text = t("editor.choice_spelled", { output: resolved.output });
        } else {
            text = t("editor.choice_listed", { count: answer.options.length });
        }
        choice.status.textContent = bad ? `⚠ ${text}` : text;
        choice.status.classList.toggle("bl-bad", bad);
        choice.status.classList.toggle("bl-hint", !bad);
        choice.status.dataset.state = !field.source ? "no_source" : failure ? "failed" : !answer ? "pending" : resolved.state;
        choice.open.disabled = !(read && answer.options.length);
        if (choice.open.disabled) this.closeOptions(card);
    }

    /** Draw a choice's source and status again (its options were read, or its source changed). */
    refreshChoice(field) {
        const card = this.cards.get(field.key);
        if (!card?.choice) return;
        this.drawSource(card);
        this.drawChoiceStatus(card);
        if (!card.choice.list.hidden) this.drawOptions(card);
    }

    /** Read the options of the field's source as this ComfyUI has them now. An answer that comes after another ask is dropped. */
    async readOptions(field) {
        if (!field.source) return;
        const ticket = this.model.askOptions(field);
        this.refreshChoice(field);
        let result;
        try {
            result = { answer: await getChoiceOptions(field.source) };
        } catch (error) {
            result = { failure: error.message };
        }
        if (this.model.answerOptions(ticket, result)) this.refreshChoice(field);
    }

    /** Check the choice against another source's options, or against none (null). */
    setSource(field, source) {
        this.model.setSource(field, source);
        this.refreshChoice(field);
        this.refreshState();
        if (source) void this.readOptions(field);
        this.cards.get(field.key)?.choice?.input.focus({ preventScroll: true });
    }

    async chooseSource(field) {
        const source = await pickSource(this.modal, field.source ?? null);
        if (source && this.model.field(field.key)) this.setSource(field, source);
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
        const choose = button(field.asset ? t("editor.replace") : t(MEDIA_TEXT[kind].choose));
        choose.addEventListener("click", () => picker.click());
        const stored = button(t("editor.from_library"), "bl-btn bl-from-library");
        stored.addEventListener("click", () => void this.pickStored(field));
        const upload = this.uploadStatus(card);
        if (field.asset) {
            const meta = el("div", "bl-media-meta");
            meta.append(el("div", null, describeAsset(kind, field.asset)));
            if (field.asset.original_name) meta.append(el("div", "bl-dim", field.asset.original_name));
            const clear = button(t("editor.clear"));
            clear.addEventListener("click", () => {
                this.model.clearAsset(field);
                this.refreshField(field);
                this.refreshState();
            });
            const actions = el("div", "bl-row-buttons");
            actions.append(choose, stored, clear);
            meta.append(actions, upload ?? el("div", "bl-hint", t(MEDIA_TEXT[kind].replace)));
            box.append(this.mediaPreview(field), meta);
        } else if (upload) {
            box.append(upload);
        } else {
            const drop = el("div", "bl-drop", t(MEDIA_TEXT[kind].drop));
            drop.append(choose, " ", stored);
            box.append(drop);
        }
        box.append(picker);
        return box;
    }

    /** Turn a field off, or on again (0.0.30): an off field stays in the bundle, value and all, but no node outputs it. */
    toggleField(field) {
        this.model.toggleField(field);
        const card = this.cards.get(field.key);
        if (card) this.showOnOff(card);
        this.refreshState();
    }

    /** A card as its field is: dimmed with an "off" mark, and the toggle saying what it would do. */
    showOnOff(card) {
        const on = card.field.enabled !== false;
        card.root.classList.toggle("off", !on);
        card.off.hidden = on;
        const label = on ? t("editor.turn_off") : t("editor.turn_on");
        card.toggle.title = label;
        card.toggle.setAttribute("aria-label", label);
        card.toggle.setAttribute("aria-pressed", String(!on));
        card.toggle.replaceChildren(icon(on ? "eye" : "eye-slash"));
    }

    /**
     * The handle a field's card is dragged by to another place among the cards
     * (0.0.28); the whole card shows while it is dragged. The keyboard moves it
     * with ▲▼, so screen readers are not offered the handle.
     */
    grip(root, field) {
        const grip = el("span", "bl-grip");
        grip.title = t("editor.drag_field");
        grip.setAttribute("aria-hidden", "true");
        grip.draggable = true;
        grip.addEventListener("dragstart", (e) => {
            const box = root.getBoundingClientRect();
            e.dataTransfer.setData(FIELD_DRAG, field.key);
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setDragImage(root, e.clientX - box.left, e.clientY - box.top);
            root.classList.add("dragging");
            this.dragged = field;
        });
        grip.addEventListener("dragend", () => {
            root.classList.remove("dragging");
            this.dragged = null;
            this.markDrop(null);
        });
        return grip;
    }

    /** The cards take a dragged field's card where it is dropped: before the first card whose middle is below the pointer. */
    takeFieldDrops(box) {
        const carries = (e) => this.dragged && e.dataTransfer?.types.includes(FIELD_DRAG);
        box.addEventListener("dragover", (e) => {
            if (!carries(e)) return;
            e.preventDefault(); // allows the drop
            e.dataTransfer.dropEffect = "move";
            this.markDrop(this.dropIndex(e.clientY));
        });
        box.addEventListener("dragleave", (e) => {
            if (carries(e) && !box.contains(e.relatedTarget)) this.markDrop(null);
        });
        box.addEventListener("drop", (e) => {
            if (!carries(e)) return;
            e.preventDefault();
            const field = this.dragged;
            const index = this.dropIndex(e.clientY);
            this.markDrop(null);
            this.moveTo(field, index);
        });
    }

    /** The index a dragged field gets when it is dropped with the pointer at `y`. */
    dropIndex(y) {
        const others = this.draft.fields.filter((f) => f !== this.dragged);
        const index = others.findIndex((f) => {
            const box = this.cards.get(f.key).root.getBoundingClientRect();
            return y < box.top + box.height / 2;
        });
        return index < 0 ? others.length : index;
    }

    /** Show where a dragged field would land (a line between the cards), or nothing (null, or its own place). */
    markDrop(index) {
        for (const marked of this.fieldsBox.querySelectorAll(".drop-before, .drop-after")) {
            marked.classList.remove("drop-before", "drop-after");
        }
        if (index === null || !this.dragged || index === this.draft.fields.indexOf(this.dragged)) return;
        const others = this.draft.fields.filter((f) => f !== this.dragged);
        if (index < others.length) this.cards.get(others[index].key).root.classList.add("drop-before");
        else this.cards.get(others.at(-1).key).root.classList.add("drop-after");
    }

    /** Put a field at `index` among the fields (a drop). */
    moveTo(field, index) {
        if (!this.model.moveFieldTo(field, index)) return;
        const card = this.cards.get(field.key);
        const next = this.draft.fields[index + 1];
        if (next) this.cards.get(next.key).root.before(card.root);
        else this.fieldsBox.append(card.root);
        this.fieldsChanged();
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
        const cancel = button(t("common.cancel_upload"));
        cancel.addEventListener("click", () => this.cancelUpload(card.field));
        status.append(el("div", null, t("editor.uploading", { name: transfer.name })), bar, cancel);
        return status;
    }

    mediaPreview(field) {
        const { asset } = field;
        if (field.type === "image") {
            const img = el("img", "bl-image-thumb");
            img.src = thumbnailURL(asset.sha256, 256);
            img.alt = field.name;
            img.title = t("editor.show_full_size");
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
        this.modal.status(t("editor.uploading", { name }));
        let answer = null;
        let error = null;
        try {
            answer = await uploadAsset(file, kind, {
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
        const asset = answer?.asset ?? null;
        if (!this.model.endUpload(field, transfer, { asset, error })) return; // stopped: another file, Cancel, or the field went
        this.refreshField(field);
        this.refreshState();
        if (error) this.modal.status(error, "error");
        else this.modal.done(asset.original_name ? t("editor.uploaded_name", { name: asset.original_name }) : t(MEDIA_TEXT[kind].uploaded), answer);
    }

    /** Take a file the library already keeps for `field` (0.0.29): chosen among the stored files of its kind. */
    async pickStored(field) {
        const asset = await pickStoredAsset(this.modal, field.type, field.asset?.sha256 ?? null);
        if (!asset || !this.draft.fields.includes(field)) return; // none chosen, or another draft by now
        this.model.takeAsset(field, asset);
        this.refreshField(field);
        this.refreshState();
        this.modal.status(t("editor.took_stored", { name: asset.original_name ?? `${asset.sha256.slice(0, 12)}…` }));
    }

    cancelUpload(field) {
        const transfer = this.model.stopUpload(field);
        if (!transfer) return;
        this.refreshField(field);
        this.refreshState();
        this.modal.status(t("common.upload_cancelled_name", { name: transfer.name }));
    }

    /** Stop everything still running; the modal calls this when it drops the editor. */
    dispose() {
        this.model.stopUploads();
    }

    renderAdd() {
        const add = menu(t("editor.add_field_menu"), TYPES.map(([type, label]) => [t(label), () => this.addField(type)]));
        this.addButton = add.opener;
        const row = el("div", "bl-add-field");
        row.append(add.root);
        this.refreshAdd();
        return row;
    }

    refreshAdd() {
        const full = this.draft.fields.length >= POOL_SIZE;
        this.addButton.disabled = full;
        this.addButton.title = full ? t("editor.fields_max", { max: POOL_SIZE }) : "";
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
                t("editor.remove_field_confirm", { name: field.name }),
                t("editor.connected_fail", { origin: field.origin }),
                t("editor.remove"), { danger: true });
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
            card.grip.draggable = last > 0; // one field has nowhere to go
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
            : !this.saved ? t("editor.state_new") : changed ? t("editor.state_unsaved") : t("editor.state_saved");
        this.stateMark.classList.toggle("clean", !!this.saved && !changed && !this.busy);
        this.saveButton.disabled = !dirty || !!blocker || !!this.busy;
        this.saveButton.title = blocker ?? t("editor.save_title");
        this.revertButton.disabled = !changed || !!this.busy;
        const revert = this.saved ? t("editor.revert") : t("common.discard");
        if (this.revertButton.getAttribute("aria-label") !== revert) {
            this.revertButton.replaceChildren(icon(this.saved ? "undo" : "times"));
            this.revertButton.setAttribute("aria-label", revert);
        }
        this.revertButton.title = revert;
        this.duplicateButton.disabled = !this.saved || changed || !!this.readOnly || !!this.busy;
        this.duplicateButton.title = this.readOnly ? blocker : changed ? t("editor.save_or_revert_first") : t("editor.duplicate");
        this.exportButton.disabled = !this.saved || changed || !!this.busy;
        this.exportButton.title = changed && this.saved ? t("editor.save_or_revert_first") : t("editor.export_title");
        this.deleteButton.disabled = !this.saved || !!this.readOnly || !!this.busy;
        this.deleteButton.title = this.readOnly ? blocker : t("editor.delete");
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
     * the user's attention (Close → Save closes only then): a warning of the
     * answer, such as a folder not synced, does (R010-04).
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
                // A new row: the list shows where it went. "Saved" opens the warning already, when there is one.
                await this.adopt(saved, saved.warning ? "" : t("editor.saved"), { reveal: created });
                if (saved.placement_error) {
                    // The bundle is made; only putting it in its category failed. Choosing it again retries that.
                    this.modal.done(t("editor.saved_not_categorized", { reason: said(saved, "placement_error") }), saved, "error");
                    return false;
                }
                return !saved.warning;
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
        this.modal.done(message, saved);
    }

    /** A save met a newer revision: Overwrite (true), Reload (the draft is dropped) or Cancel (it stays). */
    async resolveConflict(data, currentRevision) {
        const choice = await this.modal.choose(
            t("editor.changed_elsewhere"),
            t("editor.conflict_overwrite", { revision: currentRevision }),
            [[t("editor.overwrite"), "overwrite", "danger"], [t("editor.reload"), "reload"], [t("common.cancel"), null]]);
        try {
            if (choice === "overwrite") {
                const saved = await updateBundle(this.saved.id, data, currentRevision);
                await this.adopt(saved, saved.warning ? "" : t("editor.saved_over"));
                return !saved.warning;
            }
            if (choice === "reload") {
                this.model.load(await getBundle(this.saved.id));
                this.render();
                await this.modal.reload(); // the list and what "Use this bundle" hands over follow it
                this.modal.status(t("editor.reloaded"));
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
        this.modal.status(t("editor.changes_discarded"));
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
                    this.modal.done(t("editor.created_not_categorized", { name: copy.name, reason: said(copy, "placement_error") }), copy, "error");
                } else {
                    this.modal.done(t("editor.created", { name: copy.name }), copy);
                }
            } catch (error) {
                this.modal.status(error.message, "error");
            }
        });
    }

    async remove() {
        const confirmed = await this.modal.confirm(
            t("editor.delete_confirm", { name: this.saved.name }),
            t("editor.delete_detail"),
            t("editor.delete"), { danger: true });
        if (!confirmed) return;
        await this.command("delete", async (ticket) => {
            try {
                const answer = await deleteBundle(this.saved.id, this.saved.revision);
                if (this.modal.commands.owns(ticket)) await this.modal.bundleDeleted(this.saved, answer);
                else await this.modal.reload();
            } catch (error) {
                this.modal.status(error.code === "revision_conflict"
                    ? t("editor.changed_elsewhere_reopen") : error.message, "error");
            }
        });
    }
}
