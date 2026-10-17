// The tags of the whole library, shown in the library modal's right pane in
// place of the editor ("Manage tags…" in the tag menu): how many bundles have
// each, in use and in the trash, and ways to rename (or merge) and delete a tag
// in all of them. Each change says first how far it reaches; the modal runs it
// (LibraryModal.changeTags).
import { deleteTag, listTags, renameTag } from "./api.js";
import { button, el, plural } from "./dom.js";
import { t, tn } from "./i18n.js";
import { sameTag } from "./tags.js";

/** Where a tag is: "3 bundles in use and 1 in the trash" (a sentence puts "on" before it). */
function reach({ active, trash }) {
    const bundles = plural(active, "bundle");
    if (active && trash) return t("{bundles} in use and {count} in the trash", { bundles, count: trash });
    if (active) return t("{bundles} in use", { bundles });
    return trash ? t("{count} in the trash", { count: trash }) : t("no bundle");
}

export class TagsPanel {
    constructor(modal) {
        this.modal = modal;
        this.root = el("div", "bl-tags-panel");
        this.root.append(el("div", "bl-empty-state", t("Loading…")));
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
        head.append(el("div", "bl-trash-title", t("Tags")));
        const hint = el("div", "bl-hint", t("Renaming or deleting a tag changes every bundle that has it, in the trash too. "
            + "Renaming it to a tag that is there already merges the two."));
        const list = el("div", "bl-tags-list");
        if (!tags.length) list.append(el("div", "bl-empty-state", t("No bundle has a tag.")));
        list.append(...tags.map((entry) => this.renderEntry(entry)));
        const notes = [];
        if (unreadable) {
            notes.push(tn(unreadable, "{count} bundle file this version cannot read is left out: whatever tags they have stay as "
                + "they are.", "{count} bundle files this version cannot read are left out: whatever tags they have stay as they are."));
        }
        if (legacy) {
            notes.push(tn(legacy, "{count} file in the old trash folder is not changed.",
                "{count} files in the old trash folder are not changed."));
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
            t("{count} in use", { count: entry.active }), entry.trash ? t("{count} in the trash", { count: entry.trash }) : null,
            entry.protected ? t("🔒 {count} this version cannot change", { count: entry.protected }) : null,
            others.length ? t("also spelled {spellings}", { spellings: others.join(", ") }) : null,
        ].filter(Boolean).join(" · ")));
        const rename = button(t("Rename…"));
        rename.addEventListener("click", () => void this.rename(entry));
        const remove = button(t("Delete…"), "bl-btn danger");
        remove.addEventListener("click", () => void this.remove(entry));
        row.append(text, rename, remove);
        return row;
    }

    /** What a change to `entry` leaves out, for its confirmation. */
    leftOut(entry) {
        const lines = [];
        if (entry.protected) {
            lines.push(tn(entry.protected, "{count} bundle this version cannot change keeps '{tag}'.",
                "{count} bundles this version cannot change keep '{tag}'.", { tag: entry.name }));
        }
        const { unreadable } = this.listing;
        if (unreadable) {
            lines.push(tn(unreadable, "{count} file this version cannot read is left out.",
                "{count} files this version cannot read are left out."));
        }
        return lines;
    }

    async rename(entry) {
        if (!this.modal.allowed()) return;
        let target = null;
        await this.modal.ask(t("Rename '{tag}'", { tag: entry.name }), t("A new name, or the name of another tag to merge it into."), {
            value: entry.name, maxLength: 40, action: t("Next"),
            submit: async (value) => {
                const name = value.trim();
                if (!name) throw new Error(t("A tag needs a name."));
                if (name === entry.name) throw new Error(t("That is its name already."));
                target = name;
            },
        });
        if (!target) return;
        const into = this.listing.tags.find((tag) => tag !== entry && sameTag(tag.name, target)) ?? null;
        const lines = [t("'{tag}' is on {reach}.", { tag: entry.name, reach: reach(entry) })];
        if (into) {
            lines.push(t("'{tag}' is on {reach}. A bundle with both keeps one '{target}', where the first of them was.",
                { tag: into.name, reach: reach(into), target }));
        }
        lines.push(...this.leftOut(entry));
        const confirmed = await this.modal.confirm(into ? t("Merge '{tag}' into '{target}'?", { tag: entry.name, target })
            : t("Rename '{tag}' to '{target}'?", { tag: entry.name, target }), lines, into ? t("Merge") : t("Rename"));
        if (!confirmed) return;
        await this.modal.changeTags(() => renameTag(entry.name, target), { from: entry.name, to: target });
    }

    async remove(entry) {
        if (!this.modal.allowed()) return;
        const confirmed = await this.modal.confirm(t("Delete the tag '{tag}'?", { tag: entry.name }),
            [t("It comes off every bundle that has it: it is on {reach}. The bundles stay.", { reach: reach(entry) }),
                ...this.leftOut(entry)], t("Delete tag"), { danger: true });
        if (!confirmed) return;
        await this.modal.changeTags(() => deleteTag(entry.name), { from: entry.name });
    }
}
