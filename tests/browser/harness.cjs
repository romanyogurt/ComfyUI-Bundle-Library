// Shared set-up for the browser scenarios: headless Chromium against a running
// ComfyUI (COMFY_URL, default http://127.0.0.1:8188).
// Safety: every non-GET request except /api/prompt and the bundle-library API
// is answered locally (never reaches the server), so settings and workflows on
// the server are not changed. Scenarios add bundles named "[test] ..." and
// remove them at the end; removal moves them to trash/, and with BL_LIBRARY_DIR
// set to the library folder (user/bundle_library) those trash files go too.
// The runs a scenario queues are deleted from ComfyUI's job history at the end
// (by the page's client id), so they do not stay in the user's queue panel.
const { chromium } = require("playwright-core");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BASE = process.env.COMFY_URL || "http://127.0.0.1:8188";

function purgeTrash(ids) {
    const dir = process.env.BL_LIBRARY_DIR && path.join(process.env.BL_LIBRARY_DIR, "trash");
    if (!dir || !fs.existsSync(dir)) return 0;
    let removed = 0;
    for (const file of fs.readdirSync(dir)) {
        if (ids.some((id) => file.startsWith(`${id}.`))) {
            fs.unlinkSync(path.join(dir, file));
            removed++;
        }
    }
    return removed;
}

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
        async removeTestBundles() {
            const { bundles } = await this.request("GET", "/bundles");
            const removed = [];
            for (const b of bundles.filter((x) => x.name.startsWith("[test] "))) {
                await this.request("DELETE", `/bundles/${b.id}?expected_revision=${b.revision}`);
                removed.push(b.id);
            }
            return removed;
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
                if (window.__bl.app.graph && window.__bl.app.canvas) return;
            } catch {}
            await window.__bl.sleep(200);
        }
    });
}

/** Open ComfyUI in a fresh browser; `name` picks the output folder for screenshots and results. */
async function startSession(name) {
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
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
    await page.addInitScript(PAGE_HELPERS);
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await waitForApp(page);
    await page.waitForTimeout(2000);
    await page.keyboard.press("Escape");
    const ev = (fn, arg) => page.evaluate(fn, arg);
    purgeTrash(await ev(() => window.__bl.removeTestBundles())); // left over from an interrupted run
    const deleted = [];
    const clientIds = new Set([await ev(() => window.__bl.api.clientId)]);

    return {
        page, ev, check, out,
        shot: (file) => page.screenshot({ path: path.join(out, file) }),
        /** A bundle the scenario deleted itself: purge its trash file at the end too. */
        purgeLater: (id) => deleted.push(id),
        /** Reload the page and wait for ComfyUI and the helpers again. */
        async reload() {
            await page.reload({ waitUntil: "domcontentloaded" });
            await waitForApp(page);
            await page.waitForTimeout(1500);
            await page.keyboard.press("Escape");
            clientIds.add(await ev(() => window.__bl.api.clientId));
        },
        /** Remove the test bundles, record what was blocked and logged, and close. */
        async finish({ expectRemoved } = {}) {
            const removed = await ev(() => window.__bl.removeTestBundles());
            const purged = purgeTrash([...removed, ...deleted]);
            check("test bundles removed", expectRemoved === undefined || removed.length === expectRemoved,
                { removed: removed.length, trashFilesPurged: purged });
            await browser.close(); // first, so the page cannot queue anything more
            check("test runs removed from the job history (record)", true, { runs: await forgetRuns(clientIds) });
            check("no settings/workflow writes reached the server (blocked list)", true, [...new Set(blocked)]);
            check("browser console errors (record)", true, consoleErrors.slice(0, 20));
            fs.writeFileSync(path.join(out, "results.json"),
                JSON.stringify({ results, blocked: [...new Set(blocked)], consoleErrors }, null, 2));
            const failed = results.filter((r) => !r.ok).length;
            console.log(`\n${results.length - failed}/${results.length} passed`);
            if (failed) process.exitCode = 1;
        },
    };
}

module.exports = { startSession };
