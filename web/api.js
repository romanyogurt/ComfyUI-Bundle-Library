import { api } from "../../scripts/api.js";

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
    if (method !== "GET") headers["X-Bundle-Library"] = "1";
    let response;
    try {
        response = await api.fetchApi(PREFIX + path, { ...options, method, headers });
    } catch (error) {
        throw new ApiError(`Could not reach ComfyUI: ${error.message}`, 0, "network");
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) {
        const detail = body?.error;
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

/** All bundle summaries. Cached until `fresh` is set or `forgetBundles()` runs. */
export async function listBundles({ fresh = false } = {}) {
    if (fresh || !listing) {
        listing = request("/bundles").then((body) => body.bundles);
        listing.catch(() => { listing = null; });
    }
    return listing;
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
export const createBundle = (data) => request("/bundles", json("POST", data));
export const updateBundle = (id, data, expectedRevision) =>
    request(`/bundles/${id}`, json("PUT", { ...data, expected_revision: expectedRevision }));
export const deleteBundle = (id, revision) =>
    request(`/bundles/${id}?expected_revision=${revision}`, { method: "DELETE" });
export const duplicateBundle = (id, mode) => request(`/bundles/${id}/duplicate`, json("POST", { mode }));

/** The trashed bundles ({trash, errors}), last deleted first. */
export const listTrash = () => request("/trash");
export const restoreBundle = (trashId) => request(`/trash/${trashId}/restore`, { method: "POST" });
export const purgeBundle = (trashId) => request(`/trash/${trashId}`, { method: "DELETE" }, { changes: false });
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
        if (api.user) xhr.setRequestHeader("Comfy-User", api.user);
        xhr.responseType = "json";
        if (onProgress) {
            xhr.upload.addEventListener("progress", (e) => {
                if (e.lengthComputable) onProgress(e.loaded / e.total);
            });
        }
        xhr.addEventListener("load", () => {
            const detail = xhr.response?.error;
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
