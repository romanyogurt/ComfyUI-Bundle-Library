// A full-size image over the whole page, opened from a node preview. Like the
// library modal, it keeps keys, wheel and pointer events away from ComfyUI.
import { el } from "./dom.js";

const KEY_EVENTS = ["keydown", "keyup", "keypress"];
const POINTER_EVENTS = ["pointerdown", "pointermove", "pointerup", "wheel", "contextmenu", "dragover", "drop"];

let current = null;

export function showImage(url, caption) {
    current?.close();
    const overlay = el("div", "bl-overlay bl-lightbox");
    const box = el("div", "bl-viewer");
    const img = el("img");
    img.src = url;
    img.alt = caption;
    box.append(img, el("div", "bl-viewer-caption", caption));
    overlay.append(box);

    // The page has the focus, so keys arrive on <body>: catch them on window first.
    const onKey = (e) => {
        e.stopPropagation();
        if (e.type !== "keydown") return;
        if (e.key === "Escape") {
            e.preventDefault();
            close();
        } else if (e.ctrlKey || e.metaKey) {
            e.preventDefault(); // ComfyUI normally cancels these (Ctrl+S would save the page)
        }
    };
    const close = () => {
        overlay.remove();
        for (const type of KEY_EVENTS) window.removeEventListener(type, onKey, true);
        current = null;
    };
    for (const type of KEY_EVENTS) window.addEventListener(type, onKey, true);
    for (const type of POINTER_EVENTS) overlay.addEventListener(type, (e) => e.stopPropagation());
    overlay.addEventListener("click", close);
    document.body.append(overlay);
    current = { close };
}
