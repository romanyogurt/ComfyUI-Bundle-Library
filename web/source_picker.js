// Choosing where a choice field's options come from (0.2.0): the nodes of this
// ComfyUI that have a dropdown, found by their names or category, each with its
// dropdown inputs. An input a choice cannot take its options from is shown
// dimmed, with the reason. Choosing one changes nothing but the source: the
// field's value stays as it is.
import { listChoiceSources } from "./api.js";
import { button, el } from "./dom.js";
import { reasonText } from "./choices.js";
import { t } from "./i18n.js";

const SHOWN = 80; // nodes drawn at once; a filter finds the others

/** What a filter is matched against: the node's names, its category and its inputs. */
const searchText = (entry) => [entry.label, entry.node, entry.category, ...entry.inputs.map((i) => i.input)].join("\n").toLowerCase();

/**
 * Show the nodes with a dropdown over the library window (`modal`'s layer);
 * resolves to the source chosen ({node, input}), or null when none was.
 * `current` is the field's source: it is marked, and choosing it changes nothing (null).
 */
export function pickSource(modal, current) {
    return new Promise((resolve) => {
        const box = el("div", "bl-confirm wide bl-picker bl-source-picker");
        const filter = el("input", "bl-input bl-picker-filter");
        filter.type = "search";
        filter.placeholder = t("source.filter");
        filter.setAttribute("aria-label", t("source.filter"));
        const note = el("div", "bl-hint bl-picker-note", t("common.loading"));
        const list = el("div", "bl-source-list");
        const cancel = button(t("common.cancel"));
        const row = el("div", "bl-confirm-buttons");
        row.append(cancel);
        box.append(el("div", "bl-confirm-title", t("source.title")), el("div", "bl-hint", t("source.hint")), filter, note,
            list, row);
        let nodes = [];
        let done = false;
        let token = null;
        const finish = (source) => {
            if (done) return;
            done = true;
            modal.hideLayer(token); // its own layer only
            resolve(source);
        };
        const choose = (entry, input) => {
            const same = current && current.node === entry.node && current.input === input.input;
            finish(same ? null : { node: entry.node, input: input.input });
        };
        const nodeRow = (entry) => {
            const item = el("div", "bl-source-node");
            item.dataset.node = entry.node;
            const head = el("div", "bl-source-head");
            head.append(el("span", "bl-source-label", entry.label));
            if (entry.label !== entry.node) head.append(el("span", "bl-dim bl-source-id", entry.node));
            if (entry.category) head.append(el("span", "bl-dim bl-source-category", entry.category));
            const inputs = el("div", "bl-source-inputs");
            for (const input of entry.inputs) {
                const choice = button(input.input, "bl-btn bl-source-input");
                choice.dataset.input = input.input;
                if (input.supported) {
                    choice.title = t("source.options", { count: input.count });
                    choice.addEventListener("click", () => choose(entry, input));
                } else {
                    choice.disabled = true;
                    choice.classList.add("unsupported");
                    choice.title = t("source.unsupported", { reason: reasonText(input.reason) });
                }
                if (current?.node === entry.node && current.input === input.input) {
                    choice.classList.add("current");
                    choice.setAttribute("aria-current", "true");
                }
                inputs.append(choice);
            }
            item.append(head, inputs);
            return item;
        };
        const draw = () => {
            const query = filter.value.trim().toLowerCase();
            const matching = query ? nodes.filter((entry) => searchText(entry).includes(query)) : nodes;
            list.replaceChildren(...matching.slice(0, SHOWN).map(nodeRow));
            note.textContent = !nodes.length ? t("source.empty") : !matching.length ? t("source.no_match")
                : matching.length > SHOWN ? t("source.more", { count: matching.length - SHOWN }) : "";
            note.hidden = !note.textContent;
        };
        cancel.addEventListener("click", () => finish(null));
        filter.addEventListener("input", draw);
        token = modal.showLayer(box, () => finish(null));
        filter.focus();
        listChoiceSources().then((answer) => {
            if (done) return;
            // The current source first, then the nodes with something to choose, by name; those with
            // nothing to choose last, to tell why when one is looked for.
            const usable = (entry) => entry.inputs.some((input) => input.supported);
            nodes = answer.nodes.sort((a, b) => (current?.node === b.node) - (current?.node === a.node)
                || usable(b) - usable(a) || a.label.localeCompare(b.label));
            draw();
        }, (error) => {
            if (!done) note.textContent = t("source.failed", { reason: error.message });
        });
    });
}
