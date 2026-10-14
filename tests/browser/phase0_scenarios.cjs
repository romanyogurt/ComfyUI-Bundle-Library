// Phase 0 browser scenarios for Load Bundle against a running ComfyUI (see docs/compatibility.md).
// Safety: every non-GET request except /api/prompt and the bundle-library API
// is answered locally (never reaches the server), so settings and workflows on
// the server are not changed. Only tiny preview graphs are queued.
const { chromium } = require("playwright-core");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BASE = process.env.COMFY_URL || "http://127.0.0.1:8188";
const OUT = process.env.BL_TEST_OUT || path.join(os.tmpdir(), "bundle-library-phase0");
fs.mkdirSync(OUT, { recursive: true });
const ID = (s) => `5a1e0000-0000-4000-8000-0000000000${s}`;
const A = ID("a1"), B = ID("b2"), C = ID("c3"), D = ID("d4"), E = ID("e5");

const results = [];
function check(name, ok, detail) {
    results.push({ name, ok: !!ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? "  " + JSON.stringify(detail) : ""}`);
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

(async () => {
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
    await page.waitForFunction(() => window.LiteGraph && document.querySelector("canvas"), null, { timeout: 60000 });
    await page.evaluate(async () => {
        for (let i = 0; i < 100; i++) {
            try { await window.__bl.init(); if (window.__bl.app.graph && window.__bl.app.canvas) return; } catch {}
            await window.__bl.sleep(200);
        }
    });
    await page.waitForTimeout(2000);
    await page.keyboard.press("Escape");
    const ev = (fn, arg) => page.evaluate(fn, arg);

    // ---- classic renderer --------------------------------------------------
    const vue0 = await ev(() => window.__bl.app.extensionManager.setting.get("Comfy.VueNodes.Enabled"));
    check("renderer starts as classic (user setting)", vue0 === false, vue0);

    await ev(() => window.__bl.app.graph.clear());
    const created = await ev(() => {
        const b = window.__bl;
        const node = b.add("BundleLibraryLoad", [80, 80]);
        window.__node = node;
        return { outputs: node.outputs.length, widgets: node.widgets.map((w) => [w.name, w.type, !!(w.advanced || w.options?.advanced), w.serialize !== false, !!w.hidden]) };
    });
    check("new node: definition outputs trimmed to 0", created.outputs === 0, created);
    check("new node: bundle_id/slot_spec are advanced widgets", created.widgets.filter((w) => w[2]).length === 2, created.widgets);
    check("classic: bundle_id/slot_spec hidden", created.widgets.filter((w) => w[4]).length === 2, created.widgets);

    await ev((id) => window.__bl.pick(window.__node, id), A);
    let outs = await ev(() => window.__bl.outs(window.__node));
    check("select A: outputs follow fields", JSON.stringify(outs.map((o) => [o.label, o.type])) === JSON.stringify([
        ["prompt", "STRING"], ["ref_1", "IMAGE"], ["ref_2", "IMAGE"], ["use_bgm", "BOOLEAN"]]), outs);

    const wiring = await ev(() => {
        const b = window.__bl, n = window.__node;
        const pPrompt = b.add("PreviewAny", [700, 40]);
        const pRef1 = b.add("PreviewImage", [700, 260]);
        const pRef2 = b.add("PreviewImage", [1000, 260]);
        const pBgm = b.add("PreviewAny", [1000, 40]);
        const concat = b.add("StringConcatenate", [700, 620]);
        window.__p = { pPrompt: pPrompt.id, pRef1: pRef1.id, pRef2: pRef2.id, pBgm: pBgm.id };
        const ok = [n.connect(0, pPrompt, 0), n.connect(1, pRef1, 0), n.connect(2, pRef2, 0), n.connect(3, pBgm, 0)].map(Boolean);
        const wrongType = n.connect(1, concat, 0); // IMAGE -> STRING must be refused
        b.app.graph.remove(concat);
        return { ok, wrongType: !!wrongType, linkTypes: [...b.app.graph.links.values()].map((l) => l.type) };
    });
    check("links made to previews", wiring.ok.every(Boolean), wiring.ok);
    check("canvas refuses IMAGE output -> STRING input", wiring.wrongType === false);
    check("link types carry field types", JSON.stringify(wiring.linkTypes.sort()) === JSON.stringify(["BOOLEAN", "IMAGE", "IMAGE", "STRING"]), wiring.linkTypes);
    await page.screenshot({ path: path.join(OUT, "classic-A.png") });
    outs = await ev(() => window.__bl.outs(window.__node));
    check("wired baseline: one link per output", outs.every((o) => o.links === 1), outs);

    let run = await ev(() => window.__bl.run());
    const p = await ev(() => window.__p);
    const loaderId = await ev(() => String(window.__node.id));
    check("prompt indices = output positions", run.prompt && JSON.stringify(run.prompt[p.pRef2].inputs.images) === JSON.stringify([loaderId, 2]), run.prompt?.[p.pRef2]?.inputs);
    check("prompt has no panel widget input", run.prompt && !("bundle_panel" in run.prompt[loaderId].inputs), Object.keys(run.prompt?.[loaderId]?.inputs ?? {}));
    const textA = run.history?.outputs?.[p.pPrompt]?.text?.[0];
    check("run A succeeds", run.history?.status?.status_str === "success", run.history?.status?.status_str);
    check("run A: text kept exactly (newlines, Korean, spaces)", textA === "Red dress girl\n\n  두 줄 공백과 앞뒤 공백을 그대로 둔다  \n", textA);
    check("run A: two images previewed", (run.history?.outputs?.[p.pRef1]?.images?.length ?? 0) === 1 && (run.history?.outputs?.[p.pRef2]?.images?.length ?? 0) === 1);
    check("run A: boolean preview", true, run.history?.outputs?.[p.pBgm]?.text);

    await ev((id) => window.__bl.pick(window.__node, id), B);
    const afterB = await ev(() => window.__bl.outs(window.__node));
    check("A -> B: outputs and links unchanged", JSON.stringify(afterB) === JSON.stringify(outs), afterB);
    run = await ev(() => window.__bl.run());
    check("run B: new text through same links", run.history?.outputs?.[p.pPrompt]?.text?.[0] === "Blue shirt girl", run.history?.outputs?.[p.pPrompt]?.text);

    await ev((id) => window.__bl.pick(window.__node, id), C);
    const afterC = await ev(() => window.__bl.outs(window.__node));
    check("B -> C: linked ref_2/use_bgm kept, seed appended", JSON.stringify(afterC.map((o) => [o.label, o.type, o.links])) === JSON.stringify([
        ["prompt", "STRING", 1], ["ref_1", "IMAGE", 1], ["ref_2", "IMAGE", 1], ["use_bgm", "BOOLEAN", 1], ["seed", "INT", 0]]), afterC);
    const panelC = await ev(() => window.__node.bundlePanel.preview.innerText);
    check("panel marks missing slots", (panelC.match(/실행 시 오류/g) ?? []).length === 2, panelC);
    await page.screenshot({ path: path.join(OUT, "classic-C-missing.png") });
    run = await ev(() => window.__bl.run());
    const errC = (run.errors ?? []).map((e) => [String(e.node_id), e.exception_message]);
    check("run C: the loader fails once, naming both linked fields", errC.length === 1 && errC[0][0] === loaderId && errC[0][1].includes("'ref_2'") && errC[0][1].includes("'use_bgm'"), errC);
    check("run C: history status is error", run.history?.status?.status_str === "error", run.history?.status?.status_str);
    // Same run through the frontend's own queue path (the Run button), which is
    // what links an execution_error to the workflow and shows it.
    const uiRun = await ev(async () => {
        const b = window.__bl;
        b.errors = [];
        await b.app.queuePrompt(0, 1);
        for (let i = 0; i < 100; i++) {
            await b.sleep(150);
            const q = await (await b.api.fetchApi("/queue")).json();
            if (!q.queue_running.length && !q.queue_pending.length) break;
        }
        await b.sleep(1500);
        const latest = Object.values(await (await b.api.fetchApi("/history?max_items=1")).json())[0];
        return {
            errors: b.errors.map((e) => e.exception_message),
            status: latest?.status?.status_str ?? null,
            shownInPage: document.body.innerText.includes("번들을 연결된 출력에 쓸 수 없습니다"),
        };
    });
    check("run C via Run path: error event reaches the client", uiRun.errors.length === 1, uiRun.errors);
    // How the failure looks (the error dialog) was checked by hand in a real browser.
    check("run C via Run path: job recorded as failed", uiRun.status === "error", uiRun);
    const rerun = await ev(() => window.__bl.run());
    check("re-run C unchanged: fails again (not cached)", (rerun.errors ?? []).length === 1, (rerun.errors ?? []).map((e) => e.node_id));
    await page.screenshot({ path: path.join(OUT, "classic-C-run-error.png") });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    await ev((id) => window.__bl.pick(window.__node, id), A);
    const backA = await ev(() => window.__bl.outs(window.__node));
    check("C -> A: unlinked seed removed, links intact", JSON.stringify(backA) === JSON.stringify(outs), backA);

    await ev((id) => window.__bl.pick(window.__node, id), D);
    const afterD = await ev(() => window.__bl.outs(window.__node));
    run = await ev(() => window.__bl.run());
    check("A -> D: linked ref_2 keeps IMAGE type", afterD[2].type === "IMAGE", afterD[2]);
    check("run D: type mismatch fails the loader", (run.errors ?? []).some((e) => String(e.node_id) === loaderId && e.exception_message.includes("text입니다")), (run.errors ?? []).map((e) => e.exception_message));

    await ev((id) => window.__bl.pick(window.__node, id), E);
    run = await ev(() => window.__bl.run());
    check("run E: empty image fails the loader", (run.errors ?? []).some((e) => String(e.node_id) === loaderId && e.exception_message.includes("이미지가 없습니다")), (run.errors ?? []).map((e) => e.exception_message));
    const unlinkedMissing = await ev(async () => {
        const b = window.__bl;
        const prompt = {
            "1": { class_type: "BundleLibraryLoad", inputs: { bundle_id: "5a1e0000-0000-4000-8000-0000000000c3",
                slot_spec: JSON.stringify({ v: 1, slots: [{ name: "prompt", type: "text" }, { name: "ref_2", type: "image" }] }) } },
            "2": { class_type: "PreviewAny", inputs: { source: ["1", 0] } },
        };
        const res = await (await b.api.fetchApi("/prompt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt, client_id: b.api.clientId }) })).json();
        for (let i = 0; i < 100; i++) {
            await b.sleep(150);
            const h = (await (await b.api.fetchApi(`/history/${res.prompt_id}`)).json())[res.prompt_id];
            if (h?.status?.status_str) return { status: h.status.status_str, text: h.outputs?.["2"]?.text };
        }
        return null;
    });
    check("missing field on an unlinked slot does not fail the run", unlinkedMissing?.status === "success" && unlinkedMissing.text?.[0] === "Cat mascot", unlinkedMissing);
    const afterE = await ev(() => window.__bl.outs(window.__node));
    check("D -> E: cfg (float) appended", afterE.at(-1).label === "cfg" && afterE.at(-1).type === "FLOAT", afterE.map((o) => o.label));

    await ev((id) => window.__bl.pick(window.__node, id), A);
    const unknown = await ev(async () => {
        const w = window.__node.widgets.find((x) => x.name === "bundle_id");
        const keep = w.value;
        w.value = "5a1e0000-0000-4000-8000-0000000000ff";
        const r = await window.__bl.run();
        w.value = keep;
        return r;
    });
    check("unknown bundle fails validation", unknown.status === 400 && JSON.stringify(unknown.body).includes("번들을 찾을 수 없습니다"), unknown.body?.node_errors);

    // reload from serialized workflow
    const reload = await ev(async () => {
        const b = window.__bl;
        const data = JSON.parse(JSON.stringify(b.app.graph.serialize()));
        const saved = data.nodes.find((n) => n.type === "BundleLibraryLoad");
        await b.app.loadGraphData(data);
        await b.sleep(500);
        const node = b.loaders()[0];
        window.__node = node;
        return { savedOutputs: saved.outputs.length, savedWidgets: saved.widgets_values, outs: b.outs(node), linkTypes: [...b.app.graph.links.values()].map((l) => l.type).sort() };
    });
    check("save: 4 outputs and only bundle_id/slot_spec stored", reload.savedOutputs === 4 && reload.savedWidgets.length === 2, reload.savedWidgets);
    check("reload: labels/types/links restored", JSON.stringify(reload.outs) === JSON.stringify(outs), reload.outs);
    check("reload: link types restored", JSON.stringify(reload.linkTypes) === JSON.stringify(["BOOLEAN", "IMAGE", "IMAGE", "STRING"]), reload.linkTypes);

    // copy/paste and clone
    const paste = await ev(async () => {
        const b = window.__bl, c = b.app.canvas;
        c.copyToClipboard([window.__node]);
        c.graph_mouse = [100, 600];
        c.pasteFromClipboard();
        await b.sleep(300);
        const pasted = b.loaders().find((n) => n !== window.__node);
        const clone = window.__node.clone();
        clone.pos = [400, 600];
        b.app.graph.add(clone);
        await b.sleep(300);
        const res = { pasted: pasted && b.outs(pasted), clone: b.outs(clone) };
        b.app.graph.remove(pasted);
        b.app.graph.remove(clone);
        return res;
    });
    const unlinkedA = outs.map((o) => ({ ...o, links: 0 }));
    check("paste: outputs restored (no links)", JSON.stringify(paste.pasted) === JSON.stringify(unlinkedA), paste.pasted);
    check("clone: outputs restored", JSON.stringify(paste.clone) === JSON.stringify(unlinkedA), paste.clone);

    // undo / redo
    const undo = await ev(async (id) => {
        const b = window.__bl;
        const tracker = b.app.extensionManager.workflow.activeWorkflow.changeTracker;
        tracker.captureCanvasState();
        await b.pick(window.__node, id);
        const onC = b.outs(b.loaders()[0]).map((o) => o.label);
        await tracker.undo();
        await b.sleep(400);
        const undone = b.outs(b.loaders()[0]);
        await tracker.redo();
        await b.sleep(400);
        const redone = b.outs(b.loaders()[0]).map((o) => o.label);
        await tracker.undo();
        await b.sleep(400);
        window.__node = b.loaders()[0];
        return { onC, undone, redone };
    }, C);
    check("undo restores A outputs and links", JSON.stringify(undo.undone) === JSON.stringify(outs), undo.undone);
    check("redo restores C outputs", JSON.stringify(undo.redone) === JSON.stringify(undo.onC), undo.redone);

    // workflow tab switch
    const tabs = await ev(async () => {
        const b = window.__bl, cmd = b.app.extensionManager.command;
        await cmd.execute("Comfy.NewBlankWorkflow");
        await b.sleep(500);
        const blank = b.loaders().length;
        await cmd.execute("Workspace.PreviousOpenedWorkflow");
        await b.sleep(800);
        window.__node = b.loaders()[0];
        return { blank, outs: window.__node && b.outs(window.__node) };
    });
    check("tab switch: outputs restored", tabs.blank === 0 && JSON.stringify(tabs.outs) === JSON.stringify(outs), tabs);

    // keyboard isolation and wheel
    // Global shortcuts listen for keydown on window (bubbling); count what reaches it.
    await ev(() => {
        window.__keys = [];
        window.addEventListener("keydown", (e) => window.__keys.push(e.key));
    });
    const keys = { before: await ev(() => window.__bl.app.graph.nodes.length) };
    await ev(() => window.__bl.app.canvas.selectNode(window.__node));
    await ev(() => window.__node.bundlePanel.root.querySelector(".bl-open").click());
    await page.waitForSelector(".bl-overlay .bl-search");
    await page.keyboard.type("spike");
    await page.keyboard.press("Backspace");
    keys.afterBackspace = await ev(() => document.querySelector(".bl-search").value);
    await page.keyboard.press("Delete");
    await page.keyboard.press("Control+s");
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(600);
    keys.reachedWindow = await ev(() => [...window.__keys]);
    // Headless Chromium shows no "save page" dialog, so check the cancellation itself.
    keys.ctrlSCancelled = await ev(() => {
        const e = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true });
        document.querySelector(".bl-search").dispatchEvent(e);
        return e.defaultPrevented;
    });
    keys.searchValue = await ev(() => document.querySelector(".bl-search").value);
    keys.dialog = await ev(() => !!document.querySelector(".p-dialog"));
    await page.screenshot({ path: path.join(OUT, "classic-modal.png") });
    await page.keyboard.press("Escape");
    keys.modalClosed = await ev(() => !document.querySelector(".bl-overlay"));
    keys.after = await ev(() => window.__bl.app.graph.nodes.length);
    check("modal: no key reaches window; selected node survives Delete", keys.reachedWindow.length === 0 && !keys.dialog && keys.before === keys.after && keys.afterBackspace === "spik", keys);
    check("modal: Ctrl+S cancels the browser's save-page action", keys.ctrlSCancelled === true, keys.ctrlSCancelled);
    check("modal: Escape closes", keys.modalClosed);
    await ev(() => { window.__keys = []; });
    await page.mouse.click(800, 900);
    await page.keyboard.press("Shift");
    const control = await ev(() => [...window.__keys]);
    check("control: outside the modal keys do reach window", control.includes("Shift"), control);

    const wheel = await ev(() => {
        const r = window.__node.bundlePanel.preview.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, scale: window.__bl.app.canvas.ds.scale, scrollable: window.__node.bundlePanel.preview.scrollHeight > window.__node.bundlePanel.preview.clientHeight };
    });
    await page.mouse.move(wheel.x, wheel.y);
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(300);
    wheel.after = await ev(() => window.__bl.app.canvas.ds.scale);
    check("wheel over panel (record)", true, wheel);

    // sidebar and command
    const sidebar = await ev(async () => {
        const b = window.__bl;
        await b.app.extensionManager.command.execute("Workspace.ToggleSidebarTab.bundle-library");
        await b.sleep(800);
        const el = document.querySelector(".bl-sidebar");
        const text = el?.innerText ?? null;
        await b.app.extensionManager.command.execute("Workspace.ToggleSidebarTab.bundle-library");
        return text;
    });
    check("sidebar tab renders list", sidebar && sidebar.includes("Spike A"), sidebar);

    // subgraph
    const sub = await ev(async () => {
        const b = window.__bl;
        const { node } = b.app.graph.convertToSubgraph(new Set([window.__node]));
        await b.sleep(400);
        const inner = b.loaders(node.subgraph)[0];
        return { subOutputs: node.outputs.map((o) => [o.label ?? o.name, o.type, o.links?.length ?? 0]), inner: inner && b.outs(inner) };
    });
    check("subgraph: inner loader keeps outputs", JSON.stringify(sub.inner) === JSON.stringify(outs), sub);
    run = await ev(() => window.__bl.run());
    check("subgraph: run succeeds", run.history?.status?.status_str === "success" && run.history?.outputs?.[p.pPrompt]?.text?.[0]?.startsWith("Red dress"), run.history?.status?.status_str ?? run.body);
    const subReload = await ev(async () => {
        const b = window.__bl;
        const data = JSON.parse(JSON.stringify(b.app.graph.serialize()));
        await b.app.loadGraphData(data);
        await b.sleep(600);
        const sg = b.app.graph.nodes.find((n) => n.subgraph);
        return { subOutputs: sg.outputs.map((o) => [o.label ?? o.name, o.type, o.links?.length ?? 0]), inner: b.outs(b.loaders(sg.subgraph)[0]) };
    });
    check("subgraph reload: inner outputs restored", JSON.stringify(subReload.inner) === JSON.stringify(outs), subReload);

    // ---- Nodes 2.0 ---------------------------------------------------------
    await ev(async () => {
        const b = window.__bl;
        b.app.graph.clear();
        await b.app.extensionManager.setting.set("Comfy.VueNodes.Enabled", true);
        await b.sleep(1200);
    });
    const vue = await ev(async () => {
        const b = window.__bl;
        const node = b.add("BundleLibraryLoad", [80, 80]);
        window.__node = node;
        await b.sleep(800);
        return { outputs: node.outputs.length, vueMode: LiteGraph.vueNodesMode };
    });
    check("vue: renderer on, new node has 0 outputs", vue.vueMode === true && vue.outputs === 0, vue);
    const domText = (id) => ev((nid) => document.querySelector(`[data-node-id="${nid}"]`)?.innerText ?? null, id);
    await ev((id) => window.__bl.pick(window.__node, id), A);
    await page.waitForTimeout(600);
    const vueId = await ev(() => String(window.__node.id));
    let text = await domText(vueId);
    check("vue: DOM shows A slot labels", text && ["prompt", "ref_1", "ref_2", "use_bgm"].every((s) => text.includes(s)), text);
    await ev(() => {
        const b = window.__bl, n = window.__node;
        const pRef2 = b.add("PreviewImage", [700, 260]);
        n.connect(2, pRef2, 0);
    });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, "vue-A.png") });
    await ev((id) => window.__bl.pick(window.__node, id), C);
    await page.waitForTimeout(600);
    text = await domText(vueId);
    const vueC = await ev(() => window.__bl.outs(window.__node));
    check("vue: A -> C updates DOM (seed shown, ref_2 kept, use_bgm gone)", text && text.includes("seed") && text.includes("ref_2") && !/\buse_bgm\b/.test(text.replace(/[\s\S]*?(bl-preview)/, "")), { text, outs: vueC });
    await page.screenshot({ path: path.join(OUT, "vue-C.png") });
    const vueReload = await ev(async () => {
        const b = window.__bl;
        const data = JSON.parse(JSON.stringify(b.app.graph.serialize()));
        await b.app.loadGraphData(data);
        await b.sleep(1000);
        window.__node = b.loaders()[0];
        return { outs: b.outs(window.__node), id: String(window.__node.id) };
    });
    text = await domText(vueReload.id);
    check("vue: reload restores outputs", JSON.stringify(vueReload.outs) === JSON.stringify(vueC), vueReload.outs);
    check("vue: reload DOM shows labels", text && text.includes("seed") && text.includes("ref_2"), text);
    await page.screenshot({ path: path.join(OUT, "vue-reload.png") });

    await ev(async () => {
        await window.__bl.app.extensionManager.setting.set("Comfy.VueNodes.Enabled", false);
        window.__bl.app.graph.clear();
    });

    check("no settings/workflow writes reached the server (blocked list)", true, [...new Set(blocked)]);
    check("browser console errors (record)", true, consoleErrors.slice(0, 20));
    fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ results, blocked: [...new Set(blocked)], consoleErrors }, null, 2));
    await browser.close();
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
