// A full-size image or a playing video over the whole page, opened from a
// node preview. Like the library modal, it keeps keys, wheel and pointer
// events away from ComfyUI.
import { el } from "./dom.js";

const KEY_EVENTS = ["keydown", "keyup", "keypress"];
const POINTER_EVENTS = ["pointerdown", "pointermove", "pointerup", "wheel", "contextmenu", "dragover", "drop"];

let current = null;

export function showImage(url, caption) {
    const img = el("img");
    img.src = url;
    img.alt = caption;
    show(img, caption, { closeOnClick: true });
}

export function showVideo(url, caption) {
    const video = el("video");
    video.src = url;
    video.controls = true;
    video.autoplay = true;
    // Clicks on the video belong to its controls; the backdrop closes.
    show(video, caption, { closeOnClick: false });
    video.focus();
}

function show(media, caption, { closeOnClick }) {
    current?.close();
    const overlay = el("div", "bl-overlay bl-lightbox");
    const box = el("div", "bl-viewer");
    box.append(media, el("div", "bl-viewer-caption", caption));
    overlay.append(box);

    const handle = (e) => {
        if (e.type !== "keydown") return;
        if (e.key === "Escape") {
            e.preventDefault();
            close();
        } else if (e.ctrlKey || e.metaKey) {
            e.preventDefault(); // ComfyUI normally cancels these (Ctrl+S would save the page)
        }
    };
    // Keys on the video (Space plays and pauses) reach it and stop at the
    // overlay; keys anywhere else (the page keeps the focus) stop on window.
    const onWindowKey = (e) => {
        if (overlay.contains(e.target)) return;
        e.stopPropagation();
        handle(e);
    };
    const close = () => {
        media.pause?.();
        overlay.remove();
        for (const type of KEY_EVENTS) window.removeEventListener(type, onWindowKey, true);
        current = null;
    };
    for (const type of KEY_EVENTS) {
        window.addEventListener(type, onWindowKey, true);
        overlay.addEventListener(type, (e) => {
            e.stopPropagation();
            handle(e);
        });
    }
    for (const type of POINTER_EVENTS) overlay.addEventListener(type, (e) => e.stopPropagation());
    overlay.addEventListener("click", (e) => {
        if (closeOnClick || e.target === overlay) close();
    });
    document.body.append(overlay);
    current = { close };
}
