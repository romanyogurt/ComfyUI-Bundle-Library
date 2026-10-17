// What the library modal's right pane shows for several bundles at once:
// the selection and what can be done to all of it (BatchPanel), a change
// being sent, and its result (BatchResult). The modal runs the change
// (LibraryModal.runBatch); these only draw.
import { exportURL, thumbnailURL } from "./api.js";
import { button, el, formatBytes, icon } from "./dom.js";
import { msg, said, t } from "./i18n.js";
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
        const clear = button(t("batch.clear_selection"));
        clear.addEventListener("click", () => modal.clearSelection());
        head.append(el("div", "bl-batch-title", t("batch.selected", { bundles: t("count.bundles", { count: bundles.length }) })), clear);

        const names = el("div", "bl-batch-names");
        const categories = new Map(modal.categories.map((c) => [c.id, c.name]));
        names.append(...bundles.map((bundle) => {
            const row = el("div", "bl-batch-name");
            row.dataset.id = bundle.id;
            const text = el("div", "bl-list-text");
            text.append(el("div", "bl-list-name", modal.labels?.get(bundle.id) ?? bundle.name),
                el("div", "bl-list-sub", [categories.get(bundle.category) ?? t("common.uncategorized"), bundle.favorite ? "★" : null,
                    bundle.read_only ? t("batch.locked_item") : null].filter(Boolean).join(" · ")));
            row.append(thumb(bundle), text);
            return row;
        }));

        const why = modal.organizeBlocker;
        const place = el("div", "bl-batch-row");
        this.categorySelect = el("select", "bl-input bl-batch-category");
        this.categorySelect.dataset.control = "category";
        const choices = [["", t("common.no_category")], ...modal.categories.map((c) => [c.id, c.name])];
        if (this.category === null) choices.unshift([GONE, t("batch.choose_category_again")]);
        for (const [value, label] of choices) {
            const option = el("option", null, label);
            option.value = value;
            option.disabled = value === GONE;
            this.categorySelect.append(option);
        }
        this.categorySelect.value = this.category ?? GONE;
        const move = button(t("batch.move"), "bl-btn primary");
        move.dataset.control = "move";
        const chosen = () => {
            move.disabled = !!why || this.category === null;
            move.title = why ?? (this.category === null ? t("batch.category_deleted") : "");
        };
        this.categorySelect.addEventListener("change", () => {
            this.category = this.categorySelect.value;
            chosen();
        });
        move.addEventListener("click", () => {
            if (this.category === null) return;
            void modal.runBatch("set_category", { category: this.category || null }, this.bundles);
        });
        place.append(el("span", "bl-label", t("common.category")), this.categorySelect, move);

        const stars = el("div", "bl-batch-row");
        const add = button("", "bl-btn");
        add.dataset.control = "add-favorites";
        add.append(t("batch.favorite_add"));
        add.addEventListener("click", () => void modal.runBatch("set_favorite", { favorite: true }, this.bundles));
        const remove = button("", "bl-btn");
        remove.dataset.control = "remove-favorites";
        remove.append(t("batch.favorite_remove"));
        remove.addEventListener("click", () => void modal.runBatch("set_favorite", { favorite: false }, this.bundles));
        stars.append(el("span", "bl-label", t("common.favorites")), add, remove);
        for (const control of [this.categorySelect, add, remove]) {
            control.disabled = !!why;
            if (why) control.title = why;
        }
        chosen();

        // The tags the selected bundles have, each with how many have it; × takes
        // it off all of them, and a tag typed below goes on all of them.
        const tags = el("div", "bl-batch-row bl-batch-tags");
        tags.append(el("span", "bl-label", t("common.tags")));
        for (const { name, count } of tagCounts(bundles)) {
            const chip = el("span", "bl-chip bl-batch-tag", `${name} `);
            chip.dataset.tag = name;
            chip.append(el("span", "bl-dim", `${count}/${bundles.length}`));
            const remove = button("×", "bl-chip-x", t("batch.tag_remove_title", { tag: name }));
            remove.setAttribute("aria-label", t("batch.tag_remove_label", { tag: name }));
            remove.addEventListener("click", () => void modal.runBatch("remove_tags", { tags: [name] }, this.bundles));
            chip.append(remove);
            tags.append(chip);
        }
        const addTag = el("input", "bl-input bl-tag-input bl-batch-add-tag");
        addTag.dataset.control = "add-tag";
        addTag.placeholder = t("batch.tag_add_all");
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
        toZip.append(icon("download"), ` ${t("batch.export_zip")}`);
        toZip.addEventListener("click", () => void modal.runExport(this.bundles));
        out.append(el("span", "bl-label", t("batch.export")), toZip,
            el("span", "bl-hint", t("batch.export_hint")));

        const trash = el("div", "bl-batch-row");
        const toTrash = button("", "bl-btn danger");
        toTrash.dataset.control = "trash";
        toTrash.append(icon("trash"), ` ${t("batch.move_to_trash")}`);
        toTrash.addEventListener("click", () => void modal.runBatch("trash", {}, this.bundles));
        trash.append(el("span", "bl-label", t("common.trash")), toTrash);
        const locked = bundles.filter((b) => b.read_only).length;
        if (locked) {
            const note = t("batch.locked_left_out", { count: locked });
            trash.append(el("span", "bl-hint", note));
            tags.append(el("span", "bl-hint", note));
        }

        this.root.replaceChildren(head, names, place, stars, tags, out, trash);
        if (focused) this.root.querySelector(`[data-control="${focused}"]`)?.focus({ preventScroll: true });
    }
}

// How each kind of refusal is listed in a result, most useful first.
const OUTCOMES = [
    ["retry", msg("batch.not_done_retry")],
    ["revision_conflict", msg("batch.changed_elsewhere")],
    ["protected", msg("batch.locked_left")],
    ["not_found", msg("batch.no_longer_in_library")],
    ["in_trash", msg("batch.in_trash")],
    ["other", msg("batch.not_done")],
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
        const stop = button(t("batch.stop_waiting"));
        stop.addEventListener("click", () => this.modal.stopWaiting(this.job));
        this.stall.append(el("div", "bl-hint", t("batch.no_answer_yet")), stop);
        this.root.replaceChildren(line, el("div", "bl-hint", t("count.bundles", { count: this.job.summaries.length })), this.stall);
    }

    stalled() {
        if (this.stall) this.stall.hidden = false;
    }

    render({ answer, unknown, refused }) {
        this.root.classList.remove("waiting");
        const { job, modal } = this;
        const names = new Map(job.summaries.map((b) => [b.id, b.label]));
        const done = el("div", "bl-batch-actions");
        const back = button(t("common.done"), "bl-btn primary");
        back.addEventListener("click", () => modal.leaveResult());
        const parts = [];
        if (unknown) {
            parts.push(el("div", "bl-batch-title", t("common.unknown_outcome")),
                el("div", "bl-warn", t("batch.sent_no_answer", { what: job.describe.what })));
            const reload = button(t("common.reload_list"));
            reload.addEventListener("click", () => void modal.reload());
            const again = button(t("batch.try_again"));
            again.addEventListener("click", () => void modal.retryBatch(job, job.summaries.map((b) => b.id)));
            done.append(reload, again, back);
        } else if (refused) {
            parts.push(el("div", "bl-batch-title", t("batch.nothing_changed")), el("div", "bl-error", refused.message));
            done.append(back);
        } else {
            const results = answer.results;
            const changed = results.filter((r) => r.ok && r.changed);
            const unchanged = results.filter((r) => r.ok && !r.changed);
            const failed = results.filter((r) => !r.ok);
            parts.push(el("div", "bl-batch-title", job.describe.done),
                el("div", "bl-batch-summary", [t("batch.count_changed", { count: changed.length }),
                    unchanged.length ? t("batch.count_already", { count: unchanged.length }) : null,
                    failed.length ? t("batch.count_not_done", { count: failed.length }) : null].filter(Boolean).join(" · ")));
            const list = (title, items, kind) => {
                if (!items.length) return;
                const group = el("div", `bl-batch-outcome ${kind}`);
                group.dataset.outcome = kind;
                group.append(el("div", "bl-batch-outcome-title", `${title} (${items.length})`));
                for (const r of items) {
                    const row = el("div", "bl-batch-outcome-row");
                    row.dataset.id = r.id;
                    row.append(el("span", "bl-list-name", names.get(r.id) ?? r.id));
                    if (r.message && kind !== "changed" && kind !== "unchanged") row.append(el("span", "bl-dim", said(r, "message")));
                    if (r.warning) row.append(el("span", "bl-warn", said(r, "warning"))); // done, but not synced to the disk
                    group.append(row);
                }
                parts.push(group);
            };
            for (const [kind, title] of OUTCOMES) list(t(title), failed.filter((r) => kindOf(r) === kind), kind);
            list(t("batch.changed"), changed, "changed");
            list(t("batch.already"), unchanged, "unchanged");
            const retryable = failed.filter((r) => r.retry).map((r) => r.id);
            if (retryable.length) {
                const again = button(t("batch.try_again_with", { bundles: t("count.bundles", { count: retryable.length }) }));
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
        const back = button(t("common.done"), "bl-btn primary");
        back.addEventListener("click", () => modal.leaveResult());
        const parts = [];
        if (unknown || refused) {
            parts.push(el("div", "bl-batch-title", t("batch.nothing_to_download")),
                el("div", refused ? "bl-error" : "bl-warn", refused ? refused.message
                    : t("batch.export_no_answer")));
            done.append(back);
            this.root.replaceChildren(...parts, done);
            return;
        }
        const link = el("a", "bl-btn primary bl-export-download");
        link.href = exportURL(answer.token, answer.file_name);
        link.download = answer.file_name;
        link.append(icon("download"), ` ${t("batch.download_again")}`);
        parts.push(el("div", "bl-batch-title", t("common.exported")), el("div", "bl-batch-summary",
            `${t("batch.bundles_and_files", { bundles: t("count.bundles", { count: answer.bundles }),
                files: t("count.files", { count: answer.assets }) })} · `
            + `${formatBytes(answer.bytes)} · ${answer.file_name}`), el("div", "bl-hint", t("batch.download_starts")));
        if (answer.skipped.length) {
            const group = el("div", "bl-batch-outcome other");
            group.dataset.outcome = "skipped";
            group.append(el("div", "bl-batch-outcome-title", `${t("batch.left_out")} (${answer.skipped.length})`));
            for (const s of answer.skipped) {
                const row = el("div", "bl-batch-outcome-row");
                row.dataset.id = s.id;
                row.append(el("span", "bl-list-name", names.get(s.id) ?? s.id), el("span", "bl-dim", said(s, "reason")));
                group.append(row);
            }
            parts.push(group);
        }
        if (answer.missing.length) {
            parts.push(el("div", "bl-warn", t("batch.export_missing_files", { count: answer.missing.length,
            names: [...new Set(answer.missing.flatMap((m) => m.bundles))].join(", ") })));
        }
        done.append(link, back);
        this.root.replaceChildren(...parts, done);
        link.click(); // the browser's own download: nothing is held in the page
    }
}
