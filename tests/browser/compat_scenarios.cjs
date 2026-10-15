// Browser scenarios for compatibility (Phase 7.5): a workflow saved by 0.0.10,
// one with an output type this version does not know, large old ints, files
// this version cannot fully read (under Needs attention since Phase 7.6), and
// a page and server of different versions.
// Set-up and safety notes are in harness.cjs. The hand-made bundle files are
// placed in the test server's library through its container (BL_TEST_CONTAINER
// and BL_TEST_LIBRARY, which scripts/bundle-library-test-server.sh run sets)
// and removed at the end; without them those checks are skipped.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { startSession } = require("./harness.cjs");

const COMPAT = path.join(__dirname, "..", "fixtures", "compat");
const IN_CONTAINER = "/opt/ComfyUI/custom_nodes/ComfyUI-Bundle-Library/tests/fixtures/compat";
const CONTAINER = process.env.BL_TEST_CONTAINER;
const LIBRARY = process.env.BL_TEST_LIBRARY;
const EXPECTED = JSON.parse(fs.readFileSync(path.join(COMPAT, "handmade", "expected.json"), "utf8"));

/** Put hand-made files into the test server's library; the paths placed. */
function place(keys) {
    const placed = keys.map((key) => `${LIBRARY}/bundles/${EXPECTED[key].id}.json`);
    keys.forEach((key, i) => execFileSync("docker", ["exec", CONTAINER, "python", "-c",
        "import shutil, sys; shutil.copy(sys.argv[1], sys.argv[2])", `${IN_CONTAINER}/handmade/${key}.json`, placed[i]]));
    return placed;
}

function unplace(paths) {
    execFileSync("docker", ["exec", CONTAINER, "python", "-c",
        "import os, sys\nfor p in sys.argv[1:]:\n    if os.path.exists(p): os.remove(p)", ...paths]);
}

(async () => {
    const session = await startSession("compat");
    const { page, ev, check, shot, finish } = session;
    const overlay = page.locator(".bl-overlay");
    const layerBox = page.locator(".bl-overlay .bl-layer");
    const button = (name, scope = overlay) => scope.getByRole("button", { name, exact: true });
    const until = (fn, arg, timeout = 10000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
    const api = (method, route, body) => ev(([m, r, b]) => window.__bl.request(m, r, b), [method, route, body]);

    // ---- a workflow saved by 0.0.10 ---------------------------------------------------
    const png = fs.readFileSync(path.join(COMPAT, "0.0.10-workflow", "workflow-ref.png")).toString("base64");
    const saved = JSON.parse(fs.readFileSync(path.join(COMPAT, "0.0.10-workflow", "workflow-bundle.json"), "utf8"));
    const bundle = await ev(async ([data, saved]) => {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        const form = new FormData();
        form.append("file", new Blob([bytes], { type: "image/png" }), "compat.png");
        const { asset } = await window.__bl.request("POST", "/assets", form);
        const fields = saved.fields.map((f) => (f.type === "image" ? { name: f.name, type: f.type, asset: { sha256: asset.sha256 } }
            : { name: f.name, type: f.type, value: f.value }));
        return window.__bl.request("POST", "/bundles", { name: saved.name, tags: ["test"], fields });
    }, [png, saved]);
    const load = async (file) => {
        const text = fs.readFileSync(path.join(COMPAT, "0.0.10-workflow", file), "utf8").replaceAll(saved.id, bundle.id);
        return ev(async (workflow) => {
            await window.__bl.app.loadGraphData(JSON.parse(workflow));
            await window.__bl.sleep(800);
            const node = window.__bl.loaders()[0];
            const out = window.__bl.app.graph.serialize();
            const savedNode = out.nodes.find((n) => n.type === "BundleLibraryLoad");
            return {
                outputs: node.outputs.map((o) => [o.name, o.label, o.type, o.links?.length ?? 0]),
                spec: savedNode.widgets_values[1],
                links: out.links.map((l) => [l[2], l[5]]).sort(),
                preview: node.bundlePanel.rows.textContent,
                tiles: node.bundlePanel.rows.querySelectorAll(".bl-tile img").length,
            };
        }, text);
    };
    const original = JSON.parse(fs.readFileSync(path.join(COMPAT, "0.0.10-workflow", "workflow.json"), "utf8"));
    const originalNode = original.nodes.find((n) => n.type === "BundleLibraryLoad");
    const expectedOutputs = originalNode.outputs.map((o) => [o.name, o.label, o.type, o.links?.length ?? 0]);
    let loaded = await load("workflow.json");
    check("a workflow saved by 0.0.10 comes back: outputs, types, links and preview",
        JSON.stringify(loaded.outputs) === JSON.stringify(expectedOutputs) && loaded.links.length === 3
        && loaded.links.every(([slot]) => slot <= 2) && loaded.tiles === 1 && loaded.preview.includes("Saved by an older release."),
        loaded);

    const unknownNode = JSON.parse(fs.readFileSync(path.join(COMPAT, "0.0.10-workflow", "workflow-unknown-slot-type.json"),
        "utf8")).nodes.find((n) => n.type === "BundleLibraryLoad");
    loaded = await load("workflow-unknown-slot-type.json");
    check("a workflow with an output type this version does not know keeps its outputs, links and spec when saved",
        JSON.stringify(loaded.outputs) === JSON.stringify(expectedOutputs) && loaded.links.length === 3
        && loaded.spec === unknownNode.widgets_values[1] && loaded.preview.includes("saved by a newer Bundle Library"),
        loaded);
    const kept = await ev(async (otherId) => {
        const node = window.__bl.loaders()[0];
        const before = window.__bl.spec(node);
        node.bundlePanel.select.value = otherId;
        node.bundlePanel.select.dispatchEvent(new Event("change"));
        await window.__bl.sleep(300);
        return { same: window.__bl.spec(node) === before, id: node.widgets.find((w) => w.name === "bundle_id").value };
    }, bundle.id);
    check("such a node does not change its bundle (a newer node pack is needed)", kept.same && kept.id === bundle.id, kept);
    await ev(() => window.__bl.app.graph.clear());

    // ---- files placed in the library ---------------------------------------------------
    if (CONTAINER && LIBRARY) {
        const placed = place(["int-2p60", "unknown-top-key", "v3-other-references"]);
        try {
            await ev(() => window.__bl.app.extensionManager.command.execute("BundleLibrary.Open"));
            await overlay.waitFor();
            const bigId = EXPECTED["int-2p60"].id;
            const readOnlyId = EXPECTED["unknown-top-key"].id;
            await until((ids) => ids.every((id) => document.querySelector(`.bl-overlay .bl-list-item[data-id="${id}"]`)),
                [bigId, readOnlyId]);
            const marks = await ev((ids) => ids.map((id) => document.querySelector(
                `.bl-overlay .bl-list-item[data-id="${id}"] .bl-list-warn`)?.textContent ?? null), [bigId, readOnlyId]);
            check("the list marks a bundle to fix and one this version cannot change",
                marks[0] === "⚠ Fix before saving" && marks[1] === "🔒 Cannot be changed by this version", marks);

            await page.locator(`.bl-overlay .bl-group.attention .bl-list-item[data-id="${bigId}"]`).click();
            await until(() => document.querySelector(".bl-overlay .bl-number"));
            await page.locator(".bl-overlay .bl-note-input").fill("only the note changed");
            let editor = await ev(() => ({
                number: document.querySelector(".bl-overlay .bl-number").value,
                error: document.querySelector(".bl-overlay .bl-field .bl-error:not([hidden])")?.textContent ?? null,
                notes: document.querySelector(".bl-overlay .bl-editor-notes")?.textContent ?? null,
                save: !document.querySelector(".bl-overlay .bl-editor-head button.primary").disabled,
            }));
            check("a large old int is shown exactly, marked, and keeps the bundle from being saved",
                editor.number === String(2n ** 60n) && editor.error?.includes("Change this value before saving.")
                && editor.notes?.includes("allowed when it was saved") && !editor.save, editor);
            await shot("compat-big-int.png");
            await page.locator(".bl-overlay .bl-number").fill("5");
            await button("Save", page.locator(".bl-overlay .bl-editor")).click();
            await until(() => document.querySelector(".bl-overlay .bl-state")?.textContent === "Saved");
            const fixed = await api("GET", `/bundles/${bigId}`);
            check("once the value is changed it saves", fixed.fields[0].value === 5 && !fixed.warnings, fixed.fields[0]);

            await page.locator(`.bl-overlay .bl-group.attention .bl-list-item[data-id="${readOnlyId}"]`).click();
            await until(() => document.querySelector(".bl-overlay .bl-editor-notes"));
            editor = await ev(() => {
                const head = [...document.querySelectorAll(".bl-overlay .bl-editor-head > button:not(.bl-star), .bl-overlay .bl-editor-head .bl-menu-wrap > button")];
                return {
                    notes: document.querySelector(".bl-overlay .bl-editor-notes").textContent,
                    enabled: head.filter((b) => !b.disabled).map((b) => b.textContent),
                    inert: document.querySelector(".bl-overlay .bl-fields").inert,
                    tags: document.querySelector(".bl-overlay .bl-tags").inert,
                    place: !document.querySelector(".bl-overlay .bl-category-select").disabled
                        && !document.querySelector(".bl-overlay .bl-editor-head .bl-star").disabled,
                };
            });
            check("a bundle with data this version does not know can be seen but not saved, duplicated or deleted; "
                + "it can still be starred and placed, which does not change it",
                editor.notes.includes("does not change it") && editor.inert && editor.tags && editor.enabled.length === 0
                && editor.place, editor);

            const newer = `bundles/${EXPECTED["v3-other-references"].id}.json`;
            const attention = (file) => `.bl-overlay .bl-group.attention .bl-error-item[data-file="${file}"]`;
            await until((selector) => document.querySelector(selector), attention(newer));
            const row = await ev((selector) => document.querySelector(selector).textContent, attention(newer));
            const marked = await ev((ids) => ids.map((id) => [...document.querySelectorAll(
                ".bl-overlay .bl-group.attention .bl-list-item")].some((r) => r.dataset.id === id)), [bigId, readOnlyId]);
            const trashButton = await ev(() => document.querySelector(".bl-overlay .bl-trash-button").textContent);
            check("Needs attention lists a file saved by a newer version with the reason, and the bundles to look at",
                row.includes("saved by a newer Bundle Library") && marked[1] && !trashButton.includes("⚠"),
                { row, marked, trashButton });
            await button("Delete forever", page.locator(attention(newer))).click();
            const layer = await ev(() => [...document.querySelectorAll(".bl-overlay .bl-layer .bl-confirm-text")]
                .map((t) => t.textContent));
            check("deleting it asks with a warning that a newer version loses it too",
                layer.length === 2 && layer[1].startsWith("If a newer Bundle Library saved it"), layer);
            await button("Delete forever", layerBox).click();
            const gone = await until((selector) => !document.querySelector(selector), attention(newer));
            check("it is deleted only when asked", gone);
            await shot("compat-attention.png");
            await page.keyboard.press("Escape");
            await overlay.waitFor({ state: "detached" });
        } finally {
            unplace(placed);
        }
    } else {
        check("hand-made library files (skipped: no test server container)", true);
    }

    // ---- a page and a server of different versions --------------------------------------
    await page.route("**/api/bundle-library/v1/health", async (route) => {
        const answer = await route.fetch();
        await route.fulfill({ response: answer, json: { ...(await answer.json()), version: "9.9.9" } });
    });
    await session.reload();
    const toast = await page.waitForFunction(() => [...document.querySelectorAll(".p-toast-message")]
        .map((t) => t.textContent).find((t) => t.includes("Bundle Library 9.9.9")), null, { timeout: 10000 })
        .then((h) => h.jsonValue(), () => null);
    check("a newer server is noticed on start: reload the page", toast?.includes("Reload the page.")
        && toast.includes("cannot be changed from this page"), toast);
    await page.unroute("**/api/bundle-library/v1/health");
    await page.route("**/api/bundle-library/v1/bundles", (route) => route.request().method() === "POST"
        ? route.continue({ headers: { ...route.request().headers(), "x-bundle-library-version": "0.0.1" } })
        : route.fallback());
    const refused = await ev(() => window.__bl.request("POST", "/bundles", { name: "[test] Must not be made", fields: [] })
        .then(() => "made", (e) => e.message));
    check("the server refuses a write from a page of another version", refused.includes("This page runs Bundle Library 0.0.1"),
        refused);
    await page.unroute("**/api/bundle-library/v1/bundles");

    await finish({ expectRemoved: 1 }); // the bundle of the saved workflow
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
