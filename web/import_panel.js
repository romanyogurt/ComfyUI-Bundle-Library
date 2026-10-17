// Importing an export ZIP (Phase 8b), in the library modal's right pane: the
// upload with its progress, then what importing it would do (nothing in the
// library has changed yet) with the choices it takes, then its result. The
// modal runs the upload and the import (LibraryModal.showImport, runImport).
import { BatchResult } from "./batch_panel.js";
import { button, el, formatBytes, formatTime } from "./dom.js";
import { msg, said, t } from "./i18n.js";

// How a bundle of the file stands to this library.
const CONFLICT = {
    none: msg("import.new_here"),
    active: msg("import.existing"),
    trash: msg("import.existing_in_trash"),
    unreadable: msg("import.existing_unreadable"),
};

/**
 * A group of radio buttons named `title` (shown above it): [[value, label]],
 * `chosen` and `onChange(value)`; `after[value]` goes under its button.
 */
function choice(title, name, options, chosen, onChange, after = {}) {
    const group = el("div", "bl-import-choice");
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", title);
    for (const [value, label] of options) {
        const line = el("label", "bl-import-option");
        const radio = el("input");
        radio.type = "radio";
        radio.name = name;
        radio.value = value;
        radio.checked = value === chosen;
        radio.addEventListener("change", () => {
            if (radio.checked) onChange(value);
        });
        line.append(radio, label);
        group.append(line);
        if (after[value]) group.append(after[value]);
    }
    return [el("div", "bl-label", title), group];
}

export class ImportPanel {
    constructor(modal, file) {
        this.modal = modal;
        this.file = file;
        this.controller = new AbortController();
        this.preview = null;
        this.sent = false; // whether Import was pressed: the upload is the import's then
        // What the user chose, kept when the panel is drawn again.
        this.conflict = "skip";
        this.mode = "zip";
        this.categoryId = "";
        this.root = el("div", "bl-trash bl-import");
        this.renderUpload();
    }

    renderUpload() {
        this.bar = el("progress", "bl-progress");
        this.bar.max = 1;
        this.bar.value = 0;
        const cancel = button(t("common.cancel_upload"));
        cancel.addEventListener("click", () => this.controller.abort());
        this.line = el("div", "bl-hint", t("import.uploading", { name: this.file.name, size: formatBytes(this.file.size) }));
        const upload = el("div", "bl-upload");
        upload.append(this.line, this.bar, cancel);
        this.root.replaceChildren(el("div", "bl-trash-title", t("import.import")), upload);
    }

    progress(sent) {
        this.bar.value = sent;
        if (sent >= 1) this.line.textContent = t("import.uploaded_reading", { name: this.file.name });
    }

    /** What importing the file would do, and the choices: nothing has changed yet. */
    showPreview(preview) {
        this.preview = preview;
        const { bundles, assets } = preview;
        const importable = bundles.filter((b) => b.importable);
        const here = importable.filter((b) => b.conflict !== "none");
        const head = el("div", "bl-trash-head");
        head.append(el("div", "bl-trash-title", t("import.import_name", { name: preview.file_name ?? this.file.name })));
        const made = [preview.generator, preview.exported_at && t("import.exported_at", { time: formatTime(preview.exported_at) })]
            .filter(Boolean);
        const summary = el("div", "bl-batch-summary", [
            `${t("count.bundles", { count: bundles.length })}`,
            t("import.count_new", { count: importable.length - here.length }),
            here.length ? t("import.count_existing", { count: here.length }) : null,
            bundles.length - importable.length ? t("import.count_not_importable", { count: bundles.length - importable.length }) : null,
        ].filter(Boolean).join(" · "));
        const files = el("div", "bl-hint", [
            `${t("count.new_files", { count: assets.new })} (${formatBytes(assets.bytes)})`,
            assets.present ? t("import.count_existing", { count: assets.present }) : null,
            assets.missing ? t("import.count_missing", { count: assets.missing }) : null,
        ].filter(Boolean).join(" · "));
        const list = el("div", "bl-trash-list");
        list.append(...bundles.map((b) => {
            const row = el("div", "bl-trash-item bl-import-item");
            row.dataset.id = b.id;
            row.dataset.conflict = b.conflict;
            const text = el("div", "bl-list-text");
            text.append(el("div", "bl-list-name", b.name), el("div", "bl-list-sub", [
                b.category ? t("import.in_category", { category: b.category }) : null, t("count.fields", { count: b.fields }),
                b.tags.length ? b.tags.join(" · ") : null,
            ].filter(Boolean).join(" · ")));
            if (!b.importable) text.append(el("div", "bl-list-warn", `⚠ ${said(b, "reason")}`));
            else if (b.missing_files) {
                text.append(el("div", "bl-list-warn", t("import.missing_files", { count: b.missing_files })));
            }
            row.append(text, el("span", `bl-chip bl-import-state ${b.importable ? b.conflict : "out"}`,
                b.importable ? t(CONFLICT[b.conflict]) : t("import.left_out")));
            return row;
        }));
        const choices = el("div", "bl-import-choices");
        if (here.length) {
            choices.append(...choice(t("import.existing_title"), "bl-import-conflict", [
                ["skip", t("import.conflict_leave")],
                ["overwrite", t("import.conflict_replace")],
                ["copy", t("import.conflict_new")],
            ], this.conflict, (value) => { this.conflict = value; }),
            el("div", "bl-hint", t("import.locked_kept")));
        }
        const select = el("select", "bl-input bl-import-category");
        for (const c of this.modal.categories) {
            const option = el("option", null, c.name);
            option.value = c.id;
            select.append(option);
        }
        if (this.categoryId && this.modal.categories.some((c) => c.id === this.categoryId)) select.value = this.categoryId;
        this.categoryId = select.value;
        select.addEventListener("change", () => { this.categoryId = select.value; });
        const modes = [["zip", t("import.category_as_file")],
            ...(this.modal.categories.length ? [["one", t("import.category_one")]] : []), ["none", t("common.uncategorized")]];
        choices.append(...choice(t("import.categories_title"), "bl-import-mode", modes, this.mode, (value) => {
            this.mode = value;
            select.disabled = value !== "one";
        }, { one: select }));
        select.disabled = this.mode !== "one";
        const go = button(t("import.import_bundles", { bundles: t("count.bundles", { count: importable.length }) }), "bl-btn primary bl-import-go");
        go.disabled = importable.length === 0;
        go.addEventListener("click", () => void this.modal.runImport(this));
        const cancel = button(t("common.cancel"));
        cancel.addEventListener("click", () => this.modal.cancelImport());
        const actions = el("div", "bl-batch-actions");
        actions.append(go, cancel);
        this.root.replaceChildren(head, ...(made.length ? [el("div", "bl-hint", made.join(" · "))] : []), summary, files, list,
            choices, el("div", "bl-hint", t("import.hint")),
            actions);
        this.modal.keepFocus();
    }

    /** The choices as the API takes them. */
    choices() {
        return { conflict: this.conflict, category: this.mode === "one" ? { mode: "one", id: this.categoryId } : { mode: this.mode } };
    }

    /** The upload or its preview failed: say why, with a way back. */
    showError(message) {
        const back = button(t("common.done"), "bl-btn primary");
        back.addEventListener("click", () => this.modal.leaveResult());
        this.root.replaceChildren(el("div", "bl-trash-title", t("import.import")), el("div", "bl-error", message), back);
    }
}

// How each outcome of an import is listed in its result, in this order.
const OUTCOMES = [
    ["failed", msg("import.not_imported")],
    ["new", msg("import.new_title")],
    ["overwritten", msg("import.replaced")],
    ["copied", msg("import.imported_beside")],
    ["skipped", msg("import.existing_left")],
];

/** What an import did, by the names the bundles have in the file. */
export class ImportResult extends BatchResult {
    render({ answer, unknown, refused }) {
        this.root.classList.remove("waiting");
        const { job, modal } = this;
        const back = button(t("common.done"), "bl-btn primary");
        back.addEventListener("click", () => modal.leaveResult());
        const done = el("div", "bl-batch-actions");
        if (unknown || refused) {
            const reload = button(t("common.reload_list"));
            reload.addEventListener("click", () => void modal.reload());
            // The server runs an import once and keeps its answer for an hour: asking again is safe (R22-02).
            const check = button(t("import.check_again"));
            check.addEventListener("click", () => void modal.checkImport(job));
            const [title, kind, text, actions] = unknown ? [t("common.unknown_outcome"), "bl-warn",
                t("import.sent_no_answer"), [check, reload]]
                : refused.code === "import_running" ? [t("import.still_running"), "bl-warn", refused.message, [check, reload]]
                    : refused.code === "import_interrupted" ? [t("import.cut_off"), "bl-warn", refused.message, [reload]]
                        : [job.checked ? t("import.no_answer_kept") : t("import.nothing_imported"), job.checked ? "bl-warn" : "bl-error",
                            job.checked ? t("import.reload_hint", { message: refused.message })
                                : refused.message, job.checked ? [reload] : []];
            done.append(...actions, back);
            this.root.replaceChildren(el("div", "bl-batch-title", title), el("div", kind, text), done);
            return;
        }
        const names = new Map(job.summaries.map((b) => [b.id, b.label]));
        const parts = [el("div", "bl-batch-title", job.describe.done), el("div", "bl-batch-summary", [
            t("import.count_imported", { count: answer.imported }),
            answer.skipped ? t("import.count_left", { count: answer.skipped }) : null,
            answer.failed ? t("import.count_not_imported", { count: answer.failed }) : null,
            `${t("count.new_files", { count: answer.files.stored })}`,
        ].filter(Boolean).join(" · "))];
        for (const [kind, title] of OUTCOMES) {
            const items = answer.results.filter((r) => (kind === "failed" ? !r.ok : r.ok && r.as === kind));
            if (!items.length) continue;
            const group = el("div", `bl-batch-outcome ${kind === "failed" ? "other" : "changed"}`);
            group.dataset.outcome = kind;
            group.append(el("div", "bl-batch-outcome-title", `${t(title)} (${items.length})`));
            for (const r of items) {
                const row = el("div", "bl-batch-outcome-row");
                row.dataset.id = r.id;
                row.append(el("span", "bl-list-name", names.get(r.source) ?? r.source));
                if (!r.ok) row.append(el("span", "bl-dim", said(r, "message")));
                if (r.restored) row.append(el("span", "bl-dim", t("import.back_from_trash")));
                if (r.warning) row.append(el("span", "bl-warn", said(r, "warning"))); // done, but not synced to the disk (R22-05)
                group.append(row);
            }
            parts.push(group);
        }
        if (answer.categories_created.length) {
            parts.push(el("div", "bl-hint", t("import.categories_made", { names: answer.categories_created.map((c) => c.name).join(", ") })));
        }
        if (answer.placement_error) {
            parts.push(el("div", "bl-warn", t("import.imported_not_categorized", { reason: said(answer, "placement_error") })));
        }
        if (answer.warning) parts.push(el("div", "bl-warn", t("import.category_warning", { warning: said(answer, "warning") })));
        if (answer.replayed) parts.push(el("div", "bl-hint", t("import.replayed")));
        if (answer.files.failed.length) {
            parts.push(el("div", "bl-warn", t("import.files_failed", { count: answer.files.failed.length,
                reasons: answer.files.failed.map((f) => said(f, "reason")).join("; ") })));
        }
        done.append(back);
        this.root.replaceChildren(...parts, done);
    }
}
