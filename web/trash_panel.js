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
        empty.disabled = trash.length === 0;
        empty.addEventListener("click", () => void this.empty(trash));
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
        const restore = button("Restore");
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

    /** Delete one bundle for good, as it was shown (the server keeps it if it changed since). */
    async purge(entry, what) {
        const confirmed = await this.modal.confirm(`Delete ${what} for good?`,
            "It cannot be restored afterwards. The files it used stay in the library until you clean up unused files.",
            "Delete forever", { danger: true });
        if (!confirmed) return;
        try {
            await purgeBundle(entry.id, { revision: entry.revision });
            this.modal.status(`Deleted ${what} for good.`);
        } catch (error) {
            this.modal.status(error.message, "error");
        }
        await this.refresh();
    }

    /** Delete for good the bundles shown; any put in the trash or changed since stay. */
    async empty(trash) {
        const count = trash.length;
        const confirmed = await this.modal.confirm("Empty the trash?",
            `${plural(count, "deleted bundle")} will be gone for good. `
            + "The files they used stay in the library until you clean up unused files. "
            + "Files this version cannot read are not touched.",
            "Empty trash", { danger: true });
        if (!confirmed) return;
        try {
            const { deleted, results } = await emptyTrash(Object.fromEntries(trash.map((e) => [e.id, e.revision])));
            const left = results.length - deleted;
            this.modal.status(`Emptied the trash: ${plural(deleted, "bundle")} deleted for good.`
                + (left ? ` ${plural(left, "bundle")} changed or restored meanwhile ${left === 1 ? "was" : "were"} kept.` : ""));
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
