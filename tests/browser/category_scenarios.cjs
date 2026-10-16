// Browser scenarios for categories and favorites (Phase 7.6): the grouped
// list, collapsing, searching, bundles with the same name, making, renaming
// and deleting categories, placing from the editor and by dragging, stars,
// an unsaved draft that survives both, Needs attention, the trash, the
// sidebar and the node's dropdown. Set-up and safety notes are in
// harness.cjs: the categories made here are removed at the end.
const { startSession } = require("./harness.cjs");

const PREFIX = "[test] Cat";
const HEROES = "[test] Heroes";
const ALLIES = "[test] Allies";

const CAT_HELPERS = () => {
    const $ = (selector, root = document) => root.querySelector(selector);
    const groupOf = (key) => [...document.querySelectorAll(".bl-overlay .bl-group")].find((g) => g.dataset.group === key);
    window.__cat = {
        groupOf,
        /** The groups shown: key, heading, count, collapsed, and the rows (bundle ids, or files). */
        groups: () => [...document.querySelectorAll(".bl-overlay .bl-group")].map((g) => ({
            key: g.dataset.group,
            name: $(".bl-group-name", g).textContent,
            count: $(".bl-group-count", g).textContent,
            sign: $(".bl-group-sign", g).textContent,
            collapsed: $(".bl-group-rows", g).hidden,
            toggle: !$(".bl-group-toggle", g).disabled,
            rows: [...g.querySelectorAll(".bl-list-item, .bl-error-item")].map((r) => r.dataset.id ?? r.dataset.file),
            empty: $(".bl-group-empty", g)?.textContent ?? null,
            menu: !!$(".bl-group-menu", g),
        })),
        group(key) { return this.groups().find((g) => g.key === key) ?? null; },
        categoryKey: (name) => [...document.querySelectorAll(".bl-overlay .bl-group.category")]
            .find((g) => $(".bl-group-name", g).textContent === name)?.dataset.group ?? null,
        row: (key, id) => [...(groupOf(key)?.querySelectorAll(".bl-list-item") ?? [])].find((r) => r.dataset.id === id),
        label(key, id) { return $(".bl-list-name", this.row(key, id))?.textContent ?? null; },
        editor() {
            const editor = $(".bl-overlay .bl-editor");
            if (!editor) return null;
            const select = $(".bl-category-select", editor);
            return {
                name: $(".bl-name-input", editor).value,
                note: $(".bl-note-input", editor).value,
                state: $(".bl-state", editor).textContent,
                star: $(".bl-editor-head .bl-star", editor).textContent,
                starEnabled: !$(".bl-editor-head .bl-star", editor).disabled,
                category: select.selectedOptions[0]?.textContent ?? null,
                options: [...select.options].map((o) => o.textContent),
                selectEnabled: !select.disabled,
            };
        },
        layer() {
            const layer = $(".bl-overlay .bl-layer");
            if (!layer) return null;
            return {
                title: $(".bl-confirm-title", layer)?.textContent ?? null,
                text: [...layer.querySelectorAll(".bl-confirm-text")].map((t) => t.textContent),
                error: layer.querySelector(".bl-error:not([hidden])")?.textContent ?? null,
                input: $("input", layer)?.value ?? null,
            };
        },
        status: () => ({ text: $(".bl-overlay .bl-status")?.textContent ?? "", error: !!$(".bl-overlay .bl-status.error") }),
        selected: () => [...document.querySelectorAll(".bl-overlay .bl-list-item.selected")].map((r) => r.dataset.id),
        /** Drag a bundle row onto a group with HTML drag and drop events; whether the group lit up. */
        drag(fromKey, id, toKey) {
            const row = this.row(fromKey, id);
            const target = groupOf(toKey);
            const data = new DataTransfer();
            const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
            fire(row, "dragstart");
            fire(target, "dragenter");
            fire(target, "dragover");
            const lit = target.classList.contains("drop-target");
            fire(target, "drop");
            fire(row, "dragend");
            return lit;
        },
        /** Drop a file from outside on a group; whether it was taken for a move (the group lit up). */
        dropFile(key) {
            const target = groupOf(key);
            const data = new DataTransfer();
            data.items.add(new File(["x"], "outside.png", { type: "image/png" }));
            const over = new DragEvent("dragover", { dataTransfer: data, bubbles: true, cancelable: true });
            target.dispatchEvent(new DragEvent("dragenter", { dataTransfer: data, bubbles: true, cancelable: true }));
            target.dispatchEvent(over);
            const lit = target.classList.contains("drop-target");
            target.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
            return lit;
        },
    };
};

(async () => {
    const session = await startSession("category");
    const { page, ev, check, shot, finish } = session;
    const overlay = page.locator(".bl-overlay");
    const layerBox = page.locator(".bl-overlay .bl-layer");
    const button = (name, scope = overlay) => scope.getByRole("button", { name, exact: true });
    const menuItem = (name, scope = overlay) => scope.getByRole("menuitem", { name, exact: true });
    const until = (fn, arg, timeout = 10000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
    const api = (method, route, body) => ev(([m, r, b]) => window.__bl.request(m, r, b), [method, route, body ?? null]);
    const cat = (fn, arg) => ev(fn, arg);
    const command = (id) => ev((c) => window.__bl.app.extensionManager.command.execute(c), id);
    const openLibrary = async () => {
        await command("BundleLibrary.Open");
        await overlay.waitFor();
        await page.evaluate(CAT_HELPERS);
        await until(() => document.querySelector(".bl-overlay .bl-group"));
    };
    const server = async () => Object.fromEntries((await api("GET", "/bundles")).bundles
        .map((b) => [b.id, [b.category, b.favorite]]));
    const settled = () => until(() => !document.querySelector(".bl-overlay .bl-editor.saving"), null, 3000)
        .then(() => page.waitForTimeout(400));

    const text = (value) => [{ name: "prompt", type: "text", value }];
    const make = async (name) => (await api("POST", "/bundles", { name, tags: ["test"], fields: text(name) })).id;
    const ids = {
        red: await make(`${PREFIX} Red`),
        blue: await make(`${PREFIX} Blue`),
        green: await make(`${PREFIX} Green`),
        twinA: await make(`${PREFIX} Twin`),
        twinB: await make(`${PREFIX} Twin`),
    };

    // ---- the grouped list -------------------------------------------------------------
    await openLibrary();
    let groups = await cat(() => window.__cat.groups());
    const order = groups.map((g) => g.key);
    check("the list opens in groups: Favorites first, Uncategorized last, our bundles uncategorized",
        order[0] === "favorites" && order.at(-1) === "uncategorized"
        && Object.values(ids).every((id) => groups.at(-1).rows.includes(id)), order);
    const twins = await cat(([a, b]) => [window.__cat.label("uncategorized", a), window.__cat.label("uncategorized", b)],
        [ids.twinA, ids.twinB]);
    check("bundles with the same name are told apart by the start of their id",
        twins[0] !== twins[1] && twins.every((t) => t.startsWith(`${PREFIX} Twin · `)), twins);

    // ---- making a category ------------------------------------------------------------
    await button("New category").click();
    await page.locator(".bl-overlay .bl-ask-input").fill("Favorites");
    await page.keyboard.press("Enter");
    await until(() => window.__cat.layer()?.error);
    let layer = await cat(() => window.__cat.layer());
    check("a category may not take the name of a view; the question stays with the reason",
        layer?.title === "New category" && layer.error.includes("is the name of a view"), layer);
    await page.locator(".bl-overlay .bl-ask-input").fill(HEROES);
    await button("Create", layerBox).click();
    await until(() => !window.__cat.layer());
    const heroesKey = await cat((name) => window.__cat.categoryKey(name), HEROES);
    const heroesId = heroesKey?.slice("category:".length);
    let heroes = await cat((key) => window.__cat.group(key), heroesKey);
    check("+ New category makes an empty category, shown with a hint and a menu",
        heroes?.count === "0" && heroes.empty?.startsWith("No bundles. Drag one here") && heroes.menu, heroes);
    await button("New category").click();
    await page.locator(".bl-overlay .bl-ask-input").fill(HEROES.toUpperCase());
    await page.keyboard.press("Enter");
    await until(() => window.__cat.layer()?.error);
    layer = await cat(() => window.__cat.layer());
    check("category names are unique regardless of case", layer?.error === `A category named '${HEROES}' already exists.`,
        layer);
    await page.keyboard.press("Escape");
    await until(() => !window.__cat.layer());

    // ---- renaming it ------------------------------------------------------------------
    await page.locator(`.bl-overlay .bl-group[data-group="${heroesKey}"] .bl-group-menu`).click();
    await menuItem("Rename…").click();
    layer = await cat(() => window.__cat.layer());
    await page.locator(".bl-overlay .bl-ask-input").fill(ALLIES);
    await button("Rename", layerBox).click();
    await until(([key, name]) => window.__cat.group(key)?.name === name, [heroesKey, ALLIES]);
    check("⋯ > Rename… renames the category in place", layer?.input === HEROES
        && (await cat((key) => window.__cat.group(key)?.name, heroesKey)) === ALLIES, layer);

    // ---- the editor: category and star keep an unsaved draft ----------------------------
    await page.locator(`.bl-overlay .bl-group[data-group="uncategorized"] .bl-list-item[data-id="${ids.blue}"]`).click();
    await until(() => document.querySelector(".bl-overlay .bl-category-select"));
    await page.locator(".bl-overlay .bl-note-input").fill("not saved yet");
    let editor = await cat(() => window.__cat.editor());
    check("the editor shows the category (No category, the categories, New category…) and a star",
        editor.category === "No category" && editor.options.includes(ALLIES) && editor.options.at(-1) === "New category…"
        && editor.star === "☆" && editor.starEnabled, editor);
    await page.locator(".bl-overlay .bl-category-select").selectOption(heroesId);
    await until(([key, id]) => window.__cat.row(key, id), [heroesKey, ids.blue]);
    await page.locator(".bl-overlay .bl-editor-head .bl-star").click();
    await until((id) => window.__cat.row("favorites", id), ids.blue);
    await settled();
    editor = await cat(() => window.__cat.editor());
    let stored = await server();
    check("choosing a category and starring are saved at once, and the unsaved note stays",
        editor.note === "not saved yet" && editor.state !== "Saved" && editor.category === ALLIES && editor.star === "★"
        && JSON.stringify(stored[ids.blue]) === JSON.stringify([heroesId, true]), { editor, stored: stored[ids.blue] });
    const bundleFile = await api("GET", `/bundles/${ids.blue}`);
    check("neither changes the bundle (same revision)", bundleFile.revision === 1, bundleFile.revision);
    groups = await cat(() => window.__cat.groups());
    const selected = await cat(() => window.__cat.selected());
    check("a starred bundle shows in Favorites and in its category, selected in both",
        groups.find((g) => g.key === "favorites").rows.includes(ids.blue)
        && groups.find((g) => g.key === heroesKey).rows.includes(ids.blue)
        && selected.length === 2 && selected.every((id) => id === ids.blue), { selected });
    await button("Revert", page.locator(".bl-overlay .bl-editor")).click();
    editor = await cat(() => window.__cat.editor());
    check("Revert undoes the note but leaves the category and the star",
        editor.note === "" && editor.category === ALLIES && editor.star === "★", editor);
    await shot("category-list.png");

    // ---- dragging -----------------------------------------------------------------------
    let lit = await cat(([id, key]) => window.__cat.drag("uncategorized", id, key), [ids.green, heroesKey]);
    await until(([key, id]) => window.__cat.row(key, id), [heroesKey, ids.green]);
    lit = lit && await cat((id) => window.__cat.drag("uncategorized", id, "favorites"), ids.red);
    await until((id) => window.__cat.row("favorites", id), ids.red);
    await settled();
    stored = await server();
    check("dropping a bundle on a category moves it; on Favorites stars it",
        lit && JSON.stringify(stored[ids.green]) === JSON.stringify([heroesId, false])
        && JSON.stringify(stored[ids.red]) === JSON.stringify([null, true]), { lit, green: stored[ids.green], red: stored[ids.red] });
    await cat(([id, key]) => window.__cat.drag(key, id, "uncategorized"), [ids.green, heroesKey]);
    await until((id) => window.__cat.row("uncategorized", id), ids.green);
    const outside = await cat(() => window.__cat.dropFile("uncategorized"));
    await settled();
    stored = await server();
    check("dropping on Uncategorized takes the category away; a file from outside is not a move",
        stored[ids.green][0] === null && !outside, { green: stored[ids.green], outside });
    const attentionTarget = await cat(() => !!window.__cat.groupOf("attention"));
    check("Needs attention is not shown while nothing needs it", !attentionTarget);

    // ---- stars in the list ------------------------------------------------------------
    await page.locator(`.bl-overlay .bl-group[data-group="uncategorized"] .bl-list-item[data-id="${ids.green}"] .bl-star`).click();
    await until((id) => window.__cat.row("favorites", id), ids.green);
    editor = await cat(() => window.__cat.editor());
    check("a row's star does not open the bundle", editor.name === `${PREFIX} Blue`, editor.name);
    await cat((id) => {
        for (let i = 0; i < 3; i++) {
            [...document.querySelectorAll(".bl-overlay .bl-group[data-group='uncategorized'] .bl-list-item")]
                .find((r) => r.dataset.id === id).querySelector(".bl-star").click();
        }
    }, ids.green);
    await until((id) => !window.__cat.row("favorites", id), ids.green);
    await settled();
    stored = await server();
    check("quick star clicks go out in order: the last one counts", stored[ids.green][1] === false, stored[ids.green]);

    // ---- collapsing ---------------------------------------------------------------------
    await page.locator(`.bl-overlay .bl-group[data-group="${heroesKey}"] .bl-group-toggle`).click();
    let heroesGroup = await cat((key) => window.__cat.group(key), heroesKey);
    check("a group collapses", heroesGroup.collapsed && heroesGroup.sign === "+", heroesGroup);
    await page.keyboard.press("Escape");
    await overlay.waitFor({ state: "detached" });
    await openLibrary();
    heroesGroup = await cat((key) => window.__cat.group(key), heroesKey);
    check("it stays collapsed when the library opens again", heroesGroup.collapsed, heroesGroup);

    // ---- searching ----------------------------------------------------------------------
    await page.locator(".bl-overlay .bl-search").fill(`${PREFIX} Blue`);
    await until(() => !window.__cat.group("uncategorized")); // the search has answered
    groups = await cat(() => window.__cat.groups());
    check("while searching every group with a match is expanded, and the rest are hidden",
        JSON.stringify(groups.map((g) => [g.key, g.rows, g.collapsed, g.toggle]))
        === JSON.stringify([["favorites", [ids.blue], false, false], [heroesKey, [ids.blue], false, false]]), groups);
    await page.locator(".bl-overlay .bl-search").fill("");
    await until(() => window.__cat.group("uncategorized"));
    await page.locator(".bl-overlay .bl-search").fill(ALLIES);
    await until(() => !window.__cat.group("uncategorized"));
    groups = await cat(() => window.__cat.groups());
    check("a search finds bundles by their category's name",
        groups.find((g) => g.key === heroesKey)?.rows.join() === ids.blue, groups.map((g) => [g.key, g.rows]));
    await page.locator(".bl-overlay .bl-search").fill("");
    await until((key) => window.__cat.group(key)?.collapsed, heroesKey);
    await page.locator(`.bl-overlay .bl-group[data-group="${heroesKey}"] .bl-group-toggle`).click();

    // ---- New category… in the editor ------------------------------------------------------
    await page.locator(`.bl-overlay .bl-group[data-group="favorites"] .bl-list-item[data-id="${ids.blue}"]`).click();
    await until(() => document.querySelector(".bl-overlay .bl-category-select"));
    await page.locator(".bl-overlay .bl-category-select").selectOption("new");
    await page.locator(".bl-overlay .bl-ask-input").fill(HEROES);
    await page.keyboard.press("Enter");
    const newKey = await until((name) => window.__cat.categoryKey(name), HEROES)
        && await cat((name) => window.__cat.categoryKey(name), HEROES);
    await until(([key, id]) => window.__cat.row(key, id), [newKey, ids.blue]);
    editor = await cat(() => window.__cat.editor());
    check("New category… in the editor makes one and puts the bundle in it", editor.category === HEROES, editor);

    // ---- a new bundle goes in its category on its first save ---------------------------------
    await button("+ New bundle").click();
    await page.locator(".bl-overlay .bl-name-input").fill(`${PREFIX} Fresh`);
    await page.locator(".bl-overlay .bl-category-select").selectOption(heroesId);
    editor = await cat(() => window.__cat.editor());
    const starOfDraft = !editor.starEnabled;
    await button("Save", page.locator(".bl-overlay .bl-editor")).click();
    await until(() => document.querySelector(".bl-overlay .bl-state")?.textContent === "Saved");
    let fresh = (await api("GET", "/bundles")).bundles.find((b) => b.name === `${PREFIX} Fresh`);
    check("a new bundle can be given a category before it is saved (no star until then)",
        starOfDraft && fresh?.category === heroesId, { starOfDraft, category: fresh?.category });

    const gone = await api("POST", "/categories", { name: "[test] Gone" });
    await page.keyboard.press("Escape");
    await overlay.waitFor({ state: "detached" });
    await openLibrary();
    await button("+ New bundle").click();
    await page.locator(".bl-overlay .bl-name-input").fill(`${PREFIX} Partly`);
    await page.locator(".bl-overlay .bl-category-select").selectOption(gone.id);
    await api("DELETE", `/categories/${gone.id}`); // behind the page's back
    await button("Save", page.locator(".bl-overlay .bl-editor")).click();
    await until(() => document.querySelector(".bl-overlay .bl-state")?.textContent === "Saved");
    const partly = await cat(() => window.__cat.status());
    fresh = (await api("GET", "/bundles")).bundles.filter((b) => b.name === `${PREFIX} Partly`);
    editor = await cat(() => window.__cat.editor());
    check("when only the placing fails, the bundle is saved once and the page says so",
        fresh.length === 1 && fresh[0].category === null && partly.error && partly.text.startsWith("Saved, but not put in its category")
        && editor.category === "No category", { partly, made: fresh.length });

    // ---- the trash keeps the place ------------------------------------------------------------
    const trashed = await api("GET", `/bundles/${ids.blue}`);
    await page.keyboard.press("Escape");
    await overlay.waitFor({ state: "detached" });
    await api("DELETE", `/bundles/${ids.blue}?expected_revision=${trashed.revision}`);
    await openLibrary();
    await page.locator(".bl-overlay .bl-trash-button").click();
    await until((id) => document.querySelector(`.bl-overlay .bl-trash-item[data-id="${id}"]`), ids.blue);
    const trashRow = await ev((id) => document.querySelector(`.bl-overlay .bl-trash-item[data-id="${id}"] .bl-list-sub`)
        .textContent, ids.blue);
    check("the trash says where a bundle goes back to", trashRow.includes(`back to ${HEROES}`) && trashRow.includes("★"),
        trashRow);
    await button("Restore", page.locator(`.bl-overlay .bl-trash-item[data-id="${ids.blue}"]`)).click();
    await until(([key, id]) => window.__cat.row(key, id) && window.__cat.row("favorites", id), [newKey, ids.blue]);
    check("restored, it is in its category with its star again",
        !!(await cat(([key, id]) => window.__cat.row(key, id) && window.__cat.row("favorites", id), [newKey, ids.blue])));

    // ---- the node's dropdown and the sidebar ----------------------------------------------------
    await page.keyboard.press("Escape");
    await overlay.waitFor({ state: "detached" });
    const dropdown = await ev(async () => {
        const b = window.__bl;
        const node = b.add("BundleLibraryLoad", [100, 100]);
        await b.waitFor(() => node.bundlePanel?.select.querySelector("optgroup"), 5000);
        const result = [...node.bundlePanel.select.children].map((child) => (child.tagName === "OPTGROUP"
            ? [child.label, [...child.children].map((o) => o.value)] : child.value));
        b.app.graph.remove(node);
        return result;
    });
    const groupOf = (label) => dropdown.find((entry) => Array.isArray(entry) && entry[0] === label)?.[1] ?? [];
    check("the node's dropdown groups the bundles: ★ Favorites first, a starred bundle also in its category",
        dropdown[0] === "" && dropdown[1]?.[0] === "★ Favorites" && groupOf("★ Favorites").includes(ids.blue)
        && groupOf(HEROES).includes(ids.blue) && groupOf("Uncategorized").includes(ids.green)
        && !dropdown.some((entry) => Array.isArray(entry) && entry[0].includes("Needs attention")),
        dropdown.map((entry) => (Array.isArray(entry) ? entry[0] : entry)));
    await command("Workspace.ToggleSidebarTab.bundle-library");
    await until(() => document.querySelector(".bl-sidebar-group"));
    const sidebar = await ev(() => [...document.querySelectorAll(".bl-sidebar-list > *")].map((e) => e.textContent));
    await command("Workspace.ToggleSidebarTab.bundle-library");
    const after = (heading) => sidebar.slice(sidebar.indexOf(heading) + 1);
    check("the sidebar lists the bundles under the same headings",
        sidebar[0] === "★ Favorites" && after(HEROES).includes(`${PREFIX} Blue`) && sidebar.includes("Uncategorized"),
        sidebar.slice(0, 12));

    // ---- deleting a category ------------------------------------------------------------------
    await openLibrary();
    await page.locator(`.bl-overlay .bl-group[data-group="${newKey}"] .bl-group-menu`).click();
    await menuItem("Delete…").click();
    layer = await cat(() => window.__cat.layer());
    check("deleting a category says how many bundles move to Uncategorized",
        layer?.title === `Delete the category '${HEROES}'?` && layer.text[0] === "Its bundle moves to Uncategorized. "
        + "The bundles themselves are not changed.", layer);
    await button("Delete category", layerBox).click();
    await until((key) => !window.__cat.group(key), newKey);
    await until((id) => window.__cat.row("uncategorized", id), ids.blue);
    stored = await server();
    check("deleted, its bundle is uncategorized and keeps its star", JSON.stringify(stored[ids.blue]) === "[null,true]",
        stored[ids.blue]);
    await page.keyboard.press("Escape");
    await overlay.waitFor({ state: "detached" });

    // ---- Needs attention, and a library with nothing else ---------------------------------------
    const onlyBroken = (route) => (route.request().method() === "GET"
        ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
            bundles: [], categories: [], organization: { revision: 0, state: "missing" },
            errors: [{ file: "bundles/00000000-0000-4000-8000-000000000000.json", id: "00000000-0000-4000-8000-000000000000",
                code: "corrupt", error: "not valid JSON" }] }) })
        : route.fallback());
    await page.route("**/bundle-library/v1/bundles", onlyBroken);
    await openLibrary();
    groups = await cat(() => window.__cat.groups());
    const emptyState = await ev(() => document.querySelector(".bl-overlay .bl-modal-list > .bl-empty-state")?.textContent ?? null);
    const attention = groups.find((g) => g.key === "attention");
    const purge = await ev(() => [...document.querySelectorAll(".bl-overlay .bl-error-item button")].map((b) => b.textContent));
    check("a library with only a file that cannot be read shows it under Needs attention, not as empty",
        groups[0]?.key === "attention" && attention.name === "⚠ Needs attention"
        && attention.rows[0] === "bundles/00000000-0000-4000-8000-000000000000.json" && emptyState === null
        && JSON.stringify(purge) === JSON.stringify(["Delete forever"]), { groups, emptyState, purge });
    await page.keyboard.press("Escape");
    await overlay.waitFor({ state: "detached" });
    await page.unroute("**/bundle-library/v1/bundles", onlyBroken);

    // ---- an organization this version cannot change ------------------------------------------------
    const newer = async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        const answer = await route.fetch();
        const body = await answer.json();
        body.organization = { ...body.organization, state: "newer_version" };
        body.errors = [...body.errors, { file: "organization.json", id: null, code: "newer_version",
            error: "saved by a newer Bundle Library; categories and favorites cannot be changed" }];
        await route.fulfill({ response: answer, json: body });
    };
    await page.route("**/bundle-library/v1/bundles", newer);
    await openLibrary();
    await page.locator(`.bl-overlay .bl-group[data-group="uncategorized"] .bl-list-item[data-id="${ids.red}"]`).click();
    await until(() => document.querySelector(".bl-overlay .bl-category-select"));
    const locked = await ev(() => ({
        newCategory: !document.querySelector(".bl-overlay .bl-new-category").disabled,
        stars: [...document.querySelectorAll(".bl-overlay .bl-list-item .bl-star")].filter((s) => !s.disabled).length,
        draggable: document.querySelectorAll(".bl-overlay .bl-list-item[draggable='true']").length,
        menus: document.querySelectorAll(".bl-overlay .bl-group-menu").length,
        attention: [...document.querySelectorAll(".bl-overlay .bl-group.attention .bl-error-item")].map((r) => r.dataset.file),
    }));
    editor = await cat(() => window.__cat.editor());
    check("when organization.json cannot be changed by this version, nothing offers to change it",
        !locked.newCategory && locked.stars === 0 && locked.draggable === 0 && locked.menus === 0
        && locked.attention.includes("organization.json") && !editor.starEnabled && !editor.selectEnabled, { locked, editor });
    await page.keyboard.press("Escape");
    await overlay.waitFor({ state: "detached" });
    await page.unroute("**/bundle-library/v1/bundles", newer);

    await finish({ expectRemoved: 7 }); // five made here, Fresh and Partly from the editor
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
