// Browser scenarios for tags (Phase 7.8b): the batch panel's tag chips and
// its tag for all, the Tags pane (counts with the trash, rename, merge,
// delete, each asked first), the tag filter following a rename, an open
// editor after its bundle was saved elsewhere (N23), and tags that differ only
// in case being one tag (N47). Set-up and safety notes are in harness.cjs. A
// bundle this version cannot change is written into the test server's library
// through its container (BL_TEST_CONTAINER and BL_TEST_LIBRARY); without them
// that check is skipped.
const { execFileSync } = require("child_process");
const { startSession } = require("./harness.cjs");

const PREFIX = "[test] Tags";
const CONTAINER = process.env.BL_TEST_CONTAINER;
const LIBRARY = process.env.BL_TEST_LIBRARY;

const TAG_HELPERS = () => {
    const $ = (selector, root = document) => root.querySelector(selector);
    window.__tags = {
        status: () => $(".bl-overlay .bl-status")?.textContent ?? "",
        chips: () => [...document.querySelectorAll(".bl-overlay .bl-batch-tag")].map((c) => c.textContent.replace("×", "").trim()),
        result: () => $(".bl-overlay .bl-batch-result:not(.waiting) .bl-batch-title")?.textContent ?? null,
        outcomes: () => Object.fromEntries([...document.querySelectorAll(".bl-overlay .bl-batch-outcome")]
            .map((g) => [g.dataset.outcome, [...g.querySelectorAll(".bl-batch-outcome-row")].map((r) => r.textContent)])),
        pane: () => [...document.querySelectorAll(".bl-overlay .bl-tag-item")].map((row) => ({
            name: row.dataset.tag, sub: $(".bl-list-sub", row).textContent })),
        layer() {
            const layer = $(".bl-overlay .bl-layer");
            return layer ? { title: $(".bl-confirm-title", layer)?.textContent ?? null,
                text: [...layer.querySelectorAll(".bl-confirm-text")].map((t) => t.textContent).join(" ") } : null;
        },
        menu: () => [...document.querySelectorAll(".bl-overlay .bl-menu:not([hidden]) .bl-menu-item")]
            .map((i) => ({ role: i.getAttribute("role"), text: i.querySelector(".bl-menu-text")?.textContent ?? "" })),
        filter: () => $(".bl-overlay .bl-filter-chip")?.textContent ?? null,
        editor() {
            const editor = $(".bl-overlay .bl-editor");
            return editor ? { name: $(".bl-name-input", editor).value, note: $(".bl-note-input", editor).value,
                tags: [...editor.querySelectorAll(".bl-tags .bl-chip")].map((c) => c.firstChild.textContent),
                state: $(".bl-state", editor).textContent } : null;
        },
    };
};

(async () => {
    const session = await startSession("tags");
    const { page, ev, check, shot, finish } = session;
    const overlay = page.locator(".bl-overlay");
    const layerBox = page.locator(".bl-overlay .bl-layer");
    const button = (name, scope = overlay) => scope.getByRole("button", { name, exact: true });
    const until = (fn, arg, timeout = 10000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
    const api = (method, route, body) => ev(([m, r, b]) => window.__bl.request(m, r, b), [method, route, body ?? null]);
    const t = (fn, arg) => ev(fn, arg);
    const row = (id) => page.locator(`.bl-overlay .bl-list-item[data-id="${id}"]`).first();
    const command = (id) => ev((c) => window.__bl.app.extensionManager.command.execute(c), id);
    const tagsOf = async (id) => (await api("GET", `/bundles/${id}`)).tags;
    const openLibrary = async () => {
        await command("BundleLibrary.Open");
        await overlay.waitFor();
        await page.evaluate(TAG_HELPERS);
        await page.locator(".bl-overlay .bl-search").fill(PREFIX);
        await until(() => document.querySelectorAll(".bl-overlay .bl-list-item").length >= 4);
    };
    const resultShown = () => until(() => window.__tags.result() !== null);
    const make = async (name, tags) => (await api("POST", "/bundles", {
        name, tags: ["test", ...tags], fields: [{ name: "prompt", type: "text", value: name }] })).id;

    const ids = {
        one: await make(`${PREFIX} 1`, ["Portrait", "outdoor"]),
        two: await make(`${PREFIX} 2`, ["portrait"]),
        three: await make(`${PREFIX} 3`, []),
        full: await make(`${PREFIX} full`, Array.from({ length: 19 }, (_, i) => `f${i}`)), // 20 with "test"
        trashed: await make(`${PREFIX} trashed`, ["Portrait"]),
    };
    await api("DELETE", `/bundles/${ids.trashed}?expected_revision=1`);

    // ---- the batch panel's tags ---------------------------------------------------------------------
    await openLibrary();
    await row(ids.one).click();
    await row(ids.two).click({ modifiers: ["Control"] });
    await row(ids.three).click({ modifiers: ["Control"] });
    await until(() => window.__tags.chips().length > 0);
    let chips = await t(() => window.__tags.chips());
    check("the batch panel shows each tag once whatever its case, with how many of the selection have it (N47)",
        JSON.stringify(chips) === JSON.stringify(["outdoor 1/3", "Portrait 2/3", "test 3/3"]), chips);
    await button("Remove the tag outdoor from the selected bundles").click();
    await resultShown();
    let outcomes = await t(() => window.__tags.outcomes());
    check("× takes the tag off the selection: changed where it was, already so elsewhere",
        (await t(() => window.__tags.result())) === "Removed the tag 'outdoor'" && outcomes.changed?.length === 1
        && outcomes.unchanged?.length === 2 && JSON.stringify(await tagsOf(ids.one)) === JSON.stringify(["test", "Portrait"]),
        outcomes);
    await button("Done").click();
    await until(() => window.__tags.chips().length > 0);
    await row(ids.full).click({ modifiers: ["Control"] });
    await until(() => window.__tags.chips().some((c) => c.endsWith("/4")));
    await page.locator(".bl-overlay .bl-batch-add-tag").fill("Studio");
    await page.keyboard.press("Enter");
    await resultShown();
    outcomes = await t(() => window.__tags.outcomes());
    check("a tag typed in the panel goes on every selected bundle; one with 20 tags already says why not",
        (await t(() => window.__tags.result())) === "Added the tag 'Studio'" && outcomes.changed?.length === 3
        && outcomes.other?.length === 1 && outcomes.other[0].includes("would have 21 tags"), outcomes);
    await shot("tags-batch.png");
    await button("Done").click();
    await page.keyboard.press("Escape"); // the selection

    // ---- the Tags pane -------------------------------------------------------------------------------
    await page.locator(".bl-overlay .bl-tag-button").click();
    const menu = await t(() => window.__tags.menu());
    check("the tag menu ends with Manage tags…, a command after the tag choices",
        menu.at(-1)?.text === "Manage tags…" && menu.at(-1).role === "menuitem"
        && menu.slice(0, -1).every((i) => i.role === "menuitemradio"), menu);
    await page.getByRole("menuitem", { name: "Manage tags…" }).click();
    await until(() => window.__tags.pane().length > 0);
    let pane = await t(() => window.__tags.pane());
    const portrait = pane.find((p) => p.name === "Portrait");
    check("the Tags pane counts each tag in use and in the trash, and names its other spellings",
        portrait?.sub.includes("2 in use") && portrait.sub.includes("1 in the trash") && portrait.sub.includes("also spelled portrait"),
        pane);
    await shot("tags-pane.png");
    await button("Rename…", page.locator('.bl-overlay .bl-tag-item[data-tag="Studio"]')).click();
    await page.locator(".bl-overlay .bl-ask-input").fill("Light");
    await button("Next", layerBox).click();
    await until(() => window.__tags.layer()?.title?.startsWith("Rename"));
    let layer = await t(() => window.__tags.layer());
    check("renaming asks first, saying how far it reaches", layer?.title === "Rename 'Studio' to 'Light'?"
        && layer.text.includes("'Studio' is on 3 bundles in use."), layer);
    await button("Rename", layerBox).click();
    await until(() => window.__tags.status().startsWith("Renamed"));
    check("then it is renamed in every bundle that had it", (await t(() => window.__tags.status())) === "Renamed 'Studio' to 'Light' in 3 bundles."
        && JSON.stringify(await tagsOf(ids.three)) === JSON.stringify(["test", "Light"]), await t(() => window.__tags.status()));

    // the tag filter follows a rename
    await page.locator(".bl-overlay .bl-tag-button").click();
    await page.getByRole("menuitemradio", { name: "Light" }).click();
    await until(() => window.__tags.filter() === "Tag: Light×");
    await button("Rename…", page.locator('.bl-overlay .bl-tag-item[data-tag="Light"]')).click();
    await page.locator(".bl-overlay .bl-ask-input").fill("portrait");
    await button("Next", layerBox).click();
    await until(() => window.__tags.layer()?.title?.startsWith("Merge"));
    layer = await t(() => window.__tags.layer());
    check("renaming to a tag that is there already offers to merge, with both reaches",
        layer?.title === "Merge 'Light' into 'portrait'?" && layer.text.includes("'Portrait' is on 2 bundles in use and 1 in the trash.")
        && layer.text.includes("A bundle with both keeps one 'portrait'"), layer);
    await button("Merge", layerBox).click();
    await until(() => window.__tags.status().startsWith("Renamed 'Light'"));
    const merged = { status: await t(() => window.__tags.status()), one: await tagsOf(ids.one), three: await tagsOf(ids.three),
        filter: await t(() => window.__tags.filter()) };
    check("merging keeps one tag where the first was, spelled as asked; the filter follows it",
        merged.status === "Renamed 'Light' to 'portrait' in 3 bundles (2 merged)."
        && JSON.stringify(merged.one) === JSON.stringify(["test", "portrait"])
        && JSON.stringify(merged.three) === JSON.stringify(["test", "portrait"]) && merged.filter === "Tag: portrait×", merged);
    await button("Delete…", page.locator('.bl-overlay .bl-tag-item[data-tag="portrait"]')).click();
    layer = await t(() => window.__tags.layer());
    check("deleting a tag asks first, with its reach including the trash",
        layer?.title === "Delete the tag 'portrait'?" && layer.text.includes("3 bundles in use and 1 in the trash"), layer);
    await button("Delete tag", layerBox).click();
    await until(() => window.__tags.status().startsWith("Deleted the tag"));
    const trash = (await api("GET", "/trash")).trash.find((e) => e.id === ids.trashed);
    pane = await t(() => window.__tags.pane());
    check("then it comes off every bundle, the one in the trash too, and the filter is cleared",
        (await t(() => window.__tags.status())) === "Deleted the tag 'portrait' from 4 bundles."
        && JSON.stringify(trash?.tags) === JSON.stringify(["test"]) && !pane.some((p) => p.name === "portrait")
        && (await t(() => window.__tags.filter())) === null, { pane, trash: trash?.tags });

    // ---- a bundle this version cannot change keeps its tags --------------------------------------------
    if (CONTAINER && LIBRARY) {
        const path = `${LIBRARY}/bundles/${ids.two}.json`;
        execFileSync("docker", ["exec", CONTAINER, "python", "-c",
            "import json, sys; p = sys.argv[1]; d = json.load(open(p)); d['tags'] = d['tags'] + ['keep']; d['color'] = 'red'; "
            + "json.dump(d, open(p, 'w'))", path]);
        await page.locator(".bl-overlay .bl-tag-button").click();
        await page.getByRole("menuitem", { name: "Manage tags…" }).click(); // reads the tags again
        await until(() => window.__tags.pane().some((p) => p.name === "keep"));
        pane = await t(() => window.__tags.pane());
        check("a bundle this version cannot change is counted as such", pane.find((p) => p.name === "keep")?.sub.includes("🔒 1"), pane);
        await button("Delete…", page.locator('.bl-overlay .bl-tag-item[data-tag="keep"]')).click();
        layer = await t(() => window.__tags.layer());
        const warned = layer?.text.includes("1 bundle this version cannot change keeps 'keep'.");
        await button("Delete tag", layerBox).click();
        await until(() => window.__tags.status().startsWith("Deleted the tag 'keep'"));
        const status = await t(() => window.__tags.status());
        check("deleting its tag says it is kept there, and why", warned && status.startsWith("Deleted the tag 'keep' from 0 bundles. 1 bundle kept 'keep':"),
            { layer, status });
        execFileSync("docker", ["exec", CONTAINER, "python", "-c",
            "import json, sys; p = sys.argv[1]; d = json.load(open(p)); d.pop('color'); json.dump(d, open(p, 'w'))", path]);
    } else {
        check("a bundle this version cannot change keeps its tags (skipped: no BL_TEST_CONTAINER/BL_TEST_LIBRARY)", true);
    }

    // ---- an open editor after its bundle was saved elsewhere (N23) --------------------------------------
    const seen = async (id) => api("GET", `/bundles/${id}`);
    await row(ids.three).click();
    await until((name) => window.__tags.editor()?.name === name, `${PREFIX} 3`);
    let stored = await seen(ids.three);
    await api("PUT", `/bundles/${ids.three}`, { name: stored.name, tags: [...stored.tags, "elsewhere"], note: stored.note,
        fields: stored.fields, expected_revision: stored.revision }); // as from another tab
    await ev(() => document.dispatchEvent(new Event("visibilitychange"))); // coming back to this tab
    await until(() => window.__tags.editor()?.tags.includes("elsewhere"));
    let editor = await t(() => window.__tags.editor());
    check("a clean editor shows its bundle as saved elsewhere once the list is read again (N23)",
        editor?.tags.includes("elsewhere") && editor.state === "Saved"
        && (await t(() => window.__tags.status())).includes("was saved elsewhere"), editor);
    await page.locator(".bl-overlay .bl-note-input").fill("typed here");
    stored = await seen(ids.three);
    await api("PUT", `/bundles/${ids.three}`, { name: stored.name, tags: stored.tags.filter((x) => x !== "elsewhere"),
        note: stored.note, fields: stored.fields, expected_revision: stored.revision });
    await ev(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.waitForTimeout(800);
    editor = await t(() => window.__tags.editor());
    check("an editor with changes keeps them", editor?.note === "typed here" && editor.tags.includes("elsewhere"), editor);
    await page.keyboard.press("Control+s");
    await layerBox.waitFor();
    layer = await t(() => window.__tags.layer());
    check("saving them meets the newer version and says overwriting brings its tags back",
        layer?.title === "This bundle was changed elsewhere" && layer.text.includes("its tags too"), layer);
    await button("Reload", layerBox).click();
    await until(() => window.__tags.editor()?.state === "Saved");

    // ---- tags that differ only in case are one tag (N47) -------------------------------------------------
    const s1 = await make(`${PREFIX} street 1`, ["Straße"]);
    const s2 = await make(`${PREFIX} street 2`, ["STRASSE"]);
    await ev(() => document.dispatchEvent(new Event("visibilitychange"))); // made behind the window's back: read the list again
    await page.locator(".bl-overlay .bl-search").fill(`${PREFIX} street`);
    await until(() => document.querySelectorAll(".bl-overlay .bl-list-item").length >= 2);
    await row(s1).click();
    await row(s2).click({ modifiers: ["Control"] });
    await until(() => window.__tags.chips().length > 0);
    chips = await t(() => window.__tags.chips());
    await page.locator(".bl-overlay .bl-tag-button").click();
    const choices = (await t(() => window.__tags.menu())).filter((i) => i.role === "menuitemradio").map((i) => i.text);
    check("'Straße' and 'STRASSE' are one tag, as the server takes them (N47)",
        chips.filter((c) => c.endsWith("2/2")).length === 2 && chips.some((c) => /^(Straße|STRASSE) 2\/2$/.test(c))
        && choices.filter((c) => /^(Straße|STRASSE)$/.test(c)).length === 1, { chips, choices });
    await page.keyboard.press("Escape"); // the menu
    await page.keyboard.press("Escape"); // the selection

    // ---- tags that only look alike are two tags (R19-04) -------------------------------------------
    const tr = await make(`${PREFIX} red tr`, ["kırmızı"]);
    const ascii = await make(`${PREFIX} red ascii`, ["kirmizi"]);
    await ev(() => document.dispatchEvent(new Event("visibilitychange"))); // made behind the window's back
    await page.locator(".bl-overlay .bl-search").fill(`${PREFIX} red`);
    // The rows of this search's answer: those of the last search are two as well.
    await until((want) => [...new Set([...document.querySelectorAll(".bl-overlay .bl-list-item")].map((r) => r.dataset.id))]
        .sort().join() === want, [tr, ascii].sort().join());
    await page.locator(".bl-overlay .bl-tag-button").click();
    const reds = (await t(() => window.__tags.menu())).filter((i) => i.role === "menuitemradio")
        .map((i) => i.text).filter((x) => /^k[ıi]rm[ıi]z[ıi]$/.test(x));
    // By its value: Playwright's own case-insensitive name match would take kirmizi too.
    await page.locator('.bl-overlay .bl-menu-item[data-value="kırmızı"]').click();
    await until(() => window.__tags.filter() === "Tag: kırmızı×");
    const filtered = await ev(() => [...new Set([...document.querySelectorAll(".bl-overlay .bl-list-item")].map((r) => r.dataset.id))]);
    check("'kırmızı' and 'kirmizi' are two tags: two entries in the menu, and the filter shows only its own (R19-04)",
        JSON.stringify(reds.sort()) === JSON.stringify(["kirmizi", "kırmızı"]) && JSON.stringify(filtered) === JSON.stringify([tr]),
        { reds, filtered });
    await row(tr).click();
    await until((name) => window.__tags.editor()?.name === name, `${PREFIX} red tr`);
    await page.locator(".bl-overlay .bl-tags .bl-tag-input").fill("kirmizi");
    await page.keyboard.press("Enter");
    editor = await t(() => window.__tags.editor());
    check("in the editor, 'kirmizi' goes on a bundle that has 'kırmızı'",
        editor?.tags.includes("kirmizi") && editor.tags.includes("kırmızı") && editor.state === "● Unsaved changes", editor);
    await button("Revert").click();
    await button("Clear the tag filter").click();

    await finish({ expectRemoved: 8 });
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
