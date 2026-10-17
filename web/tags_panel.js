// The tags of the whole library, shown in the library modal's right pane in
// place of the editor ("Manage tags…" in the tag menu): how many bundles have
// each, in use and in the trash, and ways to rename (or merge) and delete a tag
// in all of them. Each change says first how far it reaches; the modal runs it
// (LibraryModal.changeTags).
import { deleteTag, listTags, renameTag } from "./api.js";
import { button, el, plural } from "./dom.js";
import { sameTag } from "./tags.js";

/** "on 3 bundles in use and 1 in the trash". */
function reach({ active, trash }) {
    const parts = [active ? `${plural(active, "bundle")} in use` : null, trash ? `${trash} in the trash` : null];
    return `on ${parts.filter(Boolean).join(" and ") || "no bundle"}`;
}

export class TagsPanel {
    constructor(modal) {
        this.modal = modal;
        this.root = el("div", "bl-tags-panel");
        this.root.append(el("div", "bl-empty-state", "Loading…"));
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
        head.append(el("div", "bl-trash-title", "Tags"));
        const hint = el("div", "bl-hint", "Renaming or deleting a tag changes every bundle that has it, in the trash too. "
            + "Renaming it to a tag that is there already merges the two.");
        const list = el("div", "bl-tags-list");
        if (!tags.length) list.append(el("div", "bl-empty-state", "No bundle has a tag."));
        list.append(...tags.map((entry) => this.renderEntry(entry)));
        const notes = [];
        if (unreadable) {
            notes.push(`${plural(unreadable, "bundle file")} this version cannot read ${unreadable === 1 ? "is" : "are"} `
                + "left out: whatever tags they have stay as they are.");
        }
        if (legacy) notes.push(`${plural(legacy, "file")} in the old trash folder ${legacy === 1 ? "is" : "are"} not changed.`);
        this.root.replaceChildren(head, hint, list, ...notes.map((text) => el("div", "bl-hint bl-tags-note", text)));
        this.modal.keepFocus(); // the focused button may have been replaced
    }

    renderEntry(entry) {
        const row = el("div", "bl-trash-item bl-tag-item");
        row.dataset.tag = entry.name;
        const text = el("div", "bl-list-text");
        const others = entry.spellings.filter((s) => s !== entry.name);
        text.append(el("div", "bl-list-name", entry.name), el("div", "bl-list-sub", [
            `${entry.active} in use`, entry.trash ? `${entry.trash} in the trash` : null,
            entry.protected ? `🔒 ${entry.protected} this version cannot change` : null,
            others.length ? `also spelled ${others.join(", ")}` : null,
        ].filter(Boolean).join(" · ")));
        const rename = button("Rename…");
        rename.addEventListener("click", () => void this.rename(entry));
        const remove = button("Delete…", "bl-btn danger");
        remove.addEventListener("click", () => void this.remove(entry));
        row.append(text, rename, remove);
        return row;
    }

    /** What a change to `entry` leaves out, for its confirmation. */
    leftOut(entry) {
        const lines = [];
        if (entry.protected) {
            lines.push(`${plural(entry.protected, "bundle")} this version cannot change ${entry.protected === 1 ? "keeps" : "keep"} `
                + `'${entry.name}'.`);
        }
        const { unreadable } = this.listing;
        if (unreadable) lines.push(`${plural(unreadable, "file")} this version cannot read ${unreadable === 1 ? "is" : "are"} left out.`);
        return lines;
    }

    async rename(entry) {
        if (!this.modal.allowed()) return;
        let target = null;
        await this.modal.ask(`Rename '${entry.name}'`, "A new name, or the name of another tag to merge it into.", {
            value: entry.name, maxLength: 40, action: "Next",
            submit: async (value) => {
                const name = value.trim();
                if (!name) throw new Error("A tag needs a name.");
                if (name === entry.name) throw new Error("That is its name already.");
                target = name;
            },
        });
        if (!target) return;
        const into = this.listing.tags.find((t) => t !== entry && sameTag(t.name, target)) ?? null;
        const lines = [`'${entry.name}' is ${reach(entry)}.`];
        if (into) {
            lines.push(`'${into.name}' is ${reach(into)}. A bundle with both keeps one '${target}', where the first of them was.`);
        }
        lines.push(...this.leftOut(entry));
        const confirmed = await this.modal.confirm(into ? `Merge '${entry.name}' into '${target}'?` : `Rename '${entry.name}' to '${target}'?`,
            lines, into ? "Merge" : "Rename");
        if (!confirmed) return;
        await this.modal.changeTags(() => renameTag(entry.name, target), { from: entry.name, to: target });
    }

    async remove(entry) {
        if (!this.modal.allowed()) return;
        const confirmed = await this.modal.confirm(`Delete the tag '${entry.name}'?`,
            [`It comes off every bundle that has it: it is ${reach(entry)}. The bundles stay.`, ...this.leftOut(entry)],
            "Delete tag", { danger: true });
        if (!confirmed) return;
        await this.modal.changeTags(() => deleteTag(entry.name), { from: entry.name });
    }
}
