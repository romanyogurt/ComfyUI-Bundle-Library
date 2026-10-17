// Importing an export ZIP (Phase 8b), in the library modal's right pane: the
// upload with its progress, then what importing it would do (nothing in the
// library has changed yet) with the choices it takes, then its result. The
// modal runs the upload and the import (LibraryModal.showImport, runImport).
import { BatchResult } from "./batch_panel.js";
import { button, el, formatBytes, formatTime, plural } from "./dom.js";
import { msg, said, t, tn } from "./i18n.js";

// How a bundle of the file stands to this library.
const CONFLICT = {
    none: msg("new here"),
    active: msg("here already"),
    trash: msg("here already, in the trash"),
    unreadable: msg("here already, as a file this version cannot read"),
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
        const cancel = button(t("Cancel upload"));
        cancel.addEventListener("click", () => this.controller.abort());
        this.line = el("div", "bl-hint", t("Uploading {name} ({size})…", { name: this.file.name, size: formatBytes(this.file.size) }));
        const upload = el("div", "bl-upload");
        upload.append(this.line, this.bar, cancel);
        this.root.replaceChildren(el("div", "bl-trash-title", t("Import")), upload);
    }

    progress(sent) {
        this.bar.value = sent;
        if (sent >= 1) this.line.textContent = t("Uploaded {name}; reading it…", { name: this.file.name });
    }

    /** What importing the file would do, and the choices: nothing has changed yet. */
    showPreview(preview) {
        this.preview = preview;
        const { bundles, assets } = preview;
        const importable = bundles.filter((b) => b.importable);
        const here = importable.filter((b) => b.conflict !== "none");
        const head = el("div", "bl-trash-head");
        head.append(el("div", "bl-trash-title", t("Import {name}", { name: preview.file_name ?? this.file.name })));
        const made = [preview.generator, preview.exported_at && t("exported {time}", { time: formatTime(preview.exported_at) })]
            .filter(Boolean);
        const summary = el("div", "bl-batch-summary", [
            `${plural(bundles.length, "bundle")}`,
            t("{count} new here", { count: importable.length - here.length }),
            here.length ? t("{count} here already", { count: here.length }) : null,
            bundles.length - importable.length ? t("{count} cannot be imported", { count: bundles.length - importable.length }) : null,
        ].filter(Boolean).join(" · "));
        const files = el("div", "bl-hint", [
            `${plural(assets.new, "new file")} (${formatBytes(assets.bytes)})`,
            assets.present ? t("{count} here already", { count: assets.present }) : null,
            assets.missing ? t("{count} in neither the file nor the library", { count: assets.missing }) : null,
        ].filter(Boolean).join(" · "));
        const list = el("div", "bl-trash-list");
        list.append(...bundles.map((b) => {
            const row = el("div", "bl-trash-item bl-import-item");
            row.dataset.id = b.id;
            row.dataset.conflict = b.conflict;
            const text = el("div", "bl-list-text");
            text.append(el("div", "bl-list-name", b.name), el("div", "bl-list-sub", [
                b.category ? t("in {category}", { category: b.category }) : null, plural(b.fields, "field"),
                b.tags.length ? b.tags.join(" · ") : null,
            ].filter(Boolean).join(" · ")));
            if (!b.importable) text.append(el("div", "bl-list-warn", `⚠ ${said(b, "reason")}`));
            else if (b.missing_files) {
                text.append(el("div", "bl-list-warn", tn(b.missing_files, "⚠ {count} file it uses is not in the file or the library",
                    "⚠ {count} files it uses are not in the file or the library")));
            }
            row.append(text, el("span", `bl-chip bl-import-state ${b.importable ? b.conflict : "out"}`,
                b.importable ? t(CONFLICT[b.conflict]) : t("left out")));
            return row;
        }));
        const choices = el("div", "bl-import-choices");
        if (here.length) {
            choices.append(...choice(t("Bundles here already"), "bl-import-conflict", [
                ["skip", t("Leave them as they are")],
                ["overwrite", t("Replace them with the file's version (one in the trash comes back)")],
                ["copy", t("Import them as new bundles beside them")],
            ], this.conflict, (value) => { this.conflict = value; }),
            el("div", "bl-hint", t("One here that this version cannot read or change is never replaced.")));
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
        const modes = [["zip", t("As in the file (a category with the same name, made if it is not here)")],
            ...(this.modal.categories.length ? [["one", t("All into one category:")]] : []), ["none", t("Uncategorized")]];
        choices.append(...choice(t("Categories"), "bl-import-mode", modes, this.mode, (value) => {
            this.mode = value;
            select.disabled = value !== "one";
        }, { one: select }));
        select.disabled = this.mode !== "one";
        const go = button(t("Import {bundles}", { bundles: plural(importable.length, "bundle") }), "bl-btn primary bl-import-go");
        go.disabled = importable.length === 0;
        go.addEventListener("click", () => void this.modal.runImport(this));
        const cancel = button(t("Cancel"));
        cancel.addEventListener("click", () => this.modal.cancelImport());
        const actions = el("div", "bl-batch-actions");
        actions.append(go, cancel);
        this.root.replaceChildren(head, ...(made.length ? [el("div", "bl-hint", made.join(" · "))] : []), summary, files, list,
            choices, el("div", "bl-hint", t("Favorites are not imported. Names may repeat; bundles are told apart by their ids.")),
            actions);
        this.modal.keepFocus();
    }

    /** The choices as the API takes them. */
    choices() {
        return { conflict: this.conflict, category: this.mode === "one" ? { mode: "one", id: this.categoryId } : { mode: this.mode } };
    }

    /** The upload or its preview failed: say why, with a way back. */
    showError(message) {
        const back = button(t("Done"), "bl-btn primary");
        back.addEventListener("click", () => this.modal.leaveResult());
        this.root.replaceChildren(el("div", "bl-trash-title", t("Import")), el("div", "bl-error", message), back);
    }
}

// How each outcome of an import is listed in its result, in this order.
const OUTCOMES = [
    ["failed", msg("Not imported")],
    ["new", msg("New here")],
    ["overwritten", msg("Replaced with the file's version")],
    ["copied", msg("Imported beside the bundles here")],
    ["skipped", msg("Here already: left as they are")],
];

/** What an import did, by the names the bundles have in the file. */
export class ImportResult extends BatchResult {
    render({ answer, unknown, refused }) {
        this.root.classList.remove("waiting");
        const { job, modal } = this;
        const back = button(t("Done"), "bl-btn primary");
        back.addEventListener("click", () => modal.leaveResult());
        const done = el("div", "bl-batch-actions");
        if (unknown || refused) {
            const reload = button(t("Reload the list"));
            reload.addEventListener("click", () => void modal.reload());
            // The server runs an import once and keeps its answer for an hour: asking again is safe (R22-02).
            const check = button(t("Check again"));
            check.addEventListener("click", () => void modal.checkImport(job));
            const [title, kind, text, actions] = unknown ? [t("Could not tell whether it finished"), "bl-warn",
                t("The import was sent, but no answer came back. The server may have imported all, some or none of it. "
                    + "Check again for its answer, or reload the list to see where things stand."), [check, reload]]
                : refused.code === "import_running" ? [t("Still running"), "bl-warn", refused.message, [check, reload]]
                    : refused.code === "import_interrupted" ? [t("Cut off"), "bl-warn", refused.message, [reload]]
                        : [job.checked ? t("No answer kept") : t("Nothing was imported"), job.checked ? "bl-warn" : "bl-error",
                            job.checked ? t("{message} Reload the list to see where things stand.", { message: refused.message })
                                : refused.message, job.checked ? [reload] : []];
            done.append(...actions, back);
            this.root.replaceChildren(el("div", "bl-batch-title", title), el("div", kind, text), done);
            return;
        }
        const names = new Map(job.summaries.map((b) => [b.id, b.label]));
        const parts = [el("div", "bl-batch-title", job.describe.done), el("div", "bl-batch-summary", [
            t("{count} imported", { count: answer.imported }),
            answer.skipped ? t("{count} left as they are", { count: answer.skipped }) : null,
            answer.failed ? t("{count} not imported", { count: answer.failed }) : null,
            `${plural(answer.files.stored, "new file")}`,
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
                if (r.restored) row.append(el("span", "bl-dim", t("back from the trash")));
                if (r.warning) row.append(el("span", "bl-warn", said(r, "warning"))); // done, but not synced to the disk (R22-05)
                group.append(row);
            }
            parts.push(group);
        }
        if (answer.categories_created.length) {
            parts.push(el("div", "bl-hint", t("Categories made: {names}.", { names: answer.categories_created.map((c) => c.name).join(", ") })));
        }
        if (answer.placement_error) {
            parts.push(el("div", "bl-warn", t("Imported, but not put in categories: {reason}", { reason: said(answer, "placement_error") })));
        }
        if (answer.warning) parts.push(el("div", "bl-warn", t("Their places in categories: {warning}", { warning: said(answer, "warning") })));
        if (answer.replayed) parts.push(el("div", "bl-hint", t("This is the answer the server kept from when the import ran.")));
        if (answer.files.failed.length) {
            parts.push(el("div", "bl-warn", tn(answer.files.failed.length, "{count} file could not be imported: {reasons}",
                "{count} files could not be imported: {reasons}", { reasons: answer.files.failed.map((f) => said(f, "reason")).join("; ") })));
        }
        done.append(back);
        this.root.replaceChildren(...parts, done);
    }
}
