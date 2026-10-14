// The library modal: the bundle list on the left, the editor on the right.
// It is a document.body overlay of its own: ComfyUI's dialogs need Vue
// components, and they would open underneath it.
import { CHANGED_EVENT, getBundle, listBundles, listTrash, searchBundleIds, thumbnailURL } from "./api.js";
import { BundleEditor } from "./bundle_editor.js";
import { button, el } from "./dom.js";
import { slotStatuses } from "./reconcile.js";
import { TrashPanel } from "./trash_panel.js";

let current = null;

// Caught on window while the modal is open; see build().
const STRAY_EVENTS = ["keydown", "keyup", "keypress", "paste", "copy", "cut"];

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
        this.trashButton = button("🗑 Trash", "bl-btn bl-trash-button");
        this.trashButton.addEventListener("click", () => void this.showTrash());
        side.append(this.list, this.trashButton);
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
        let all = [];
        try {
            all = await listBundles({ fresh: true });
        } catch (error) {
            if (generation === this.listGeneration) this.status(error.message, "error");
        }
        if (generation !== this.listGeneration) return; // a newer reload answers instead
        this.all = all;
        this.renderTags();
        if (this.search.value.trim()) await this.applySearch();
        else this.renderList();
        if (selectId && this.all.some((b) => b.id === selectId)) await this.open(selectId, { force: true });
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
        items = [...items].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
        if (this.sort.value === "updated") items.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
        return items;
    }

    lacking(bundle) {
        return this.linked.filter((s) => slotStatuses([s], bundle.fields)[0] !== "ok").map((s) => s.name);
    }

    renderList() {
        const items = this.visible();
        const focused = this.list.contains(document.activeElement) ? document.activeElement.dataset.id : null;
        if (!this.all.length) {
            this.list.replaceChildren(el("div", "bl-empty-state", "No bundles yet. Create one with + New bundle."));
        } else if (!items.length) {
            this.list.replaceChildren(el("div", "bl-empty-state", "No bundles match."));
        } else {
            this.list.replaceChildren(...items.map((bundle) => this.renderItem(bundle)));
        }
        if (focused) [...this.list.children].find((item) => item.dataset.id === focused)?.focus({ preventScroll: true });
        this.keepFocus();
        this.editorChanged();
    }

    renderItem(bundle) {
        const item = el("div", "bl-list-item");
        item.tabIndex = 0;
        item.dataset.id = bundle.id;
        item.classList.toggle("selected", bundle.id === this.selectedId);
        const image = bundle.fields.find((f) => (f.type === "image" || f.type === "video") && f.preview);
        const thumb = el(image ? "img" : "div", "bl-list-thumb");
        if (image) {
            thumb.src = thumbnailURL(image.preview.sha256);
            thumb.alt = "";
        }
        const text = el("div", "bl-list-text");
        text.append(el("div", "bl-list-name", bundle.name),
            el("div", "bl-list-sub", bundle.tags.length ? bundle.tags.join(" · ") : `${bundle.fields.length} field(s)`));
        const lacking = this.lacking(bundle);
        if (lacking.length) text.append(el("div", "bl-list-warn", `⚠ no ${lacking.join(", ")}`));
        item.append(thumb, text);
        item.addEventListener("click", () => void this.open(bundle.id));
        item.addEventListener("keydown", (e) => {
            if (e.key === "Enter") void this.open(bundle.id);
        });
        if (this.onPick) {
            item.addEventListener("dblclick", async () => {
                await this.open(bundle.id);
                if (this.editor?.saved?.id === bundle.id) this.pick(); // not when opening it was cancelled
            });
        }
        return item;
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
        let count;
        try {
            const { trash, errors } = await listTrash();
            count = trash.length + errors.length;
        } catch {
            return; // the count is only a hint
        }
        if (generation === this.trashGeneration) this.trashCounted(count);
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
    listBundles({ fresh }).then((bundles) => {
        if (generation !== sidebarGeneration) return; // a newer list is on its way
        list.replaceChildren(...(bundles.length ? bundles.map((bundle) => {
            const item = button(bundle.name, "bl-sidebar-item");
            item.addEventListener("click", () => openLibrary({ selected: bundle.id }));
            return item;
        }) : [el("div", "bl-empty-state", "No bundles yet.")]));
    }, (error) => {
        if (generation === sidebarGeneration) list.replaceChildren(el("div", "bl-bad", `⚠ ${error.message}`));
    });
}

window.addEventListener(CHANGED_EVENT, () => {
    if (sidebarList?.isConnected) fillSidebar(sidebarList);
});

/** The sidebar tab: the bundle names, each opening the library at that bundle. */
export function renderSidebar(container) {
    const root = el("div", "bl-sidebar");
    const open = button("Open library", "bl-btn primary");
    open.addEventListener("click", () => openLibrary());
    sidebarList = el("div", "bl-sidebar-list");
    root.append(open, sidebarList);
    container.replaceChildren(root);
    fillSidebar(sidebarList, true);
}
