// The trash and the cleanup of unused files, shown in the library modal's
// right pane in place of the editor. Files this version cannot read are not
// here: the list shows them under Needs attention.
import {
    deleteUnusedFiles, emptyTrash, listTrash, listUnusedFiles, purgeBundle, restoreBundle, thumbnailURL,
} from "./api.js";
import { button, el, formatBytes, formatTime, kindName } from "./dom.js";
import { said, t } from "./i18n.js";
import { displayNames } from "./names.js";

export class TrashPanel {
    constructor(modal) {
        this.modal = modal;
        this.root = el("div", "bl-trash");
        this.root.append(el("div", "bl-empty-state", t("common.loading")));
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
        const cleanup = button(t("trash.cleanup_menu"));
        cleanup.addEventListener("click", () => void this.cleanup());
        const empty = button(t("trash.empty"), "bl-btn danger");
        const deletable = trash.filter((entry) => !entry.read_only); // emptying leaves the others alone
        empty.disabled = deletable.length === 0;
        if (trash.length && !deletable.length) empty.title = t("trash.locked_all");
        empty.addEventListener("click", () => void this.empty(deletable, trash.length - deletable.length));
        head.append(el("div", "bl-trash-title", t("common.trash")), cleanup, empty);
        const hint = el("div", "bl-hint", t("trash.hint"));
        const list = el("div", "bl-trash-list");
        if (!trash.length) list.append(el("div", "bl-empty-state", t("trash.is_empty")));
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
            el("div", "bl-list-sub", [t("trash.deleted_at", { time: formatTime(entry.deleted_at) }),
                t("count.fields", { count: entry.fields.length }), category ? t("trash.back_to", { category }) : null, entry.favorite ? "★" : null].filter(Boolean).join(" · ")));
        // A bundle this version cannot change (it holds data from a newer one)
        // cannot be restored by it; deleting it for good is asked for as such.
        if (entry.read_only) text.append(el("div", "bl-list-warn", t("common.locked")));
        const restore = button(t("trash.restore"));
        restore.disabled = !!entry.read_only;
        if (entry.read_only) restore.title = t("trash.locked");
        restore.addEventListener("click", () => void this.restore(entry));
        const purge = button(t("common.delete_forever"), "bl-btn danger");
        purge.addEventListener("click", () => void this.purge(entry, `'${label ?? entry.name}'`));
        row.append(thumb, text, restore, purge);
        return row;
    }

    async restore(entry) {
        try {
            const bundle = await restoreBundle(entry.id);
            this.modal.status(t("trash.restored", { name: bundle.name }));
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
        const confirmed = await this.modal.confirm(t("trash.delete_confirm", { what }), [
            ...(entry.read_only ? [t("trash.not_fully_usable", { reason: said(entry, "read_only") })] : []),
            t("trash.delete_detail"),
        ], t("common.delete_forever"), { danger: true });
        if (!confirmed) return;
        try {
            await purgeBundle(entry.id, { revision: entry.revision, unreadable: !!entry.read_only });
            this.modal.status(t("trash.deleted", { what }));
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
        const confirmed = await this.modal.confirm(t("trash.empty_confirm"), [
            t("trash.empty_detail", { count }),
            t("trash.empty_files_note"),
            locked ? t("trash.empty_locked_detail", { count: locked })
                : t("trash.unreadable_untouched"),
        ].join(" "), t("trash.empty"), { danger: true });
        if (!confirmed) return;
        try {
            const { deleted, results } = await emptyTrash(Object.fromEntries(trash.map((e) => [e.id, e.revision])));
            const unchangeable = results.filter((r) => r.code === "unreadable_file").length;
            const left = results.length - deleted - unchangeable;
            this.modal.status([t("trash.emptied", { bundles: t("count.bundles", { count: deleted }) }),
                left ? t("trash.empty_kept_changed", { count: left }) : null,
                unchangeable ? t("trash.empty_kept_locked", { count: unchangeable }) : null].filter(Boolean).join(" "));
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
            ? t("trash.cleanup_detail", { count: assets.length, size: formatBytes(bytes) })
            : t("trash.cleanup_nothing")];
        if (recent) {
            notes.push(t("trash.cleanup_recent", { count: recent, hours }));
        }
        const choices = assets.length ? [[t("trash.cleanup_delete", { files: t("count.files", { count: assets.length }) }), true, "danger"],
            [t("common.cancel"), false]] : [[t("trash.close"), false]];
        const confirmed = await this.modal.choose(t("trash.cleanup_title"), notes, choices,
            assets.length ? this.renderFiles(assets) : null);
        if (!confirmed) return;
        try {
            const report = await deleteUnusedFiles(assets.map((asset) => asset.sha256));
            this.modal.status([t("trash.cleanup_done", { files: t("count.unused_files", { count: report.deleted }),
                size: formatBytes(report.bytes) }), report.kept ? t("trash.cleanup_kept", { count: report.kept }) : null].filter(Boolean).join(" "));
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
            tile.append(thumb, el("div", null, `${kindName(asset.kind)} · ${formatBytes(asset.bytes)}`),
                el("div", "bl-dim", formatTime(asset.stored_at)));
            grid.append(tile);
        }
        return grid;
    }
}
