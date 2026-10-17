// What the library modal's right pane shows for several bundles at once:
// the selection and what can be done to all of it (BatchPanel), a change
// being sent, and its result (BatchResult). The modal runs the change
// (LibraryModal.runBatch); these only draw.
import { exportURL, thumbnailURL } from "./api.js";
import { button, el, formatBytes, icon, plural } from "./dom.js";
import { msg, t, tn } from "./i18n.js";
import { tagCounts } from "./tags.js";

/** The small picture of a bundle, if it has an image or a video. */
function thumb(bundle) {
    const media = bundle.fields?.find((f) => (f.type === "image" || f.type === "video") && f.preview);
    const element = el(media ? "img" : "div", "bl-batch-thumb");
    if (media) {
        element.src = thumbnailURL(media.preview.sha256);
        element.alt = "";
        element.draggable = false;
    }
    return element;
}

// The category select's entry while the category chosen in it is gone (deleted
// since): Move waits for a new choice instead of quietly taking "No category".
const GONE = "gone";

export class BatchPanel {
    /** `bundles`: the selected summaries, in list order. */
    constructor(modal, bundles) {
        this.modal = modal;
        // What the panel's inputs hold, kept when the selection or the list is
        // drawn again: the category Move puts the bundles in, an id or "" for
        // none, or null once the chosen category is gone.
        this.category = "";
        this.tagText = ""; // a tag typed to add, kept when the panel is drawn again
        this.root = el("div", "bl-batch");
        this.show(bundles);
    }

    /** Show the selection as it is now; what was chosen in the panel stays. */
    show(bundles) {
        this.bundles = bundles;
        const { modal } = this;
        const focused = this.root.contains(document.activeElement) ? document.activeElement.dataset.control : null;
        if (this.category && !modal.categories.some((c) => c.id === this.category)) this.category = null;
        const head = el("div", "bl-batch-head");
        const clear = button(t("Clear selection"));
        clear.addEventListener("click", () => modal.clearSelection());
        head.append(el("div", "bl-batch-title", t("{bundles} selected", { bundles: plural(bundles.length, "bundle") })), clear);

        const names = el("div", "bl-batch-names");
        const categories = new Map(modal.categories.map((c) => [c.id, c.name]));
        names.append(...bundles.map((bundle) => {
            const row = el("div", "bl-batch-name");
            row.dataset.id = bundle.id;
            const text = el("div", "bl-list-text");
            text.append(el("div", "bl-list-name", modal.labels?.get(bundle.id) ?? bundle.name),
                el("div", "bl-list-sub", [categories.get(bundle.category) ?? t("Uncategorized"), bundle.favorite ? "★" : null,
                    bundle.read_only ? t("🔒 cannot be changed by this version") : null].filter(Boolean).join(" · ")));
            row.append(thumb(bundle), text);
            return row;
        }));

        const why = modal.organizeBlocker;
        const place = el("div", "bl-batch-row");
        this.categorySelect = el("select", "bl-input bl-batch-category");
        this.categorySelect.dataset.control = "category";
        const choices = [["", t("No category")], ...modal.categories.map((c) => [c.id, c.name])];
        if (this.category === null) choices.unshift([GONE, t("Choose a category (the one chosen was deleted)")]);
        for (const [value, label] of choices) {
            const option = el("option", null, label);
            option.value = value;
            option.disabled = value === GONE;
            this.categorySelect.append(option);
        }
        this.categorySelect.value = this.category ?? GONE;
        const move = button(t("Move"), "bl-btn primary");
        move.dataset.control = "move";
        const chosen = () => {
            move.disabled = !!why || this.category === null;
            move.title = why ?? (this.category === null ? t("The category chosen was deleted. Choose one again.") : "");
        };
        this.categorySelect.addEventListener("change", () => {
            this.category = this.categorySelect.value;
            chosen();
        });
        move.addEventListener("click", () => {
            if (this.category === null) return;
            void modal.runBatch("set_category", { category: this.category || null }, this.bundles);
        });
        place.append(el("span", "bl-label", t("Category")), this.categorySelect, move);

        const stars = el("div", "bl-batch-row");
        const add = button("", "bl-btn");
        add.dataset.control = "add-favorites";
        add.append(t("★ Add to favorites"));
        add.addEventListener("click", () => void modal.runBatch("set_favorite", { favorite: true }, this.bundles));
        const remove = button("", "bl-btn");
        remove.dataset.control = "remove-favorites";
        remove.append(t("☆ Remove from favorites"));
        remove.addEventListener("click", () => void modal.runBatch("set_favorite", { favorite: false }, this.bundles));
        stars.append(el("span", "bl-label", t("Favorites")), add, remove);
        for (const control of [this.categorySelect, add, remove]) {
            control.disabled = !!why;
            if (why) control.title = why;
        }
        chosen();

        // The tags the selected bundles have, each with how many have it; × takes
        // it off all of them, and a tag typed below goes on all of them.
        const tags = el("div", "bl-batch-row bl-batch-tags");
        tags.append(el("span", "bl-label", t("Tags")));
        for (const { name, count } of tagCounts(bundles)) {
            const chip = el("span", "bl-chip bl-batch-tag", `${name} `);
            chip.dataset.tag = name;
            chip.append(el("span", "bl-dim", `${count}/${bundles.length}`));
            const remove = button("×", "bl-chip-x", t("Remove '{tag}' from the selected bundles", { tag: name }));
            remove.setAttribute("aria-label", t("Remove the tag {tag} from the selected bundles", { tag: name }));
            remove.addEventListener("click", () => void modal.runBatch("remove_tags", { tags: [name] }, this.bundles));
            chip.append(remove);
            tags.append(chip);
        }
        const addTag = el("input", "bl-input bl-tag-input bl-batch-add-tag");
        addTag.dataset.control = "add-tag";
        addTag.placeholder = t("+ tag for all");
        addTag.maxLength = 40;
        addTag.value = this.tagText;
        addTag.addEventListener("input", () => {
            this.tagText = addTag.value;
        });
        addTag.addEventListener("keydown", (e) => {
            if (e.isComposing || e.key !== "Enter") return;
            e.preventDefault();
            const tag = addTag.value.trim();
            if (!tag) return;
            this.tagText = "";
            void modal.runBatch("add_tags", { tags: [tag] }, this.bundles);
        });
        tags.append(addTag);

        const out = el("div", "bl-batch-row");
        const toZip = button("", "bl-btn");
        toZip.dataset.control = "export";
        toZip.append(icon("download"), ` ${t("Export ZIP")}`);
        toZip.addEventListener("click", () => void modal.runExport(this.bundles));
        out.append(el("span", "bl-label", t("Export")), toZip,
            el("span", "bl-hint", t("The bundles and the files they use, to keep or to bring into another library.")));

        const trash = el("div", "bl-batch-row");
        const toTrash = button("", "bl-btn danger");
        toTrash.dataset.control = "trash";
        toTrash.append(icon("trash"), ` ${t("Move to trash…")}`);
        toTrash.addEventListener("click", () => void modal.runBatch("trash", {}, this.bundles));
        trash.append(el("span", "bl-label", t("Trash")), toTrash);
        const locked = bundles.filter((b) => b.read_only).length;
        if (locked) {
            const note = tn(locked, "{count} bundle this version cannot change will be left out.",
                "{count} bundles this version cannot change will be left out.");
            trash.append(el("span", "bl-hint", note));
            tags.append(el("span", "bl-hint", note));
        }

        this.root.replaceChildren(head, names, place, stars, tags, out, trash);
        if (focused) this.root.querySelector(`[data-control="${focused}"]`)?.focus({ preventScroll: true });
    }
}

// How each kind of refusal is listed in a result, most useful first.
const OUTCOMES = [
    ["retry", msg("Not done; trying again may work")],
    ["revision_conflict", msg("Changed elsewhere since you selected it; not moved")],
    ["protected", msg("This version cannot change these; left as they are")],
    ["not_found", msg("No longer in the library")],
    ["in_trash", msg("In the trash")],
    ["other", msg("Not done")],
];
const PROTECTED = new Set(["read_only", "newer_version", "unsupported", "corrupt", "corrupt_bundle"]);

function kindOf(result) {
    if (result.retry) return "retry";
    if (PROTECTED.has(result.code)) return "protected";
    if (["revision_conflict", "not_found", "in_trash"].includes(result.code)) return result.code;
    return "other";
}

/** What a batch did, by the names the bundles had when it started. */
export class BatchResult {
    /**
     * `job`: {action, describe, summaries}; `answer`: the server's answer, or
     * null with `unknown` (no answer: it may have run in part or whole) or
     * `refused` (an error that changed nothing).
     */
    constructor(modal, job, { answer = null, unknown = false, refused = null, waiting = false } = {}) {
        this.modal = modal;
        this.job = job;
        this.root = el("div", "bl-batch bl-batch-result");
        this.root.dataset.token = String(job.token);
        if (waiting) this.renderWaiting();
        else this.render({ answer, unknown, refused });
    }

    /** While the request is out: what is being done, and after a while a way to stop waiting. */
    renderWaiting() {
        this.root.classList.add("waiting");
        const line = el("div", "bl-batch-title", `${this.job.describe.doing}…`);
        this.stall = el("div", "bl-batch-stall");
        this.stall.hidden = true;
        const stop = button(t("Stop waiting"));
        stop.addEventListener("click", () => this.modal.stopWaiting(this.job));
        this.stall.append(el("div", "bl-hint", t("No answer yet. You can stop waiting; the server may still finish it.")), stop);
        this.root.replaceChildren(line, el("div", "bl-hint", plural(this.job.summaries.length, "bundle")), this.stall);
    }

    stalled() {
        if (this.stall) this.stall.hidden = false;
    }

    render({ answer, unknown, refused }) {
        this.root.classList.remove("waiting");
        const { job, modal } = this;
        const names = new Map(job.summaries.map((b) => [b.id, b.label]));
        const done = el("div", "bl-batch-actions");
        const back = button(t("Done"), "bl-btn primary");
        back.addEventListener("click", () => modal.leaveResult());
        const parts = [];
        if (unknown) {
            parts.push(el("div", "bl-batch-title", t("Could not tell whether it finished")),
                el("div", "bl-warn", t("{what} was sent, but no answer came back. The server may have done all, "
                    + "some or none of it. Reload the list to see where things stand.", { what: job.describe.what })));
            const reload = button(t("Reload the list"));
            reload.addEventListener("click", () => void modal.reload());
            const again = button(t("Try again"));
            again.addEventListener("click", () => void modal.retryBatch(job, job.summaries.map((b) => b.id)));
            done.append(reload, again, back);
        } else if (refused) {
            parts.push(el("div", "bl-batch-title", t("Nothing was changed")), el("div", "bl-error", refused.message));
            done.append(back);
        } else {
            const results = answer.results;
            const changed = results.filter((r) => r.ok && r.changed);
            const unchanged = results.filter((r) => r.ok && !r.changed);
            const failed = results.filter((r) => !r.ok);
            parts.push(el("div", "bl-batch-title", job.describe.done),
                el("div", "bl-batch-summary", [t("{count} changed", { count: changed.length }),
                    unchanged.length ? t("{count} already so", { count: unchanged.length }) : null,
                    failed.length ? t("{count} not done", { count: failed.length }) : null].filter(Boolean).join(" · ")));
            const list = (title, items, kind) => {
                if (!items.length) return;
                const group = el("div", `bl-batch-outcome ${kind}`);
                group.dataset.outcome = kind;
                group.append(el("div", "bl-batch-outcome-title", `${title} (${items.length})`));
                for (const r of items) {
                    const row = el("div", "bl-batch-outcome-row");
                    row.dataset.id = r.id;
                    row.append(el("span", "bl-list-name", names.get(r.id) ?? r.id));
                    if (r.message && kind !== "changed" && kind !== "unchanged") row.append(el("span", "bl-dim", r.message));
                    if (r.warning) row.append(el("span", "bl-warn", r.warning)); // done, but not synced to the disk
                    group.append(row);
                }
                parts.push(group);
            };
            for (const [kind, title] of OUTCOMES) list(t(title), failed.filter((r) => kindOf(r) === kind), kind);
            list(t("Changed"), changed, "changed");
            list(t("Already so"), unchanged, "unchanged");
            const retryable = failed.filter((r) => r.retry).map((r) => r.id);
            if (retryable.length) {
                const again = button(t("Try again with {bundles}", { bundles: plural(retryable.length, "bundle") }));
                again.addEventListener("click", () => void modal.retryBatch(job, retryable));
                done.append(again);
            }
            done.append(back);
        }
        this.root.replaceChildren(...parts, done);
    }
}

/** An export: the ZIP made, what it holds and what was left out; its download starts at once. */
export class ExportResult extends BatchResult {
    render({ answer, unknown, refused }) {
        this.root.classList.remove("waiting");
        const { job, modal } = this;
        const names = new Map(job.summaries.map((b) => [b.id, b.label]));
        const done = el("div", "bl-batch-actions");
        const back = button(t("Done"), "bl-btn primary");
        back.addEventListener("click", () => modal.leaveResult());
        const parts = [];
        if (unknown || refused) {
            parts.push(el("div", "bl-batch-title", t("Nothing to download")),
                el("div", refused ? "bl-error" : "bl-warn", refused ? refused.message
                    : t("No answer came back. The export may still be made on the server; export again to download it.")));
            done.append(back);
            this.root.replaceChildren(...parts, done);
            return;
        }
        const link = el("a", "bl-btn primary bl-export-download");
        link.href = exportURL(answer.token, answer.file_name);
        link.download = answer.file_name;
        link.append(icon("download"), ` ${t("Download again")}`);
        parts.push(el("div", "bl-batch-title", t("Exported")), el("div", "bl-batch-summary",
            `${t("{bundles} and {files}", { bundles: plural(answer.bundles, "bundle"), files: plural(answer.assets, "file") })} · `
            + `${formatBytes(answer.bytes)} · ${answer.file_name}`), el("div", "bl-hint", t("The download starts by itself; the file "
            + "can be downloaded again for an hour.")));
        if (answer.skipped.length) {
            const group = el("div", "bl-batch-outcome other");
            group.dataset.outcome = "skipped";
            group.append(el("div", "bl-batch-outcome-title", `${t("Left out")} (${answer.skipped.length})`));
            for (const s of answer.skipped) {
                const row = el("div", "bl-batch-outcome-row");
                row.dataset.id = s.id;
                row.append(el("span", "bl-list-name", names.get(s.id) ?? s.id), el("span", "bl-dim", s.reason));
                group.append(row);
            }
            parts.push(group);
        }
        if (answer.missing.length) {
            parts.push(el("div", "bl-warn", tn(answer.missing.length, "{count} file the bundles use is not in the library and is "
                + "not in the ZIP: {names}.", "{count} files the bundles use are not in the library and are not in the ZIP: {names}.",
            { names: [...new Set(answer.missing.flatMap((m) => m.bundles))].join(", ") })));
        }
        done.append(link, back);
        this.root.replaceChildren(...parts, done);
        link.click(); // the browser's own download: nothing is held in the page
    }
}
