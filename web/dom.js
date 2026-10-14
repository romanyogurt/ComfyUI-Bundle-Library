// Small DOM helpers. User data only ever goes in through textContent and
// attributes, never innerHTML.

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

export const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

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
