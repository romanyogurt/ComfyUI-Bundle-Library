// The library modal: the bundle list on the left, grouped by category, and
// the editor on the right. It is a document.body overlay of its own: ComfyUI's
// dialogs need Vue components, and they would open underneath it.
import {
    CHANGED_EVENT, createCategory, deleteCategory, getBundle, listLibrary, listTrash, purgeBundle, renameCategory,
    searchBundleIds, setCategory, setFavorite, thumbnailURL,
} from "./api.js";
import { BundleEditor } from "./bundle_editor.js";
import { button, el, menu } from "./dom.js";
import { ATTENTION, CATEGORY, FAVORITES, UNCATEGORIZED, compactGroups, groupBundles, groupLabel } from "./groups.js";
import { displayNames } from "./names.js";
import { slotStatuses } from "./reconcile.js";
import { TrashPanel } from "./trash_panel.js";

let current = null;

// Caught on window while the modal is open; see build().
const STRAY_EVENTS = ["keydown", "keyup", "keypress", "paste", "copy", "cut"];

// What a bundle row carries while dragged onto a group. Files dragged in from
// outside do not have it and are not taken for a move.
const DRAG_TYPE = "application/x-bundle-library-bundle";

// The groups collapsed in this browser. Only a convenience: without storage
// every group starts expanded.
const COLLAPSED_KEY = "bundle-library.collapsed-groups";

function loadCollapsed() {
    try {
        const keys = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
        return new Set(Array.isArray(keys) ? keys.filter((key) => typeof key === "string") : []);
    } catch {
        return new Set();
    }
}

function saveCollapsed(keys) {
    try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...keys]));
    } catch {
        // not kept for the next time
    }
}

const EMPTY_GROUP = {
    [FAVORITES]: "Star a bundle (☆) to list it here as well.",
    [CATEGORY]: "No bundles. Drag one here, or choose this category in the editor.",
    [UNCATEGORIZED]: "Every bundle is in a category.",
};

/**
 * Open the library. With `onPick` it is the bundle picker of a Load Bundle
 * node: "Use this bundle" hands the selected bundle's summary to onPick, and
 * `linked` (the node's connected slots) marks bundles that lack one.
 */
export function openLibrary({ onPick = null, linked = [], selected = null } = {}) {
    if (!current) current = new LibraryModal({ onPick, linked, selected });
    return current;
}

class LibraryModal {
    constructor({ onPick, linked, selected }) {
        this.onPick = onPick;
        this.linked = linked;
        this.selectedId = selected;
        this.all = [];
        this.errors = []; // the files this version cannot use, shown under Needs attention
        this.categories = [];
        this.organization = { revision: 0, state: "missing" };
        this.collapsed = loadCollapsed();
        // Changes of categories and favorites go out one after another (see organize()).
        this.organizeQueue = Promise.resolve();
        this.organizing = 0;
        this.matches = null;
        this.editor = null;
        this.trashPanel = null; // shown in the pane instead of an editor
        this.layer = null;
        // Answers that arrive after a newer request was made are dropped: each
        // kind of request counts its generations.
        this.editorGeneration = 0; // what the editor pane shows
        this.listGeneration = 0;
        this.searchGeneration = 0;
        this.trashGeneration = 0;
        this.onBeforeUnload = (e) => {
            if (this.unsaved) e.preventDefault();
        };
        this.build();
        this.showPlaceholder();
        void this.reload(selected);
        void this.refreshTrashCount();
    }

    build() {
        this.overlay = el("div", "bl-overlay");
        this.dialog = el("div", "bl-modal");
        this.dialog.setAttribute("role", "dialog");
        this.dialog.setAttribute("aria-modal", "true");
        this.dialog.tabIndex = -1; // holds the focus when the element that had it goes away

        const header = el("div", "bl-modal-header");
        const title = el("div", "bl-modal-title", this.onPick ? "Bundle Library — pick a bundle" : "Bundle Library");
        this.search = el("input", "bl-input bl-search");
        this.search.type = "search";
        this.search.placeholder = "Search names, tags, fields and text";
        let searchTimer = null;
        this.search.addEventListener("input", () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => void this.applySearch(), 250);
        });
        this.tagFilter = el("select", "bl-input bl-tag-filter");
        this.tagFilter.addEventListener("change", () => this.renderList());
        this.sort = el("select", "bl-input bl-sort");
        for (const [value, label] of [["name", "By name"], ["updated", "Recently updated"]]) {
            const option = el("option", null, label);
            option.value = value;
            this.sort.append(option);
        }
        this.sort.addEventListener("change", () => this.renderList());
        const create = button("+ New bundle", "bl-btn primary bl-new");
        create.addEventListener("click", () => void this.newBundle());
        const close = button("✕", "bl-btn icon bl-close", "Close (Esc)");
        close.addEventListener("click", () => void this.requestClose());
        header.append(title, this.search, this.tagFilter, this.sort, create, close);

        const body = el("div", "bl-modal-body");
        const side = el("div", "bl-modal-side");
        this.list = el("div", "bl-modal-list");
        const sideFooter = el("div", "bl-side-footer");
        this.newCategoryButton = button("+ New category", "bl-btn bl-new-category");
        this.newCategoryButton.addEventListener("click", () => void this.newCategory());
        this.trashButton = button("🗑 Trash", "bl-btn bl-trash-button");
        this.trashButton.addEventListener("click", () => void this.showTrash());
        sideFooter.append(this.newCategoryButton, this.trashButton);
        side.append(this.list, sideFooter);
        this.pane = el("div", "bl-modal-editor");
        body.append(side, this.pane);

        const footer = el("div", "bl-modal-footer");
        this.statusLine = el("div", "bl-status");
        footer.append(this.statusLine);
        if (this.onPick) {
            this.pickHint = el("div", "bl-pick-hint");
            const cancel = button("Cancel");
            cancel.addEventListener("click", () => void this.requestClose());
            this.pickButton = button("Use this bundle", "bl-btn primary bl-pick");
            this.pickButton.addEventListener("click", () => this.pick());
            footer.append(this.pickHint, cancel, this.pickButton);
        }
        this.dialog.append(header, body, footer);
        this.overlay.append(this.dialog);
        // One listener for every popup menu: a click elsewhere closes it.
        this.dialog.addEventListener("pointerdown", (e) => {
            for (const open of this.dialog.querySelectorAll(".bl-menu:not([hidden])")) {
                if (!open.parentElement.contains(e.target)) open.hidden = true;
            }
        });

        // Nothing done in here may reach ComfyUI: its keyboard shortcuts listen
        // on window, and it handles paste, copy, drops and context menus on
        // the document (a dropped PNG would load as a workflow).
        for (const type of ["keydown", "keyup", "keypress"]) {
            this.overlay.addEventListener(type, (e) => {
                e.stopPropagation();
                if (type === "keydown") this.onKey(e);
            });
        }
        for (const type of ["paste", "copy", "cut", "wheel", "contextmenu", "dragover", "drop"]) {
            this.overlay.addEventListener(type, (e) => {
                e.stopPropagation();
                if (type === "dragover" || type === "drop") e.preventDefault();
            });
        }
        this.overlay.addEventListener("pointerdown", (e) => {
            if (e.target === this.overlay) void this.requestClose();
        });
        // Focus falls to <body> when the focused element is re-rendered or
        // removed, and Tab can move it behind the overlay; the next key would
        // then go to ComfyUI. Catch such events first and keep the focus here.
        this.onStrayEvent = (e) => {
            if (this.overlay.contains(e.target)) return; // the overlay's own listeners take it
            e.stopPropagation();
            if (e.type === "keydown") this.onKey(e);
        };
        this.onStrayFocus = (e) => {
            if (!this.overlay.contains(e.target)) this.keepFocus();
        };
        for (const type of STRAY_EVENTS) window.addEventListener(type, this.onStrayEvent, true);
        window.addEventListener("focusin", this.onStrayFocus, true);
        document.body.append(this.overlay);
        window.addEventListener("beforeunload", this.onBeforeUnload);
        this.search.focus();
    }

    /** Put the focus back in the modal when the element holding it went away. */
    keepFocus() {
        if (!this.overlay.contains(document.activeElement)) this.dialog.focus({ preventScroll: true });
    }

    onKey(e) {
        if (e.isComposing) return; // Enter or Escape that ends an IME composition (Korean input)
        const mod = e.ctrlKey || e.metaKey;
        const key = (e.key ?? "").toLowerCase(); // autofill sends keydowns without a key
        // Stopping propagation also kept ComfyUI from cancelling the browser's
        // own action for these, so cancel them here: Ctrl+S saves the bundle,
        // Ctrl+O would open the browser's file dialog.
        if (mod && (key === "s" || key === "o")) {
            e.preventDefault();
            if (key === "s" && !this.layer) void this.editor?.save();
        } else if (e.key === "Escape") {
            e.preventDefault();
            if (this.layer) this.layer.dismiss();
            else void this.requestClose();
        }
    }

    // -- list ------------------------------------------------------------------

    async reload(selectId = null) {
        const generation = ++this.listGeneration;
        let library = {};
        try {
            library = await listLibrary({ fresh: true });
        } catch (error) {
            if (generation === this.listGeneration) this.status(error.message, "error");
        }
        if (generation !== this.listGeneration) return; // a newer reload answers instead
        this.all = library.bundles ?? [];
        this.errors = library.errors ?? [];
        this.categories = library.categories ?? [];
        this.organization = library.organization ?? { revision: 0, state: "missing" };
        this.newCategoryButton.disabled = !!this.organizeBlocker;
        this.newCategoryButton.title = this.organizeBlocker ?? "";
        this.renderTags();
        if (this.search.value.trim()) await this.applySearch();
        else this.renderList();
        this.editor?.organizationChanged();
        if (selectId && this.all.some((b) => b.id === selectId)) await this.open(selectId, { force: true });
    }

    /** The list's summary of a bundle (with its category and star), or null. */
    summary(id) {
        return this.all.find((b) => b.id === id) ?? null;
    }

    async applySearch() {
        const generation = ++this.searchGeneration;
        const query = this.search.value.trim();
        let matches = null;
        try {
            matches = query ? await searchBundleIds(query) : null;
        } catch (error) {
            if (generation === this.searchGeneration) this.status(error.message, "error");
        }
        if (generation !== this.searchGeneration) return; // the query changed meanwhile
        this.matches = matches;
        this.renderList();
    }

    renderTags() {
        const chosen = this.tagFilter.value;
        const tags = new Map();
        for (const bundle of this.all) {
            for (const tag of bundle.tags) tags.set(tag.toLowerCase(), tags.get(tag.toLowerCase()) ?? tag);
        }
        const options = [["", "All tags"], ...[...tags.values()].sort((a, b) => a.localeCompare(b)).map((t) => [t, t])];
        this.tagFilter.replaceChildren(...options.map(([value, label]) => {
            const option = el("option", null, label);
            option.value = value;
            return option;
        }));
        this.tagFilter.value = tags.has(chosen.toLowerCase()) ? chosen : "";
    }

    visible() {
        let items = this.all;
        if (this.matches) items = items.filter((b) => this.matches.has(b.id));
        const tag = this.tagFilter.value.toLowerCase();
        if (tag) items = items.filter((b) => b.tags.some((t) => t.toLowerCase() === tag));
        // Names may repeat: the id keeps the order still.
        items = [...items].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
            || a.id.localeCompare(b.id));
        if (this.sort.value === "updated") items.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
        return items;
    }

    lacking(bundle) {
        return this.linked.filter((s) => slotStatuses([s], bundle.fields)[0] !== "ok").map((s) => s.name);
    }

    renderList() {
        this.labels = displayNames(this.all);
        const filtering = !!this.matches || !!this.tagFilter.value;
        const groups = groupBundles(this.visible(), this.categories, this.errors, { filtering });
        const focus = this.focusedRow();
        if (!this.all.length && !this.errors.length && !this.categories.length) {
            this.list.replaceChildren(el("div", "bl-empty-state", "No bundles yet. Create one with + New bundle."));
        } else if (!groups.length) {
            this.list.replaceChildren(el("div", "bl-empty-state", "No bundles match."));
        } else {
            this.list.replaceChildren(...groups.map((group) => this.renderGroup(group, filtering)));
        }
        this.restoreFocus(focus);
        this.keepFocus();
        this.editorChanged();
    }

    /** A group: its heading (collapse, count, the menu of a category) and its rows. */
    renderGroup(group, filtering) {
        const root = el("div", `bl-group ${group.kind}`);
        root.dataset.group = group.key;
        const collapsed = !filtering && this.collapsed.has(group.key); // a search shows every match
        const head = el("div", "bl-group-head");
        const toggle = button("", "bl-group-toggle", filtering ? "" : collapsed ? "Expand" : "Collapse");
        toggle.disabled = filtering;
        toggle.setAttribute("aria-expanded", String(!collapsed));
        toggle.append(el("span", "bl-group-sign", filtering ? "" : collapsed ? "+" : "−"),
            el("span", "bl-group-name", groupLabel(group)),
            el("span", "bl-group-count", String(group.bundles.length + group.errors.length)));
        toggle.addEventListener("click", () => {
            if (this.collapsed.has(group.key)) this.collapsed.delete(group.key);
            else this.collapsed.add(group.key);
            saveCollapsed(this.collapsed);
            this.renderList();
        });
        head.append(toggle);
        if (group.kind === CATEGORY && !this.organizeBlocker) {
            const actions = menu("⋯", [
                ["Rename…", () => void this.askRename(group.category)],
                ["Delete…", () => void this.askDelete(group.category)],
            ], "bl-btn icon bl-group-menu", `Rename or delete '${group.name}'`);
            head.append(actions.root);
        }
        const rows = el("div", "bl-group-rows");
        rows.hidden = collapsed;
        rows.append(...group.errors.map((entry) => this.renderError(entry)),
            ...group.bundles.map((bundle) => this.renderItem(bundle)));
        if (!group.bundles.length && !group.errors.length) rows.append(el("div", "bl-group-empty", EMPTY_GROUP[group.kind]));
        root.append(head, rows);
        if (group.kind !== ATTENTION && !this.organizeBlocker) this.dropTarget(root, group);
        return root;
    }

    /** Dropping a bundle on a category puts it there, on Uncategorized takes it out, on Favorites stars it. */
    dropTarget(root, group) {
        const carries = (e) => e.dataTransfer?.types.includes(DRAG_TYPE);
        let depth = 0; // dragenter and dragleave also come from the rows inside
        root.addEventListener("dragenter", (e) => {
            if (!carries(e)) return;
            depth++;
            root.classList.add("drop-target");
        });
        root.addEventListener("dragleave", (e) => {
            if (carries(e) && --depth <= 0) {
                depth = 0;
                root.classList.remove("drop-target");
            }
        });
        root.addEventListener("dragover", (e) => {
            if (!carries(e)) return;
            e.preventDefault(); // allows the drop
            e.dataTransfer.dropEffect = group.kind === FAVORITES ? "copy" : "move";
        });
        root.addEventListener("drop", (e) => {
            depth = 0;
            root.classList.remove("drop-target");
            if (!carries(e)) return;
            e.preventDefault();
            const id = e.dataTransfer.getData(DRAG_TYPE);
            if (group.kind === FAVORITES) void this.setFavorite(id, true);
            else void this.moveBundle(id, group.kind === CATEGORY ? group.category.id : null);
        });
    }

    renderItem(bundle) {
        const item = el("div", "bl-list-item");
        item.tabIndex = 0;
        item.dataset.id = bundle.id;
        item.classList.toggle("selected", bundle.id === this.selectedId); // in every group it shows in
        const image = bundle.fields.find((f) => (f.type === "image" || f.type === "video") && f.preview);
        const thumb = el(image ? "img" : "div", "bl-list-thumb");
        if (image) {
            thumb.src = thumbnailURL(image.preview.sha256);
            thumb.alt = "";
            thumb.draggable = false; // the row is dragged, not the picture
        }
        const text = el("div", "bl-list-text");
        text.append(el("div", "bl-list-name", this.labels.get(bundle.id) ?? bundle.name),
            el("div", "bl-list-sub", bundle.tags.length ? bundle.tags.join(" · ") : `${bundle.fields.length} field(s)`));
        const lacking = this.lacking(bundle);
        if (lacking.length) text.append(el("div", "bl-list-warn", `⚠ no ${lacking.join(", ")}`));
        if (bundle.read_only) text.append(el("div", "bl-list-warn", "🔒 Cannot be changed by this version"));
        else if (bundle.warnings) text.append(el("div", "bl-list-warn", "⚠ Fix before saving"));
        const star = button(bundle.favorite ? "★" : "☆", "bl-star",
            this.organizeBlocker ?? (bundle.favorite ? "Remove from the favorites" : "Add to the favorites"));
        star.classList.toggle("on", !!bundle.favorite);
        star.setAttribute("aria-pressed", String(!!bundle.favorite));
        star.disabled = !!this.organizeBlocker;
        // Starring neither selects the row nor, with a double click, picks the bundle.
        star.addEventListener("click", (e) => {
            e.stopPropagation();
            void this.toggleFavorite(bundle.id);
        });
        star.addEventListener("dblclick", (e) => e.stopPropagation());
        item.append(thumb, text, star);
        item.addEventListener("click", () => void this.open(bundle.id));
        item.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && e.target === item) void this.open(bundle.id);
        });
        if (this.onPick) {
            item.addEventListener("dblclick", async () => {
                await this.open(bundle.id);
                if (this.editor?.saved?.id === bundle.id) this.pick(); // not when opening it was cancelled
            });
        }
        if (!this.organizeBlocker) {
            item.draggable = true;
            item.addEventListener("dragstart", (e) => {
                e.dataTransfer.setData(DRAG_TYPE, bundle.id);
                e.dataTransfer.effectAllowed = "copyMove";
                item.classList.add("dragging");
            });
            item.addEventListener("dragend", () => {
                item.classList.remove("dragging");
                for (const target of this.list.querySelectorAll(".drop-target")) target.classList.remove("drop-target");
            });
        }
        return item;
    }

    /** A file this version cannot use: why, and a way to delete it on purpose when it is a bundle file. */
    renderError(entry) {
        const row = el("div", "bl-error-item");
        row.dataset.file = entry.file;
        const text = el("div", "bl-list-text");
        text.append(el("div", "bl-list-name bl-bad", `⚠ ${entry.file}`), el("div", "bl-list-sub", entry.error));
        row.append(el("div", "bl-list-thumb"), text);
        if (entry.id) {
            const purge = button("Delete forever", "bl-btn danger");
            purge.addEventListener("click", () => void this.purgeUnreadable(entry));
            row.append(purge);
        }
        return row;
    }

    /** Where the focus is in the list: the group, the bundle or file, and which part of the row. */
    focusedRow() {
        const active = document.activeElement;
        if (!this.list.contains(active) || active === this.list) return null;
        const row = active.closest(".bl-list-item, .bl-error-item");
        return {
            group: active.closest(".bl-group")?.dataset.group ?? null,
            id: row?.dataset.id ?? null,
            file: row?.dataset.file ?? null,
            part: active.classList.contains("bl-star") ? "star" : active.classList.contains("bl-group-toggle") ? "toggle"
                : active === row ? "row" : "other",
        };
    }

    /** Focus the same place again after the list was rebuilt: in the same group if it is there, else anywhere. */
    restoreFocus(focus) {
        if (!focus) return;
        const groups = [...this.list.querySelectorAll(".bl-group")];
        const group = groups.find((g) => g.dataset.group === focus.group);
        let target = null;
        if (focus.part === "toggle") {
            target = group?.querySelector(".bl-group-toggle");
        } else if (focus.id || focus.file) {
            const rows = (scope) => [...(scope?.querySelectorAll(".bl-list-item, .bl-error-item") ?? [])]
                .filter((r) => (focus.id ? r.dataset.id === focus.id : r.dataset.file === focus.file));
            const row = rows(group)[0] ?? rows(this.list)[0];
            target = focus.part === "star" ? row?.querySelector(".bl-star") : focus.part === "row" ? row : null;
        }
        target?.focus({ preventScroll: true });
    }

    // -- categories and favorites ----------------------------------------------

    /** Why categories and favorites cannot be changed now, or null. */
    get organizeBlocker() {
        const { state } = this.organization;
        return state === "ok" || state === "missing" ? null
            : "This version of Bundle Library cannot change the categories and favorites: see Needs attention.";
    }

    /**
     * Send a change of categories or favorites after those asked for before,
     * so the server ends with the last one; once none is waiting, read the
     * list again. The editor is not reopened: a draft that is not saved stays.
     * Resolves to the answer, or rejects with the request's error.
     */
    async organize(request) {
        this.organizing++;
        const sent = this.organizeQueue.then(() => request());
        this.organizeQueue = sent.catch(() => {});
        try {
            return await sent;
        } finally {
            if (--this.organizing === 0) await this.reload();
        }
    }

    /** Show a change to a bundle's summary at once; the list read afterwards has the server's answer. */
    showOrganized(id, change) {
        this.all = this.all.map((b) => (b.id === id ? { ...b, ...change } : b));
        this.renderList();
        this.editor?.organizationChanged();
    }

    async setFavorite(id, favorite) {
        const summary = this.summary(id);
        if (!summary || this.organizeBlocker || summary.favorite === favorite) return;
        this.showOrganized(id, { favorite });
        try {
            await this.organize(() => setFavorite(id, favorite));
        } catch (error) {
            this.status(error.message, "error");
        }
    }

    toggleFavorite(id) {
        const summary = this.summary(id);
        return summary ? this.setFavorite(id, !summary.favorite) : undefined;
    }

    /** Put a bundle in a category (an id), or in none with null. */
    async moveBundle(id, category) {
        const summary = this.summary(id);
        if (!summary || this.organizeBlocker || (summary.category ?? null) === category) return;
        const name = this.categories.find((c) => c.id === category)?.name;
        this.showOrganized(id, { category });
        try {
            await this.organize(() => setCategory(id, category));
            this.status(category ? `Moved '${summary.name}' to ${name}.` : `'${summary.name}' is uncategorized now.`);
        } catch (error) {
            this.status(error.message, "error");
        }
    }

    /** Ask for a name and make a category; resolves to it, or to null. */
    async newCategory() {
        if (this.organizeBlocker) {
            this.status(this.organizeBlocker, "error");
            return null;
        }
        let made = null;
        await this.ask("New category", "Each bundle sits in one category. Choose it in the editor, or drag the "
            + "bundle onto the category.", {
            placeholder: "Category name", action: "Create",
            submit: async (name) => {
                made = await this.organize(() => createCategory(name));
            },
        });
        if (!made) return null;
        if (!this.categories.some((c) => c.id === made.id)) { // when the list is read again later
            this.categories = [...this.categories, { ...made, count: 0 }]
                .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id));
            this.renderList();
            this.editor?.organizationChanged();
        }
        this.status(`Created the category '${made.name}'.`);
        return made;
    }

    async askRename(category) {
        let renamed = null;
        await this.ask(`Rename '${category.name}'`, null, {
            value: category.name, action: "Rename",
            submit: async (name) => {
                renamed = await this.organize(() => renameCategory(category.id, name));
            },
        });
        if (renamed) this.status(`Renamed the category to '${renamed.name}'.`);
    }

    async askDelete(category) {
        const count = this.all.filter((b) => b.category === category.id).length;
        const confirmed = await this.confirm(`Delete the category '${category.name}'?`,
            count ? `${count === 1 ? "Its bundle moves" : `Its ${count} bundles move`} to Uncategorized. `
                + "The bundles themselves are not changed."
                : "It has no bundles.",
            "Delete category", { danger: true });
        if (!confirmed) return;
        try {
            await this.organize(() => deleteCategory(category.id));
            this.collapsed.delete(`${CATEGORY}:${category.id}`);
            saveCollapsed(this.collapsed);
            this.status(`Deleted the category '${category.name}'.`);
        } catch (error) {
            this.status(error.message, "error");
        }
    }

    /** Delete a file this version cannot fully read, once the user confirms. */
    async purgeUnreadable(entry) {
        const confirmed = await this.confirm(`Delete ${entry.file} for good?`, [
            `This version of Bundle Library cannot fully read it: ${entry.error}.`,
            "If a newer Bundle Library saved it, that version loses it too. Deleting cannot be undone.",
        ], "Delete forever", { danger: true });
        if (!confirmed) return;
        try {
            await purgeBundle(entry.id, { unreadable: true });
            this.status(`Deleted ${entry.file} for good.`);
        } catch (error) {
            this.status(error.message, "error");
        }
        void this.refreshTrashCount();
        await this.reload();
    }

    // -- editor ----------------------------------------------------------------

    /** Whether the editor holds changes (or an upload in progress) that are not saved. */
    get unsaved() {
        return !!this.editor && (this.editor.dirty || this.editor.uploads > 0);
    }

    /** Ask before an unsaved draft would be lost; true when it may go. */
    async leaveEditor() {
        if (this.editor?.saving) {
            this.status("Wait until the bundle is saved.");
            return false;
        }
        if (!this.unsaved) return true;
        return this.confirm("Discard unsaved changes?",
            `Your changes to '${this.editor.draft.name || "this bundle"}' have not been saved.`, "Discard", { danger: true });
    }

    async open(id, { force = false } = {}) {
        if (this.editor?.saved?.id === id && !this.editor.dirty) return;
        if (!force && !(await this.leaveEditor())) return;
        this.selectedId = id;
        const generation = this.showPane(el("div", "bl-empty-state bl-loading", "Loading…"));
        this.renderList();
        let bundle;
        try {
            bundle = await getBundle(id);
        } catch (error) {
            if (generation !== this.editorGeneration) return;
            this.selectedId = null;
            this.showPlaceholder();
            this.renderList();
            this.status(error.message, "error");
            return;
        }
        if (generation !== this.editorGeneration) return; // another bundle or a new draft was opened meanwhile
        this.show(new BundleEditor(this, bundle));
    }

    async newBundle() {
        if (!(await this.leaveEditor())) return;
        const taken = new Set(this.all.map((b) => b.name.toLowerCase()));
        let name = "New bundle";
        for (let n = 2; taken.has(name.toLowerCase()); n++) name = `New bundle ${n}`;
        this.selectedId = null;
        this.show(new BundleEditor(this, null, name));
        this.renderList();
        this.editor.nameInput.focus();
        this.editor.nameInput.select();
    }

    show(editor) {
        this.showPane(editor.root, editor);
    }

    async showTrash() {
        if (this.trashPanel) {
            void this.trashPanel.refresh(); // the button reads the trash again
            return;
        }
        if (!(await this.leaveEditor())) return;
        this.selectedId = null;
        const panel = new TrashPanel(this);
        this.showPane(panel.root, null, panel);
        this.renderList();
    }

    /** The trash button says how many bundles are in the trash. */
    trashCounted(count) {
        this.trashGeneration++; // a count still on its way is older
        this.trashButton.textContent = count ? `🗑 Trash (${count})` : "🗑 Trash";
    }

    async refreshTrashCount() {
        const generation = ++this.trashGeneration;
        let listing;
        try {
            listing = await listTrash();
        } catch {
            return; // the count is only a hint
        }
        if (generation === this.trashGeneration) this.trashCounted(listing.trash.length);
    }

    showPlaceholder() {
        this.showPane(el("div", "bl-empty-state", "Select a bundle on the left, or create one with + New bundle."));
    }

    /** Put `content` in the editor pane, dropping the editor shown before; the new generation. */
    showPane(content, editor = null, trashPanel = null) {
        if (this.editor !== editor) this.editor?.dispose();
        this.editor = editor;
        this.trashPanel = trashPanel;
        this.trashButton.classList.toggle("selected", !!trashPanel);
        this.pane.replaceChildren(content);
        this.pane.scrollTop = 0;
        this.keepFocus();
        this.editorChanged();
        return ++this.editorGeneration;
    }

    // Called by the editor.
    async bundleSaved(bundle, { open = false } = {}) {
        this.selectedId = bundle.id;
        await this.reload();
        if (open) await this.open(bundle.id, { force: true });
    }

    async bundleDeleted(bundle) {
        this.selectedId = null;
        this.showPlaceholder();
        void this.refreshTrashCount();
        await this.reload();
        this.status(`Deleted '${bundle.name}'. It is in the trash.`);
    }

    discardDraft() {
        this.showPlaceholder();
        this.renderList();
        this.status("Discarded the new bundle.");
    }

    editorChanged() {
        if (!this.onPick) return;
        const ready = this.editor?.saved && !this.unsaved;
        const summary = ready ? this.all.find((b) => b.id === this.editor.saved.id) : null;
        const lacking = summary ? this.lacking(summary) : [];
        this.pickButton.disabled = !summary;
        this.pickHint.textContent = !this.editor ? "Select a bundle."
            : !ready ? "Save or revert your changes first."
                : lacking.length === 1 ? `⚠ The node's connected output ${lacking[0]} is missing here or has another type; running would fail.`
                    : lacking.length ? `⚠ The node's connected outputs ${lacking.join(", ")} are missing here or have another type; running would fail.`
                        : "";
    }

    pick() {
        const summary = this.editor?.saved && !this.unsaved && this.all.find((b) => b.id === this.editor.saved.id);
        if (!summary) return;
        this.onPick(summary);
        this.close();
    }

    async requestClose() {
        if (this.layer) return;
        if (await this.leaveEditor()) this.close();
    }

    close() {
        this.editor?.dispose();
        this.overlay.remove();
        for (const type of STRAY_EVENTS) window.removeEventListener(type, this.onStrayEvent, true);
        window.removeEventListener("focusin", this.onStrayFocus, true);
        window.removeEventListener("beforeunload", this.onBeforeUnload);
        current = null;
    }

    status(message, kind = "info") {
        this.statusLine.textContent = message;
        this.statusLine.classList.toggle("error", kind === "error");
        clearTimeout(this.statusTimer);
        if (kind !== "error") this.statusTimer = setTimeout(() => { this.statusLine.textContent = ""; }, 6000);
    }

    // -- layers: confirmations and the image viewer ----------------------------

    showLayer(content, dismiss) {
        this.hideLayer();
        const layer = el("div", "bl-layer");
        layer.append(content);
        layer.addEventListener("pointerdown", (e) => {
            if (e.target === layer) dismiss();
        });
        this.dialog.append(layer);
        this.layer = { element: layer, dismiss, returnFocus: document.activeElement };
    }

    hideLayer() {
        if (!this.layer) return;
        const { element, returnFocus } = this.layer;
        this.layer = null;
        element.remove();
        if (returnFocus?.isConnected && this.overlay.contains(returnFocus)) returnFocus.focus({ preventScroll: true });
        else this.keepFocus();
    }

    /**
     * Resolves to the value of the chosen button; dismissing picks the last one.
     * `message` is a paragraph or a list of them; `extra`, an element to show below.
     */
    choose(title, message, choices, extra = null) {
        return new Promise((resolve) => {
            const box = el("div", extra ? "bl-confirm wide" : "bl-confirm");
            const row = el("div", "bl-confirm-buttons");
            const finish = (value) => {
                this.hideLayer();
                resolve(value);
            };
            for (const [label, value, style] of choices) {
                const choice = button(label, `bl-btn ${style ?? ""}`.trim());
                choice.addEventListener("click", () => finish(value));
                row.append(choice);
            }
            box.append(el("div", "bl-confirm-title", title),
                ...[message].flat().map((text) => el("div", "bl-confirm-text", text)), ...(extra ? [extra] : []), row);
            this.showLayer(box, () => finish(choices.at(-1)[1]));
            row.lastChild.focus(); // the safe choice
        });
    }

    /**
     * Ask for a line of text. `submit(value)` does the work: when it throws, its
     * message shows under the input and the question stays. Resolves to true
     * once submitted, false when cancelled.
     */
    ask(title, message, { value = "", placeholder = "", maxLength = 60, action = "OK", submit }) {
        return new Promise((resolve) => {
            const box = el("form", "bl-confirm bl-ask");
            const input = el("input", "bl-input bl-ask-input");
            input.value = value;
            input.placeholder = placeholder;
            input.maxLength = maxLength;
            const problem = el("div", "bl-error");
            problem.hidden = true;
            const row = el("div", "bl-confirm-buttons");
            const ok = button(action, "bl-btn primary");
            ok.type = "submit";
            const cancel = button("Cancel");
            let busy = false;
            const finish = (done) => {
                this.hideLayer();
                resolve(done);
            };
            cancel.addEventListener("click", () => finish(false));
            box.addEventListener("submit", async (e) => {
                e.preventDefault();
                if (busy) return;
                busy = ok.disabled = true;
                try {
                    await submit(input.value);
                    finish(true);
                } catch (error) {
                    problem.textContent = error.message;
                    problem.hidden = false;
                    busy = ok.disabled = false;
                    input.focus();
                }
            });
            row.append(ok, cancel);
            box.append(el("div", "bl-confirm-title", title), ...(message ? [el("div", "bl-confirm-text", message)] : []),
                input, problem, row);
            this.showLayer(box, () => {
                if (!busy) finish(false);
            });
            input.focus();
            input.select();
        });
    }

    async confirm(title, message, label, { danger = false } = {}) {
        return (await this.choose(title, message, [[label, true, danger ? "danger" : "primary"], ["Cancel", false]])) === true;
    }

    viewImage(url, caption) {
        const box = el("div", "bl-viewer");
        const img = el("img");
        img.src = url;
        img.alt = caption;
        box.append(img, el("div", "bl-viewer-caption", caption));
        box.addEventListener("click", () => this.hideLayer());
        this.showLayer(box, () => this.hideLayer());
    }
}

// The list of the sidebar tab while it is shown.
let sidebarList = null;
let sidebarGeneration = 0;

function fillSidebar(list, fresh = false) {
    const generation = ++sidebarGeneration;
    listLibrary({ fresh }).then(({ bundles, categories = [] }) => {
        if (generation !== sidebarGeneration) return; // a newer list is on its way
        const labels = displayNames(bundles);
        const item = (bundle) => {
            const entry = button(labels.get(bundle.id), "bl-sidebar-item");
            entry.addEventListener("click", () => openLibrary({ selected: bundle.id }));
            return entry;
        };
        const groups = compactGroups(bundles, categories);
        list.replaceChildren(...(!bundles.length ? [el("div", "bl-empty-state", "No bundles yet.")]
            : groups ? groups.flatMap((group) => [el("div", "bl-sidebar-group", groupLabel(group)), ...group.bundles.map(item)])
                : bundles.map(item)));
    }, (error) => {
        if (generation === sidebarGeneration) list.replaceChildren(el("div", "bl-bad", `⚠ ${error.message}`));
    });
}

window.addEventListener(CHANGED_EVENT, () => {
    if (sidebarList?.isConnected) fillSidebar(sidebarList);
});

/** The sidebar tab: the bundle names by category, each opening the library at that bundle. */
export function renderSidebar(container) {
    const root = el("div", "bl-sidebar");
    const open = button("Open library", "bl-btn primary");
    open.addEventListener("click", () => openLibrary());
    sidebarList = el("div", "bl-sidebar-list");
    root.append(open, sidebarList);
    container.replaceChildren(root);
    fillSidebar(sidebarList, true);
}
