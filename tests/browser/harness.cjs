// Shared set-up for the browser scenarios: headless Chromium against a running
// ComfyUI, by default the test server of comfy-docker's
// scripts/bundle-library-test-server.sh (COMFY_URL, default http://127.0.0.1:8189).
// Safety:
// - every non-GET request except /api/prompt and the bundle-library API is
//   answered locally (never reaches the server), so settings and workflows on
//   the server are not changed;
// - only bundles created during the session (seen in the server's 201
//   answers, and in the answers of imports) are removed at the end, by id,
//   and then their trash entries; never one that was there before;
//   every bundle and trash entry that was there before must still be there;
// - so are the categories made during the session; the categories, places and
//   stars of what was there before must be as they were;
// - the runs a scenario queues are deleted from ComfyUI's job history at the
//   end (by the page's client id).
const { chromium } = require("playwright-core");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BASE = process.env.COMFY_URL || "http://127.0.0.1:8189";
const BUNDLES = "/api/bundle-library/v1/bundles";
const CATEGORIES = "/api/bundle-library/v1/categories";

// Console errors that are expected: what a fresh user folder lacks (no saved
// workflows, templates or user.css), the browser's report of the error answers
// the scenarios provoke on purpose (conflicts, deleted bundles, refused
// uploads, refused category names, invalid prompts), and frontend start-up noise. Any other error fails
// the session, so a missing thumbnail or an exception in this package shows up.
const FAILED = /^Failed to load resource: the server responded with a status of 4\d\d /;
const EXPECTED_CONSOLE_ERRORS = [
    { text: FAILED, url: /\/api\/userdata\b|\/user\.css$/ },
    { text: FAILED, url: /\/api\/prompt$|\/api\/bundle-library\/v1\/(bundles\b|assets$|categories\b)/ },
    { text: /^ComfyApp graph accessed before initialization$/ },
];
const expectedError = (e) => EXPECTED_CONSOLE_ERRORS.some((k) => k.text.test(e.text) && (!k.url || k.url.test(e.url)));

const PAGE_HELPERS = () => {
    window.__bl = {
        async init() {
            const { app } = await import("/scripts/app.js");
            const { api } = await import("/scripts/api.js");
            this.app = app;
            this.api = api;
            this.errors = [];
            if (!this.listening) {
                api.addEventListener("execution_error", (e) => this.errors.push(e.detail));
                this.listening = true;
            }
        },
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        async waitFor(predicate, timeout = 15000) {
            const end = Date.now() + timeout;
            while (Date.now() < end) {
                if (predicate()) return true;
                await this.sleep(100);
            }
            return false;
        },
        /** A PNG (or other canvas type) File with a solid colour and a label. */
        async makeImage(color, label, name = `${label}.png`, type = "image/png") {
            const canvas = new OffscreenCanvas(256, 384);
            const g = canvas.getContext("2d");
            g.fillStyle = color;
            g.fillRect(0, 0, 256, 384);
            g.fillStyle = "white";
            g.font = "32px sans-serif";
            g.fillText(label, 16, 48);
            return new File([await canvas.convertToBlob({ type })], name, { type });
        },
        setFiles(input, files) {
            const transfer = new DataTransfer();
            for (const file of files) transfer.items.add(file);
            input.files = transfer.files;
            input.dispatchEvent(new Event("change", { bubbles: true }));
        },
        async sha256(file) {
            const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
            return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
        },
        async request(method, route, body) {
            const headers = method === "GET" ? {} : { "X-Bundle-Library": "1" };
            let payload = body;
            if (body && !(body instanceof FormData)) {
                headers["Content-Type"] = "application/json";
                payload = JSON.stringify(body);
            }
            const res = await this.api.fetchApi(`/bundle-library/v1${route}`, { method, headers, body: payload });
            const json = await res.json();
            if (!res.ok) throw new Error(`${method} ${route}: ${res.status} ${JSON.stringify(json)}`);
            return json;
        },
        async image(name, color, label) {
            const canvas = new OffscreenCanvas(512, 768);
            const g = canvas.getContext("2d");
            g.fillStyle = color;
            g.fillRect(0, 0, 512, 768);
            g.fillStyle = "white";
            g.font = "64px sans-serif";
            g.fillText(label, 32, 96);
            const form = new FormData();
            form.append("file", await canvas.convertToBlob({ type: "image/png" }), `${label}.png`);
            const { asset } = await this.request("POST", "/assets", form);
            return { name, type: "image", asset: { sha256: asset.sha256, original_name: `${label}.png` } };
        },
        async bundleIds() {
            return (await this.request("GET", "/bundles")).bundles.map((b) => b.id);
        },
        /** Delete these bundles if they still exist, then their trash entries; the ids of the bundles deleted. */
        async removeBundles(ids) {
            const removed = [];
            for (const id of ids) {
                const res = await this.api.fetchApi(`/bundle-library/v1/bundles/${id}`);
                if (!res.ok) continue;
                const { revision } = await res.json();
                await this.request("DELETE", `/bundles/${id}?expected_revision=${revision}`);
                removed.push(id);
            }
            const { trash } = await this.request("GET", "/trash");
            for (const entry of trash.filter((e) => ids.includes(e.id))) {
                await this.request("DELETE", `/trash/${entry.id}?expected_revision=${entry.revision}`);
            }
            return removed;
        },
        /** The categories and each bundle's place and star, to compare before and after. */
        async organization() {
            const { bundles, categories = [] } = await this.request("GET", "/bundles");
            return {
                categories: Object.fromEntries(categories.map((c) => [c.id, c.name])),
                bundles: Object.fromEntries(bundles.map((b) => [b.id, [b.category ?? null, !!b.favorite]])),
            };
        },
        async removeCategories(ids) {
            const { categories = [] } = await this.request("GET", "/categories");
            const removed = [];
            for (const category of categories.filter((c) => ids.includes(c.id))) {
                await this.request("DELETE", `/categories/${category.id}`);
                removed.push(category.id);
            }
            return removed;
        },
        async trashIds() {
            const { trash, errors } = await this.request("GET", "/trash");
            return [...trash.map((e) => e.id), ...errors.map((e) => e.file)];
        },
        async createTestBundles() {
            const text = (name, value) => ({ name, type: "text", value });
            const bool = (name, value) => ({ name, type: "boolean", value });
            const specs = {
                A: ["[test] A (red)", [text("prompt", "Red dress girl\n\n  두 줄 공백과 앞뒤 공백을 그대로 둔다  \n"),
                    await this.image("ref_1", "#b3261e", "A ref_1"), await this.image("ref_2", "#e8710a", "A ref_2"),
                    bool("use_bgm", true)]],
                B: ["[test] B (blue)", [text("prompt", "Blue shirt girl"),
                    await this.image("ref_1", "#1a56db", "B ref_1"), await this.image("ref_2", "#0e7490", "B ref_2"),
                    bool("use_bgm", false)]],
                C: ["[test] C (no ref_2)", [text("prompt", "Cat mascot"),
                    await this.image("ref_1", "#15803d", "C ref_1"), { name: "seed", type: "int", value: 42 }]],
                D: ["[test] D (ref_2 is text)", [text("prompt", "Type mismatch case"),
                    await this.image("ref_1", "#6d28d9", "D ref_1"), text("ref_2", "not an image"), bool("use_bgm", true)]],
                E: ["[test] E (empty ref_2)", [text("prompt", "Empty image case"),
                    await this.image("ref_1", "#374151", "E ref_1"), { name: "ref_2", type: "image", asset: null },
                    bool("use_bgm", true), { name: "cfg", type: "float", value: 4.5 }]],
            };
            const ids = {};
            for (const [key, [name, fields]] of Object.entries(specs)) {
                ids[key] = (await this.request("POST", "/bundles", { name, tags: ["test"], fields })).id;
            }
            return ids;
        },
        loaders(graph = this.app.graph) { return graph.nodes.filter((n) => n.type === "BundleLibraryLoad"); },
        outs(node) {
            return node.outputs.map((o) => ({ label: o.label, name: o.name, type: o.type, links: o.links?.length ?? 0 }));
        },
        spec(node) { return node.widgets.find((w) => w.name === "slot_spec").value; },
        async pick(node, id) {
            const select = node.bundlePanel.select;
            for (let i = 0; i < 50 && select.options.length < 2; i++) await this.sleep(100);
            select.value = id;
            select.dispatchEvent(new Event("change"));
            for (let i = 0; i < 50 && node.widgets.find((w) => w.name === "bundle_id").value !== id; i++) await this.sleep(50);
            await this.sleep(200);
        },
        add(type, pos) {
            const node = LiteGraph.createNode(type);
            node.pos = pos;
            this.app.graph.add(node);
            return node;
        },
        async run() {
            const { output } = await this.app.graphToPrompt();
            this.errors = [];
            const res = await this.api.fetchApi("/prompt", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ prompt: output, client_id: this.api.clientId }),
            });
            const body = await res.json();
            if (!res.ok) return { status: res.status, body };
            const id = body.prompt_id;
            for (let i = 0; i < 200; i++) {
                const h = await (await this.api.fetchApi(`/history/${id}`)).json();
                if (h[id]?.status?.completed !== undefined || h[id]?.status?.status_str) {
                    await this.sleep(200);
                    return { status: 200, prompt: output, history: h[id], errors: this.errors.filter((e) => e.prompt_id === id) };
                }
                await this.sleep(150);
            }
            return { status: "timeout" };
        },
    };
};

/** Delete the runs queued by these client ids from ComfyUI's job history. */
async function forgetRuns(clientIds) {
    const history = await (await fetch(`${BASE}/api/history?max_items=10000`)).json();
    const ours = Object.entries(history)
        .filter(([, entry]) => clientIds.has(entry.prompt?.[3]?.client_id))
        .map(([id]) => id);
    if (ours.length) {
        await fetch(`${BASE}/api/history`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delete: ours }),
        });
    }
    return ours.length;
}

async function waitForApp(page) {
    await page.waitForFunction(() => window.LiteGraph && document.querySelector("canvas"), null, { timeout: 60000 });
    await page.evaluate(async () => {
        for (let i = 0; i < 100; i++) {
            try {
                await window.__bl.init();
                // Ready once the extensions' setup() ran (the pack's tab is there): before that a key ComfyUI
                // handles fails, and a slow init leaves the canvas without the nodes (R31-02, 0.0.32)
                const tabs = window.__bl.app.extensionManager?.sidebarTab?.sidebarTabs ?? [];
                if (window.__bl.app.graph && window.__bl.app.canvas && tabs.some((tab) => tab.id === "bundle-library")) return;
            } catch {}
            await window.__bl.sleep(200);
        }
    });
}

/**
 * Open ComfyUI in a fresh browser; `name` picks the output folder for screenshots
 * and results. `expectedErrors` adds console errors this scenario provokes on
 * purpose ({text, url} patterns, like EXPECTED_CONSOLE_ERRORS).
 */
async function startSession(name, { expectedErrors = [] } = {}) {
    const out = process.env.BL_TEST_OUT || path.join(os.tmpdir(), `bundle-library-${name}`);
    fs.mkdirSync(out, { recursive: true });
    const results = [];
    const check = (label, ok, detail) => {
        results.push({ name: label, ok: !!ok, detail });
        console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? "  " + JSON.stringify(detail) : ""}`);
    };
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const blocked = [];
    await context.route("**/*", (route) => {
        const req = route.request();
        const url = new URL(req.url());
        const allowed = req.method() === "GET" || url.pathname === "/api/prompt"
            || url.pathname.startsWith("/api/bundle-library/");
        if (allowed) return route.continue();
        blocked.push(`${req.method()} ${url.pathname}`);
        return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push({ text: m.text(), url: m.location().url }); });
    page.on("pageerror", (e) => consoleErrors.push({ text: String(e.stack || e), url: "" }));
    // Bundles and categories made during the session, by the scenario or by the UI under test.
    const created = new Set();
    const createdCategories = new Set();
    const reading = [];
    page.on("response", (res) => {
        const route = new URL(res.url()).pathname;
        const making = route === BUNDLES || /^\/api\/bundle-library\/v1\/bundles\/[^/]+\/duplicate$/.test(route);
        if (res.request().method() === "POST" && res.status() === 200 && /^\/api\/bundle-library\/v1\/import\/[^/]+$/.test(route)) {
            reading.push(res.json().then((answer) => { // what an import made, new, copied or overwritten
                for (const r of answer.results) if (r.ok && r.as !== "skipped") created.add(r.id);
                for (const c of answer.categories_created) createdCategories.add(c.id);
            }, () => {}));
        }
        if (res.request().method() !== "POST" || res.status() !== 201) return;
        if (making) reading.push(res.json().then((b) => created.add(b.id), () => {}));
        if (route === CATEGORIES) reading.push(res.json().then((c) => createdCategories.add(c.id), () => {}));
    });
    await page.addInitScript(PAGE_HELPERS);
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await waitForApp(page);
    await page.waitForTimeout(2000);
    await page.keyboard.press("Escape");
    const ev = (fn, arg) => page.evaluate(fn, arg);
    const existing = await ev(() => window.__bl.bundleIds());
    const existingTrash = await ev(() => window.__bl.trashIds());
    const existingOrganization = await ev(() => window.__bl.organization());
    const clientIds = new Set([await ev(() => window.__bl.api.clientId)]);

    return {
        page, ev, check, out,
        shot: (file) => page.screenshot({ path: path.join(out, file) }),
        /** Reload the page and wait for ComfyUI and the helpers again. */
        async reload() {
            await page.reload({ waitUntil: "domcontentloaded" });
            await waitForApp(page);
            await page.waitForTimeout(1500);
            await page.keyboard.press("Escape");
            clientIds.add(await ev(() => window.__bl.api.clientId));
        },
        /** Remove the bundles made in the session, check what else happened, and close. */
        async finish({ expectRemoved } = {}) {
            await Promise.all(reading);
            const before = new Set([...existing, ...existingTrash]);
            const removed = await ev((ids) => window.__bl.removeBundles(ids), [...created].filter((id) => !before.has(id)));
            check("bundles made in the session removed", expectRemoved === undefined || removed.length === expectRemoved,
                { removed: removed.length, made: created.size });
            const removedCategories = await ev((ids) => window.__bl.removeCategories(ids), [...createdCategories]);
            const organization = await ev(() => window.__bl.organization());
            const changed = Object.entries(existingOrganization.bundles)
                .filter(([id, place]) => JSON.stringify(organization.bundles[id] ?? place) !== JSON.stringify(place));
            check("categories made in the session removed; the rest of the organization is untouched",
                JSON.stringify(organization.categories) === JSON.stringify(existingOrganization.categories)
                && changed.length === 0, { removed: removedCategories.length, changed });
            const now = new Set(await ev(() => window.__bl.bundleIds()));
            const lost = existing.filter((id) => !now.has(id));
            check("bundles the session did not make are untouched", lost.length === 0, { before: existing.length, lost });
            const trashNow = new Set(await ev(() => window.__bl.trashIds()));
            const lostTrash = existingTrash.filter((id) => !trashNow.has(id));
            check("trash entries the session did not make are untouched", lostTrash.length === 0,
                { before: existingTrash.length, lost: lostTrash });
            await browser.close(); // first, so the page cannot queue anything more
            check("test runs removed from the job history (record)", true, { runs: await forgetRuns(clientIds) });
            check("no settings/workflow writes reached the server (blocked list)", true, [...new Set(blocked)]);
            const expectedHere = (e) => expectedErrors.some((k) => k.text.test(e.text) && (!k.url || k.url.test(e.url)));
            const unexpected = consoleErrors.filter((e) => !expectedError(e) && !expectedHere(e));
            check("no unexpected browser console errors", unexpected.length === 0,
                { unexpected: unexpected.slice(0, 10), expected: consoleErrors.length - unexpected.length });
            fs.writeFileSync(path.join(out, "results.json"),
                JSON.stringify({ results, blocked: [...new Set(blocked)], consoleErrors }, null, 2));
            const failed = results.filter((r) => !r.ok).length;
            console.log(`\n${results.length - failed}/${results.length} passed`);
            if (failed) process.exitCode = 1;
        },
    };
}

module.exports = { startSession };
