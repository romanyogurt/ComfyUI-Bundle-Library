import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { VERSION } from "./version.js";

const PREFIX = "/bundle-library/v1";

/** Fired on window after a request that changed the library. */
export const CHANGED_EVENT = "bundle-library:changed";

// Field types whose value is a file, with the limits and formats of
// bundle_library/constants.py. The server checks the file itself; these only
// spare an upload that would be refused. Browsers name audio types in many
// ways, so video and audio are only checked by their prefix.
export const MEDIA = {
    image: { bytes: 50 * 1024 * 1024, types: ["image/png", "image/jpeg", "image/webp"],
        accept: "image/png,image/jpeg,image/webp", label: "PNG, JPEG and WebP images" },
    video: { bytes: 1024 * 1024 * 1024, prefix: "video/", accept: "video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov",
        label: "MP4, WebM and MOV videos" },
    audio: { bytes: 200 * 1024 * 1024, prefix: "audio/", accept: "audio/*,.wav,.flac,.mp3,.ogg,.opus,.m4a",
        label: "WAV, FLAC, MP3, OGG and M4A audio files" },
};

/** Why `file` cannot go in a field of `kind`, or null. */
export function fileProblem(file, kind) {
    const spec = MEDIA[kind];
    const typed = !file.type || (spec.types ? spec.types.includes(file.type) : file.type.startsWith(spec.prefix));
    if (!typed) return `Only ${spec.label} are accepted.`;
    if (file.size > spec.bytes) {
        const limit = spec.bytes >= 1024 ** 3 ? `${spec.bytes / 1024 ** 3} GB` : `${spec.bytes / 1024 ** 2} MB`;
        return `The file is larger than ${limit}.`;
    }
    return null;
}

/** Numeric parts of "0.0.11", to tell which of two versions is newer. */
function versionParts(version) {
    return String(version).split(".").map((part) => Number.parseInt(part, 10) || 0);
}

function newer(a, b) {
    const [x, y] = [versionParts(a), versionParts(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
    }
    return false;
}

let versionWarned = false;

/**
 * Say, once per page, that this page and the server run different versions,
 * and what fixes it: files updated without a restart, or a page left open
 * across one. The server refuses this page's changes until then.
 */
export function warnVersionMismatch(server, page = VERSION) {
    if (versionWarned || server === page) return;
    versionWarned = true;
    const detail = newer(page, server)
        ? `Bundle Library was updated to ${page}, but ComfyUI still runs ${server}. Restart ComfyUI to finish the update.`
        : `ComfyUI runs Bundle Library ${server}, but this page has ${page}. Reload the page.`;
    app.extensionManager?.toast?.add({ severity: "warn", summary: "Bundle Library",
        detail: `${detail} Until then the library cannot be changed from this page.` });
}

/** Compare this page's version with the server's (on start). */
export async function checkVersion() {
    try {
        const response = await api.fetchApi(`${PREFIX}/health`);
        if (response.ok) warnVersionMismatch((await response.json()).version);
    } catch {
        // the library's own requests report an unreachable server
    }
}

/** A refused request: `status` is the HTTP status, `code` and `details` come from the error body. */
export class ApiError extends Error {
    constructor(message, status, code, details) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details ?? {};
    }
}

/** `changes`: whether a successful non-GET request changed the bundles (an upload does not). */
async function request(path, options = {}, { changes = true } = {}) {
    const method = options.method ?? "GET";
    const headers = { ...(options.headers ?? {}) };
    if (method !== "GET") {
        headers["X-Bundle-Library"] = "1";
        headers["X-Bundle-Library-Version"] = VERSION; // the server refuses writes from another version
    }
    let response;
    try {
        response = await api.fetchApi(PREFIX + path, { ...options, method, headers });
    } catch (error) {
        throw new ApiError(`Could not reach ComfyUI: ${error.message}`, 0, "network");
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) {
        const detail = body?.error;
        if (detail?.code === "version_mismatch") warnVersionMismatch(detail.server_version);
        throw new ApiError(detail?.message ?? `${method} ${path}: HTTP ${response.status}`,
            response.status, detail?.code, detail);
    }
    if (method !== "GET" && changes) {
        forgetBundles();
        window.dispatchEvent(new CustomEvent(CHANGED_EVENT));
    }
    return body;
}

function json(method, data) {
    return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) };
}

let listing = null;

/**
 * The library as the list shows it: {bundles (summaries with category and
 * favorite), errors (files this version cannot use), categories (by name),
 * organization}. Cached until `fresh` is set or `forgetBundles()` runs.
 */
export async function listLibrary({ fresh = false } = {}) {
    if (fresh || !listing) {
        listing = request("/bundles");
        listing.catch(() => { listing = null; });
    }
    return listing;
}

/** All bundle summaries in use. */
export async function listBundles(options) {
    return (await listLibrary(options)).bundles;
}

export function forgetBundles() {
    listing = null;
}

/** Ids of the bundles whose name, tags, field names or text values contain `query`. */
export async function searchBundleIds(query) {
    const body = await request(`/bundles?q=${encodeURIComponent(query)}`);
    return new Set(body.bundles.map((b) => b.id));
}

export const getBundle = (id) => request(`/bundles/${id}`);
/** A new bundle, put in `category` too (an id); `placement_error` in the answer if only that failed. */
export const createBundle = (data, category = null) =>
    request("/bundles", json("POST", category ? { ...data, category } : data));
export const updateBundle = (id, data, expectedRevision) =>
    request(`/bundles/${id}`, json("PUT", { ...data, expected_revision: expectedRevision }));
export const deleteBundle = (id, revision) =>
    request(`/bundles/${id}?expected_revision=${revision}`, { method: "DELETE" });
export const duplicateBundle = (id, mode) => request(`/bundles/${id}/duplicate`, json("POST", { mode }));

/**
 * One action on several bundles: "set_category" ({category}), "set_favorite"
 * ({favorite}) or "trash" ({expected_revisions}). The answer has a result per
 * bundle (data-format.md); a refused request changes nothing.
 */
export const batchBundles = (ids, action, args = {}) => request("/bundles/batch", json("POST", { ids, action, ...args }));

// Categories and favorites: they organize the list and leave the bundles (and their revisions) alone.
export const createCategory = (name) => request("/categories", json("POST", { name }));
export const renameCategory = (id, name) => request(`/categories/${id}`, json("PATCH", { name }));
export const deleteCategory = (id) => request(`/categories/${id}`, { method: "DELETE" });
export const setCategory = (bundleId, category) => request(`/bundles/${bundleId}/category`, json("PUT", { category }));
export const setFavorite = (bundleId, favorite) => request(`/bundles/${bundleId}/favorite`, json("PUT", { favorite }));

/** The bundles in the trash, last deleted first, and the files this version cannot use: {trash, errors}. */
export const listTrash = () => request("/trash");
export const restoreBundle = (id) => request(`/bundles/${id}/restore`, { method: "POST" });
/** Delete a bundle in the trash for good; `unreadable` also a file this version cannot fully read. */
export const purgeBundle = (id, { unreadable = false } = {}) =>
    request(`/trash/${id}${unreadable ? "?unreadable=1" : ""}`, { method: "DELETE" }, { changes: false });
export const emptyTrash = () => request("/trash", { method: "DELETE" }, { changes: false });
/** Stored files that no bundle uses, in the library or in the trash. */
export const listUnusedFiles = () => request("/cleanup");
export const deleteUnusedFiles = (shas) => request("/cleanup", json("POST", { sha256: shas }), { changes: false });

/**
 * Upload one file for a field of `kind` (image, video or audio); resolves to
 * the stored asset's metadata. `onProgress` gets the sent fraction (0..1).
 * Aborting `signal` stops the upload, which then rejects with code "aborted".
 * fetch() cannot report upload progress, so this uses XMLHttpRequest, with
 * the headers api.fetchApi() would add.
 */
export function uploadAsset(file, kind = "image", { onProgress = null, name = null, signal = null } = {}) {
    const form = new FormData();
    form.append("kind", kind); // before the file: it picks the size limit
    form.append("file", file, name ?? (file.name || "upload"));
    return new Promise((resolve, reject) => {
        const aborted = () => reject(new ApiError("Upload cancelled.", 0, "aborted"));
        if (signal?.aborted) return aborted();
        const xhr = new XMLHttpRequest();
        xhr.open("POST", api.apiURL(`${PREFIX}/assets`));
        xhr.setRequestHeader("X-Bundle-Library", "1");
        xhr.setRequestHeader("X-Bundle-Library-Version", VERSION);
        if (api.user) xhr.setRequestHeader("Comfy-User", api.user);
        xhr.responseType = "json";
        if (onProgress) {
            xhr.upload.addEventListener("progress", (e) => {
                if (e.lengthComputable) onProgress(e.loaded / e.total);
            });
        }
        xhr.addEventListener("load", () => {
            const detail = xhr.response?.error;
            if (detail?.code === "version_mismatch") warnVersionMismatch(detail.server_version);
            if (xhr.status >= 200 && xhr.status < 300 && xhr.response?.asset) resolve(xhr.response.asset);
            else reject(new ApiError(detail?.message ?? `Upload failed: HTTP ${xhr.status}`, xhr.status, detail?.code, detail));
        });
        xhr.addEventListener("error", () => reject(new ApiError("Could not reach ComfyUI.", 0, "network")));
        xhr.addEventListener("abort", aborted);
        signal?.addEventListener("abort", () => xhr.abort(), { once: true });
        xhr.send(form);
    });
}

export function assetURL(sha256) {
    return api.apiURL(`${PREFIX}/assets/${sha256}`);
}

export function thumbnailURL(sha256, size = 128) {
    return api.apiURL(`${PREFIX}/assets/${sha256}/thumb?size=${size}`);
}
