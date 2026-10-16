// Browser scenarios for several bundles at once and the editing lock (Phase
// 7.8a): Ctrl/Shift selection, Select all, the picker's single selection,
// the batch panel and its results (moves, stars, the trash with a bundle
// changed elsewhere), a batch that is slow, refused or never answered, a
// drag of several bundles, and the lock while the editor holds changes.
// Set-up and safety notes are in harness.cjs.
const { startSession } = require("./harness.cjs");

const PREFIX = "[test] Batch";
const SHELF = "[test] Batch shelf";
const MODULE = "/extensions/ComfyUI-Bundle-Library";
const BATCH = "**/api/bundle-library/v1/bundles/batch";

const BATCH_HELPERS = () => {
    const $ = (selector, root = document) => root.querySelector(selector);
    const groupOf = (key) => [...document.querySelectorAll(".bl-overlay .bl-group")].find((g) => g.dataset.group === key);
    window.__batch = {
        groupOf,
        row: (key, id) => [...(groupOf(key)?.querySelectorAll(".bl-list-item") ?? [])].find((r) => r.dataset.id === id),
        selectedRows: () => [...document.querySelectorAll(".bl-overlay .bl-list-item.selected")].map((r) => r.dataset.id),
        pane() {
            return {
                batch: $(".bl-overlay .bl-batch:not(.bl-batch-result) .bl-batch-title")?.textContent ?? null,
                names: [...document.querySelectorAll(".bl-overlay .bl-batch-name")].map((r) => r.dataset.id),
                result: $(".bl-overlay .bl-batch-result:not(.waiting) .bl-batch-title")?.textContent ?? null,
                waiting: !!$(".bl-overlay .bl-batch-result.waiting"),
                stall: !!$(".bl-overlay .bl-batch-stall:not([hidden])"),
                outcomes: Object.fromEntries([...document.querySelectorAll(".bl-overlay .bl-batch-outcome")]
                    .map((g) => [g.dataset.outcome, [...g.querySelectorAll(".bl-batch-outcome-row")].map((r) => r.dataset.id)])),
                summary: $(".bl-overlay .bl-batch-summary")?.textContent ?? null,
                editor: $(".bl-overlay .bl-name-input")?.value ?? null,
                text: $(".bl-overlay .bl-modal-editor")?.innerText ?? "",
            };
        },
        status: () => $(".bl-overlay .bl-status")?.textContent ?? "",
        locks: () => ({
            search: $(".bl-overlay .bl-search").disabled,
            create: $(".bl-overlay .bl-new").disabled,
            tools: ["bl-new-category", "bl-sort-button", "bl-tag-button", "bl-trash-button"]
                .map((c) => $(`.bl-overlay .${c}`).disabled),
            stars: [...document.querySelectorAll(".bl-overlay .bl-list-item .bl-star")].map((s) => s.disabled),
            draggable: [...document.querySelectorAll(".bl-overlay .bl-list-item")].map((r) => r.draggable),
            menus: [...document.querySelectorAll(".bl-overlay .bl-group-menu")].map((m) => m.disabled),
        }),
        layer() {
            const layer = $(".bl-overlay .bl-layer");
            return layer ? { title: $(".bl-confirm-title", layer)?.textContent ?? null,
                buttons: [...layer.querySelectorAll("button")].map((b) => b.textContent) } : null;
        },
        /** Drag a row (and so the selection it is in) onto a group, as the browser would. */
        drag(fromKey, id, toKey) {
            const data = new DataTransfer();
            const fire = (target, type) => target.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
            const row = this.row(fromKey, id);
            fire(row, "dragstart");
            const carried = data.getData("application/x-bundle-library-bundle");
            const target = groupOf(toKey);
            for (const type of ["dragenter", "dragover", "drop"]) fire(target, type);
            fire(row, "dragend");
            return carried;
        },
    };
};

(async () => {
    const session = await startSession("batch", { expectedErrors: [
        // a save answered with 500 and a batch whose connection is cut, both on purpose
        { text: /^Failed to load resource: (the server responded with a status of 500|net::ERR_CONNECTION_RESET)/,
            url: /\/api\/bundle-library\/v1\/bundles\// },
    ] });
    const { page, ev, check, shot, finish } = session;
    const overlay = page.locator(".bl-overlay");
    const layerBox = page.locator(".bl-overlay .bl-layer");
    const button = (name, scope = overlay) => scope.getByRole("button", { name, exact: true });
    const until = (fn, arg, timeout = 10000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
    const api = (method, route, body) => ev(([m, r, b]) => window.__bl.request(m, r, b), [method, route, body ?? null]);
    const b = (fn, arg) => ev(fn, arg);
    const pane = () => b(() => window.__batch.pane());
    const command = (id) => ev((c) => window.__bl.app.extensionManager.command.execute(c), id);
    const openLibrary = async () => {
        await command("BundleLibrary.Open");
        await overlay.waitFor();
        await page.evaluate(BATCH_HELPERS);
        await until(() => document.querySelector(".bl-overlay .bl-group"));
    };
    const closeLibrary = async () => {
        await page.keyboard.press("Escape");
        await overlay.waitFor({ state: "detached" });
    };
    const row = (key, id) => page.locator(`.bl-overlay .bl-group[data-group="${key}"] .bl-list-item[data-id="${id}"]`);
    const server = async () => Object.fromEntries((await api("GET", "/bundles")).bundles.map((x) => [x.id, x]));
    const resultShown = () => until(() => window.__batch.pane().result !== null);

    const shelf = await api("POST", "/categories", { name: SHELF });
    const shelfKey = `category:${shelf.id}`;
    const make = async (name, fields = [{ name: "prompt", type: "text", value: name }]) =>
        (await api("POST", "/bundles", { name, tags: ["test"], fields })).id;
    const ids = {
        one: await make(`${PREFIX} 1`),
        two: await make(`${PREFIX} 2`),
        three: await make(`${PREFIX} 3`, [{ name: "steps", type: "int", value: 20 },
            { name: "ref", type: "image", asset: null }]),
        four: await make(`${PREFIX} 4`),
    };
    await api("PUT", `/bundles/${ids.one}/favorite`, { favorite: true });
    await openLibrary();
    await page.locator(".bl-overlay .bl-search").fill(PREFIX); // only this suite's bundles
    await until((id) => window.__batch.row("uncategorized", id), ids.four);

    // ---- selecting ------------------------------------------------------------------------
    await row("favorites", ids.one).click();
    await row("uncategorized", ids.two).click({ modifiers: ["Control"] });
    let p = await pane();
    let selected = await b(() => window.__batch.selectedRows());
    check("Ctrl+click adds a bundle: two selected show the batch panel; a starred one is marked in both its rows",
        p.batch === "2 bundles selected" && JSON.stringify(p.names) === JSON.stringify([ids.one, ids.two])
        && selected.filter((id) => id === ids.one).length === 2 && selected.includes(ids.two), { p, selected });
    await row("uncategorized", ids.two).click({ modifiers: ["Control"] });
    await until(() => window.__batch.pane().editor !== null);
    p = await pane();
    check("Ctrl+click on a selected bundle takes it out; one left opens in the editor", p.editor === `${PREFIX} 1`, p.editor);
    await row("favorites", ids.one).click();
    await row("uncategorized", ids.three).click({ modifiers: ["Shift"] });
    p = await pane();
    check("Shift selects from the row clicked first to this one, in list order, each bundle once",
        p.batch === "3 bundles selected" && JSON.stringify(p.names) === JSON.stringify([ids.one, ids.two, ids.three]), p.names);
    await page.locator(".bl-overlay .bl-search").focus();
    await page.keyboard.press("Control+A");
    p = await pane();
    check("Ctrl+A in the search box selects its text, not bundles", p.batch === "3 bundles selected", p.batch);
    await row("uncategorized", ids.four).focus();
    await page.keyboard.press("Control+A");
    p = await pane();
    check("Ctrl+A in the list selects every bundle shown", p.batch === "4 bundles selected", p.batch);
    await page.locator(".bl-overlay .bl-search").fill(`${PREFIX} 1`);
    await until(() => window.__batch.pane().editor !== null);
    p = await pane();
    check("bundles a search hides leave the selection, and the window says how many",
        (await b(() => window.__batch.status())) === "3 selected bundles hidden by the search or filter were taken out of the selection."
        && p.editor === `${PREFIX} 1`, { status: await b(() => window.__batch.status()), editor: p.editor });
    await page.locator(".bl-overlay .bl-search").fill(PREFIX);
    await until((id) => window.__batch.row("uncategorized", id), ids.four);
    await row("uncategorized", ids.two).click({ modifiers: ["Control"] });
    await page.keyboard.press("Escape");
    p = await pane();
    check("Esc takes back a selection of several, and keeps the library open",
        p.batch === null && (await b(() => window.__batch.selectedRows())).length === 0 && await overlay.isVisible(), p);

    // ---- changing several ----------------------------------------------------------------------
    await row("uncategorized", ids.two).click();
    await row("uncategorized", ids.three).click({ modifiers: ["Shift"] });
    await page.locator(".bl-overlay .bl-batch-category").selectOption(shelf.id);
    await button("Move").click();
    await resultShown();
    p = await pane();
    let stored = await server();
    check("Move puts every selected bundle in the category, and the result lists them",
        p.result === `Moved to ${SHELF}` && JSON.stringify(p.outcomes.changed) === JSON.stringify([ids.two, ids.three])
        && stored[ids.two].category === shelf.id && stored[ids.three].category === shelf.id, p);
    await shot("batch-result.png");
    await button("Done").click();
    p = await pane();
    check("Done goes back to the selection", p.batch === "2 bundles selected", p.batch);
    await button("★ Add to favorites").click();
    await resultShown();
    await button("Done").click();
    await button("★ Add to favorites").click();
    await resultShown();
    p = await pane();
    check("a change that is already so is reported as such and writes nothing",
        p.summary === "0 changed · 2 already so" && JSON.stringify(p.outcomes.unchanged) === JSON.stringify([ids.two, ids.three]), p);
    await button("Done").click();
    await button("☆ Remove from favorites").click();
    await resultShown();
    await button("Done").click();

    // a drag of the selection moves all of it
    await row(shelfKey, ids.two).click();
    await row(shelfKey, ids.three).click({ modifiers: ["Control"] });
    const carried = await b(([key, id]) => window.__batch.drag(key, id, "favorites"), [shelfKey, ids.two]);
    await resultShown();
    p = await pane();
    stored = await server();
    check("dragging a selected row carries the whole selection: both are starred",
        JSON.parse(carried).length === 2 && p.result === "Added to the favorites"
        && stored[ids.two].favorite && stored[ids.three].favorite, { carried, result: p.result });
    await button("Done").click();

    // the trash, with one bundle changed elsewhere since it was selected
    await row(shelfKey, ids.three).click({ modifiers: ["Control"] }); // now: two
    await row("uncategorized", ids.four).click({ modifiers: ["Control"] }); // two and four
    const four = await api("GET", `/bundles/${ids.four}`);
    await api("PUT", `/bundles/${ids.four}`, { name: four.name, tags: four.tags, note: "changed elsewhere",
        fields: four.fields.map((f) => ({ name: f.name, type: f.type, value: f.value })), expected_revision: four.revision });
    await button("Move to trash…").click();
    const asked = await b(() => window.__batch.layer());
    await button("Move to trash", layerBox).click();
    await resultShown();
    p = await pane();
    await until((id) => !document.querySelector(`.bl-overlay .bl-list-item[data-id="${id}"]`), ids.two);
    const kept = await pane();
    check("Move to trash asks, then moves what has not changed since; a bundle changed elsewhere stays",
        asked?.title === "Move 2 bundles to the trash?" && JSON.stringify(p.outcomes.changed) === JSON.stringify([ids.two])
        && JSON.stringify(p.outcomes.revision_conflict) === JSON.stringify([ids.four]), { asked, outcomes: p.outcomes });
    check("the result stays even though its bundles are gone from the selection",
        kept.result === "Moved to the trash" && kept.outcomes.changed?.[0] === ids.two, kept.result);
    await button("Done").click();
    await until(() => window.__batch.pane().editor !== null);
    p = await pane();
    check("Done then shows what is left selected: the one that was not moved", p.editor === `${PREFIX} 4`, p.editor);
    await api("POST", `/bundles/${ids.two}/restore`);
    await closeLibrary();

    // ---- a batch that takes long, is refused, or gets no answer --------------------------------------
    await openLibrary();
    await page.locator(".bl-overlay .bl-search").fill(PREFIX);
    await until((id) => window.__batch.row("uncategorized", id), ids.four);
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route(BATCH, async (route) => {
        await held;
        await route.continue();
    });
    await row("favorites", ids.one).click();
    await row("uncategorized", ids.four).click({ modifiers: ["Control"] });
    await button("☆ Remove from favorites").click();
    await until(() => window.__batch.pane().waiting);
    await row("uncategorized", ids.four).click();
    await page.keyboard.press("Escape");
    const during = { pane: await pane(), locks: await b(() => window.__batch.locks()), status: await b(() => window.__batch.status()),
        open: await overlay.isVisible() };
    check("while a batch is out the window is locked: no other bundle, no Esc, no tools",
        during.pane.waiting && during.pane.editor === null && during.open && during.locks.search
        && during.status === "Wait until the change to the selected bundles is done.", during);
    release();
    await resultShown();
    p = await pane();
    check("its answer then shows, and the window is free", p.result === "Removed from the favorites"
        && !(await b(() => window.__batch.locks().search)), p.result);
    await button("Done").click();
    await page.unroute(BATCH);

    await page.route(BATCH, (route) => route.fulfill({ status: 409, contentType: "application/json",
        body: JSON.stringify({ error: { code: "organization_unwritable", message: "organization.json is broken." } }) }));
    await button("★ Add to favorites").click();
    await resultShown();
    p = await pane();
    check("a refused batch says nothing was changed, and why", p.result === "Nothing was changed"
        && p.text.includes("organization.json is broken."), p.result);
    await button("Done").click();
    await page.unroute(BATCH);

    await page.route(BATCH, (route) => route.abort("connectionreset"));
    await button("★ Add to favorites").click();
    await resultShown();
    p = await pane();
    check("a batch whose answer is lost says it cannot tell what happened, and offers to reload or try again",
        p.result === "Could not tell whether it finished" && p.text.includes("Reload the list") && p.text.includes("Try again"),
        p.result);
    await page.unroute(BATCH);
    await button("Try again").click();
    await resultShown();
    p = await pane();
    check("Try again sends it again", p.result === "Added to the favorites", p.result);
    await button("Done").click();

    // no answer at all: after a while the user may stop waiting
    let releaseLate;
    const late = new Promise((resolve) => { releaseLate = resolve; });
    await page.route(BATCH, async (route) => {
        await late;
        await route.continue();
    });
    await button("☆ Remove from favorites").click();
    await until(() => window.__batch.pane().waiting);
    const early = (await pane()).stall;
    const offered = await until(() => window.__batch.pane().stall, null, 40000);
    await button("Stop waiting").click();
    p = await pane();
    check("after 30 s with no answer, Stop waiting frees the window and says the outcome is not known",
        !early && offered && p.result === "Could not tell whether it finished" && !(await b(() => window.__batch.locks().search)),
        { early, offered, result: p.result });
    releaseLate();
    await until(() => window.__batch.pane().result === "Removed from the favorites");
    p = await pane();
    check("an answer that comes after all replaces that result while it is shown", p.result === "Removed from the favorites",
        p.result);
    await page.unroute(BATCH);
    await button("Done").click();

    let releaseLater;
    const later = new Promise((resolve) => { releaseLater = resolve; });
    await page.route(BATCH, async (route) => {
        await later;
        await route.continue();
    });
    await button("★ Add to favorites").click();
    await until(() => window.__batch.pane().stall, null, 40000);
    await button("Stop waiting").click();
    await row("uncategorized", ids.four).click();
    await until(() => window.__batch.pane().editor !== null);
    releaseLater();
    await page.waitForTimeout(1500);
    p = await pane();
    check("an answer that comes after the user moved on does not take over the pane", p.editor === `${PREFIX} 4`
        && p.result === null, p);
    await page.unroute(BATCH);
    await closeLibrary();

    // ---- the lock while the editor holds changes --------------------------------------------------
    await openLibrary();
    await page.locator(".bl-overlay .bl-search").fill(PREFIX);
    await until((id) => document.querySelector(`.bl-overlay .bl-list-item[data-id="${id}"]`), ids.three);
    await page.locator(`.bl-overlay .bl-list-item[data-id="${ids.three}"]`).first().click();
    await until(() => document.querySelector(".bl-overlay .bl-number"));
    const free = await b(() => window.__batch.locks());
    await page.locator(".bl-overlay .bl-number").fill("1.5"); // not a whole number
    const typed = await b(() => window.__batch.locks());
    await page.locator(".bl-overlay .bl-number").fill("20");
    const back = await b(() => window.__batch.locks());
    check("a number typed that does not parse locks the window; typing the value back frees it",
        !free.search && typed.search && typed.tools.every(Boolean) && typed.stars.every(Boolean) && !typed.draggable.some(Boolean)
        && typed.menus.every(Boolean) && !back.search, { free: free.search, typed, back: back.search });
    await page.locator(".bl-overlay .bl-note-input").fill("a change");
    await page.locator(`.bl-overlay .bl-list-item[data-id="${ids.four}"]`).first().click({ modifiers: ["Control"] });
    p = await pane();
    check("with changes, Ctrl+click selects nothing more", p.editor === `${PREFIX} 3`
        && (await b(() => window.__batch.status())) === "Save or discard your changes first.", p.editor);
    await page.locator(".bl-overlay .bl-editor-head .bl-star").click(); // three was starred by the drag above
    await until((id) => !window.__batch.row("favorites", id), ids.three);
    const note = await page.locator(".bl-overlay .bl-note-input").inputValue();
    check("the editor's own star still works, and the draft stays", note === "a change", note);
    await page.route(`**/api/bundle-library/v1/bundles/${ids.three}`, (route) => route.request().method() === "PUT"
        ? route.fulfill({ status: 500, contentType: "application/json",
            body: JSON.stringify({ error: { code: "internal", message: "Disk trouble." } }) })
        : route.fallback());
    await button("Save", page.locator(".bl-overlay .bl-editor")).click();
    await page.waitForTimeout(300);
    const failed = { locks: await b(() => window.__batch.locks()), note: await page.locator(".bl-overlay .bl-note-input").inputValue() };
    check("a save that fails keeps the draft and the lock", failed.locks.search && failed.note === "a change", failed);
    await page.unroute(`**/api/bundle-library/v1/bundles/${ids.three}`);
    let releaseUpload;
    const uploading = new Promise((resolve) => { releaseUpload = resolve; });
    await button("Revert", page.locator(".bl-overlay .bl-editor")).click();
    await page.route("**/api/bundle-library/v1/assets", async (route) => {
        await uploading;
        await route.continue().catch(() => {}); // cancelled meanwhile: the page dropped it
    });
    await ev(async () => {
        const input = document.querySelector('.bl-overlay .bl-field[data-field="ref"] input[type=file]');
        window.__bl.setFiles(input, [await window.__bl.makeImage("#225588", "batch", "batch-lock.png")]);
    });
    await until(() => document.querySelector(".bl-overlay .bl-search").disabled);
    const whileUploading = await b(() => window.__batch.locks().search);
    await button("Cancel upload", page.locator('.bl-overlay .bl-field[data-field="ref"]')).click();
    releaseUpload();
    await page.unroute("**/api/bundle-library/v1/assets");
    check("an upload on its way locks the window; cancelling it frees it",
        whileUploading && !(await b(() => window.__batch.locks().search)));
    await closeLibrary();

    // ---- the picker picks one --------------------------------------------------------------------
    await ev(async (module) => {
        const { openLibrary } = await import(`${module}/library_modal.js`);
        openLibrary({ onPick: () => {} });
    }, MODULE);
    await overlay.waitFor();
    await page.evaluate(BATCH_HELPERS);
    await page.locator(".bl-overlay .bl-search").fill(PREFIX);
    await until((id) => window.__batch.row("uncategorized", id), ids.four);
    await page.locator(`.bl-overlay .bl-list-item[data-id="${ids.three}"]`).first().click();
    await row("uncategorized", ids.four).click({ modifiers: ["Control"] });
    await row("uncategorized", ids.four).click({ modifiers: ["Shift"] });
    p = await pane();
    check("in the picker, Ctrl and Shift still pick one bundle", p.batch === null && p.editor === `${PREFIX} 4`
        && new Set(await b(() => window.__batch.selectedRows())).size === 1, p);
    await closeLibrary();

    await finish({ expectRemoved: 4 });
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
