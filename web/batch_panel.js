// What the library modal's right pane shows for several bundles at once:
// the selection and what can be done to all of it (BatchPanel), a change
// being sent, and its result (BatchResult). The modal runs the change
// (LibraryModal.runBatch); these only draw.
import { thumbnailURL } from "./api.js";
import { button, el, icon, plural } from "./dom.js";

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

export class BatchPanel {
    /** `bundles`: the selected summaries, in list order. */
    constructor(modal, bundles) {
        this.modal = modal;
        this.root = el("div", "bl-batch");
        this.show(bundles);
    }

    show(bundles) {
        this.bundles = bundles;
        const { modal } = this;
        const head = el("div", "bl-batch-head");
        const clear = button("Clear selection");
        clear.addEventListener("click", () => modal.clearSelection());
        head.append(el("div", "bl-batch-title", `${plural(bundles.length, "bundle")} selected`), clear);

        const names = el("div", "bl-batch-names");
        const categories = new Map(modal.categories.map((c) => [c.id, c.name]));
        names.append(...bundles.map((bundle) => {
            const row = el("div", "bl-batch-name");
            row.dataset.id = bundle.id;
            const text = el("div", "bl-list-text");
            text.append(el("div", "bl-list-name", modal.labels?.get(bundle.id) ?? bundle.name),
                el("div", "bl-list-sub", [categories.get(bundle.category) ?? "Uncategorized", bundle.favorite ? "★" : null,
                    bundle.read_only ? "🔒 cannot be changed by this version" : null].filter(Boolean).join(" · ")));
            row.append(thumb(bundle), text);
            return row;
        }));

        const why = modal.organizeBlocker;
        const place = el("div", "bl-batch-row");
        this.categorySelect = el("select", "bl-input bl-batch-category");
        for (const [value, label] of [["", "No category"], ...modal.categories.map((c) => [c.id, c.name])]) {
            const option = el("option", null, label);
            option.value = value;
            this.categorySelect.append(option);
        }
        const move = button("Move", "bl-btn primary");
        move.addEventListener("click", () => {
            const category = this.categorySelect.value || null;
            void modal.runBatch("set_category", { category }, this.bundles);
        });
        place.append(el("span", "bl-label", "Category"), this.categorySelect, move);

        const stars = el("div", "bl-batch-row");
        const add = button("", "bl-btn");
        add.append("★ Add to favorites");
        add.addEventListener("click", () => void modal.runBatch("set_favorite", { favorite: true }, this.bundles));
        const remove = button("", "bl-btn");
        remove.append("☆ Remove from favorites");
        remove.addEventListener("click", () => void modal.runBatch("set_favorite", { favorite: false }, this.bundles));
        stars.append(el("span", "bl-label", "Favorites"), add, remove);
        for (const control of [this.categorySelect, move, add, remove]) {
            control.disabled = !!why;
            if (why) control.title = why;
        }

        const trash = el("div", "bl-batch-row");
        const toTrash = button("", "bl-btn danger");
        toTrash.append(icon("trash"), " Move to trash…");
        toTrash.addEventListener("click", () => void modal.runBatch("trash", {}, this.bundles));
        trash.append(el("span", "bl-label", "Trash"), toTrash);
        const locked = bundles.filter((b) => b.read_only).length;
        if (locked) {
            trash.append(el("span", "bl-hint", `${plural(locked, "bundle")} this version cannot change will be left out.`));
        }

        this.root.replaceChildren(head, names, place, stars, trash);
    }
}

// How each kind of refusal is listed in a result, most useful first.
const OUTCOMES = [
    ["retry", "Not done; trying again may work"],
    ["revision_conflict", "Changed elsewhere since you selected it; not moved"],
    ["protected", "This version cannot change these; left as they are"],
    ["not_found", "No longer in the library"],
    ["in_trash", "In the trash"],
    ["other", "Not done"],
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
        const stop = button("Stop waiting");
        stop.addEventListener("click", () => this.modal.stopWaiting(this.job));
        this.stall.append(el("div", "bl-hint", "No answer yet. You can stop waiting; the server may still finish it."), stop);
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
        const back = button("Done", "bl-btn primary");
        back.addEventListener("click", () => modal.leaveResult());
        const parts = [];
        if (unknown) {
            parts.push(el("div", "bl-batch-title", "Could not tell whether it finished"),
                el("div", "bl-warn", `${job.describe.what} was sent, but no answer came back. The server may have done all, `
                    + "some or none of it. Reload the list to see where things stand."));
            const reload = button("Reload the list");
            reload.addEventListener("click", () => void modal.reload());
            const again = button("Try again");
            again.addEventListener("click", () => void modal.retryBatch(job, job.summaries.map((b) => b.id)));
            done.append(reload, again, back);
        } else if (refused) {
            parts.push(el("div", "bl-batch-title", "Nothing was changed"), el("div", "bl-error", refused.message));
            done.append(back);
        } else {
            const results = answer.results;
            const changed = results.filter((r) => r.ok && r.changed);
            const unchanged = results.filter((r) => r.ok && !r.changed);
            const failed = results.filter((r) => !r.ok);
            parts.push(el("div", "bl-batch-title", job.describe.done),
                el("div", "bl-batch-summary", [`${changed.length} changed`, unchanged.length ? `${unchanged.length} already so` : null,
                    failed.length ? `${failed.length} not done` : null].filter(Boolean).join(" · ")));
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
                    group.append(row);
                }
                parts.push(group);
            };
            for (const [kind, title] of OUTCOMES) list(title, failed.filter((r) => kindOf(r) === kind), kind);
            list("Changed", changed, "changed");
            list("Already so", unchanged, "unchanged");
            const retryable = failed.filter((r) => r.retry).map((r) => r.id);
            if (retryable.length) {
                const again = button(`Try again with ${plural(retryable.length, "bundle")}`);
                again.addEventListener("click", () => void modal.retryBatch(job, retryable));
                done.append(again);
            }
            done.append(back);
        }
        this.root.replaceChildren(...parts, done);
    }
}
