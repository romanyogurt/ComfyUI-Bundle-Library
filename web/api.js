import { api } from "../../scripts/api.js";

const PREFIX = "/bundle-library/v1";

async function request(path, options = {}) {
    const method = options.method ?? "GET";
    const headers = { ...(options.headers ?? {}) };
    if (method !== "GET") headers["X-Bundle-Library"] = "1";
    const response = await api.fetchApi(PREFIX + path, { ...options, method, headers });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
        throw new Error(body?.error?.message ?? `${method} ${path}: HTTP ${response.status}`);
    }
    return body;
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

export function thumbnailURL(sha256, size = 128) {
    return api.apiURL(`${PREFIX}/assets/${sha256}/thumb?size=${size}`);
}
