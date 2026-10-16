// The trash and the cleanup of unused files, shown in the library modal's
// right pane in place of the editor. Files this version cannot read are not
// here: the list shows them under Needs attention.
import {
    deleteUnusedFiles, emptyTrash, listTrash, listUnusedFiles, purgeBundle, restoreBundle, thumbnailURL,
} from "./api.js";
import { button, el, formatBytes, formatTime, plural } from "./dom.js";
import { displayNames } from "./names.js";

export class TrashPanel {
    constructor(modal) {
        this.modal = modal;
        this.root = el("div", "bl-trash");
        this.root.append(el("div", "bl-empty-state", "Loading…"));
        this.generation = 0;
        void this.refresh();
    }

    /** Read the trash and show it; the answer to an older read is dropped. */
    async refresh() {
        const generation = ++this.generation;
        let listing;
        try {
            listing = await listTrash();
        } catch (error) {
            if (generation === this.generation) this.modal.status(error.message, "error");
            return;
        }
        if (generation !== this.generation) return;
        this.render(listing);
        this.modal.trashCounted(listing.trash.length);
    }

    render({ trash }) {
        const head = el("div", "bl-trash-head");
        const cleanup = button("Clean up unused files…");
        cleanup.addEventListener("click", () => void this.cleanup());
        const empty = button("Empty trash", "bl-btn danger");
        const deletable = trash.filter((entry) => !entry.read_only); // emptying leaves the others alone
        empty.disabled = deletable.length === 0;
        if (trash.length && !deletable.length) empty.title = "This version cannot change the bundles in the trash.";
        empty.addEventListener("click", () => void this.empty(deletable, trash.length - deletable.length));
        head.append(el("div", "bl-trash-title", "Trash"), cleanup, empty);
        const hint = el("div", "bl-hint", "Deleted bundles stay here until you delete them for good. "
            + "The files they use are kept, so a restored bundle is whole.");
        const list = el("div", "bl-trash-list");
        if (!trash.length) list.append(el("div", "bl-empty-state", "The trash is empty."));
        const labels = displayNames(trash);
        list.append(...trash.map((entry) => this.renderEntry(entry, labels.get(entry.id))));
        this.root.replaceChildren(head, hint, list);
        this.modal.keepFocus(); // the focused button may have been replaced
    }

    renderEntry(entry, label) {
        const row = el("div", "bl-trash-item");
        row.dataset.id = entry.id;
        const media = entry.fields.find((f) => (f.type === "image" || f.type === "video") && f.preview);
        const thumb = el(media ? "img" : "div", "bl-list-thumb");
        if (media) {
            thumb.src = thumbnailURL(media.preview.sha256);
            thumb.alt = "";
        }
        // Restoring puts it back in its category, with its star.
        const category = this.modal.categories.find((c) => c.id === entry.category)?.name;
        const text = el("div", "bl-list-text");
        text.append(el("div", "bl-list-name", label ?? entry.name),
            el("div", "bl-list-sub", [`Deleted ${formatTime(entry.deleted_at)}`, plural(entry.fields.length, "field"),
                category ? `back to ${category}` : null, entry.favorite ? "★" : null].filter(Boolean).join(" · ")));
        // A bundle this version cannot change (it holds data from a newer one)
        // cannot be restored by it; deleting it for good is asked for as such.
        if (entry.read_only) text.append(el("div", "bl-list-warn", "🔒 Cannot be changed by this version"));
        const restore = button("Restore");
        restore.disabled = !!entry.read_only;
        if (entry.read_only) restore.title = "This version of Bundle Library cannot change this bundle. Update the node pack to restore it.";
        restore.addEventListener("click", () => void this.restore(entry));
        const purge = button("Delete forever", "bl-btn danger");
        purge.addEventListener("click", () => void this.purge(entry, `'${label ?? entry.name}'`));
        row.append(thumb, text, restore, purge);
        return row;
    }

    async restore(entry) {
        try {
            const bundle = await restoreBundle(entry.id);
            this.modal.status(`Restored '${bundle.name}'.`);
            await this.modal.reload();
        } catch (error) {
            this.modal.status(error.message, "error");
        }
        await this.refresh();
    }

    /**
     * Delete one bundle for good, as it was shown (the server keeps it if it
     * changed since). One this version cannot change is deleted only when the
     * user confirms that as well.
     */
    async purge(entry, what) {
        const confirmed = await this.modal.confirm(`Delete ${what} for good?`, [
            ...(entry.read_only ? [`This version of Bundle Library cannot fully use it: it ${entry.read_only}. `
                + "If a newer Bundle Library saved it, that version loses it too."] : []),
            "It cannot be restored afterwards. The files it used stay in the library until you clean up unused files.",
        ], "Delete forever", { danger: true });
        if (!confirmed) return;
        try {
            await purgeBundle(entry.id, { revision: entry.revision, unreadable: !!entry.read_only });
            this.modal.status(`Deleted ${what} for good.`);
        } catch (error) {
            this.modal.status(error.message, "error");
        }
        await this.refresh();
    }

    /**
     * Delete for good the bundles shown (`trash`: those this version can
     * change; `locked` more stay); any put in the trash or changed since stay.
     */
    async empty(trash, locked = 0) {
        const count = trash.length;
        const confirmed = await this.modal.confirm("Empty the trash?",
            `${plural(count, "deleted bundle")} will be gone for good. `
            + "The files they used stay in the library until you clean up unused files. "
            + (locked ? `${plural(locked, "bundle")} this version cannot change ${locked === 1 ? "stays" : "stay"}, `
                + "and files it cannot read are not touched." : "Files this version cannot read are not touched."),
            "Empty trash", { danger: true });
        if (!confirmed) return;
        try {
            const { deleted, results } = await emptyTrash(Object.fromEntries(trash.map((e) => [e.id, e.revision])));
            const unchangeable = results.filter((r) => r.code === "unreadable_file").length;
            const left = results.length - deleted - unchangeable;
            this.modal.status(`Emptied the trash: ${plural(deleted, "bundle")} deleted for good.`
                + (left ? ` ${plural(left, "bundle")} changed or restored meanwhile ${left === 1 ? "was" : "were"} kept.` : "")
                + (unchangeable ? ` ${plural(unchangeable, "bundle")} this version cannot change ${unchangeable === 1 ? "was" : "were"} kept.` : ""));
        } catch (error) {
            this.modal.status(error.message, "error");
        }
        await this.refresh();
    }

    /** List the files nothing uses with their size, and delete them once confirmed. */
    async cleanup() {
        let unused;
        try {
            unused = await listUnusedFiles();
        } catch (error) {
            this.modal.status(error.message, "error");
            return;
        }
        const { assets, bytes, recent, grace_hours: hours } = unused;
        const notes = [assets.length
            ? `${plural(assets.length, "file")} (${formatBytes(bytes)}) ${assets.length === 1 ? "is" : "are"} used by no bundle, `
                + "in the library or in the trash. Deleting cannot be undone: back up the library folder first "
                + "if you may want them."
            : "There is nothing to clean up: every file is used by a bundle or by a bundle in the trash."];
        if (recent) {
            notes.push(`${plural(recent, "unused file")} stored in the last ${hours} hours ${recent === 1 ? "is" : "are"} `
                + "kept: changes that are not saved yet may use them.");
        }
        const choices = assets.length ? [[`Delete ${plural(assets.length, "file")}`, true, "danger"], ["Cancel", false]]
            : [["Close", false]];
        const confirmed = await this.modal.choose("Clean up unused files", notes, choices,
            assets.length ? this.renderFiles(assets) : null);
        if (!confirmed) return;
        try {
            const report = await deleteUnusedFiles(assets.map((asset) => asset.sha256));
            const kept = report.kept
                ? ` ${plural(report.kept, "file")} ${report.kept === 1 ? "was" : "were"} kept: in use or uploaded again since.` : "";
            this.modal.status(`Deleted ${plural(report.deleted, "unused file")} (${formatBytes(report.bytes)}).${kept}`);
        } catch (error) {
            this.modal.status(error.message, "error");
        }
    }

    renderFiles(assets) {
        const grid = el("div", "bl-cleanup-files");
        for (const asset of assets) {
            const tile = el("div", "bl-cleanup-file");
            tile.dataset.sha256 = asset.sha256;
            let thumb;
            if (asset.kind === "audio") {
                thumb = el("div", "bl-cleanup-thumb", "♪");
            } else {
                thumb = el("img", "bl-cleanup-thumb");
                thumb.src = thumbnailURL(asset.sha256);
                thumb.alt = "";
                thumb.loading = "lazy";
            }
            tile.append(thumb, el("div", null, `${asset.kind} · ${formatBytes(asset.bytes)}`),
                el("div", "bl-dim", formatTime(asset.stored_at)));
            grid.append(tile);
        }
        return grid;
    }
}
