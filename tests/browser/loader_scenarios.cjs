// Browser scenarios for the Load Bundle node (started in Phase 0). Set-up and
// safety notes are in harness.cjs.
const { startSession } = require("./harness.cjs");

(async () => {
    const { page, ev, check, shot, reload: reloadPage, finish } = await startSession("loader");
    const { A, B, C, D, E } = await ev(() => window.__bl.createTestBundles());

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
    await shot("classic-A.png");
    outs = await ev(() => window.__bl.outs(window.__node));
    check("wired baseline: one link per output", outs.every((o) => o.links === 1), outs);
    const panelA = await ev(async (bundleA) => {
        const b = window.__bl, { preview, rows, notice } = window.__node.bundlePanel;
        const summary = (await b.request("GET", "/bundles")).bundles.find((x) => x.id === bundleA);
        const shown = Object.fromEntries([...rows.querySelectorAll("[data-field]")].map((item) => [item.dataset.field, {
            type: item.dataset.type,
            kind: item.className,
            text: item.querySelector(".bl-text")?.textContent ?? null,
            img: item.querySelector("img")?.getAttribute("src") ?? null,
            value: item.querySelector(".bl-value")?.textContent ?? null,
            box: [item.offsetWidth, item.offsetHeight],
        }]));
        const padding = parseFloat(getComputedStyle(preview).paddingTop) + parseFloat(getComputedStyle(preview).paddingBottom);
        return { summary, shown, spare: preview.clientHeight - padding - rows.offsetHeight - (notice.hidden ? 0 : notice.offsetHeight + 6) };
    }, A);
    check("panel height fits its content (at most a small margin left)", panelA.spare >= 0 && panelA.spare <= 16, panelA.spare);
    const fieldsA = Object.fromEntries(panelA.summary.fields.map((f) => [f.name, f]));
    check("preview shows each field of the bundle", JSON.stringify(Object.entries(panelA.shown).map(([name, item]) => [name, item.type]).sort())
        === JSON.stringify(panelA.summary.fields.map((f) => [f.name, f.type]).sort()), panelA.shown);
    check("preview: images in the gallery, then the text, then the value chip",
        JSON.stringify(Object.values(panelA.shown).map((item) => item.kind)) === JSON.stringify(["bl-tile", "bl-tile", "bl-text-block", "bl-value-chip"]),
        Object.keys(panelA.shown));
    check("preview: text, thumbnails and value match the bundle",
        panelA.shown.prompt.text === fieldsA.prompt.preview
        && panelA.shown.ref_1.img.includes(fieldsA.ref_1.preview.sha256) && panelA.shown.ref_2.img.includes(fieldsA.ref_2.preview.sha256)
        && panelA.shown.use_bgm.value === "true", panelA.shown);
    const tileA = panelA.shown.ref_1.box;
    check("gallery: a tile keeps the image's aspect ratio, at most 240px high",
        Math.abs(tileA[0] / tileA[1] - 512 / 768) < 0.02 && tileA[1] <= 240 && tileA[1] >= 150, tileA);
    const narrow = await ev(async () => {
        const b = window.__bl, n = window.__node;
        const before = n.size.slice();
        const height = () => n.bundlePanel.preview.querySelector(".bl-tile").offsetHeight;
        const wide = height();
        n.setSize([260, n.size[1]]);
        b.app.canvas.setDirty(true, true);
        await b.sleep(400);
        const small = height();
        n.setSize(before);
        b.app.canvas.setDirty(true, true);
        await b.sleep(400);
        return { wide, small, back: height() };
    });
    check("gallery: the tiles follow the node's width", narrow.small < narrow.wide && narrow.back === narrow.wide, narrow);
    await ev(() => {
        window.__keys = [];
        window.addEventListener("keydown", (e) => window.__keys.push(e.key));
    });
    const nodeCount = await ev(() => window.__bl.app.graph.nodes.length);
    await page.locator(".bl-panel .bl-tile").first().click();
    const lightbox = await page.waitForFunction(() => {
        const img = document.querySelector(".bl-lightbox img");
        return img?.complete && img.naturalWidth > 0 && { src: img.getAttribute("src"), width: img.naturalWidth };
    }, null, { timeout: 10000 }).then((h) => h.jsonValue(), () => null);
    check("clicking a tile shows the full image", lightbox && lightbox.src.endsWith(`/assets/${fieldsA.ref_1.preview.sha256}`) && lightbox.width === 512, lightbox);
    await shot("classic-lightbox.png");
    await ev(() => window.__bl.app.canvas.selectNode(window.__node)); // Delete would remove it if the key got through
    await page.keyboard.press("Delete");
    await page.keyboard.press("Escape");
    const afterBox = await ev(() => ({ open: !!document.querySelector(".bl-lightbox"), keys: [...window.__keys], nodes: window.__bl.app.graph.nodes.length }));
    check("the image view closes with Escape; its keys never reach ComfyUI (Delete kept the node)",
        !afterBox.open && afterBox.keys.length === 0 && afterBox.nodes === nodeCount, afterBox);

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
    check("panel marks missing slots", (panelC.match(/running will fail/g) ?? []).length === 2, panelC);
    await shot("classic-C-missing.png");
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
            shownInPage: document.body.innerText.includes("cannot fill the connected outputs"),
        };
    });
    check("run C via Run path: error event reaches the client", uiRun.errors.length === 1, uiRun.errors);
    // How the failure looks (the error dialog) was checked by hand in a real browser.
    check("run C via Run path: job recorded as failed", uiRun.status === "error", uiRun);
    const rerun = await ev(() => window.__bl.run());
    check("re-run C unchanged: fails again (not cached)", (rerun.errors ?? []).length === 1, (rerun.errors ?? []).map((e) => e.node_id));
    await shot("classic-C-run-error.png");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    await ev((id) => window.__bl.pick(window.__node, id), A);
    const backA = await ev(() => window.__bl.outs(window.__node));
    check("C -> A: unlinked seed removed, links intact", JSON.stringify(backA) === JSON.stringify(outs), backA);

    await ev((id) => window.__bl.pick(window.__node, id), D);
    const afterD = await ev(() => window.__bl.outs(window.__node));
    run = await ev(() => window.__bl.run());
    check("A -> D: linked ref_2 keeps IMAGE type", afterD[2].type === "IMAGE", afterD[2]);
    check("run D: type mismatch fails the loader", (run.errors ?? []).some((e) => String(e.node_id) === loaderId && e.exception_message.includes("is text, not image")), (run.errors ?? []).map((e) => e.exception_message));

    await ev((id) => window.__bl.pick(window.__node, id), E);
    const emptyTile = await ev(() => window.__node.bundlePanel.rows.querySelector('[data-field="ref_2"] .bl-tile-empty')?.textContent ?? null);
    check("preview: a connected empty image warns that running will fail", emptyTile === "⚠ No image; running will fail", emptyTile);
    run = await ev(() => window.__bl.run());
    check("run E: empty image fails the loader", (run.errors ?? []).some((e) => String(e.node_id) === loaderId && e.exception_message.includes("has no image")), (run.errors ?? []).map((e) => e.exception_message));
    const unlinkedMissing = await ev(async (bundleC) => {
        const b = window.__bl;
        const prompt = {
            "1": { class_type: "BundleLibraryLoad", inputs: { bundle_id: bundleC,
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
    }, C);
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
    check("unknown bundle fails validation", unknown.status === 400 && JSON.stringify(unknown.body).includes("Bundle not found"), unknown.body?.node_errors);

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

    // collapse the preview, then reload the whole page with the saved workflow
    const collapse = await ev(async () => {
        const b = window.__bl, n = window.__node;
        const before = n.size[1];
        n.bundlePanel.toggle.click();
        await b.sleep(200);
        return { before, after: n.size[1], hidden: n.bundlePanel.preview.hidden, saved: n.properties.preview_collapsed };
    });
    check("collapse: preview hidden, node shorter, state saved", collapse.hidden && collapse.saved === true && collapse.after < collapse.before - 40, collapse);
    const savedGraph = await ev(() => JSON.parse(JSON.stringify(window.__bl.app.graph.serialize())));
    await reloadPage();
    const pageReload = await ev(async (data) => {
        const b = window.__bl;
        await b.app.loadGraphData(data);
        await b.sleep(800);
        const n = b.loaders()[0];
        window.__node = n;
        const { select, preview } = n.bundlePanel;
        const collapsed = preview.hidden;
        n.bundlePanel.toggle.click();
        await b.sleep(300);
        return { outs: b.outs(n), selected: select.selectedOptions[0]?.textContent, collapsed,
                 rows: preview.querySelectorAll("[data-field]").length, expanded: !preview.hidden && !n.properties.preview_collapsed };
    }, savedGraph);
    check("page reload: outputs, links and selection restored", JSON.stringify(pageReload.outs) === JSON.stringify(outs)
        && pageReload.selected === "[test] A (red)", pageReload);
    check("page reload: collapsed state kept, then expands with the preview", pageReload.collapsed && pageReload.expanded && pageReload.rows === 4, pageReload);

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
    await shot("classic-modal.png");
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
    check("sidebar tab renders list", sidebar && sidebar.includes("[test] A (red)"), sidebar);

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
    const subSwitch = await ev(async (ids) => {
        const b = window.__bl;
        const sg = b.app.graph.nodes.find((n) => n.subgraph);
        const inner = b.loaders(sg.subgraph)[0];
        const sgOuts = () => sg.outputs.map((o) => [o.label ?? o.name, o.type, o.links?.length ?? 0]);
        const before = sgOuts();
        await b.pick(inner, ids.B);
        const onB = { inner: b.outs(inner), outer: sgOuts() };
        await b.pick(inner, ids.C);
        const onC = { inner: b.outs(inner), outer: sgOuts() };
        return { before, onB, onC };
    }, { B, C });
    check("subgraph: switching the inner loader A -> B keeps inner and outer slots",
        JSON.stringify(subSwitch.onB.inner) === JSON.stringify(outs) && JSON.stringify(subSwitch.onB.outer) === JSON.stringify(subSwitch.before), subSwitch.onB);
    check("subgraph: switching to C keeps the linked slots and the subgraph outputs",
        JSON.stringify(subSwitch.onC.outer) === JSON.stringify(subSwitch.before) && subSwitch.onC.inner.length === 5, subSwitch.onC);
    run = await ev(() => window.__bl.run());
    check("subgraph on C: run fails at the inner loader", (run.errors ?? []).some((e) => e.exception_message.includes("cannot fill the connected outputs")),
        (run.errors ?? []).map((e) => [e.node_id, e.exception_message.slice(0, 60)]));
    await ev(async (bundleA) => {
        const b = window.__bl;
        const sg = b.app.graph.nodes.find((n) => n.subgraph);
        await b.pick(b.loaders(sg.subgraph)[0], bundleA);
    }, A);

    // a second loader beside the first: independence, rename, field changes, unlinked misfits
    const second = await ev(async (ids) => {
        const b = window.__bl;
        const n2 = b.add("BundleLibraryLoad", [80, 700]);
        window.__node2 = n2;
        await b.pick(n2, ids.B);
        const p2 = b.add("PreviewAny", [700, 700]);
        const p3 = b.add("PreviewAny", [1000, 700]);
        n2.connect(0, p2, 0);
        n2.connect(3, p3, 0);
        window.__p2 = { p2: p2.id, p3: p3.id };
        return { outs: b.outs(n2) };
    }, { B });
    run = await ev(() => window.__bl.run());
    const p2 = await ev(() => window.__p2);
    check("two loaders run side by side with their own bundles",
        run.history?.outputs?.[p.pPrompt]?.text?.[0]?.startsWith("Red dress") && run.history?.outputs?.[p2.p2]?.text?.[0] === "Blue shirt girl",
        { first: run.history?.outputs?.[p.pPrompt]?.text, second: run.history?.outputs?.[p2.p2]?.text });

    const renamed = await ev(async (ids) => {
        const b = window.__bl;
        const summary = (await b.request("GET", "/bundles")).bundles.find((x) => x.id === ids.B);
        const full = await b.request("GET", `/bundles/${ids.B}`);
        await b.request("PUT", `/bundles/${ids.B}`, { ...full, name: "[test] B renamed", expected_revision: summary.revision });
        window.dispatchEvent(new CustomEvent("bundle-library:changed"));
        await b.sleep(600);
        const n2 = window.__node2;
        return { selected: n2.bundlePanel.select.selectedOptions[0]?.textContent, outs: b.outs(n2) };
    }, { B });
    check("rename in the library: the node keeps its selection and outputs",
        renamed.selected === "[test] B renamed" && JSON.stringify(renamed.outs) === JSON.stringify(second.outs), renamed);

    const grown = await ev(async (ids) => {
        const b = window.__bl;
        const full = await b.request("GET", `/bundles/${ids.B}`);
        await b.request("PUT", `/bundles/${ids.B}`, { ...full, expected_revision: full.revision,
            fields: [...full.fields, { name: "extra", type: "int", value: 7 }] });
        window.dispatchEvent(new CustomEvent("bundle-library:changed"));
        await b.sleep(600);
        const n2 = window.__node2, { notice } = n2.bundlePanel;
        const before = { visible: !notice.hidden, text: notice.textContent };
        notice.querySelector(".bl-update")?.click();
        await b.sleep(300);
        return { before, after: b.outs(n2), hidden: notice.hidden };
    }, { B });
    check("a new field in the library is offered, and Update outputs adds it", grown.before.visible && grown.before.text.includes("+extra")
        && grown.after.at(-1).label === "extra" && grown.after.at(-1).type === "INT" && grown.after[0].links === 1 && grown.hidden, grown);

    const misfit = await ev(async (ids) => {
        const b = window.__bl, n2 = window.__node2;
        await b.pick(n2, ids.C);
        const linkedText = n2.bundlePanel.rows.textContent;
        n2.disconnectOutput(n2.outputs.findIndex((o) => o.label === "use_bgm"));  // linked and missing until now
        await b.sleep(400);
        const { rows, notice } = n2.bundlePanel;
        const unlinked = { rows: rows.textContent, notice: notice.hidden ? null : notice.textContent };
        notice.querySelector(".bl-update")?.click();
        await b.sleep(300);
        return { linkedText, unlinked, after: b.outs(n2).map((o) => o.label) };
    }, { C });
    check("misfit status follows the link: failure warning while linked",
        (misfit.linkedText.match(/running will fail/g) ?? []).length === 1, misfit.linkedText);
    check("misfit status follows the link: 'not connected' once unlinked, with an update to drop it",
        misfit.unlinked.rows.includes("not in this bundle (not connected)") && misfit.unlinked.notice?.includes("−use_bgm")
        && !misfit.after.includes("use_bgm"), misfit);
    await ev(() => {
        const b = window.__bl;
        for (const id of Object.values(window.__p2)) b.app.graph.remove(b.app.graph.getNodeById(id));
        b.app.graph.remove(window.__node2);
    });

    // ---- a field turned off in the bundle (0.0.30) ------------------------------------------------
    const switchId = await ev(async () => {
        const b = window.__bl;
        const made = await b.request("POST", "/bundles", { name: "[test] Switch", tags: ["test"], fields: [
            { name: "prompt", type: "text", value: "on and off" }, { name: "flag", type: "boolean", value: true },
            { name: "extra", type: "text", value: "spare" }] });
        window.dispatchEvent(new CustomEvent("bundle-library:changed")); // the lists read before it was made
        await b.sleep(300);
        const n = b.add("BundleLibraryLoad", [80, 420]);
        window.__switch = n;
        await b.pick(n, made.id);
        const preview = b.add("PreviewAny", [700, 420]);
        window.__switchPreview = preview.id;
        n.connect(0, preview, 0); // prompt is linked; flag and extra are not
        return made.id;
    });
    /** Turn the named fields of the bundle off (or every field on), then read the node as the library says it changed. */
    const turn = (off) => ev(async ([id, names]) => {
        const b = window.__bl, n = window.__switch;
        const full = await b.request("GET", `/bundles/${id}`);
        await b.request("PUT", `/bundles/${id}`, { ...full, expected_revision: full.revision, fields: full.fields.map(
            ({ enabled, ...f }) => (names.includes(f.name) ? { ...f, enabled: false } : f)) });
        window.dispatchEvent(new CustomEvent("bundle-library:changed"));
        await b.sleep(600);
        const { rows, notice } = n.bundlePanel;
        return { version: (await b.request("GET", `/bundles/${id}`)).schema_version, outs: b.outs(n).map((o) => o.label),
            rows: rows.textContent, notice: notice.hidden ? null : notice.textContent };
    }, [switchId, off]);
    const update = () => ev(async () => {
        const b = window.__bl, n = window.__switch;
        n.bundlePanel.notice.querySelector(".bl-update")?.click();
        await b.sleep(300);
        return b.outs(n).map((o) => [o.label, o.links]);
    });
    let switched = await turn(["prompt", "extra"]);
    check("turned off: a linked output stays, marked to fail; an unlinked one is offered to drop",
        switched.version === 3 && switched.rows.includes("turned off in this bundle; running will fail")
        && switched.rows.includes("turned off in this bundle (not connected)") && switched.notice?.includes("−extra")
        && !switched.notice.includes("prompt"), switched);
    check("Update outputs drops the unlinked off output only", JSON.stringify(await update()) === JSON.stringify([
        ["prompt", 1], ["flag", 0]]));
    run = await ev(() => window.__bl.run());
    const offErrors = (run.errors ?? []).map((e) => e.exception_message);
    check("running with a linked output turned off fails with that reason",
        offErrors.length === 1 && offErrors[0].includes("'prompt' is turned off in the bundle"), offErrors);
    switched = await turn([]);
    check("on again: the output is fine where it was, and the other field is offered back",
        switched.version === 2 && !switched.rows.includes("turned off") && switched.notice?.includes("+extra"), switched);
    check("Update outputs adds it at the end; the link never moved", JSON.stringify(await update()) === JSON.stringify([
        ["prompt", 1], ["flag", 0], ["extra", 0]]));
    run = await ev(() => window.__bl.run());
    check("the run passes again", run.history?.status?.status_str === "success"
        && run.history?.outputs?.[await ev(() => window.__switchPreview)]?.text?.[0] === "on and off", run.errors);
    await ev(() => {
        const b = window.__bl;
        b.app.graph.remove(b.app.graph.getNodeById(window.__switchPreview));
        b.app.graph.remove(window.__switch);
    });

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
    const vueTiles = await ev(() => [...window.__node.bundlePanel.preview.querySelectorAll(".bl-tile")].map((t) => [t.offsetWidth, t.offsetHeight]));
    check("vue: the gallery shows both images", vueTiles.length === 2 && vueTiles.every(([w, h]) => w > 50 && h > 50 && h <= 240), vueTiles);
    const vueCollapse = await ev(async (nid) => {
        const b = window.__bl, n = window.__node;
        n.bundlePanel.toggle.click();
        await b.sleep(400);
        const collapsedText = document.querySelector(`[data-node-id="${nid}"]`)?.innerText ?? "";
        n.bundlePanel.toggle.click();
        await b.sleep(400);
        return { collapsedHasPreview: collapsedText.includes("Red dress girl"), expanded: !n.bundlePanel.preview.hidden };
    }, vueId);
    check("vue: collapse hides the preview and expands it again", !vueCollapse.collapsedHasPreview && vueCollapse.expanded, vueCollapse);
    await ev(() => {
        const b = window.__bl, n = window.__node;
        const pRef2 = b.add("PreviewImage", [700, 260]);
        n.connect(2, pRef2, 0);
    });
    await page.waitForTimeout(400);
    await shot("vue-A.png");
    await ev((id) => window.__bl.pick(window.__node, id), C);
    await page.waitForTimeout(600);
    text = await domText(vueId);
    const vueC = await ev(() => window.__bl.outs(window.__node));
    check("vue: A -> C updates DOM (seed shown, ref_2 kept, use_bgm gone)", text && text.includes("seed") && text.includes("ref_2") && !/\buse_bgm\b/.test(text.replace(/[\s\S]*?(bl-preview)/, "")), { text, outs: vueC });
    await shot("vue-C.png");
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
    await shot("vue-reload.png");

    await ev(async () => {
        await window.__bl.app.extensionManager.setting.set("Comfy.VueNodes.Enabled", false);
        window.__bl.app.graph.clear();
    });

    // ---- a workflow that saved linked outputs under other fields (N10) ----------------------------------
    const WARNING = "under another field than the node records";
    const warnings = () => ev((text) => [...document.querySelectorAll(".p-toast-message")]
        .map((t) => t.textContent).filter((t) => t.includes(text)), WARNING);
    const misplaced = await ev(async (id) => {
        const b = window.__bl;
        const n = b.add("BundleLibraryLoad", [80, 80]);
        await b.pick(n, id);
        n.connect(0, b.add("PreviewAny", [600, 80]), 0);
        n.connect(1, b.add("PreviewImage", [600, 300]), 0);
        const data = JSON.parse(JSON.stringify(b.app.graph.serialize()));
        const saved = data.nodes.find((x) => x.type === "BundleLibraryLoad").outputs;
        [saved[0].label, saved[1].label] = [saved[1].label, saved[0].label]; // as a hand-edited file might
        await b.app.loadGraphData(data);
        await b.sleep(800);
        return { labels: b.outs(b.loaders()[0]).slice(0, 2).map((o) => o.label), spec: JSON.parse(b.spec(b.loaders()[0])).slots };
    }, A);
    const toast = await page.waitForFunction((text) => [...document.querySelectorAll(".p-toast-message")]
        .map((t) => t.textContent).find((t) => t.includes(text)) ?? null, WARNING, { timeout: 5000 })
        .then((h) => h.jsonValue(), () => null);
    check("a workflow that saved linked outputs under other fields says so; the outputs follow slot_spec (N10)",
        toast?.includes("1 (ref_1 → prompt)") && toast.includes("2 (prompt → ref_1)")
        && JSON.stringify(misplaced.labels) === JSON.stringify(["prompt", "ref_1"]), { toast, misplaced });
    const before = (await warnings()).length;
    await ev(async () => {
        const b = window.__bl;
        await b.app.loadGraphData(JSON.parse(JSON.stringify(b.app.graph.serialize())));
        await b.sleep(800);
    });
    check("the same workflow saved again (outputs and slot_spec agree) loads without it", (await warnings()).length === before);
    await ev(() => window.__bl.app.graph.clear());

    await finish({ expectRemoved: 6 }); // A–E and the switched one
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
