// Importing an export ZIP (Phase 8b), in the library modal's right pane: the
// upload with its progress, then what importing it would do (nothing in the
// library has changed yet) with the choices it takes, then its result. The
// modal runs the upload and the import (LibraryModal.showImport, runImport).
import { BatchResult } from "./batch_panel.js";
import { button, el, formatBytes, formatTime, plural } from "./dom.js";

// How a bundle of the file stands to this library.
const CONFLICT = {
    none: "new here",
    active: "here already",
    trash: "here already, in the trash",
    unreadable: "here already, as a file this version cannot read",
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
        const cancel = button("Cancel upload");
        cancel.addEventListener("click", () => this.controller.abort());
        this.line = el("div", "bl-hint", `Uploading ${this.file.name} (${formatBytes(this.file.size)})…`);
        const upload = el("div", "bl-upload");
        upload.append(this.line, this.bar, cancel);
        this.root.replaceChildren(el("div", "bl-trash-title", "Import"), upload);
    }

    progress(sent) {
        this.bar.value = sent;
        if (sent >= 1) this.line.textContent = `Uploaded ${this.file.name}; reading it…`;
    }

    /** What importing the file would do, and the choices: nothing has changed yet. */
    showPreview(preview) {
        this.preview = preview;
        const { bundles, assets } = preview;
        const importable = bundles.filter((b) => b.importable);
        const here = importable.filter((b) => b.conflict !== "none");
        const head = el("div", "bl-trash-head");
        head.append(el("div", "bl-trash-title", `Import ${preview.file_name ?? this.file.name}`));
        const made = [preview.generator, preview.exported_at && `exported ${formatTime(preview.exported_at)}`].filter(Boolean);
        const summary = el("div", "bl-batch-summary", [
            `${plural(bundles.length, "bundle")}`,
            `${importable.length - here.length} new here`,
            here.length ? `${here.length} here already` : null,
            bundles.length - importable.length ? `${bundles.length - importable.length} cannot be imported` : null,
        ].filter(Boolean).join(" · "));
        const files = el("div", "bl-hint", [
            `${plural(assets.new, "new file")} (${formatBytes(assets.bytes)})`,
            assets.present ? `${assets.present} here already` : null,
            assets.missing ? `${assets.missing} in neither the file nor the library` : null,
        ].filter(Boolean).join(" · "));
        const list = el("div", "bl-trash-list");
        list.append(...bundles.map((b) => {
            const row = el("div", "bl-trash-item bl-import-item");
            row.dataset.id = b.id;
            row.dataset.conflict = b.conflict;
            const text = el("div", "bl-list-text");
            text.append(el("div", "bl-list-name", b.name), el("div", "bl-list-sub", [
                b.category ? `in ${b.category}` : null, plural(b.fields, "field"), b.tags.length ? b.tags.join(" · ") : null,
            ].filter(Boolean).join(" · ")));
            if (!b.importable) text.append(el("div", "bl-list-warn", `⚠ ${b.reason}`));
            else if (b.missing_files) text.append(el("div", "bl-list-warn", `⚠ ${plural(b.missing_files, "file")} it uses `
                + `${b.missing_files === 1 ? "is" : "are"} not in the file or the library`));
            row.append(text, el("span", `bl-chip bl-import-state ${b.importable ? b.conflict : "out"}`,
                b.importable ? CONFLICT[b.conflict] : "left out"));
            return row;
        }));
        const choices = el("div", "bl-import-choices");
        if (here.length) {
            choices.append(...choice("Bundles here already", "bl-import-conflict", [
                ["skip", "Leave them as they are"],
                ["overwrite", "Replace them with the file's version (one in the trash comes back)"],
                ["copy", "Import them as new bundles beside them"],
            ], this.conflict, (value) => { this.conflict = value; }),
            el("div", "bl-hint", "One here that this version cannot read or change is never replaced."));
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
        const modes = [["zip", "As in the file (a category with the same name, made if it is not here)"],
            ...(this.modal.categories.length ? [["one", "All into one category:"]] : []), ["none", "Uncategorized"]];
        choices.append(...choice("Categories", "bl-import-mode", modes, this.mode, (value) => {
            this.mode = value;
            select.disabled = value !== "one";
        }, { one: select }));
        select.disabled = this.mode !== "one";
        const go = button(`Import ${plural(importable.length, "bundle")}`, "bl-btn primary bl-import-go");
        go.disabled = importable.length === 0;
        go.addEventListener("click", () => void this.modal.runImport(this));
        const cancel = button("Cancel");
        cancel.addEventListener("click", () => this.modal.cancelImport());
        const actions = el("div", "bl-batch-actions");
        actions.append(go, cancel);
        this.root.replaceChildren(head, ...(made.length ? [el("div", "bl-hint", made.join(" · "))] : []), summary, files, list,
            choices, el("div", "bl-hint", "Favorites are not imported. Names may repeat; bundles are told apart by their ids."),
            actions);
        this.modal.keepFocus();
    }

    /** The choices as the API takes them. */
    choices() {
        return { conflict: this.conflict, category: this.mode === "one" ? { mode: "one", id: this.categoryId } : { mode: this.mode } };
    }

    /** The upload or its preview failed: say why, with a way back. */
    showError(message) {
        const back = button("Done", "bl-btn primary");
        back.addEventListener("click", () => this.modal.leaveResult());
        this.root.replaceChildren(el("div", "bl-trash-title", "Import"), el("div", "bl-error", message), back);
    }
}

// How each outcome of an import is listed in its result, in this order.
const OUTCOMES = [
    ["failed", "Not imported"],
    ["new", "New here"],
    ["overwritten", "Replaced with the file's version"],
    ["copied", "Imported beside the bundles here"],
    ["skipped", "Here already: left as they are"],
];

/** What an import did, by the names the bundles have in the file. */
export class ImportResult extends BatchResult {
    render({ answer, unknown, refused }) {
        this.root.classList.remove("waiting");
        const { job, modal } = this;
        const back = button("Done", "bl-btn primary");
        back.addEventListener("click", () => modal.leaveResult());
        const done = el("div", "bl-batch-actions");
        if (unknown || refused) {
            const reload = button("Reload the list");
            reload.addEventListener("click", () => void modal.reload());
            done.append(...(unknown ? [reload] : []), back);
            this.root.replaceChildren(el("div", "bl-batch-title", unknown ? "Could not tell whether it finished" : "Nothing was imported"),
                el(unknown ? "div" : "div", unknown ? "bl-warn" : "bl-error", unknown
                    ? "The import was sent, but no answer came back. The server may have imported all, some or none of it. "
                    + "Reload the list to see where things stand." : refused.message), done);
            return;
        }
        const names = new Map(job.summaries.map((b) => [b.id, b.label]));
        const parts = [el("div", "bl-batch-title", job.describe.done), el("div", "bl-batch-summary", [
            `${answer.imported} imported`, answer.skipped ? `${answer.skipped} left as they are` : null,
            answer.failed ? `${answer.failed} not imported` : null,
            `${plural(answer.files.stored, "new file")}`,
        ].filter(Boolean).join(" · "))];
        for (const [kind, title] of OUTCOMES) {
            const items = answer.results.filter((r) => (kind === "failed" ? !r.ok : r.ok && r.as === kind));
            if (!items.length) continue;
            const group = el("div", `bl-batch-outcome ${kind === "failed" ? "other" : "changed"}`);
            group.dataset.outcome = kind;
            group.append(el("div", "bl-batch-outcome-title", `${title} (${items.length})`));
            for (const r of items) {
                const row = el("div", "bl-batch-outcome-row");
                row.dataset.id = r.id;
                row.append(el("span", "bl-list-name", names.get(r.source) ?? r.source));
                if (!r.ok) row.append(el("span", "bl-dim", r.message));
                if (r.restored) row.append(el("span", "bl-dim", "back from the trash"));
                group.append(row);
            }
            parts.push(group);
        }
        if (answer.categories_created.length) {
            parts.push(el("div", "bl-hint", `Categories made: ${answer.categories_created.map((c) => c.name).join(", ")}.`));
        }
        if (answer.placement_error) parts.push(el("div", "bl-warn", `Imported, but not put in categories: ${answer.placement_error}`));
        if (answer.files.failed.length) {
            parts.push(el("div", "bl-warn", `${plural(answer.files.failed.length, "file")} could not be imported: `
                + `${answer.files.failed.map((f) => f.reason).join("; ")}`));
        }
        done.append(back);
        this.root.replaceChildren(...parts, done);
    }
}
