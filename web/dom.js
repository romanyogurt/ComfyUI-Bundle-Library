// Small DOM helpers. User data only ever goes in through textContent and
// attributes, never innerHTML.

import { msg, t } from "./i18n.js";

const KINDS = { image: msg("image"), video: msg("video"), audio: msg("audio") };

/** A file's kind in words: "image", "video" or "audio" in English. */
export const kindName = (kind) => (kind in KINDS ? t(KINDS[kind]) : kind);

export function el(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
}

export function button(label, className = "bl-btn", title) {
    const element = el("button", className, label);
    element.type = "button";
    if (title) element.title = title;
    return element;
}

/** A PrimeIcons icon (ComfyUI's frontend ships them), hidden from assistive technology. */
export function icon(name) {
    const element = el("i", `pi pi-${name}`);
    element.setAttribute("aria-hidden", "true");
    return element;
}

/** A name (of an output or a field) set apart from the sentence around it. */
export function code(text) {
    return el("code", "bl-code", text);
}

/** `names` as code, separated by commas; spread it into append(). */
export function codeList(names) {
    return names.flatMap((name, i) => (i ? [", ", code(name)] : [code(name)]));
}

/**
 * A button that opens a popup menu.
 * - `content`: the button's text, or an element (an icon; give `label` then).
 * - `items`: [text, action] pairs, or {text, action, checked?, count?, value?}
 *   objects; or a function that returns them, called each time it opens.
 *   With `checked` the items are a choice of one (menuitemradio).
 * - options: className (of the button), title, label (its accessible name),
 *   up (open above the button), search (placeholder of a box that narrows
 *   the items by text; items with `always` stay), empty (text when none match).
 * Keyboard: ↓ or ↑ on the button opens it; ↑/↓, Home and End move; Enter or
 * Space chooses; Esc closes it and returns to the button; Tab closes it.
 * The library modal also closes it on a click elsewhere (closeMenus()).
 */
export function menu(content, items, { className = "bl-btn", title, label, up = false, search = null,
    empty = t("Nothing to choose.") } = {}) {
    const root = el("span", "bl-menu-wrap");
    const opener = button(typeof content === "string" ? content : "", className, title);
    if (typeof content !== "string") opener.append(content);
    if (label) opener.setAttribute("aria-label", label);
    opener.setAttribute("aria-haspopup", "menu");
    opener.setAttribute("aria-expanded", "false");
    const popup = el("div", up ? "bl-menu up" : "bl-menu");
    popup.hidden = true;
    const list = el("div", "bl-menu-list");
    list.setAttribute("role", "menu");
    if (label || typeof content === "string") list.setAttribute("aria-label", label ?? content);
    let filter = null;
    if (search) {
        filter = el("input", "bl-input bl-menu-search");
        filter.type = "search";
        filter.placeholder = search;
        filter.setAttribute("aria-label", search);
        popup.append(filter);
    }
    popup.append(list);
    let shown = [];
    const entries = () => [...list.querySelectorAll(".bl-menu-item")];

    const fill = () => {
        const query = filter?.value.trim().toLowerCase() ?? "";
        const matching = shown.filter((item) => !query || item.always || item.text.toLowerCase().includes(query));
        list.replaceChildren(...matching.map((item) => {
            const entry = button("", "bl-menu-item");
            entry.tabIndex = -1;
            entry.setAttribute("role", item.checked === undefined ? "menuitem" : "menuitemradio");
            if (item.checked !== undefined) {
                entry.setAttribute("aria-checked", String(!!item.checked));
                entry.append(el("span", "bl-menu-check", item.checked ? "✓" : ""));
            }
            entry.append(el("span", "bl-menu-text", item.text));
            if (item.count !== undefined) entry.append(el("span", "bl-menu-count", String(item.count)));
            if (item.value !== undefined) entry.dataset.value = item.value;
            entry.addEventListener("click", () => {
                close(true);
                item.action();
            });
            return entry;
        }));
        if (!matching.length) list.append(el("div", "bl-menu-empty", empty));
    };

    const close = (focusOpener = false) => {
        if (popup.hidden) return;
        popup.hidden = true;
        opener.setAttribute("aria-expanded", "false");
        if (focusOpener) opener.focus({ preventScroll: true });
    };
    popup.close = close; // for closeMenus()

    const open = (last = false) => {
        shown = (typeof items === "function" ? items() : items)
            .map((item) => (Array.isArray(item) ? { text: item[0], action: item[1] } : item));
        if (filter) filter.value = "";
        fill();
        popup.hidden = false;
        opener.setAttribute("aria-expanded", "true");
        if (!up) popup.scrollIntoView({ block: "nearest" }); // "+ Add field" sits at the bottom
        const choices = entries();
        const target = filter ?? (last ? choices.at(-1) : choices.find((e) => e.getAttribute("aria-checked") === "true")
            ?? choices[0]);
        target?.focus({ preventScroll: true });
    };

    opener.addEventListener("click", () => (popup.hidden ? open() : close()));
    opener.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        e.preventDefault();
        open(e.key === "ArrowUp");
    });
    filter?.addEventListener("input", fill);
    popup.addEventListener("keydown", (e) => {
        const choices = entries();
        const at = choices.indexOf(document.activeElement);
        const move = (index) => choices[(index + choices.length) % choices.length]?.focus({ preventScroll: true });
        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation(); // closes the menu only, not the library
            close(true);
        } else if (e.key === "Tab") {
            close();
        } else if (e.key === "ArrowDown") {
            e.preventDefault();
            move(at + 1); // from the search box (at -1) to the first item
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            if (at <= 0 && filter) filter.focus();
            else move(at - 1);
        } else if ((e.key === "Home" || e.key === "End") && at >= 0) {
            e.preventDefault();
            move(e.key === "Home" ? 0 : -1);
        } else if (e.key === "Enter" && e.target === filter) {
            e.preventDefault();
            choices[0]?.click(); // the first match
        }
    });
    root.append(opener, popup);
    return { root, opener };
}

/** Close the open popup menus in `root` that do not contain `except`; whether any was open. */
export function closeMenus(root, except = null) {
    let closed = false;
    for (const popup of root.querySelectorAll(".bl-menu:not([hidden])")) {
        if (except && popup.parentElement.contains(except)) continue;
        popup.close(popup.contains(document.activeElement)); // the focus goes back to its button

        closed = true;
    }
    return closed;
}

export { plural } from "./i18n.js"; // "3 bundles", "번들 3개"

/** "2026-10-15 07:45", in the browser's time zone. */
export function formatTime(iso) {
    const time = new Date(iso);
    const two = (n) => String(n).padStart(2, "0");
    return `${time.getFullYear()}-${two(time.getMonth() + 1)}-${two(time.getDate())} ${two(time.getHours())}:${two(time.getMinutes())}`;
}

export function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "0:42", or "1:02:03" from an hour on. */
export function formatDuration(seconds) {
    const total = Math.round(seconds);
    const [h, m, s] = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60];
    const two = (n) => String(n).padStart(2, "0");
    return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}
