// The tags of the whole library, shown in the library modal's right pane in
// place of the editor ("Manage tags…" in the tag menu): how many bundles have
// each, in use and in the trash, and ways to rename (or merge) and delete a tag
// in all of them. Each change says first how far it reaches; the modal runs it
// (LibraryModal.changeTags).
import { deleteTag, listTags, renameTag } from "./api.js";
import { button, el } from "./dom.js";
import { t } from "./i18n.js";
import { sameTag } from "./tags.js";

/** Where a tag is: "3 bundles in use and 1 in the trash" (a sentence puts "on" before it). */
function reach({ active, trash }) {
    const bundles = t("count.bundles", { count: active });
    if (active && trash) return t("tags.reach_used_trash", { bundles, count: trash });
    if (active) return t("tags.reach_used", { bundles });
    return trash ? t("tags.count_trash", { count: trash }) : t("tags.no_bundle");
}

export class TagsPanel {
    constructor(modal) {
        this.modal = modal;
        this.root = el("div", "bl-tags-panel");
        this.root.append(el("div", "bl-empty-state", t("common.loading")));
        this.generation = 0;
        this.listing = null;
        void this.refresh();
    }

    /** Read the tags and show them; the answer to an older read is dropped. */
    async refresh() {
        const generation = ++this.generation;
        let listing;
        try {
            listing = await listTags();
        } catch (error) {
            if (generation === this.generation) this.modal.status(error.message, "error");
            return;
        }
        if (generation !== this.generation) return;
        this.listing = listing;
        this.render(listing);
    }

    render({ tags, unreadable, legacy }) {
        const head = el("div", "bl-trash-head");
        head.append(el("div", "bl-trash-title", t("common.tags")));
        const hint = el("div", "bl-hint", t("tags.hint"));
        const list = el("div", "bl-tags-list");
        if (!tags.length) list.append(el("div", "bl-empty-state", t("tags.none")));
        list.append(...tags.map((entry) => this.renderEntry(entry)));
        const notes = [];
        if (unreadable) {
            notes.push(t("tags.unreadable_left_out", { count: unreadable }));
        }
        if (legacy) {
            notes.push(t("tags.legacy_unchanged", { count: legacy }));
        }
        this.root.replaceChildren(head, hint, list, ...notes.map((text) => el("div", "bl-hint bl-tags-note", text)));
        this.modal.keepFocus(); // the focused button may have been replaced
    }

    renderEntry(entry) {
        const row = el("div", "bl-trash-item bl-tag-item");
        row.dataset.tag = entry.name;
        const text = el("div", "bl-list-text");
        const others = entry.spellings.filter((s) => s !== entry.name);
        text.append(el("div", "bl-list-name", entry.name), el("div", "bl-list-sub", [
            t("tags.count_used", { count: entry.active }), entry.trash ? t("tags.count_trash", { count: entry.trash }) : null,
            entry.protected ? t("tags.count_locked", { count: entry.protected }) : null,
            others.length ? t("tags.also_spelled", { spellings: others.join(", ") }) : null,
        ].filter(Boolean).join(" · ")));
        const rename = button(t("common.rename_menu"));
        rename.addEventListener("click", () => void this.rename(entry));
        const remove = button(t("common.delete_menu"), "bl-btn danger");
        remove.addEventListener("click", () => void this.remove(entry));
        row.append(text, rename, remove);
        return row;
    }

    /** What a change to `entry` leaves out, for its confirmation. */
    leftOut(entry) {
        const lines = [];
        if (entry.protected) {
            lines.push(t("tags.locked_keep", { count: entry.protected, tag: entry.name }));
        }
        const { unreadable } = this.listing;
        if (unreadable) {
            lines.push(t("tags.unknown_left_out", { count: unreadable }));
        }
        return lines;
    }

    async rename(entry) {
        if (!this.modal.allowed()) return;
        let target = null;
        await this.modal.ask(t("tags.rename_title", { tag: entry.name }), t("tags.rename_hint"), {
            value: entry.name, maxLength: 40, action: t("tags.next"),
            submit: async (value) => {
                const name = value.trim();
                if (!name) throw new Error(t("tags.name_required"));
                if (name === entry.name) throw new Error(t("tags.same_name"));
                target = name;
            },
        });
        if (!target) return;
        const into = this.listing.tags.find((tag) => tag !== entry && sameTag(tag.name, target)) ?? null;
        const lines = [t("tags.rename_detail", { tag: entry.name, reach: reach(entry) })];
        if (into) {
            lines.push(t("tags.merge_detail", { tag: into.name, reach: reach(into), target }));
        }
        lines.push(...this.leftOut(entry));
        const confirmed = await this.modal.confirm(into ? t("tags.merge_confirm", { tag: entry.name, target })
            : t("tags.rename_confirm", { tag: entry.name, target }), lines, into ? t("tags.merge") : t("common.rename"));
        if (!confirmed) return;
        await this.modal.changeTags(() => renameTag(entry.name, target), { from: entry.name, to: target });
    }

    async remove(entry) {
        if (!this.modal.allowed()) return;
        const confirmed = await this.modal.confirm(t("tags.delete_confirm", { tag: entry.name }),
            [t("tags.delete_detail", { reach: reach(entry) }),
                ...this.leftOut(entry)], t("tags.delete"), { danger: true });
        if (!confirmed) return;
        await this.modal.changeTags(() => deleteTag(entry.name), { from: entry.name });
    }
}
