// Phase 0 stand-in for the library modal: a document.body overlay with a
// search box and a bundle list, enough to check keyboard isolation and the
// picker flow. Phase 4 replaces it with the real editor.
import { listBundles } from "./api.js";

function el(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
}

function fieldSummary(bundle) {
    return bundle.fields.map((f) => `${f.name}:${f.type}`).join(", ");
}

export function openLibrary({ onPick } = {}) {
    document.querySelector(".bl-overlay")?.remove();
    const overlay = el("div", "bl-overlay");
    const dialog = el("div", "bl-dialog");
    const header = el("div", "bl-dialog-header");
    const title = el("div", "bl-dialog-title", onPick ? "Bundle Library — 번들 선택" : "Bundle Library");
    const close = el("button", "bl-close", "✕");
    const search = el("input", "bl-search");
    search.type = "search";
    search.placeholder = "이름·필드 검색";
    const list = el("div", "bl-list");
    header.append(title, close);
    dialog.append(header, search, list);
    overlay.append(dialog);

    const shut = () => overlay.remove();
    close.addEventListener("click", shut);
    overlay.addEventListener("pointerdown", (e) => {
        if (e.target === overlay) shut();
    });
    // The canvas listens on window; nothing typed here may reach it. Its
    // handler is also what cancels the browser's own action for a shortcut
    // (Ctrl+S would save the page), so shortcuts the library keeps for itself
    // are cancelled here.
    for (const type of ["keydown", "keyup", "keypress"]) {
        overlay.addEventListener(type, (e) => {
            e.stopPropagation();
            if (type !== "keydown") return;
            if (e.key === "Escape") shut();
            else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") e.preventDefault();
        });
    }
    overlay.addEventListener("wheel", (e) => e.stopPropagation());

    let bundles = [];
    const render = () => {
        const query = search.value.trim().toLowerCase();
        list.replaceChildren();
        for (const bundle of bundles) {
            const text = `${bundle.name} ${fieldSummary(bundle)}`.toLowerCase();
            if (query && !text.includes(query)) continue;
            const row = el("div", "bl-list-row");
            const info = el("div", "bl-list-info");
            info.append(el("div", "bl-list-name", bundle.name), el("div", "bl-list-fields", fieldSummary(bundle)));
            row.append(info);
            if (onPick) {
                const use = el("button", "bl-use", "이 번들 사용");
                use.addEventListener("click", () => {
                    onPick(bundle);
                    shut();
                });
                row.append(use);
            }
            list.append(row);
        }
    };
    search.addEventListener("input", render);
    document.body.append(overlay);
    search.focus();
    listBundles({ fresh: true }).then((result) => {
        bundles = result;
        render();
    }, (error) => list.replaceChildren(el("div", "bl-bad", `⚠ ${error.message}`)));
}

export function renderSidebar(container) {
    container.replaceChildren();
    const root = el("div", "bl-sidebar");
    const open = el("button", "bl-use", "라이브러리 열기");
    open.addEventListener("click", () => openLibrary());
    const list = el("div", "bl-list");
    root.append(open, list);
    container.append(root);
    listBundles({ fresh: true }).then(
        (bundles) => list.replaceChildren(...bundles.map((b) => el("div", "bl-list-row", b.name))),
        (error) => list.replaceChildren(el("div", "bl-bad", `⚠ ${error.message}`)),
    );
}
