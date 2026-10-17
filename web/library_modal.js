// The library modal: the bundle list on the left, grouped by category, and
// the editor on the right. It is a document.body overlay of its own: ComfyUI's
// dialogs need Vue components, and they would open underneath it.
import {
    CHANGED_EVENT, applyImport, batchBundles, createCategory, discardImport, exportBundles, deleteCategory, getBundle,
    listLibrary, listTrash, purgeBundle, renameCategory, searchBundleIds, setCategory, setFavorite, thumbnailURL, uploadImport,
} from "./api.js";
import { BatchPanel, BatchResult, ExportResult } from "./batch_panel.js";
import { BundleEditor } from "./bundle_editor.js";
import { Commands } from "./commands.js";
import { button, closeMenus, code, codeList, el, icon, menu } from "./dom.js";
import { ATTENTION, CATEGORY, FAVORITES, UNCATEGORIZED, compactGroups, groupBundles, groupLabel } from "./groups.js";
import { ImportPanel, ImportResult } from "./import_panel.js";
import { displayNames } from "./names.js";
import { slotStatuses } from "./reconcile.js";
import { around, msg, onCatalogs, said, t } from "./i18n.js";
import { compareText, sameTag, tagCounts } from "./tags.js";
import { TagsPanel } from "./tags_panel.js";
import { TrashPanel } from "./trash_panel.js";

let current = null;

// Caught on window while the modal is open; see build().
const STRAY_EVENTS = ["keydown", "keyup", "keypress", "paste", "copy", "cut"];

// What a bundle row carries while dragged onto a group: the ids moved, as a
// JSON list. Files dragged in from outside do not have it and are not taken
// for a move.
const DRAG_TYPE = "application/x-bundle-library-bundle";

// How long a change to several bundles may go unanswered before the user is
// offered to stop waiting (fetch has no time limit of its own).
const STALL_MS = 30000;

/** The ids a drag carries (a JSON list; a bare id from an older page counts as one). */
function draggedIds(data) {
    try {
        const ids = JSON.parse(data);
        if (Array.isArray(ids)) return ids.filter((id) => typeof id === "string");
    } catch {
        // not JSON
    }
    return data ? [data] : [];
}

// Kept in this browser: the collapsed groups and the sort. Only a convenience:
// without storage every group starts expanded and the list sorted by name.
const COLLAPSED_KEY = "bundle-library.collapsed-groups";
const SORT_KEY = "bundle-library.sort";
// [value, menu text, icon, button label]. "name" and "updated" are the values kept from before 0.0.26.
const SORTS = [["name", msg("library.sort_name"), "sort-alpha-down", msg("library.sort_name_title")],
    ["name_desc", msg("library.sort_name_desc"), "sort-alpha-up", msg("library.sort_name_desc_title")],
    ["updated", msg("library.sort_updated"), "sort-amount-down", msg("library.sort_updated_title")],
    ["updated_asc", msg("library.sort_updated_asc"), "sort-amount-up", msg("library.sort_updated_asc_title")]];

function remembered(key, fallback) {
    try {
        const value = JSON.parse(localStorage.getItem(key) ?? "null");
        return value ?? fallback;
    } catch {
        return fallback;
    }
}

function remember(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // not kept for the next time
    }
}

function loadCollapsed() {
    const keys = remembered(COLLAPSED_KEY, []);
    return new Set(Array.isArray(keys) ? keys.filter((key) => typeof key === "string") : []);
}

function loadSort() {
    const sort = remembered(SORT_KEY, "name");
    return SORTS.some(([value]) => value === sort) ? sort : "name";
}

// What an empty group says, unless the whole list is empty (that has its own line).
const EMPTY_GROUP = {
    [FAVORITES]: msg("library.favorites_hint"),
    [CATEGORY]: msg("library.group_empty_category"),
};
const EMPTY_WHILE_FILTERING = msg("library.no_favorite_match");

/** The text around elements (around() in i18n.js), with the elements in their place. */
const spread = ([before, after], middle) => [before, ...middle, after];

/**
 * Open the library. With `onPick` it is the bundle picker of a Load Bundle
 * node: "Use this bundle" hands onPick the summary of the bundle the editor
 * shows, as saved (with one bundle selected; several can still be selected
 * and changed), and `linked` (the node's connected slots) marks bundles that
 * lack one.
 */
export function openLibrary({ onPick = null, linked = [], selected = null } = {}) {
    if (!current) current = new LibraryModal({ onPick, linked, selected });
    return current;
}

class LibraryModal {
    constructor({ onPick, linked, selected }) {
        this.onPick = onPick;
        this.linked = linked;
        // The selected bundles, by id: one opens in the editor, two or more show
        // what can be done to all of them. The anchor is the row a Shift+click
        // range starts from: {group, id}.
        this.selection = new Set(selected ? [selected] : []);
        this.anchor = null;
        // The commands that wait for the server, the one holding the window,
        // and who owns the pane and the question layer (commands.js).
        this.commands = new Commands(() => this.editorChanged());
        this.batchJobs = 0;
        this.all = [];
        this.errors = []; // the files this version cannot use, shown under Needs attention
        this.categories = [];
        this.organization = { revision: 0, state: "missing" };
        this.collapsed = loadCollapsed();
        this.sortMode = loadSort();
        this.tag = ""; // the tag the list is filtered by, or ""
        this.dragging = null; // the bundle id being dragged from a row (see startDrag())
        // Changes of categories and favorites go out one after another (see organize()).
        this.organizeQueue = Promise.resolve();
        this.organizing = 0;
        this.matches = null;
        this.editor = null;
        this.trashPanel = null; // shown in the pane instead of an editor
        this.layer = null; // the question or picture over the window: {token, element, dismiss, behind, returnFocus}
        // Answers to reads that arrive after a newer read was made are dropped:
        // each kind of read counts its generations.
        this.listGeneration = 0;
        this.refreshGeneration = 0; // editor reads by refreshEditor(): only the last one counts
        this.searchGeneration = 0;
        this.trashGeneration = 0;
        this.onBeforeUnload = (e) => {
            if (this.unsaved) e.preventDefault();
        };
        this.build();
        // The bundle asked for opens when the list is in, unless the pane changed meanwhile (R19-01).
        const view = this.showPlaceholder();
        void this.reload({ select: selected ? { id: selected, view } : null });
        void this.refreshTrashCount();
    }

    build() {
        this.overlay = el("div", "bl-overlay");
        this.dialog = el("div", "bl-modal");
        this.dialog.setAttribute("role", "dialog");
        this.dialog.setAttribute("aria-modal", "true");
        this.dialog.tabIndex = -1; // holds the focus when the element that had it goes away

        const header = el("div", "bl-modal-header");
        const title = el("div", "bl-modal-title", "Bundle Library");
        this.search = el("input", "bl-input bl-search");
        this.search.type = "search";
        this.search.placeholder = t("library.search_placeholder");
        let searchTimer = null;
        this.search.addEventListener("input", () => {
            if (this.lockReason) return; // disabled meanwhile; a typed key that slipped through does nothing
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => void this.applySearch(), 250);
        });
        const create = button(t("library.new_bundle_button"), "bl-btn primary bl-new");
        create.addEventListener("click", () => void this.newBundle());
        this.createButton = create;
        const close = button("✕", "bl-btn icon bl-close", t("library.close"));
        close.addEventListener("click", () => void this.requestClose());
        header.append(title, this.search, create, close);

        const body = el("div", "bl-modal-body");
        const side = el("div", "bl-modal-side");
        this.chips = el("div", "bl-filter-chips"); // the tag filter, when one is set
        this.chips.hidden = true;
        this.list = el("div", "bl-modal-list");
        side.append(this.chips, this.list, this.buildTools());
        this.pane = el("div", "bl-modal-editor");
        body.append(side, this.pane);

        const footer = el("div", "bl-modal-footer");
        this.statusLine = el("div", "bl-status");
        footer.append(this.statusLine);
        if (this.onPick) {
            this.pickHint = el("div", "bl-pick-hint");
            const cancel = button(t("common.cancel"));
            cancel.addEventListener("click", () => void this.requestClose());
            this.pickButton = button(t("library.use_bundle"), "bl-btn primary bl-pick");
            this.pickButton.addEventListener("click", () => this.pick());
            footer.append(this.pickHint, cancel, this.pickButton);
        }
        this.dialog.append(header, body, footer);
        this.overlay.append(this.dialog);
        // One listener for every popup menu: a click elsewhere closes it.
        this.dialog.addEventListener("pointerdown", (e) => closeMenus(this.dialog, e.target));

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
                if (type === "drop") this.endDrag(); // after the place it was dropped on took it
            });
        }
        // The row a drag started from may be gone before the drag ends (the
        // list was drawn again), and then no dragend comes. The pointer moves
        // again only once the drag is over, so that ends it too.
        this.onPointerMove = () => {
            if (this.dragging && performance.now() - this.dragStarted > 300) this.endDrag();
        };
        window.addEventListener("pointermove", this.onPointerMove, true);
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
        // Another tab may have changed the library meanwhile: read the list again
        // on coming back (a clean editor then shows a bundle saved there).
        this.onVisible = () => {
            if (document.visibilityState === "visible" && !this.commands.running) void this.reload();
        };
        document.addEventListener("visibilitychange", this.onVisible);
        this.search.focus();
    }

    /** Put the focus back in the modal (in the question, while one is open) when the element holding it went away. */
    keepFocus() {
        if (this.layer) {
            if (!this.layer.element.contains(document.activeElement)) {
                (this.layerStops()[0] ?? this.dialog).focus({ preventScroll: true });
            }
        } else if (!this.overlay.contains(document.activeElement)) {
            this.dialog.focus({ preventScroll: true });
        }
    }

    /** What Tab moves through in the open question: not what is inert there (R31-05: a grid while its pick is sent). */
    layerStops() {
        return [...this.layer.element.querySelectorAll("button, input, select, textarea, a[href], [tabindex]")]
            .filter((e) => !e.disabled && e.tabIndex >= 0 && e.getClientRects().length > 0 && !e.closest("[inert]"));
    }

    /** Tab and Shift+Tab go round the open question instead of leaving it. */
    trapTab(e) {
        const stops = this.layerStops();
        if (!stops.length) return;
        const at = stops.indexOf(document.activeElement);
        e.preventDefault();
        const next = at < 0 ? (e.shiftKey ? stops.length - 1 : 0) : (at + (e.shiftKey ? -1 : 1) + stops.length) % stops.length;
        stops[next].focus({ preventScroll: true });
    }

    onKey(e) {
        if (e.isComposing) return; // Enter or Escape that ends an IME composition (Korean input)
        if (e.key === "Tab" && this.layer) {
            this.trapTab(e);
            return;
        }
        const mod = e.ctrlKey || e.metaKey;
        const key = (e.key ?? "").toLowerCase(); // autofill sends keydowns without a key
        // Stopping propagation also kept ComfyUI from cancelling the browser's
        // own action for these, so cancel them here: Ctrl+S saves the bundle,
        // Ctrl+O would open the browser's file dialog.
        if (mod && (key === "s" || key === "o")) {
            e.preventDefault();
            if (key === "s" && !this.layer) void this.editor?.save();
        } else if (mod && key === "a" && !this.layer && this.list.contains(e.target)) {
            e.preventDefault(); // in the list only: a text box keeps its own Select all
            this.selectAll();
        } else if (e.key === "Escape") {
            e.preventDefault();
            // One thing at a time: a confirmation, an open menu, a drag, a selection of
            // several bundles, then the library.
            if (this.layer) this.layer.dismiss();
            else if (closeMenus(this.dialog)) return;
            else if (this.dragging) this.endDrag();
            else if (this.commands.running) this.status(this.lockReason);
            else if (this.selection.size > 1) this.clearSelection();
            else void this.requestClose();
        }
    }

    /** The tools under the list: new category, sort, tag filter and the trash. */
    buildTools() {
        const footer = el("div", "bl-side-footer");
        const tools = el("div", "bl-list-tools");
        this.newCategoryButton = button("", "bl-btn icon bl-new-category", t("library.category_new"));
        this.newCategoryButton.setAttribute("aria-label", t("library.category_new"));
        this.newCategoryButton.append(icon("folder-plus"));
        this.newCategoryButton.addEventListener("click", () => {
            if (this.allowed()) void this.newCategory();
        });
        const sort = menu(icon("sort-alpha-down"), () => SORTS.map(([value, text]) => ({
            text: t(text), value, checked: this.sortMode === value, action: () => this.setSort(value),
        })), { className: "bl-btn icon bl-sort-button", up: true });
        this.sortButton = sort.opener;
        const tags = menu(icon("filter"), () => this.tagChoices(), {
            className: "bl-btn icon bl-tag-button", up: true, search: t("library.tag_find"), empty: t("library.no_tag_match"),
        });
        this.tagButton = tags.opener;
        this.trashButton = button("", "bl-btn icon bl-trash-button");
        this.trashCount = el("span", "bl-count-badge");
        this.trashButton.append(icon("trash"), this.trashCount);
        this.trashButton.addEventListener("click", () => void this.showTrash());
        this.importButton = button("", "bl-btn icon bl-import-button");
        this.importButton.setAttribute("aria-label", t("library.import_title"));
        this.importButton.append(icon("upload"));
        const importPicker = el("input");
        importPicker.type = "file";
        importPicker.accept = ".zip,application/zip";
        importPicker.hidden = true;
        importPicker.addEventListener("change", () => {
            const file = importPicker.files[0];
            importPicker.value = "";
            if (file) void this.showImport(file);
        });
        this.importButton.addEventListener("click", () => {
            if (this.allowed()) importPicker.click();
        });
        tools.append(this.newCategoryButton, sort.root, tags.root, el("span", "bl-tools-gap"), this.importButton, importPicker,
            this.trashButton);
        // While a bundle in a category is dragged, this takes the place of the
        // tools: Uncategorized may be hidden (it is when empty). Same height,
        // so nothing in the list moves.
        this.dropZone = el("div", "bl-drop-zone", t("library.drop_uncategorize"));
        this.dropZone.hidden = true;
        this.dropTarget(this.dropZone, { kind: UNCATEGORIZED });
        footer.append(tools, this.dropZone);
        this.trashCounted(0);
        this.showSort();
        this.showTagFilter();
        return footer;
    }

    setSort(sort) {
        if (!this.allowed()) return;
        this.sortMode = sort;
        remember(SORT_KEY, sort);
        this.showSort();
        this.renderList();
    }

    showSort() {
        const [, , name, label] = SORTS.find(([value]) => value === this.sortMode);
        this.sortButton.replaceChildren(icon(name));
        this.sortButton.setAttribute("aria-label", t(label));
        this.sortButton.title = this.lockReason ?? t(label);
    }

    /** The tags of the bundles in use, with how many bundles have each; for the tag menu. */
    tagChoices() {
        return [
            { text: t("library.tag_all"), value: "", checked: !this.tag, always: true, action: () => this.setTag("") },
            ...tagCounts(this.all).map(({ name, count }) => ({
                text: name, count, value: name, checked: !!this.tag && sameTag(this.tag, name), action: () => this.setTag(name),
            })),
            { text: t("library.manage_tags"), always: true, action: () => void this.showTags() },
        ];
    }

    setTag(tag) {
        if (!this.allowed()) return;
        this.tag = tag;
        this.showTagFilter();
        this.listChanged();
    }

    /** The chip above the list and the tag button say which tag the list is filtered by. */
    showTagFilter() {
        this.chips.hidden = !this.tag;
        this.tagButton.classList.toggle("active", !!this.tag);
        this.tagButton.title = this.lockReason ?? (this.tag ? t("library.tag_filter_label", { tag: this.tag }) : t("library.tag_filter"));
        this.tagButton.setAttribute("aria-label", this.tag ? t("library.tag_filter_now", { tag: this.tag }) : t("library.tag_filter"));
        if (!this.tag) {
            this.chips.replaceChildren();
            return;
        }
        const chip = el("span", "bl-chip bl-filter-chip", t("library.tag_filter_label", { tag: this.tag }));
        const clear = button("×", "bl-chip-x", t("library.tag_show_all"));
        clear.disabled = !!this.lockReason;
        clear.setAttribute("aria-label", t("library.clear_tag_filter"));
        clear.addEventListener("click", () => {
            this.setTag("");
            this.tagButton.focus({ preventScroll: true });
        });
        chip.append(clear);
        this.chips.replaceChildren(chip);
    }

    // -- list ------------------------------------------------------------------

    /**
     * Read the list again. When it cannot be read, the list shown stays, with
     * the selection, the filter and a new draft's category, and the status
     * line says why.
     */
    async reload({ select = null } = {}) {
        const generation = ++this.listGeneration;
        let library;
        try {
            library = await listLibrary({ fresh: true });
        } catch (error) {
            if (generation === this.listGeneration) this.status(t("library.read_failed", { reason: error.message }), "error");
            return;
        }
        if (generation !== this.listGeneration || this.closed) return; // a newer reload answers instead
        this.all = library.bundles ?? [];
        this.errors = library.errors ?? [];
        this.categories = [...(library.categories ?? [])].sort((a, b) => compareText(a.name, b.name) || compareText(a.id, b.id));
        this.organization = library.organization ?? { revision: 0, state: "missing" };
        this.shownLock = undefined; // the organization may have changed what the tools allow
        this.refreshLock();
        if (this.tag && !this.all.some((b) => b.tags.some((t) => sameTag(t, this.tag)))) {
            this.tag = ""; // no bundle has it any more
            this.showTagFilter();
        }
        if (this.search.value.trim()) await this.applySearch();
        else this.listChanged();
        this.editor?.organizationChanged();
        void this.refreshEditor();
        // The bundle the window was opened at: only while the pane shows what it showed then. A new draft,
        // another bundle or anything else begun before the list came in stays (R19-01).
        if (select && this.commands.pane.shows(select.view) && !this.unsaved && this.all.some((b) => b.id === select.id)) {
            await this.open(select.id, { force: true });
            if (this.selection.has(select.id) && this.selection.size === 1) this.revealRow(select.id);
        }
    }

    /** The list's summary of a bundle (with its category and star), or null. */
    summary(id) {
        return this.all.find((b) => b.id === id) ?? null;
    }

    /**
     * Search for what the box says. When the search fails, the matches found
     * last stay (the list is still drawn: it may have been read again) and the
     * status line says why.
     */
    async applySearch() {
        const generation = ++this.searchGeneration;
        const query = this.search.value.trim();
        let matches = this.matches;
        try {
            matches = query ? await searchBundleIds(query) : null;
        } catch (error) {
            if (generation === this.searchGeneration) this.status(t("library.search_failed", { reason: error.message }), "error");
        }
        if (generation !== this.searchGeneration) return; // the query changed meanwhile
        this.matches = matches;
        this.listChanged();
    }

    visible() {
        let items = this.all;
        if (this.matches) items = items.filter((b) => this.matches.has(b.id));
        if (this.tag) items = items.filter((b) => b.tags.some((t) => sameTag(t, this.tag)));
        // Names may repeat: the id keeps the order still.
        const byName = (a, b) => compareText(a.name, b.name) || compareText(a.id, b.id);
        const byTime = (a, b) => (a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : 0);
        items = [...items].sort(byName); // ties of time stay in name order
        if (this.sortMode === "name_desc") items.sort((a, b) => byName(b, a));
        else if (this.sortMode === "updated") items.sort((a, b) => byTime(b, a));
        else if (this.sortMode === "updated_asc") items.sort(byTime);
        return items;
    }

    lacking(bundle) {
        return this.linked.filter((s) => slotStatuses([s], bundle.fields)[0] !== "ok").map((s) => s.name);
    }

    /** Draw the list as the state has it. It changes no state: listChanged() does that, before drawing. */
    renderList() {
        this.endDrag(); // the places to drop on belong to the list the drag started in
        this.labels = displayNames(this.all);
        const filtering = !!this.matches || !!this.tag;
        const visible = this.visible();
        const groups = groupBundles(visible, this.categories, this.errors, { filtering });
        const focus = this.focusedRow();
        // Favorites always shows; when there is nothing at all to list, one line says so below it.
        const nothing = !visible.length && !groups.some((g) => g.errors.length);
        const parts = groups.map((group) => this.renderGroup(group, filtering, nothing));
        if (nothing) {
            parts.push(el("div", "bl-empty-state", filtering ? t("library.no_match")
                : t("library.empty_library")));
        }
        this.list.replaceChildren(...parts);
        this.restoreFocus(focus);
        this.keepFocus();
        this.editorChanged();
    }

    /** A group: its heading (collapse, count, the menu of a category) and its rows. */
    renderGroup(group, filtering, nothing) {
        const root = el("div", `bl-group ${group.kind}`);
        root.dataset.group = group.key;
        const collapsed = !filtering && this.collapsed.has(group.key); // a search shows every match
        const head = el("div", "bl-group-head");
        const toggle = button("", "bl-group-toggle", filtering ? "" : collapsed ? t("library.expand") : t("library.collapse"));
        toggle.disabled = filtering;
        toggle.setAttribute("aria-expanded", String(!collapsed));
        toggle.append(el("span", "bl-group-sign", filtering ? "" : collapsed ? "+" : "−"),
            el("span", "bl-group-name", groupLabel(group)),
            el("span", "bl-group-count", `(${group.bundles.length + group.errors.length})`));
        toggle.addEventListener("click", () => {
            if (this.collapsed.has(group.key)) this.collapsed.delete(group.key);
            else this.collapsed.add(group.key);
            remember(COLLAPSED_KEY, [...this.collapsed]);
            this.renderList();
        });
        head.append(toggle);
        if (group.kind === CATEGORY && !this.organizeBlocker) {
            const actions = menu("⋯", [
                [t("common.rename_menu"), () => void this.askRename(group.category)],
                [t("common.delete_menu"), () => void this.askDelete(group.category)],
            ], { className: "bl-btn icon bl-group-menu", title: t("library.category_menu_title", { name: group.name }),
                label: t("library.category_group", { name: group.name }) });
            actions.opener.disabled = !!this.lockReason;
            head.append(actions.root);
        }
        const rows = el("div", "bl-group-rows");
        rows.hidden = collapsed;
        rows.append(...group.errors.map((entry) => this.renderError(entry)),
            ...group.bundles.map((bundle) => this.renderItem(bundle, group.key)));
        if (!group.bundles.length && !group.errors.length && !nothing) {
            rows.append(el("div", "bl-group-empty", t(filtering ? EMPTY_WHILE_FILTERING : EMPTY_GROUP[group.kind] ?? "")));
        }
        root.append(head, rows);
        if (group.kind !== ATTENTION && !this.organizeBlocker) this.dropTarget(root, group);
        return root;
    }

    /**
     * Dropping a bundle on a category puts it there, on Uncategorized (or the
     * place under the list) takes it out, on Favorites stars it.
     */
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
            const ids = draggedIds(e.dataTransfer.getData(DRAG_TYPE));
            this.endDrag();
            if (!ids.length || !this.allowed()) return;
            const category = group.kind === CATEGORY ? group.category.id : null;
            if (ids.length > 1) { // a selection of several: one change for all, with its result in the pane
                const bundles = this.all.filter((b) => ids.includes(b.id));
                if (group.kind === FAVORITES) void this.runBatch("set_favorite", { favorite: true }, bundles);
                else void this.runBatch("set_category", { category }, bundles);
            } else if (group.kind === FAVORITES) {
                void this.setFavorite(ids[0], true);
            } else {
                void this.moveBundle(ids[0], category);
            }
        });
    }

    renderItem(bundle, groupKey) {
        const item = el("div", "bl-list-item");
        item.tabIndex = 0;
        item.dataset.id = bundle.id;
        item.classList.toggle("selected", this.selection.has(bundle.id)); // in every group it shows in
        const image = bundle.fields.find((f) => (f.type === "image" || f.type === "video") && f.preview);
        const thumb = el(image ? "img" : "div", "bl-list-thumb");
        if (image) {
            thumb.src = thumbnailURL(image.preview.sha256);
            thumb.alt = "";
            thumb.draggable = false; // the row is dragged, not the picture
        }
        const text = el("div", "bl-list-text");
        text.append(el("div", "bl-list-name", this.labels.get(bundle.id) ?? bundle.name),
            el("div", "bl-list-sub", bundle.tags.length ? bundle.tags.join(" · ") : t("library.fields_count", { count: bundle.fields.length })));
        const lacking = this.lacking(bundle);
        if (lacking.length) {
            const warn = el("div", "bl-list-warn");
            warn.title = t("library.row_lacking_title", { fields: lacking.join(", ") }); // the line may be cut short
            const [before, after] = around("library.row_lacking", "fields");
            warn.append(before, ...codeList(lacking), after);
            text.append(warn);
        }
        if (bundle.read_only) text.append(el("div", "bl-list-warn", t("common.locked")));
        else if (bundle.warnings) text.append(el("div", "bl-list-warn", t("library.fix_before_saving")));
        const star = button(bundle.favorite ? "★" : "☆", "bl-star",
            this.organizeBlocker ?? (bundle.favorite ? t("common.favorite_remove") : t("common.favorite_add")));
        star.classList.toggle("on", !!bundle.favorite);
        star.setAttribute("aria-pressed", String(!!bundle.favorite));
        star.disabled = !!this.organizeBlocker || !!this.lockReason;
        // Starring neither selects the row nor, with a double click, picks the bundle.
        star.addEventListener("click", (e) => {
            e.stopPropagation();
            if (this.allowed()) void this.toggleFavorite(bundle.id);
        });
        star.addEventListener("dblclick", (e) => e.stopPropagation());
        item.append(thumb, text, star);
        item.addEventListener("click", (e) => this.clickRow(e, groupKey, bundle.id));
        item.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && e.target === item) this.clickRow(e, groupKey, bundle.id);
        });
        if (this.onPick) {
            item.addEventListener("dblclick", async (e) => {
                if (e.ctrlKey || e.metaKey || e.shiftKey) return; // that was selecting, not picking
                await this.open(bundle.id);
                if (this.editor?.saved?.id === bundle.id) this.pick(); // not when opening it was cancelled
            });
        }
        if (!this.organizeBlocker) {
            item.draggable = !this.lockReason;
            item.addEventListener("dragstart", (e) => {
                if (this.lockReason) {
                    e.preventDefault();
                    return;
                }
                // A row of the selection carries all of it, as it is now; any other row, itself.
                const moving = this.selection.has(bundle.id) && this.selection.size > 1 ? this.selectedBundles() : [bundle];
                e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(moving.map((b) => b.id)));
                e.dataTransfer.effectAllowed = "copyMove";
                item.classList.add("dragging");
                this.startDrag(moving);
            });
            item.addEventListener("dragend", () => {
                item.classList.remove("dragging");
                this.endDrag();
            });
        }
        return item;
    }

    /** Bundle rows are being dragged: offer the place under the list if one can leave its category. */
    startDrag(bundles) {
        this.dragging = bundles.map((b) => b.id);
        this.dragStarted = performance.now();
        this.dropZone.hidden = !bundles.some((b) => b.category);
    }

    /** The drag is over (or the list it started in is gone): put the tools back. */
    endDrag() {
        if (!this.dragging) return;
        this.dragging = null;
        this.dropZone.hidden = true;
        this.dropZone.classList.remove("drop-target");
        for (const target of this.list.querySelectorAll(".drop-target")) target.classList.remove("drop-target");
        for (const row of this.list.querySelectorAll(".dragging")) row.classList.remove("dragging");
    }

    /** A file this version cannot use: why, and a way to delete it on purpose when it is a bundle file. */
    renderError(entry) {
        const row = el("div", "bl-error-item");
        row.dataset.file = entry.file;
        const text = el("div", "bl-list-text");
        text.append(el("div", "bl-list-name bl-bad", `⚠ ${entry.file}`), el("div", "bl-list-sub", said(entry, "error")));
        row.append(el("div", "bl-list-thumb"), text);
        if (entry.id) {
            const purge = button(t("common.delete_forever"), "bl-btn danger");
            purge.disabled = !!this.lockReason;
            purge.addEventListener("click", () => {
                if (this.allowed()) void this.purgeUnreadable(entry);
            });
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

    // -- selection -------------------------------------------------------------

    /** A click (or Enter) on a row: Ctrl/⌘ adds or takes it out, Shift selects from the anchor row. */
    clickRow(e, groupKey, id) {
        const several = e.ctrlKey || e.metaKey || e.shiftKey; // in the picker too: Use this bundle then waits for one
        if (!several) {
            this.anchor = { group: groupKey, id };
            void this.open(id);
            return;
        }
        if (!this.allowed()) return;
        let next;
        const anchor = this.anchorRow();
        if (e.shiftKey && anchor) {
            next = new Set([...(e.ctrlKey || e.metaKey ? this.selection : []), ...this.rangeTo(anchor, groupKey, id)]);
        } else {
            next = new Set(this.selection);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            this.anchor = { group: groupKey, id };
        }
        void this.select(next);
    }

    /** The bundle rows a range or Select all may take: those in groups that are not collapsed. */
    expandedRows() {
        return [...this.list.querySelectorAll(".bl-group-rows:not([hidden]) .bl-list-item")];
    }

    /** The anchor's row, if it is still shown (in its own group: the same bundle elsewhere is another row). */
    anchorRow() {
        if (!this.anchor) return null;
        return this.expandedRows().find((row) => row.dataset.id === this.anchor.id
            && row.closest(".bl-group")?.dataset.group === this.anchor.group) ?? null;
    }

    /** The ids from the anchor row to a row, in list order, each once. */
    rangeTo(anchor, groupKey, id) {
        const rows = this.expandedRows();
        const from = rows.indexOf(anchor);
        const to = rows.findIndex((row) => row.dataset.id === id && row.closest(".bl-group")?.dataset.group === groupKey);
        const [first, last] = from < to ? [from, to] : [to, from];
        return [...new Set(rows.slice(first, last + 1).map((row) => row.dataset.id))];
    }

    selectAll() {
        if (!this.allowed()) return;
        void this.select(new Set(this.expandedRows().map((row) => row.dataset.id)));
    }

    clearSelection() {
        this.selection = new Set();
        this.anchor = null;
        this.showPlaceholder();
        this.renderList();
    }

    /** The selected bundles, in list order. */
    selectedBundles() {
        const order = new Map(this.visible().map((b, i) => [b.id, i]));
        return this.all.filter((b) => this.selection.has(b.id))
            .sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
    }

    async select(ids) {
        this.selection = ids;
        await this.applySelection();
    }

    /** Show what the selection calls for: an editor for one bundle, the batch panel for more. */
    async applySelection() {
        const ids = [...this.selection];
        if (ids.length > 1) {
            this.showBatch();
            this.renderList();
        } else if (ids.length === 1) {
            await this.open(ids[0], { force: true });
        } else {
            this.clearSelection();
        }
    }

    showBatch() {
        const bundles = this.selectedBundles();
        if (this.batchPanel) {
            this.batchPanel.show(bundles);
            return;
        }
        const panel = new BatchPanel(this, bundles);
        this.showPane(panel.root, { batch: panel });
    }

    /**
     * The list, the search or the tag filter changed: take out of a selection
     * of several the bundles no longer shown, draw the list, and let the pane
     * follow. The batch panel shows the selection as it is now and keeps what
     * was chosen in it; a selection down to one bundle opens it, to none the
     * placeholder. A single selection stays (its editor stays open), and so
     * does a result on screen.
     */
    listChanged() {
        const several = this.selection.size > 1;
        if (several) this.pruneSelection(this.visible());
        this.renderList();
        if (!several || !this.batchPanel) return;
        if (this.selection.size > 1) this.batchPanel.show(this.selectedBundles());
        else void this.applySelection();
    }

    /** Take out of the selection the bundles not in `visible`, and say how many a search or filter hid. */
    pruneSelection(visible) {
        const shown = new Set(visible.map((b) => b.id));
        const gone = [...this.selection].filter((id) => !shown.has(id));
        for (const id of gone) this.selection.delete(id);
        const hidden = gone.filter((id) => this.all.some((b) => b.id === id)).length;
        if (hidden) {
            this.status(t("library.selection_hidden", { count: hidden }));
        }
    }

    // -- the lock ----------------------------------------------------------------

    /** Whether the editor holds something leaving would lose (a new draft nobody touched does not count). */
    get unsaved() {
        return !!this.editor && this.editor.changed && !this.editor.untouched;
    }

    /**
     * Why everything but the editor is locked now, or null: a command holding
     * the window (a save, duplicate or delete on its way, or a change to
     * several bundles), or a draft with changes (save or discard it first).
     * The editor's own star and category stay free.
     */
    get lockReason() {
        return this.commands.waiting ?? (this.unsaved ? t("library.save_or_discard_first") : null);
    }

    /**
     * Whether a command outside the editor may run now; if not, the status
     * line says why. Nothing behind a question runs while it is open (what is
     * behind it cannot be reached either: it is inert).
     */
    allowed() {
        if (this.layer) return false;
        const why = this.lockReason;
        if (why) this.status(why);
        return !why;
    }

    /** Enable or disable what the lock covers, when it changes. */
    refreshLock() {
        const why = this.lockReason;
        if (why === this.shownLock) return;
        this.shownLock = why;
        const locked = !!why;
        for (const control of [this.search, this.createButton, this.sortButton, this.tagButton, this.importButton,
            this.trashButton]) {
            control.disabled = locked;
        }
        this.importButton.title = why ?? t("library.import_title");
        this.newCategoryButton.disabled = locked || !!this.organizeBlocker;
        this.search.title = why ?? "";
        this.createButton.title = why ?? "";
        this.newCategoryButton.title = why ?? this.organizeBlocker ?? t("library.category_new");
        this.trashButton.title = why ?? this.trashButton.getAttribute("aria-label");
        this.showSort();
        this.showTagFilter();
        this.list.classList.toggle("locked", locked);
        for (const star of this.list.querySelectorAll(".bl-list-item .bl-star")) star.disabled = locked || !!this.organizeBlocker;
        for (const row of this.list.querySelectorAll(".bl-list-item")) row.draggable = !locked && !this.organizeBlocker;
        for (const control of this.list.querySelectorAll(".bl-group-menu, .bl-error-item button")) control.disabled = locked;
    }

    // -- changes to several bundles ------------------------------------------------

    /** What a batch is called in the pane, by its action and arguments. */
    describeBatch(action, args, count) {
        const n = t("count.bundles", { count });
        if (action === "set_category") {
            const name = this.categories.find((c) => c.id === args.category)?.name;
            return args.category
                ? { doing: t("library.moving", { bundles: n, category: name }),
                    done: t("library.moved_to", { category: name }), what: t("library.job_move") }
                : { doing: t("library.uncategorizing", { bundles: n }), done: t("library.uncategorized_done"),
                    what: t("library.job_change") };
        }
        if (action === "set_favorite") {
            return args.favorite
                ? { doing: t("library.favorite_adding", { bundles: n }), done: t("library.favorite_added"), what: t("library.job_change") }
                : { doing: t("library.favorite_removing", { bundles: n }), done: t("library.favorite_removed"),
                    what: t("library.job_change") };
        }
        if (action === "add_tags") {
            return { doing: t("library.tag_adding", { tag: args.tags[0], bundles: n }),
                done: t("library.tag_added", { tag: args.tags[0] }), what: t("library.job_change") };
        }
        if (action === "remove_tags") {
            return { doing: t("library.tag_removing", { tag: args.tags[0], bundles: n }),
                done: t("library.tag_removed", { tag: args.tags[0] }), what: t("library.job_change") };
        }
        return { doing: t("library.trash_moving", { bundles: n }), done: t("library.trash_moved"), what: t("library.job_trash") };
    }

    /**
     * One change to several bundles. What it changes (the ids, the arguments
     * and the revisions seen) is fixed before anything is awaited. It holds the
     * window until its answer is in and the list read again (or until Stop
     * waiting); its result then stays in the pane until the user leaves it,
     * even when the selection is gone by then.
     */
    async runBatch(action, args, bundles) {
        if (!bundles.length || !this.allowed()) return;
        const job = {
            token: ++this.batchJobs, action, args: { ...args },
            summaries: bundles.map((b) => ({ id: b.id, label: this.labels?.get(b.id) ?? b.name, revision: b.revision })),
        };
        job.describe = this.describeBatch(action, args, bundles.length);
        if (action === "trash") {
            job.args.expected_revisions = Object.fromEntries(job.summaries.map((b) => [b.id, b.revision]));
            const confirmed = await this.confirm(t("library.trash_confirm", { bundles: t("count.bundles", { count: bundles.length }) }),
                t("library.trash_detail"),
                t("library.move_to_trash"), { danger: true });
            if (!confirmed) return;
        }
        await this.commands.hold({
            kind: "batch", wait: t("library.wait_batch"), stallMs: STALL_MS,
            onStall: () => {
                if (this.result?.job === job) this.result.stalled();
            },
        }, async (ticket) => {
            job.ticket = ticket;
            const view = new BatchResult(this, job, { waiting: true });
            ticket.view = this.showPane(view.root, { result: view }); // the pane content this batch owns
            this.renderList();
            let outcome;
            try {
                outcome = { answer: await batchBundles(job.summaries.map((b) => b.id), action, job.args) };
            } catch (error) {
                // A refusal changed nothing. No answer, or a failure in the server, may have changed some.
                outcome = error.status >= 400 && error.status < 500 ? { refused: error } : { unknown: true };
            }
            if (action === "trash") void this.refreshTrashCount();
            await this.reload();
            // To its result while that is shown, also after Stop waiting: the user has not left it.
            if (this.commands.pane.shows(ticket.view)) view.render(outcome);
        });
    }

    /**
     * Export bundles as a ZIP (exchange.py on the server). As with a batch, what
     * goes is fixed first, the window is held until the answer (or Stop waiting),
     * and the result stays until the user leaves it; the download starts there.
     */
    async runExport(bundles) {
        if (!bundles.length || !this.allowed()) return;
        const job = {
            token: ++this.batchJobs, action: "export", args: {},
            summaries: bundles.map((b) => ({ id: b.id, label: this.labels?.get(b.id) ?? b.name, revision: b.revision })),
            describe: { doing: t("library.exporting", { bundles: t("count.bundles", { count: bundles.length }) }), done: t("common.exported"),
                what: t("library.job_export") },
        };
        await this.commands.hold({
            kind: "export", wait: t("library.wait_export"), stallMs: STALL_MS,
            onStall: () => {
                if (this.result?.job === job) this.result.stalled();
            },
        }, async (ticket) => {
            job.ticket = ticket;
            const view = new ExportResult(this, job, { waiting: true });
            ticket.view = this.showPane(view.root, { result: view });
            this.renderList();
            let outcome;
            try {
                outcome = { answer: await exportBundles(job.summaries.map((b) => b.id)) };
            } catch (error) {
                outcome = error.status >= 400 && error.status < 500 ? { refused: error } : { unknown: true };
            }
            if (this.commands.pane.shows(ticket.view)) view.render(outcome);
        });
    }

    /**
     * Upload an export ZIP and show what importing it would do; nothing in the
     * library changes until Import. The upload holds the window (its pane has
     * Cancel); a preview whose pane is gone meanwhile is dropped on the server.
     */
    async showImport(file) {
        if (!this.allowed()) return;
        this.selection = new Set();
        this.status(""); // what the status line said was about something else
        const panel = new ImportPanel(this, file);
        await this.commands.hold({ kind: "upload", wait: t("library.wait_upload") },
            async (ticket) => {
                ticket.view = this.showPane(panel.root, { imports: panel });
                this.renderList();
                let preview;
                try {
                    preview = await uploadImport(file, { onProgress: (sent) => panel.progress(sent), signal: panel.controller.signal });
                } catch (error) {
                    if (!this.commands.pane.shows(ticket.view)) return;
                    if (error.code === "aborted") {
                        this.showPlaceholder();
                        this.status(t("common.upload_cancelled_name", { name: file.name }));
                    } else {
                        panel.showError(error.message);
                    }
                    return;
                }
                if (this.closed || !this.commands.pane.shows(ticket.view)) {
                    discardImport(preview.token).catch(() => {});
                    return;
                }
                panel.showPreview(preview);
            });
    }

    /** Import what the panel shows, as it chose. Like a batch: the window is held, the result stays until left. */
    async runImport(panel) {
        if (!panel.preview || !this.allowed()) return;
        const { conflict, category } = panel.choices();
        const importable = panel.preview.bundles.filter((b) => b.importable).length;
        const job = {
            token: ++this.batchJobs, action: "import", args: {}, upload: panel.preview.token, conflict, category,
            summaries: panel.preview.bundles.map((b) => ({ id: b.id, label: b.name, revision: null })),
            describe: { doing: t("library.importing", { bundles: t("count.bundles", { count: importable }) }), done: t("library.imported"),
                what: t("library.job_import") },
        };
        await this.commands.hold({
            kind: "import", wait: t("library.wait_import"), stallMs: STALL_MS,
            onStall: () => {
                if (this.result?.job === job) this.result.stalled();
            },
        }, async (ticket) => {
            job.ticket = ticket;
            panel.sent = true; // its upload is the import's now: leaving the preview must not drop it
            this.status("");
            const view = new ImportResult(this, job, { waiting: true });
            ticket.view = this.showPane(view.root, { result: view });
            this.renderList();
            const outcome = await this.importOutcome(job);
            // Refused, nothing changed and the result cannot try again: the upload goes now, not in an hour.
            if (outcome.refused && outcome.refused.code !== "import_running") discardImport(job.upload).catch(() => {});
            void this.refreshTrashCount();
            await this.reload();
            if (this.commands.pane.shows(ticket.view)) view.render(outcome);
        });
    }

    /** Send an import, or send it again: the server runs it once and then answers with what it did (R22-02). */
    async importOutcome(job) {
        try {
            return { answer: await applyImport(job.upload, job.conflict, job.category) };
        } catch (error) {
            return error.status >= 400 && error.status < 500 ? { refused: error } : { unknown: true };
        }
    }

    /** No answer came for an import (or it was still running): ask again, in its result. */
    async checkImport(job) {
        const view = this.result;
        if (view?.job !== job || !this.allowed()) return;
        job.checked = true;
        job.describe.doing = t("library.import_asking");
        await this.commands.hold({
            kind: "import", wait: t("library.wait_import_answer"), stallMs: STALL_MS,
            onStall: () => {
                if (this.result === view) view.stalled();
            },
        }, async (ticket) => {
            job.ticket = ticket;
            view.renderWaiting();
            this.renderList();
            const outcome = await this.importOutcome(job);
            void this.refreshTrashCount();
            await this.reload();
            if (this.commands.pane.shows(ticket.view)) view.render(outcome);
        });
    }

    /** Leave a preview without importing (the upload is dropped as it leaves the pane). */
    cancelImport() {
        this.showPlaceholder();
        this.renderList();
        this.status(t("library.nothing_imported"));
    }

    /**
     * A preview leaving the pane or the window without its import: the server
     * drops the upload now rather than after an hour. Not answered: an upload
     * it cannot drop now goes with the others an hour on.
     */
    dropImport() {
        const panel = this.importPanel;
        if (panel?.preview && !panel.sent) discardImport(panel.preview.token).catch(() => {});
    }

    /** Give up waiting for a batch's answer: unlock, and say it is not known what happened. */
    stopWaiting(job) {
        if (!job.ticket || !this.commands.stop(job.ticket)) return;
        this.renderList();
        if (this.result?.job === job) this.result.render({ unknown: true });
    }

    /** Run a batch again for some of its bundles, as they are in the list now. */
    async retryBatch(job, ids) {
        const bundles = this.all.filter((b) => ids.includes(b.id));
        if (!bundles.length) {
            this.status(t("library.none_listed"));
            return;
        }
        const { expected_revisions: _seen, ...args } = job.args;
        await this.runBatch(job.action, args, bundles);
    }

    /** Leave a result: back to what the selection calls for. */
    leaveResult() {
        void this.applySelection();
    }

    // -- categories and favorites ----------------------------------------------

    /** Why categories and favorites cannot be changed now, or null. */
    get organizeBlocker() {
        const { state } = this.organization;
        return state === "ok" || state === "missing" ? null
            : t("library.organization_locked");
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
            this.status(category ? t("library.moved_named", { name: summary.name, category: name })
                : t("library.uncategorized_named", { name: summary.name }));
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
        await this.ask(t("library.category_new"), t("library.category_hint"), {
            placeholder: t("library.category_name"), action: t("library.create"),
            submit: async (name) => {
                made = await this.organize(() => createCategory(name));
            },
        });
        if (!made) return null;
        if (!this.categories.some((c) => c.id === made.id)) { // when the list is read again later
            this.categories = [...this.categories, { ...made, count: 0 }]
                .sort((a, b) => compareText(a.name, b.name) || compareText(a.id, b.id));
            this.renderList();
            this.editor?.organizationChanged();
        }
        this.status(t("library.category_created", { name: made.name }));
        return made;
    }

    async askRename(category) {
        if (!this.allowed()) return;
        let renamed = null;
        await this.ask(t("library.category_rename_title", { name: category.name }), null, {
            value: category.name, action: t("common.rename"),
            submit: async (name) => {
                renamed = await this.organize(() => renameCategory(category.id, name));
            },
        });
        if (renamed) this.status(t("library.category_renamed", { name: renamed.name }));
    }

    async askDelete(category) {
        if (!this.allowed()) return;
        const count = this.all.filter((b) => b.category === category.id).length;
        const confirmed = await this.confirm(t("library.category_delete_confirm", { name: category.name }),
            count ? t("library.category_delete_detail", { count })
                : t("library.category_empty"),
            t("library.category_delete"), { danger: true });
        if (!confirmed) return;
        try {
            await this.organize(() => deleteCategory(category.id));
            this.collapsed.delete(`${CATEGORY}:${category.id}`);
            remember(COLLAPSED_KEY, [...this.collapsed]);
            this.status(t("library.category_deleted", { name: category.name }));
        } catch (error) {
            this.status(error.message, "error");
        }
    }

    /** Delete a file this version cannot fully read, once the user confirms. */
    async purgeUnreadable(entry) {
        const confirmed = await this.confirm(t("library.attention_delete_confirm", { file: entry.file }), [
            t("library.not_fully_read", { reason: said(entry, "error") }),
            t("library.attention_delete_detail"),
        ], t("common.delete_forever"), { danger: true });
        if (!confirmed) return;
        try {
            await purgeBundle(entry.id, { unreadable: true });
            this.status(t("library.attention_deleted", { file: entry.file }));
        } catch (error) {
            this.status(error.message, "error");
        }
        void this.refreshTrashCount();
        await this.reload();
    }

    // -- editor ----------------------------------------------------------------

    /**
     * Whether the pane may change: not while the editor holds changes (they
     * are saved or discarded first), a save is out, or a batch runs. A new
     * draft nobody touched goes without asking.
     */
    async leaveEditor() {
        return this.allowed();
    }

    async open(id, { force = false } = {}) {
        if (this.editor?.saved?.id === id) { // open already: just make it the selection
            if (this.selection.size !== 1 || !this.selection.has(id)) {
                this.selection = new Set([id]);
                this.renderList();
            }
            return;
        }
        if (!force && !(await this.leaveEditor())) return;
        this.selection = new Set([id]);
        const view = this.showPane(el("div", "bl-empty-state bl-loading", t("common.loading")));
        this.renderList();
        let bundle;
        try {
            bundle = await getBundle(id);
        } catch (error) {
            if (!this.commands.pane.shows(view)) return;
            this.selection = new Set();
            this.showPlaceholder();
            this.renderList();
            this.status(error.message, "error");
            return;
        }
        if (!this.commands.pane.shows(view)) return; // another bundle or a new draft was opened meanwhile
        this.show(new BundleEditor(this, bundle));
        this.renderList();
    }

    async newBundle() {
        if (!(await this.leaveEditor())) return;
        const taken = new Set(this.all.map((b) => b.name.toLowerCase()));
        let name = t("common.new_bundle");
        for (let n = 2; taken.has(name.toLowerCase()); n++) name = t("library.new_bundle_numbered", { n });
        this.selection = new Set();
        this.show(new BundleEditor(this, null, name));
        this.renderList();
        this.editor.nameInput.focus();
        this.editor.nameInput.select();
    }

    show(editor) {
        this.showPane(editor.root, { editor });
    }

    /** The tags of the whole library, with ways to rename and delete them, in the pane. */
    async showTags() {
        if (this.tagsPanel) {
            void this.tagsPanel.refresh();
            return;
        }
        if (!(await this.leaveEditor())) return;
        this.selection = new Set();
        const panel = new TagsPanel(this);
        this.showPane(panel.root, { tags: panel });
        this.renderList();
    }

    /**
     * Rename or delete a tag in every bundle (`request` sends it; `from` is the
     * tag, `to` its new name). It holds the window until the server is done and
     * the list is read again. A tag filter on `from` follows it to `to`.
     */
    async changeTags(request, { from, to = null }) {
        await this.commands.hold({ kind: "tags", wait: t("library.wait_tag") }, async () => {
            let result;
            try {
                result = await request();
            } catch (error) {
                this.status(error.message, "error");
                return;
            }
            if (this.tag && sameTag(this.tag, from)) {
                this.tag = to ?? "";
                this.showTagFilter();
            }
            await this.reload();
            await this.tagsPanel?.refresh();
            const bundles = t("count.bundles", { count: result.changed });
            const kept = result.excluded.length ? t("library.tag_kept", { tag: from,
                bundles: t("count.bundles", { count: result.excluded.length }),
                reasons: result.excluded.map((e) => said(e, "reason")).join("; ") }) : null;
            const unknown = result.unknown.length ? t("library.unknown_files_left_out", { count: result.unknown.length }) : null;
            const done = !to ? t("library.tag_deleted", { tag: from, bundles })
                : result.merged ? t("library.tag_renamed_merged", { tag: from, to, bundles, count: result.merged })
                    : t("library.tag_renamed", { tag: from, to, bundles });
            this.status([done, kept, unknown, said(result, "warning")].filter(Boolean).join(" "), kept || result.warning ? "error" : "info");
        });
    }

    async showTrash() {
        if (this.trashPanel) {
            void this.trashPanel.refresh(); // the button reads the trash again
            return;
        }
        if (!(await this.leaveEditor())) return;
        this.selection = new Set();
        const panel = new TrashPanel(this);
        this.showPane(panel.root, { trash: panel });
        this.renderList();
    }

    /** The trash button says how many bundles are in the trash. */
    trashCounted(count) {
        this.trashGeneration++; // a count still on its way is older
        this.trashCount.textContent = count ? String(count) : "";
        this.trashCount.hidden = !count;
        this.trashButton.setAttribute("aria-label", count ? t("library.trash_count", { count }) : t("common.trash"));
        this.trashButton.title = this.lockReason ?? this.trashButton.getAttribute("aria-label");
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

    /** The pane with nothing in it but how to fill it; returns its view number. */
    showPlaceholder() {
        return this.showPane(el("div", "bl-empty-state", t("library.select_hint")));
    }

    /**
     * Put `content` in the pane, dropping the editor shown before; returns its
     * view number (what was shown before no longer owns the pane). Name what
     * it is: an editor, the trash, the batch panel or a batch's result.
     */
    showPane(content, { editor = null, trash = null, batch = null, result = null, tags = null, imports = null } = {}) {
        if (this.editor !== editor) this.editor?.dispose();
        if (this.importPanel !== imports) this.dropImport();
        this.editor = editor;
        this.trashPanel = trash;
        this.tagsPanel = tags;
        this.importPanel = imports;
        this.batchPanel = batch;
        this.result = result;
        this.trashButton.classList.toggle("selected", !!trash);
        this.pane.replaceChildren(content);
        this.pane.scrollTop = 0;
        const view = this.commands.pane.show();
        this.keepFocus();
        this.editorChanged();
        return view;
    }

    // Called by the editor.
    async bundleSaved(bundle, { open = false, reveal = false } = {}) {
        this.selection = new Set([bundle.id]);
        await this.reload();
        if (open) await this.open(bundle.id, { force: true });
        if (reveal && this.selection.has(bundle.id) && this.selection.size === 1) this.revealRow(bundle.id);
    }

    /**
     * Bring the row of the bundle `id` into the list's view when it is out of
     * it, in the middle: the first row that shows it (a starred bundle is in
     * Favorites and its category). When none shows, its category (or
     * Uncategorized) was collapsed: it is expanded, and stays so, as if the
     * user had opened it. For a bundle the window selects by itself: the one
     * it opens at, a new bundle's first save, a duplicate.
     */
    revealRow(id) {
        const shown = () => [...this.list.querySelectorAll(`.bl-list-item[data-id="${CSS.escape(id)}"]`)]
            .find((row) => !row.closest("[hidden]"));
        let row = shown();
        if (!row) {
            if (this.matches || this.tag) return; // filtered out, not collapsed: groups do not collapse then
            const category = this.summary(id)?.category;
            const key = category && this.categories.some((c) => c.id === category) ? `${CATEGORY}:${category}` : UNCATEGORIZED;
            if (!this.collapsed.delete(key)) return; // not in the list as it is filtered
            remember(COLLAPSED_KEY, [...this.collapsed]);
            this.renderList();
            row = shown();
            if (!row) return;
        }
        const list = this.list.getBoundingClientRect();
        const box = row.getBoundingClientRect();
        if (box.top >= list.top && box.bottom <= list.bottom) return; // in view already
        this.list.scrollTop += box.top - list.top - (list.height - box.height) / 2;
    }

    /** The bundle went to the trash: read the list again, then show both (the pane and the list change together). */
    async bundleDeleted(bundle, answer = {}) {
        void this.refreshTrashCount();
        await this.reload();
        this.selection = new Set();
        this.showPlaceholder();
        this.renderList();
        if (answer.warning) this.status(t("library.trashed_warning", { name: bundle.name, warning: said(answer, "warning") }), "error");
        else this.status(t("library.trashed", { name: bundle.name }));
    }

    /**
     * When the list shows the open bundle saved again since the editor read it
     * (in another tab, say) and the editor holds no changes, show the saved
     * version (N23). An editor with changes keeps them: saving them meets the
     * newer revision and asks what to do.
     */
    async refreshEditor() {
        const editor = this.editor;
        const summary = editor?.saved && this.summary(editor.saved.id);
        const idle = () => !editor.changed && !editor.busy && !this.commands.running && !this.layer;
        if (!summary || summary.revision <= editor.saved.revision || !idle()) return;
        const generation = ++this.refreshGeneration;
        const view = this.commands.pane.shown;
        let bundle;
        try {
            bundle = await getBundle(editor.saved.id);
        } catch {
            return; // the list will say what became of it
        }
        // Only the last read, for the editor still shown, and never back to an older revision (R19-02).
        if (generation !== this.refreshGeneration || !this.commands.pane.shows(view) || this.editor !== editor || !idle()
            || bundle.revision <= editor.saved.revision) return;
        editor.showSaved(bundle);
        this.status(t("library.saved_elsewhere", { name: bundle.name }));
    }

    discardDraft() {
        this.showPlaceholder();
        this.renderList();
        this.status(t("library.new_discarded"));
    }

    /**
     * What "Use this bundle" would hand to the node now, or null: the summary
     * of the bundle the editor shows, as saved, once nothing is on its way (a
     * save holds the window until the list is read again).
     */
    pickable() {
        if (!this.editor?.saved || this.unsaved || this.commands.running || this.layer) return null;
        return this.editor.model.summary();
    }

    editorChanged() {
        this.refreshLock();
        if (!this.onPick) return;
        const summary = this.pickable();
        const lacking = summary ? this.lacking(summary) : [];
        this.pickButton.disabled = !summary;
        this.pickHint.replaceChildren(...(!this.editor
            ? [this.selection.size > 1 ? t("library.use_one_only") : t("common.select_bundle")]
            : this.commands.running ? [this.commands.waiting]
            : !summary ? [t("library.save_or_revert_first")]
                : lacking.length === 1 ? spread(around("library.node_output_missing", "name"), [code(lacking[0])])
                    : lacking.length ? spread(around("library.node_outputs_missing", "names"), codeList(lacking))
                        : []));
    }

    pick() {
        const summary = this.pickable();
        if (!summary) {
            if (this.lockReason) this.status(this.lockReason);
            return;
        }
        this.onPick(summary);
        this.close();
    }

    /** Close, unless something is on its way; with unsaved changes, ask: Save, Discard or Keep editing. */
    async requestClose() {
        if (this.layer) return;
        if (this.commands.running) {
            this.status(this.lockReason);
            return;
        }
        if (!this.unsaved) {
            this.close();
            return;
        }
        const editor = this.editor;
        const choices = [[t("common.discard"), "discard", "danger"], [t("library.keep_editing"), null]];
        if (!editor.blocker) choices.unshift([t("common.save"), "save", "primary"]); // what cannot be saved can still be dropped
        const choice = await this.choose(t("library.save_changes_confirm"),
            [t("library.unsaved_named", { name: editor.draft.name || t("library.this_bundle") }),
                ...(editor.blocker ? [t("library.cannot_save", { reason: editor.blocker })] : [])], choices);
        if (choice === "discard") {
            this.close();
        } else if (choice === "save") {
            // Closes only when it was saved as it is: a failure, a conflict or a
            // category it could not be put in stays on screen.
            if (await editor.save() && this.editor === editor && !this.unsaved) this.close();
        }
    }

    close() {
        this.closed = true; // answers still on their way change nothing now
        this.commands.end(); // nor do they own the pane or a question: no late result, no late download (R22-06)
        this.editor?.dispose();
        this.dropImport();
        this.endDrag();
        window.removeEventListener("pointermove", this.onPointerMove, true);
        this.overlay.remove();
        for (const type of STRAY_EVENTS) window.removeEventListener(type, this.onStrayEvent, true);
        window.removeEventListener("focusin", this.onStrayFocus, true);
        window.removeEventListener("beforeunload", this.onBeforeUnload);
        document.removeEventListener("visibilitychange", this.onVisible);
        current = null;
    }

    status(message, kind = "info") {
        this.statusLine.textContent = message;
        this.statusLine.classList.toggle("error", kind === "error");
        clearTimeout(this.statusTimer);
        if (kind !== "error") this.statusTimer = setTimeout(() => { this.statusLine.textContent = ""; }, 6000);
    }

    // -- layers: questions and the image viewer ---------------------------------

    /**
     * Show `content` over the window; returns its token. One at a time: one
     * still open is dismissed first. While it is open, the rest of the window
     * is inert (neither the pointer, nor Tab, nor a shortcut reaches it), and
     * when it closes the focus goes back where it was.
     */
    showLayer(content, dismiss) {
        this.layer?.dismiss();
        const element = el("div", "bl-layer");
        element.append(content);
        element.addEventListener("pointerdown", (e) => {
            if (e.target === element) dismiss();
        });
        const behind = [...this.dialog.children];
        for (const part of behind) part.inert = true;
        const returnFocus = document.activeElement;
        this.dialog.append(element);
        const token = this.commands.question.show();
        this.layer = { token, element, dismiss, behind, returnFocus };
        return token;
    }

    /** Close the layer `token` names, if it is still the one shown; whether it was. */
    hideLayer(token) {
        if (!this.layer || !this.commands.question.hide(token)) return false;
        const { element, behind, returnFocus } = this.layer;
        this.layer = null;
        element.remove();
        for (const part of behind) part.inert = false;
        if (returnFocus?.isConnected && this.overlay.contains(returnFocus)) returnFocus.focus({ preventScroll: true });
        else this.keepFocus();
        this.editorChanged(); // "Use this bundle" waits while a question is open
        return true;
    }

    /**
     * Resolves to the value of the chosen button; dismissing picks the last one.
     * `message` is a paragraph or a list of them; `extra`, an element to show
     * below, or a function that makes it from the buttons (to change them as
     * the user chooses in it).
     */
    choose(title, message, choices, extra = null) {
        return new Promise((resolve) => {
            const box = el("div", "bl-confirm");
            const row = el("div", "bl-confirm-buttons");
            let token = null;
            const finish = (value) => {
                this.hideLayer(token); // its own question only
                resolve(value);
            };
            for (const [label, value, style] of choices) {
                const choice = button(label, `bl-btn ${style ?? ""}`.trim());
                choice.addEventListener("click", () => finish(value));
                row.append(choice);
            }
            const below = typeof extra === "function" ? extra([...row.children]) : extra;
            if (below) box.classList.add("wide");
            box.append(el("div", "bl-confirm-title", title),
                ...[message].flat().map((text) => el("div", "bl-confirm-text", text)), ...(below ? [below] : []), row);
            token = this.showLayer(box, () => finish(choices.at(-1)[1]));
            row.lastChild.focus(); // the safe choice
        });
    }

    /**
     * Ask for a line of text. `submit(value)` does the work: when it throws, its
     * message shows under the input and the question stays. Resolves to true
     * once submitted, false when cancelled. Cancel works while `submit` is out
     * too: what it then finishes no longer touches this question, nor the one
     * shown by then.
     */
    ask(title, message, { value = "", placeholder = "", maxLength = 60, action = t("library.ok"), submit }) {
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
            const cancel = button(t("common.cancel"));
            let busy = false;
            let token = null;
            const finish = (done) => {
                this.hideLayer(token);
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
                    if (!this.commands.question.shows(token)) return; // cancelled meanwhile
                    problem.textContent = error.message;
                    problem.hidden = false;
                    busy = ok.disabled = false;
                    input.focus();
                }
            });
            row.append(ok, cancel);
            box.append(el("div", "bl-confirm-title", title), ...(message ? [el("div", "bl-confirm-text", message)] : []),
                input, problem, row);
            token = this.showLayer(box, () => {
                if (!busy) finish(false);
            });
            input.focus();
            input.select();
        });
    }

    async confirm(title, message, label, { danger = false } = {}) {
        return (await this.choose(title, message, [[label, true, danger ? "danger" : "primary"], [t("common.cancel"), false]])) === true;
    }

    viewImage(url, caption) {
        const box = el("div", "bl-viewer");
        const img = el("img");
        img.src = url;
        img.alt = caption;
        box.append(img, el("div", "bl-viewer-caption", caption));
        const token = this.showLayer(box, () => this.hideLayer(token));
        box.addEventListener("click", () => this.hideLayer(token));
    }
}

// The sidebar tab and its list while it is shown.
let sidebarTab = null;
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
        list.replaceChildren(...(!bundles.length ? [el("div", "bl-empty-state", t("library.empty_group"))]
            : groups ? groups.flatMap((group) => [el("div", "bl-sidebar-group", groupLabel(group)), ...group.bundles.map(item)])
                : bundles.map(item)));
    }, (error) => {
        if (generation === sidebarGeneration) list.replaceChildren(el("div", "bl-bad", `⚠ ${error.message}`));
    });
}

window.addEventListener(CHANGED_EVENT, () => {
    if (sidebarList?.isConnected) fillSidebar(sidebarList);
});
// Catalogs that came late (0.0.32): the tab drawn again in their language. The library window
// shows them when it opens next (an editor there may hold changes not saved).
onCatalogs(() => {
    if (sidebarList?.isConnected) renderSidebar(sidebarTab);
});

/** The sidebar tab: the bundle names by category, each opening the library at that bundle. */
export function renderSidebar(container) {
    sidebarTab = container;
    const root = el("div", "bl-sidebar");
    const open = button(t("library.open"), "bl-btn primary");
    open.addEventListener("click", () => openLibrary());
    sidebarList = el("div", "bl-sidebar-list");
    root.append(open, sidebarList);
    container.replaceChildren(root);
    fillSidebar(sidebarList, true);
}
