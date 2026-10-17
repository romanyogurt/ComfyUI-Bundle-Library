// Browser scenarios for the window's commands and what they own (Phase
// 7.8s-2): a question answered after it was cancelled, the window behind a
// question, the batch panel's choice across list updates, a list that cannot
// be read, number boxes and uploads across redraws (and the focus), duplicate
// and delete holding the window, what the picker hands to a node, a bundle in
// the trash this version cannot change, and a node's sound when its preview
// goes. Set-up and safety notes are in harness.cjs. The bundle in the trash is
// written into the test server's library through its container
// (BL_TEST_CONTAINER and BL_TEST_LIBRARY, which scripts/bundle-library-test-server.sh
// run sets) and removed at the end; without them that part is skipped.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { startSession } = require("./harness.cjs");

const PREFIX = "[test] Window";
const MODULE = "/extensions/ComfyUI-Bundle-Library";
const API = "/api/bundle-library/v1";
const CONTAINER = process.env.BL_TEST_CONTAINER;
const LIBRARY = process.env.BL_TEST_LIBRARY;
const FIXTURES = path.join(__dirname, "fixtures");
const LOCKED_ID = "c0ffee00-7800-4d2a-8000-000000000002"; // the read-only bundle put in the trash

/**
 * Hold the answers to the requests `match(url, method)` takes until release().
 * Each request reaches the server at once; its answer reaches the page later,
 * changed by `change(json)` if given, or replaced by an error of `status`.
 * Other requests pass untouched.
 */
async function holdAnswers(page, match, { change = null, status = null } = {}) {
    let open;
    const gate = new Promise((resolve) => { open = resolve; });
    const held = [];
    const delivered = [];
    const handler = async (route) => {
        const request = route.request();
        if (!match(new URL(request.url()), request.method())) return route.fallback();
        held.push(request);
        const answer = status ? null : await route.fetch();
        await gate;
        let reply = { response: answer };
        if (status) {
            reply = { status, contentType: "application/json",
                body: JSON.stringify({ error: { code: "io_error", message: "The test server could not read it.", retry: true } }) };
        } else if (change) {
            reply = { response: answer, json: change(await answer.json()) };
        }
        delivered.push(await route.fulfill(reply).then(() => true, () => false));
    };
    await page.route(`**${API}/**`, handler);
    return {
        held,
        async release() {
            open();
            const end = Date.now() + 10000;
            while (delivered.length < held.length && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
            await page.waitForTimeout(400); // let the page handle what arrived
            await page.unroute(`**${API}/**`, handler);
        },
    };
}

/** Wait for a condition on this side (the held requests), not in the page. */
async function settle(predicate, timeout = 5000) {
    const end = Date.now() + timeout;
    while (!predicate() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    return predicate();
}

const WINDOW_HELPERS = () => {
    const $ = (selector, root = document) => root.querySelector(selector);
    const named = (root, text) => [...(root?.querySelectorAll("button") ?? [])].find((b) => b.textContent === text) ?? null;
    window.__win = {
        status: () => $(".bl-overlay .bl-status")?.textContent ?? "",
        layer() {
            const layer = $(".bl-overlay .bl-layer");
            return layer ? {
                title: $(".bl-confirm-title", layer)?.textContent ?? null,
                text: [...layer.querySelectorAll(".bl-confirm-text")].map((t) => t.textContent).join(" "),
                value: $(".bl-ask-input", layer)?.value ?? null,
                problem: $(".bl-error", layer)?.hidden === false ? $(".bl-error", layer).textContent : null,
            } : null;
        },
        editor() {
            const editor = $(".bl-overlay .bl-editor");
            if (!editor) return null;
            const head = $(".bl-editor-head", editor);
            const state = (text) => {
                const b = named(head, text);
                return b ? { disabled: b.disabled, title: b.title } : null;
            };
            return {
                name: $(".bl-name-input", editor).value,
                state: $(".bl-state", editor).textContent,
                inert: editor.inert,
                save: state("Save"), revert: state("Revert") ?? state("Discard"), duplicate: state("Duplicate ▾"),
                note: $(".bl-note-input", editor).value,
                category: $(".bl-category-select", editor).selectedOptions[0]?.textContent ?? null,
                fields: [...editor.querySelectorAll(".bl-field")].map((card) => ({
                    name: $(".bl-field-name", card).value,
                    number: $(".bl-number", card)?.value ?? null,
                    error: $(".bl-error", card).hidden ? null : $(".bl-error", card).textContent,
                    uploading: !!$(".bl-upload", card),
                    image: !!$(".bl-image-thumb", card),
                })),
            };
        },
        locked: () => $(".bl-overlay .bl-search").disabled,
        rows: () => [...document.querySelectorAll(".bl-overlay .bl-list-item")].map((r) => r.dataset.id),
        selected: () => [...new Set([...document.querySelectorAll(".bl-overlay .bl-list-item.selected")].map((r) => r.dataset.id))],
        batch() {
            const select = $(".bl-overlay .bl-batch-category");
            return select ? {
                title: $(".bl-overlay .bl-batch-title")?.textContent ?? null,
                category: select.value,
                move: named($(".bl-overlay .bl-batch"), "Move")?.disabled ?? null,
                moveTitle: named($(".bl-overlay .bl-batch"), "Move")?.title ?? null,
            } : null;
        },
        focusInLayer: () => !!document.activeElement?.closest(".bl-layer"),
        behindInert: () => [...$(".bl-overlay .bl-modal").children].filter((c) => !c.classList.contains("bl-layer"))
            .every((c) => c.inert),
        pick: () => {
            const pick = $(".bl-overlay .bl-pick");
            return pick ? { disabled: pick.disabled, hint: $(".bl-overlay .bl-pick-hint").textContent } : null;
        },
        async modal(module) {
            const { openLibrary } = await import(`${module}/library_modal.js`);
            return openLibrary(); // the window open now
        },
    };
};

(async () => {
    const session = await startSession("window", { expectedErrors: [
        // the list read and a new category answered with 500 on purpose
        { text: /^Failed to load resource: the server responded with a status of 500/,
            url: /\/api\/bundle-library\/v1\/(bundles|categories)$/ },
    ] });
    const { page, ev, check, shot, finish } = session;
    const overlay = page.locator(".bl-overlay");
    const layerBox = page.locator(".bl-overlay .bl-layer");
    const button = (name, scope = overlay) => scope.getByRole("button", { name, exact: true });
    const menuItem = (name, scope = overlay) => scope.getByRole("menuitem", { name, exact: true });
    const until = (fn, arg, timeout = 10000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
    const api = (method, route, body) => ev(([m, r, b]) => window.__bl.request(m, r, b), [method, route, body ?? null]);
    const w = (fn, arg) => ev(fn, arg);
    const editor = () => w(() => window.__win.editor());
    const row = (id) => page.locator(`.bl-overlay .bl-list-item[data-id="${id}"]`).first();
    const command = (id) => ev((c) => window.__bl.app.extensionManager.command.execute(c), id);
    const onlyOurs = async () => {
        await page.locator(".bl-overlay .bl-search").fill(PREFIX);
        await until((n) => window.__win.rows().length >= n, 4);
    };
    const openLibrary = async () => {
        await command("BundleLibrary.Open");
        await overlay.waitFor();
        await page.evaluate(WINDOW_HELPERS);
        await until(() => document.querySelector(".bl-overlay .bl-group"));
        await onlyOurs();
    };
    const openPicker = async (selected = null) => {
        await ev(async ([module, selected]) => {
            window.__picked = null;
            const { openLibrary } = await import(`${module}/library_modal.js`);
            openLibrary({ onPick: (summary) => { window.__picked = summary; }, selected });
        }, [MODULE, selected]);
        await overlay.waitFor();
        await page.evaluate(WINDOW_HELPERS);
        await onlyOurs();
    };
    const closeLibrary = async () => {
        await page.keyboard.press("Escape");
        await overlay.waitFor({ state: "detached" });
    };
    const opened = (name) => until((n) => window.__win.editor()?.name === n && !window.__win.editor().inert, name);
    const isList = (url) => url.pathname === `${API}/bundles` && !url.search;
    const puts = [];
    page.on("request", (r) => {
        if (r.method() === "PUT" && new URL(r.url()).pathname.startsWith(`${API}/bundles/`)) puts.push(r.url());
    });

    const text = (name, value) => ({ name, type: "text", value });
    const make = async (name, fields) => (await api("POST", "/bundles", { name, tags: ["test"], fields })).id;
    const ids = {
        P: await make(`${PREFIX} P`, [text("prompt", "p")]),
        Q: await make(`${PREFIX} Q`, [text("prompt", "q")]),
        N: await make(`${PREFIX} N`, [text("prompt", "n"), { name: "seed", type: "int", value: 20 }]),
        M: await make(`${PREFIX} M`, [text("prompt", "m"), { name: "ref", type: "image", asset: null }]),
    };
    const shelf = await api("POST", "/categories", { name: `${PREFIX} shelf` });

    // ---- a question answered after it was cancelled (R15-06) ------------------------------------
    await openLibrary();
    const categories = await holdAnswers(page, (url, method) => url.pathname === `${API}/categories` && method === "POST");
    await button("New category").click();
    await page.locator(".bl-overlay .bl-ask-input").fill(`${PREFIX} A`);
    await button("Create").click();
    await settle(() => categories.held.length === 1);
    await button("Cancel", layerBox).click();
    const cancelled = await w(() => window.__win.layer());
    await button("New category").click();
    await page.locator(".bl-overlay .bl-ask-input").fill(`${PREFIX} B`);
    await categories.release();
    let layer = await w(() => window.__win.layer());
    const madeA = (await api("GET", "/categories")).categories.some((c) => c.name === `${PREFIX} A`);
    check("a question answered after it was cancelled leaves the next one alone (R15-06)",
        cancelled === null && madeA && layer?.title === "New category" && layer.value === `${PREFIX} B` && layer.problem === null
        && !(await w(() => window.__win.status())).includes(`${PREFIX} A`), { cancelled, madeA, layer });
    const refused = await holdAnswers(page, (url, method) => url.pathname === `${API}/categories` && method === "POST",
        { status: 500 });
    await button("Create").click();
    await settle(() => refused.held.length === 1);
    await button("Cancel", layerBox).click();
    await button("New category").click();
    await page.locator(".bl-overlay .bl-ask-input").fill(`${PREFIX} C`);
    await refused.release();
    layer = await w(() => window.__win.layer());
    check("a failure that comes after Cancel does not show on the next question either",
        layer?.value === `${PREFIX} C` && layer.problem === null, layer);
    await button("Cancel", layerBox).click();

    // ---- the window behind a question (R15-07) -----------------------------------------------
    await row(ids.N).click();
    await opened(`${PREFIX} N`);
    await page.locator(".bl-overlay .bl-note-input").fill("typed before the question");
    const removeButton = button("✕", page.locator('.bl-overlay .bl-field[data-field="prompt"]'));
    await removeButton.click();
    await layerBox.waitFor();
    const putsBefore = puts.length;
    const inside = [];
    for (const key of ["Shift+Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab", "Tab", "Tab", "Tab", "Tab", "Tab"]) {
        await page.keyboard.press(key);
        inside.push(await w(() => window.__win.focusInLayer()));
    }
    const behind = await w(() => window.__win.behindInert());
    await page.keyboard.press("Control+s");
    const allowed = await ev(async (module) => (await window.__win.modal(module)).allowed(), MODULE);
    await page.waitForTimeout(300);
    let st = await editor();
    check("while a question is open, Tab stays in it, what is behind it is inert, and nothing behind it runs (R15-07)",
        inside.every(Boolean) && behind && allowed === false && puts.length === putsBefore && st.fields.length === 2
        && st.note === "typed before the question", { inside, behind, allowed, puts: puts.length - putsBefore });
    await page.keyboard.press("Escape");
    const back = await w(() => document.activeElement?.textContent === "✕"
        && document.activeElement.closest(".bl-field")?.dataset.field === "prompt" && !window.__win.behindInert());
    check("closing it gives the window back, with the focus where it was", back);
    await button("Revert").click();

    // ---- the batch panel keeps what was chosen in it (R15-08) ---------------------------------
    await row(ids.P).click();
    await row(ids.Q).click({ modifiers: ["Control"] });
    await until(() => window.__win.batch()?.title === "2 bundles selected");
    await page.locator(".bl-overlay .bl-batch-category").selectOption(shelf.id);
    await row(ids.N).locator(".bl-star").click(); // a change to another bundle: the list is read and drawn again
    await until((id) => document.querySelector(`.bl-overlay .bl-group.favorites .bl-list-item[data-id="${id}"]`), ids.N);
    await page.waitForTimeout(500);
    let batch = await w(() => window.__win.batch());
    check("the list drawn again keeps the category chosen in the batch panel (R15-08)",
        batch?.title === "2 bundles selected" && batch.category === shelf.id && batch.move === false, batch);
    await api("DELETE", `/categories/${shelf.id}`); // as from another tab
    await row(ids.N).locator(".bl-star").click();
    await until(() => window.__win.batch()?.category === "gone");
    batch = await w(() => window.__win.batch());
    check("when the category chosen is deleted, Move waits for a new choice instead of taking No category",
        batch?.category === "gone" && batch.move === true && batch.moveTitle.includes("Choose one again"), batch);
    await page.locator(".bl-overlay .bl-batch-category").selectOption("");
    batch = await w(() => window.__win.batch());
    check("choosing again lets Move go", batch?.category === "" && batch.move === false, batch);
    await page.keyboard.press("Escape"); // the selection of two

    // ---- a list that cannot be read (N07) ----------------------------------------------------
    await row(ids.P).click();
    await opened(`${PREFIX} P`);
    const failedList = await holdAnswers(page, (url, method) => isList(url) && method === "GET", { status: 500 });
    await row(ids.Q).locator(".bl-star").click(); // the star is saved; the list read after it fails
    await failedList.release();
    await until(() => window.__win.status().startsWith("Could not read the library"));
    const kept = { rows: await w(() => window.__win.rows()), selected: await w(() => window.__win.selected()),
        editor: (await editor())?.name, status: await w(() => window.__win.status()) };
    check("a list that cannot be read keeps the list, the selection and the editor, and says why (N07)",
        Object.values(ids).every((id) => kept.rows.includes(id)) && JSON.stringify(kept.selected) === JSON.stringify([ids.P])
        && kept.editor === `${PREFIX} P` && kept.status.startsWith("Could not read the library:"), kept);
    await row(ids.Q).locator(".bl-star").click(); // back, with the list readable
    await page.waitForTimeout(400);
    await button("+ New bundle").click();
    await until(() => window.__win.editor()?.state === "● New, not saved yet");
    const failedAgain = await holdAnswers(page, (url, method) => isList(url) && method === "GET", { status: 500 });
    await page.locator(".bl-overlay .bl-category-select").selectOption("new");
    await page.locator(".bl-overlay .bl-ask-input").fill(`${PREFIX} draft shelf`);
    await button("Create").click();
    await settle(() => failedAgain.held.length === 1);
    await failedAgain.release();
    await until((name) => window.__win.editor()?.category === name, `${PREFIX} draft shelf`);
    st = await editor();
    check("a new draft keeps the category made for it when the list cannot be read (N07)",
        st.category === `${PREFIX} draft shelf` && st.state === "● New, not saved yet", st.category);
    await button("Discard").click();

    // ---- numbers across redraws (R15-09, N03) -------------------------------------------------
    await row(ids.N).click();
    await opened(`${PREFIX} N`);
    const seed = page.locator('.bl-overlay .bl-field[data-field="seed"] .bl-number');
    await seed.fill("1.5");
    st = await editor();
    check("a number typed that does not parse shows as unsaved: Revert is offered, Save and Duplicate wait (R15-09, N03)",
        st.state === "● Unsaved changes" && st.revert.disabled === false && st.save.disabled
        && st.save.title === "Fix the marked values first." && st.duplicate.disabled
        && st.fields[1].error === "Enter a whole number." && await w(() => window.__win.locked()), st);
    await button("+ Add field ▾").click();
    await menuItem("Boolean").click();
    st = await editor();
    check("adding another field keeps the number typed and its error (R15-09)",
        st.fields.length === 3 && st.fields[1].number === "1.5" && st.fields[1].error === "Enter a whole number."
        && st.state === "● Unsaved changes", st.fields);
    await button("Revert").click();
    st = await editor();
    check("Revert brings the saved number back, and the window is free",
        st.fields.length === 2 && st.fields[1].number === "20" && st.fields[1].error === null && st.state === "Saved"
        && !(await w(() => window.__win.locked())), st.fields);

    // ---- an upload on its way (N03, N12) ------------------------------------------------------
    await row(ids.M).click();
    await opened(`${PREFIX} M`);
    const upload = await holdAnswers(page, (url, method) => url.pathname === `${API}/assets` && method === "POST");
    await ev(async () => {
        const card = document.querySelector('.bl-overlay .bl-field[data-field="ref"]');
        window.__bl.setFiles(card.querySelector('input[type="file"]'), [await window.__bl.makeImage("#1f6feb", "W")]);
    });
    await until(() => window.__win.editor()?.fields[1]?.uploading);
    await settle(() => upload.held.length === 1);
    st = await editor();
    const whileUploading = { duplicate: st.duplicate.disabled, state: st.state };
    await page.locator(".bl-overlay .bl-name-input").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" renamed");
    await upload.release();
    await until(() => window.__win.editor()?.fields[1]?.image);
    const focus = await w(() => ({ inName: document.activeElement?.classList.contains("bl-name-input"),
        value: document.activeElement?.value ?? null }));
    check("an upload on its way: Duplicate waits and the state says unsaved (N03)",
        whileUploading.duplicate && whileUploading.state === "● Unsaved changes", whileUploading);
    check("the upload ending draws its own card only: the focus stays in the name being typed (N12)",
        focus.inName && focus.value === `${PREFIX} M renamed`, focus);
    await button("Revert").click();

    // ---- duplicate and delete hold the window (N02, N31) --------------------------------------
    await row(ids.P).click();
    await opened(`${PREFIX} P`);
    const isDuplicate = (url, method) => url.pathname.endsWith("/duplicate") && method === "POST";
    const duplicating = await holdAnswers(page, isDuplicate);
    await button("Duplicate ▾").click();
    await menuItem("Duplicate with values").click();
    await settle(() => duplicating.held.length === 1);
    await row(ids.Q).click();
    st = await editor();
    let status = await w(() => window.__win.status());
    check("while a duplicate is out the window waits: another bundle does not open (N02)",
        st.name === `${PREFIX} P` && st.state === "Duplicating…" && st.inert && status === "Wait until the copy is made.",
        { name: st.name, state: st.state, status });
    await duplicating.release();
    const copyOpened = await opened(`${PREFIX} P copy`);
    check("then the copy opens", copyOpened, (await editor())?.name);
    const misplaced = await holdAnswers(page, isDuplicate,
        { change: (copy) => ({ ...copy, placement_error: "organization.json could not be written: test." }) });
    await button("Duplicate ▾").click();
    await menuItem("Duplicate with values").click();
    await misplaced.release();
    await opened(`${PREFIX} P copy copy`);
    status = await w(() => window.__win.status());
    check("a copy made but not put beside the original says so (N31)",
        status.startsWith(`Created '${PREFIX} P copy copy', but not put in the category of the original:`)
        && status.includes("organization.json could not be written: test."), status);
    const deleting = await holdAnswers(page, (url, method) => url.pathname.startsWith(`${API}/bundles/`) && method === "DELETE");
    await button("Delete").click();
    await button("Delete", layerBox).click();
    await settle(() => deleting.held.length === 1);
    await row(ids.Q).click();
    st = await editor();
    status = await w(() => window.__win.status());
    check("while a delete is out the window waits too (N02)",
        st?.name === `${PREFIX} P copy copy` && st.state === "Moving to the trash…" && status === "Wait until the bundle is in the trash.",
        { name: st?.name, state: st?.state, status });
    await deleting.release();
    await until(() => window.__win.editor() === null);
    status = await w(() => window.__win.status());
    check("then the pane is empty again and the status says where it went",
        status === `Deleted '${PREFIX} P copy copy'. It is in the trash.`, status);
    await closeLibrary();

    // ---- what the picker hands to a node (R15-05, N08) ----------------------------------------
    await openPicker(ids.P);
    await opened(`${PREFIX} P`);
    await button("+ Add field ▾").click();
    await menuItem("Text").click();
    const listing = await holdAnswers(page, (url, method) => isList(url) && method === "GET");
    await page.keyboard.press("Control+s");
    await settle(() => listing.held.length >= 1);
    const during = await w(() => window.__win.pick());
    await ev(async (module) => (await window.__win.modal(module)).pick(), MODULE);
    const stillOpen = await overlay.isVisible();
    await listing.release();
    await until(() => window.__win.pick()?.disabled === false);
    await button("Use this bundle").click();
    await overlay.waitFor({ state: "detached" });
    let picked = await ev(() => window.__picked);
    const savedP = await api("GET", `/bundles/${ids.P}`);
    check("while the save and the list read are out, Use this bundle waits (R15-05)",
        during?.disabled && during.hint === "Wait until the bundle is saved." && stillOpen, during);
    check("then it hands over the bundle as saved: the new field is there (R15-05)",
        JSON.stringify(picked?.fields.map((f) => f.name)) === JSON.stringify(["prompt", "text_1"])
        && picked.revision === savedP.revision, picked && { fields: picked.fields.map((f) => f.name), revision: picked.revision });
    await openPicker(ids.P);
    await opened(`${PREFIX} P`);
    const elsewhere = await api("PUT", `/bundles/${ids.P}`, { name: savedP.name, tags: savedP.tags, note: "changed elsewhere",
        fields: [savedP.fields[0]], expected_revision: savedP.revision }); // as from another tab
    await page.locator(".bl-overlay .bl-note-input").fill("changed here");
    await page.keyboard.press("Control+s");
    await layerBox.waitFor();
    await button("Reload", layerBox).click();
    await until(() => window.__win.editor()?.note === "changed elsewhere" && window.__win.pick()?.disabled === false);
    await button("Use this bundle").click();
    await overlay.waitFor({ state: "detached" });
    picked = await ev(() => window.__picked);
    check("after a conflict and Reload it hands over the bundle the editor shows (N08)",
        JSON.stringify(picked?.fields.map((f) => f.name)) === JSON.stringify(["prompt"]) && picked.revision === elsewhere.revision,
        picked && { fields: picked.fields.map((f) => f.name), revision: picked.revision, expected: elsewhere.revision });

    // ---- the first list read answering late (R19-01) -----------------------------------------
    const firstList = async (step) => {
        const held = await holdAnswers(page, (url, method) => isList(url) && method === "GET");
        await ev(async ([module, selected]) => {
            const { openLibrary } = await import(`${module}/library_modal.js`);
            openLibrary({ selected });
        }, [MODULE, ids.Q]);
        await overlay.waitFor();
        await page.evaluate(WINDOW_HELPERS);
        await settle(() => held.held.length >= 1);
        await step();
        await held.release();
        await page.waitForTimeout(500);
    };
    await firstList(async () => {
        await button("+ New bundle").click();
        await page.locator(".bl-overlay .bl-name-input").fill("Unsaved draft that must survive");
    });
    st = await editor();
    check("a new draft begun before the first list read answers is not replaced by the bundle asked for (R19-01)",
        st?.name === "Unsaved draft that must survive" && st.state === "● New, not saved yet", st && { name: st.name, state: st.state });
    await button("Discard").click();
    await closeLibrary();
    await firstList(async () => {
        await page.locator(".bl-overlay .bl-trash-button").click();
        await until(() => document.querySelector(".bl-overlay .bl-trash"));
    });
    const trashStays = await w(() => !!document.querySelector(".bl-overlay .bl-trash") && window.__win.editor() === null);
    check("nor is the trash opened meanwhile", trashStays);
    await closeLibrary();
    await firstList(async () => {
        await page.keyboard.press("Escape");
        await overlay.waitFor({ state: "detached" });
    });
    check("an answer after the window closed opens nothing", !(await overlay.count()));
    await firstList(async () => {});
    st = await editor();
    check("left alone, the window opens at the bundle asked for", st?.name === `${PREFIX} Q`, st?.name);

    // ---- editor reads answering out of order (R19-02) -----------------------------------------
    const note = async (text) => {
        const current = await api("GET", `/bundles/${ids.Q}`);
        return api("PUT", `/bundles/${ids.Q}`, { name: current.name, tags: current.tags, note: text, fields: current.fields,
            expected_revision: current.revision }); // as from another tab
    };
    const rev2 = await note("revision 2");
    let reads = 0;
    const firstRead = await holdAnswers(page, (url, method) => method === "GET" && url.pathname === `${API}/bundles/${ids.Q}`
        && reads++ === 0);
    await ev(() => document.dispatchEvent(new Event("visibilitychange")));
    await settle(() => firstRead.held.length === 1);
    const rev3 = await note("revision 3");
    await ev(() => document.dispatchEvent(new Event("visibilitychange")));
    await until(() => window.__win.editor()?.note === "revision 3");
    await firstRead.release(); // the read for revision 2, last
    await page.waitForTimeout(400);
    st = await editor();
    check("a read for an older revision answering last does not take the editor back (R19-02)",
        st?.note === "revision 3" && st.state === "Saved" && rev3.revision === rev2.revision + 1, st && { note: st.note });
    await closeLibrary();

    // ---- a bundle in the trash this version cannot change (N30) -------------------------------
    const lockedPath = LIBRARY && `${LIBRARY}/bundles/${LOCKED_ID}.json`;
    if (CONTAINER && LIBRARY) {
        const locked = {
            format: "comfyui-bundle-library/bundle", schema_version: 2, id: LOCKED_ID, revision: 3, name: `${PREFIX} locked`,
            tags: ["test"], note: "", fields: [text("prompt", "kept by a newer version")],
            created_at: "2026-10-17T00:00:00.000Z", updated_at: "2026-10-17T00:00:00.000Z", deleted_at: "2026-10-17T00:00:00.000Z",
            color: "red", // a key this version does not know
        };
        execFileSync("docker", ["exec", CONTAINER, "python", "-c", "import sys; open(sys.argv[1], 'w').write(sys.argv[2])",
            lockedPath, JSON.stringify(locked)]);
        await openLibrary();
        await page.locator(".bl-overlay .bl-trash-button").click();
        const entry = page.locator(`.bl-overlay .bl-trash-item[data-id="${LOCKED_ID}"]`);
        await entry.waitFor();
        const shown = await entry.evaluate((item) => ({
            mark: item.querySelector(".bl-list-warn")?.textContent ?? null,
            restore: [...item.querySelectorAll("button")].find((b) => b.textContent === "Restore")?.disabled,
        }));
        check("a bundle in the trash this version cannot change says so, and cannot be restored here (N30)",
            shown.mark === "🔒 Cannot be changed by this version" && shown.restore === true, shown);
        await button("Empty trash").click();
        layer = await w(() => window.__win.layer());
        check("emptying the trash says such a bundle stays", /1 bundle this version cannot change stays/.test(layer?.text ?? ""),
            layer?.text);
        await button("Cancel", layerBox).click();
        await button("Delete forever", entry).click();
        layer = await w(() => window.__win.layer());
        const warned = (layer?.text ?? "").includes("cannot fully use it: it has data this version does not know");
        await button("Delete forever", layerBox).click();
        await entry.waitFor({ state: "detached" });
        const gone = !(await api("GET", "/trash")).trash.some((e) => e.id === LOCKED_ID);
        check("Delete forever asks with what would be lost, then deletes it (N30)", warned && gone, { warned, gone });
        await closeLibrary();
    } else {
        check("a bundle in the trash this version cannot change (skipped: no BL_TEST_CONTAINER/BL_TEST_LIBRARY)", true);
    }

    // ---- a node's sound when its preview goes (R15-12) ----------------------------------------
    const sound = async (file, type) => ev(async ([data, file, type]) => {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        const form = new FormData();
        form.append("kind", "audio"); // before the file: it picks the size limit
        form.append("file", new Blob([bytes], { type }), file);
        return (await window.__bl.request("POST", "/assets", form)).asset;
    }, [fs.readFileSync(path.join(FIXTURES, file)).toString("base64"), file, type]);
    const mp3 = await sound("tone.mp3", "audio/mpeg");
    const wav = await sound("tone.wav", "audio/wav");
    const audio = (asset) => [{ name: "bgm", type: "audio", asset: { sha256: asset.sha256 } }];
    ids.S1 = await make(`${PREFIX} Sound 1`, audio(mp3));
    ids.S2 = await make(`${PREFIX} Sound 2`, audio(wav));
    await ev(async ([one, two]) => {
        const b = window.__bl;
        // The bundles were made through ComfyUI's API helper: say so, as the window would, so the nodes' lists are read again.
        window.dispatchEvent(new CustomEvent("bundle-library:changed"));
        // The sound the previews play: which one it is, and whether it is paused.
        const play = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function () {
            if (!this.isConnected) window.__player = this;
            return play.call(this);
        };
        b.app.graph.clear();
        window.__nodes = [b.add("BundleLibraryLoad", [80, 120]), b.add("BundleLibraryLoad", [620, 120])];
        for (const [i, node] of window.__nodes.entries()) {
            node.setSize([420, node.size[1]]);
            node.bundlePanel.rows.dataset.testNode = String(i);
        }
        await b.pick(window.__nodes[0], one);
        await b.pick(window.__nodes[1], two);
    }, [ids.S1, ids.S2]);
    await page.waitForTimeout(600);
    const playIn = (i) => page.locator(`[data-test-node="${i}"] [data-field="bgm"] .bl-play`);
    const playing = () => ev(() => !!window.__player && !window.__player.paused);
    await playIn(0).click();
    await until(() => document.querySelector('[data-test-node="0"] [data-field="bgm"] .bl-play')?.textContent === "⏸");
    await ev((two) => window.__bl.pick(window.__nodes[1], two), ids.S1); // the other node's preview is drawn again
    const otherKept = (await playIn(0).textContent()) === "⏸" && await playing();
    check("another node's preview drawn again leaves the sound alone", otherKept);
    const first = await playIn(0).elementHandle();
    await ev((two) => window.__bl.pick(window.__nodes[0], two), ids.S2); // its own preview is drawn again
    const ownStopped = (await first.evaluate((b) => b.textContent)) === "▶" && !(await playing());
    check("a preview drawn again stops its own sound (R15-12)", ownStopped);
    await playIn(1).click(); // from one node's sound straight to another's
    await page.waitForTimeout(500);
    const switched = { from: await playIn(0).textContent(), to: await playIn(1).textContent(), playing: await playing() };
    check("starting another node's sound moves the ⏸ to it and keeps it there (N41)",
        switched.from === "▶" && switched.to === "⏸" && switched.playing, switched);
    await playIn(0).click();
    await until(() => document.querySelector('[data-test-node="0"] [data-field="bgm"] .bl-play')?.textContent === "⏸");
    await page.waitForTimeout(300);
    const second = await playIn(0).elementHandle();
    const soundingBefore = await playing();
    await ev(() => window.__bl.app.graph.remove(window.__nodes[0]));
    const removedStopped = soundingBefore && (await second.evaluate((b) => b.textContent)) === "▶" && !(await playing());
    check("removing the node stops its sound (R15-12)", removedStopped, { soundingBefore });
    await playIn(1).click();
    await until(() => document.querySelector('[data-test-node="1"] [data-field="bgm"] .bl-play')?.textContent === "⏸");
    const failing = await holdAnswers(page, (url, method) => isList(url) && method === "GET", { status: 500 });
    await ev(() => window.dispatchEvent(new CustomEvent("bundle-library:changed"))); // the panels read the list again
    await settle(() => failing.held.length >= 1);
    await failing.release();
    await until(() => document.querySelector('[data-test-node="1"] .bl-note.bl-bad'));
    const failedStopped = !(await playing());
    await ev(() => window.__bl.app.graph.remove(window.__nodes[1]));
    check("a list read that fails stops the sound of the preview it replaces (R19-05)",
        failedStopped && !(await playing()), { failedStopped });
    await ev(() => window.__bl.app.graph.clear());

    // ---- the list shows the bundle the window selects by itself (0.0.23) -------------------------
    const many = [];
    for (let i = 0; i < 28; i++) many.push(await make(`${PREFIX} scroll ${String(i).padStart(2, "0")}`, [text("prompt", "s")]));
    const last = many[many.length - 1]; // Uncategorized comes last, and in it this bundle
    const openAt = async (selected) => {
        await ev(async ([module, selected]) => {
            const { openLibrary } = await import(`${module}/library_modal.js`);
            openLibrary({ selected });
        }, [MODULE, selected]);
        await overlay.waitFor();
        await page.evaluate(WINDOW_HELPERS);
    };
    const place = (id) => w((id) => {
        const list = document.querySelector(".bl-overlay .bl-modal-list");
        const box = list.getBoundingClientRect();
        const rows = [...list.querySelectorAll(`.bl-list-item[data-id="${id}"]`)].filter((r) => !r.closest("[hidden]"));
        const rect = rows[0]?.getBoundingClientRect();
        return { inView: !!rect && rect.top >= box.top && rect.bottom <= box.bottom, top: list.scrollTop,
            scrolls: list.scrollHeight > list.clientHeight };
    }, id);
    const toTop = () => w(() => { document.querySelector(".bl-overlay .bl-modal-list").scrollTop = 0; });
    await openAt(last);
    await opened(`${PREFIX} scroll 27`);
    let at = await place(last);
    check("a window opened at a bundle shows its row in the list, scrolled there (0.0.23)", at.scrolls && at.inView && at.top > 0, at);
    await page.locator('.bl-overlay .bl-group[data-group="uncategorized"] .bl-group-toggle').click();
    await closeLibrary();
    await openAt(last);
    await opened(`${PREFIX} scroll 27`);
    at = await place(last);
    const expanded = await w(() => !document.querySelector('.bl-overlay .bl-group[data-group="uncategorized"] .bl-group-rows').hidden);
    check("its group, collapsed, is expanded so the row shows", expanded && at.inView, { expanded, ...at });
    await toTop();
    await page.locator(".bl-overlay .bl-note-input").fill("saved where it is");
    await page.keyboard.press("Control+s");
    await until(() => window.__win.editor()?.state === "Saved");
    await page.waitForTimeout(300);
    at = await place(last);
    check("saving a bundle that was there already leaves the list where it is", at.top === 0, at);
    await button("+ New bundle").click();
    await page.locator(".bl-overlay .bl-name-input").fill(`${PREFIX} scroll zz new`);
    await toTop();
    await page.keyboard.press("Control+s");
    await until(() => window.__win.editor()?.state === "Saved");
    const made = await w(() => window.__win.editor()?.name && document.querySelector(".bl-overlay .bl-list-item.selected")?.dataset.id);
    at = await place(made);
    check("a new bundle's first save shows its row", !!made && at.inView && at.top > 0, at);
    await row(many[0]).click();
    await opened(`${PREFIX} scroll 00`);
    await w(() => { const list = document.querySelector(".bl-overlay .bl-modal-list"); list.scrollTop = list.scrollHeight; });
    await button("Duplicate ▾").click();
    await menuItem("Duplicate with values").click();
    await opened(`${PREFIX} scroll 00 copy`);
    const copy = await w(() => document.querySelector(".bl-overlay .bl-list-item.selected")?.dataset.id);
    at = await place(copy);
    check("a duplicate shows its row", !!copy && copy !== many[0] && at.inView, at);
    await closeLibrary();

    if (CONTAINER && LIBRARY) { // in case the trash part stopped before deleting it
        execFileSync("docker", ["exec", CONTAINER, "python", "-c",
            "import os, sys\nif os.path.exists(sys.argv[1]): os.remove(sys.argv[1])", lockedPath]);
    }
    await finish({ expectRemoved: 37 }); // with the 28 to scroll to, a new one and a copy; the copy deleted above
    // is removed from the trash
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
