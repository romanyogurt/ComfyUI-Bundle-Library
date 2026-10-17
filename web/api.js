import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { msg, serverText, t } from "./i18n.js";
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
        accept: "image/png,image/jpeg,image/webp", label: msg("upload.kinds_image") },
    video: { bytes: 1024 * 1024 * 1024, prefix: "video/", accept: "video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov",
        label: msg("upload.kinds_video") },
    audio: { bytes: 200 * 1024 * 1024, prefix: "audio/", accept: "audio/*,.wav,.flac,.mp3,.ogg,.opus,.m4a",
        label: msg("upload.kinds_audio") },
};

/** Why `file` cannot go in a field of `kind`, or null. */
export function fileProblem(file, kind) {
    const spec = MEDIA[kind];
    const typed = !file.type || (spec.types ? spec.types.includes(file.type) : file.type.startsWith(spec.prefix));
    if (!typed) return t("upload.only_kinds", { kinds: t(spec.label) });
    if (file.size > spec.bytes) {
        const limit = spec.bytes >= 1024 ** 3 ? `${spec.bytes / 1024 ** 3} GB` : `${spec.bytes / 1024 ** 2} MB`;
        return t("upload.too_large", { limit });
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
        ? t("version.restart_comfyui", { page, server })
        : t("version.reload_page", { page, server });
    app.extensionManager?.toast?.add({ severity: "warn", summary: "Bundle Library",
        detail: t("version.read_only", { detail }) });
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
    /** `message` in the current language when the server said how it was made (Phase 9b). */
    constructor(message, status, code, details) {
        super(details?.message_i18n ? serverText(details.message, details.message_i18n) : message);
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
        throw new ApiError(t("api.unreachable_reason", { reason: error.message }), 0, "network");
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

/** The catalogs of messages for a language code such as "ko" (i18n.js): GET /messages. */
export const getMessages = (code) => request(`/messages?lang=${encodeURIComponent(code)}`);

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
 * ({favorite}), "add_tags" or "remove_tags" ({tags}), or "trash"
 * ({expected_revisions}). The answer has a result per bundle;
 * a refused request changes nothing.
 */
export const batchBundles = (ids, action, args = {}) => request("/bundles/batch", json("POST", { ids, action, ...args }));

// Categories and favorites: they organize the list and leave the bundles (and their revisions) alone.
export const createCategory = (name) => request("/categories", json("POST", { name }));
export const renameCategory = (id, name) => request(`/categories/${id}`, json("PATCH", { name }));
export const deleteCategory = (id) => request(`/categories/${id}`, { method: "DELETE" });
export const setCategory = (bundleId, category) => request(`/bundles/${bundleId}/category`, json("PUT", { category }));
export const setFavorite = (bundleId, favorite) => request(`/bundles/${bundleId}/favorite`, json("PUT", { favorite }));

/**
 * The tags of the whole library, in use and in the trash: {tags: [{name, spellings, active, trash, protected}],
 * unreadable, legacy}.
 */
export const listTags = () => request("/tags");
/** Rename a tag in every bundle; with a tag there already, the two merge. */
export const renameTag = (from, to) => request("/tags/rename", json("POST", { from, to }));
export const deleteTag = (tag) => request("/tags/delete", json("POST", { tag }));

/** The bundles in the trash, last deleted first, and the files this version cannot use: {trash, errors}. */
export const listTrash = () => request("/trash");
export const restoreBundle = (id) => request(`/bundles/${id}/restore`, { method: "POST" });
/**
 * Delete a bundle in the trash for good. `revision` is the one shown (one
 * changed or restored since is kept); `unreadable` also deletes a file this
 * version cannot fully read, whose revision is not known.
 */
export const purgeBundle = (id, { revision = null, unreadable = false } = {}) => {
    const query = new URLSearchParams();
    if (revision !== null) query.set("expected_revision", String(revision));
    if (unreadable) query.set("unreadable", "1");
    return request(`/trash/${id}?${query}`, { method: "DELETE" }, { changes: false });
};
/** Delete for good the bundles shown in the trash ({id: revision}): {deleted, results}. */
export const emptyTrash = (shown) =>
    request("/trash", json("DELETE", { expected_revisions: shown }), { changes: false });
/** Stored files that no bundle uses, in the library or in the trash. */
export const listUnusedFiles = () => request("/cleanup");
/** Delete unused files; with `recent`, also those within the grace time (0.0.31). */
export const deleteUnusedFiles = (shas, { recent = false } = {}) =>
    request("/cleanup", json("POST", { sha256: shas, ...(recent ? { recent: true } : {}) }), { changes: false });

/**
 * Upload one file for a field of `kind` (image, video or audio); resolves to
 * the server's answer: {asset (the stored file's metadata), warning?} (the
 * warning since 0.0.34). `onProgress` gets the sent fraction (0..1).
 * Aborting `signal` stops the upload, which then rejects with code "aborted".
 * fetch() cannot report upload progress, so this uses XMLHttpRequest, with
 * the headers api.fetchApi() would add.
 */
export function uploadAsset(file, kind = "image", { onProgress = null, name = null, signal = null } = {}) {
    const form = new FormData();
    form.append("kind", kind); // before the file: it picks the size limit
    form.append("file", file, name ?? (file.name || "upload"));
    return postFile("/assets", form, { onProgress, signal });
}

/**
 * POST a multipart `form` with the write headers, reporting upload progress
 * (0 to 1); resolves to the JSON answer. fetch() cannot report progress.
 */
function postFile(route, form, { onProgress = null, signal = null } = {}) {
    return new Promise((resolve, reject) => {
        const aborted = () => reject(new ApiError(t("upload.cancelled"), 0, "aborted"));
        if (signal?.aborted) return aborted();
        const xhr = new XMLHttpRequest();
        xhr.open("POST", api.apiURL(`${PREFIX}${route}`));
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
            if (xhr.status >= 200 && xhr.status < 300 && xhr.response) resolve(xhr.response);
            else reject(new ApiError(detail?.message ?? t("upload.failed_http", { status: xhr.status }), xhr.status, detail?.code, detail));
        });
        xhr.addEventListener("error", () => reject(new ApiError(t("api.unreachable"), 0, "network")));
        xhr.addEventListener("abort", aborted);
        signal?.addEventListener("abort", () => xhr.abort(), { once: true });
        xhr.send(form);
    });
}

/**
 * Upload an export ZIP to import: resolves to the
 * preview, {token, bundles, assets, ...}. Nothing in the library changes yet.
 */
export function uploadImport(file, options) {
    const form = new FormData();
    form.append("file", file, file.name || "import.zip");
    return postFile("/import", form, options);
}

/** Import an uploaded export; `conflict` is skip, overwrite or copy, `category` {mode: zip | one | none, id?}. */
export const applyImport = (token, conflict, category) => request(`/import/${token}`, json("POST", { conflict, category }));
export const discardImport = (token) => request(`/import/${token}`, { method: "DELETE" }, { changes: false });

/**
 * Make a ZIP of bundles to download: {token, file_name, bytes, bundles, assets,
 * skipped, missing}. It can be downloaded from exportURL() for an hour.
 */
export const exportBundles = (ids) => request("/export", json("POST", { ids }), { changes: false });

export function exportURL(token, name) {
    return api.apiURL(`${PREFIX}/export/${token}?name=${encodeURIComponent(name)}`);
}

/** The stored files of `kind`, most recent first, with the names bundles gave them and the bundles that use them (0.0.29). */
export const listStoredAssets = (kind) => request(`/assets?kind=${encodeURIComponent(kind)}`);

/** A draft takes a stored file: the server keeps it through a cleanup's grace time again. Resolves to {asset}. */
export const takeStoredAsset = (sha256) => request(`/assets/${sha256}/use`, { method: "POST" }, { changes: false });

export function assetURL(sha256) {
    return api.apiURL(`${PREFIX}/assets/${sha256}`);
}

export function thumbnailURL(sha256, size = 128) {
    return api.apiURL(`${PREFIX}/assets/${sha256}/thumb?size=${size}`);
}
