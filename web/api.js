import { api } from "../../scripts/api.js";

const PREFIX = "/bundle-library/v1";

/** Fired on window after a request that changed the library. */
export const CHANGED_EVENT = "bundle-library:changed";

// Mirrors bundle_library/constants.py.
export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

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

/** Upload one image file; resolves to the stored asset's metadata. */
export async function uploadImage(file, name) {
    const form = new FormData();
    form.append("file", file, name ?? file.name ?? "image.png");
    return (await request("/assets", { method: "POST", body: form }, { changes: false })).asset;
}

export function assetURL(sha256) {
    return api.apiURL(`${PREFIX}/assets/${sha256}`);
}

export function thumbnailURL(sha256, size = 128) {
    return api.apiURL(`${PREFIX}/assets/${sha256}/thumb?size=${size}`);
}
