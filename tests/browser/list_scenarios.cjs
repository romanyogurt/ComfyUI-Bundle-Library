// Browser scenarios for the library list's tools (Phase 7.7): Favorites that
// always shows, Uncategorized that hides when empty, the place under the list
// to drop a bundle out of its category (and that it goes away however a drag
// ends), the sort and tag menus with the keyboard, names shown as code, and
// the picker's title. Set-up and safety notes are in harness.cjs.
const { startSession } = require("./harness.cjs");

const PREFIX = "[test] List";
const CATEGORY = "[test] List shelf";
const MODULE = "/extensions/ComfyUI-Bundle-Library";

const LIST_HELPERS = () => {
    const $ = (selector, root = document) => root.querySelector(selector);
    const groupOf = (key) => [...document.querySelectorAll(".bl-overlay .bl-group")].find((g) => g.dataset.group === key);
    window.__list = {
        groupOf,
        groups: () => [...document.querySelectorAll(".bl-overlay .bl-group")].map((g) => ({
            key: g.dataset.group,
            sign: $(".bl-group-sign", g).textContent,
            collapsed: $(".bl-group-rows", g).hidden,
            rows: [...g.querySelectorAll(".bl-list-item")].map((r) => r.dataset.id),
            empty: $(".bl-group-empty", g)?.textContent ?? null,
        })),
        group(key) { return this.groups().find((g) => g.key === key) ?? null; },
        row: (key, id) => [...(groupOf(key)?.querySelectorAll(".bl-list-item") ?? [])].find((r) => r.dataset.id === id),
        emptyState: () => $(".bl-overlay .bl-modal-list > .bl-empty-state")?.textContent ?? null,
        zone: () => !$(".bl-overlay .bl-drop-zone").hidden,
        footerHeight: () => $(".bl-overlay .bl-side-footer").getBoundingClientRect().height,
        firstRowTop: () => $(".bl-overlay .bl-list-item")?.getBoundingClientRect().top ?? null,
        openMenu: () => $(".bl-overlay .bl-menu:not([hidden])"),
        focused: () => {
            const a = document.activeElement;
            return { className: a?.className ?? null, text: a?.textContent ?? null, label: a?.getAttribute("aria-label") ?? null };
        },
        chip: () => $(".bl-overlay .bl-filter-chips:not([hidden])")?.textContent ?? null,
        /** dragstart on a row, as the browser sends it; the DataTransfer to carry on with. */
        startDrag(key, id) {
            this.data = new DataTransfer();
            this.row(key, id).dispatchEvent(new DragEvent("dragstart", { dataTransfer: this.data, bubbles: true, cancelable: true }));
        },
        dropOnZone() {
            const zone = $(".bl-overlay .bl-drop-zone");
            for (const type of ["dragenter", "dragover", "drop"]) {
                zone.dispatchEvent(new DragEvent(type, { dataTransfer: this.data, bubbles: true, cancelable: true }));
            }
        },
    };
};

(async () => {
    const session = await startSession("list");
    const { page, ev, check, shot, finish } = session;
    const overlay = page.locator(".bl-overlay");
    const button = (name, scope = overlay) => scope.getByRole("button", { name, exact: true });
    const until = (fn, arg, timeout = 10000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
    const api = (method, route, body) => ev(([m, r, b]) => window.__bl.request(m, r, b), [method, route, body ?? null]);
    const list = (fn, arg) => ev(fn, arg);
    const command = (id) => ev((c) => window.__bl.app.extensionManager.command.execute(c), id);
    const openLibrary = async () => {
        await command("BundleLibrary.Open");
        await overlay.waitFor();
        await page.evaluate(LIST_HELPERS);
        await until(() => document.querySelector(".bl-overlay .bl-group"));
    };
    const closeLibrary = async () => {
        await page.keyboard.press("Escape");
        await overlay.waitFor({ state: "detached" });
    };
    const server = async (id) => (await api("GET", "/bundles")).bundles.find((b) => b.id === id);
    /** The bundle once the server has `category` for it (changes go out one after another), or as it is after 5 s. */
    const settledTo = async (id, category) => {
        let bundle;
        for (let i = 0; i < 50; i++) {
            bundle = await server(id);
            if (bundle.category === category) break;
            await page.waitForTimeout(100);
        }
        return bundle;
    };

    const shelf = await api("POST", "/categories", { name: CATEGORY });
    const make = async (name, extra = {}) => (await api("POST", "/bundles", {
        name, tags: ["test"], fields: [{ name: "prompt", type: "text", value: name }], ...extra })).id;
    const ids = {
        plain: await make(`${PREFIX} Plain`, { tags: ["test", "listtag"] }),
        placed: await make(`${PREFIX} Placed`, { category: shelf.id }),
        // the most tags a bundle may have: the tag menu gets long
        tagged: await make(`${PREFIX} Tagged`, { category: shelf.id,
            tags: Array.from({ length: 20 }, (_, i) => `[test] list tag ${String(i).padStart(2, "0")}`) }),
    };
    const shelfKey = `category:${shelf.id}`;

    // ---- the groups ---------------------------------------------------------------------
    const emptyLibrary = (route) => (route.request().method() === "GET"
        ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
            bundles: [], errors: [], categories: [], organization: { revision: 0, state: "missing" } }) })
        : route.fallback());
    await page.route("**/bundle-library/v1/bundles", emptyLibrary);
    await openLibrary();
    let groups = await list(() => window.__list.groups());
    let emptyState = await list(() => window.__list.emptyState());
    check("an empty library shows Favorites, and below it how to start and the examples (0.0.33)",
        JSON.stringify(groups.map((g) => [g.key, g.empty])) === '[["favorites",null]]'
        && emptyState === "No bundles yet. Create one with + New bundle." + "Import the examples"
            + "Example bundles to try, some made for the z-image-turbo workflow among ComfyUI's templates.", { groups, emptyState });
    await closeLibrary();
    await page.unroute("**/bundle-library/v1/bundles", emptyLibrary);

    const allPlaced = async (route) => {
        if (route.request().method() !== "GET" || new URL(route.request().url()).search) return route.fallback();
        const answer = await route.fetch();
        const body = await answer.json();
        body.bundles = body.bundles.map((b) => ({ ...b, category: shelf.id }));
        await route.fulfill({ response: answer, json: body });
    };
    await page.route("**/bundle-library/v1/bundles", allPlaced);
    await openLibrary();
    groups = await list(() => window.__list.groups());
    check("with every bundle in a category, Uncategorized is not shown; Favorites is",
        groups.some((g) => g.key === "favorites") && !groups.some((g) => g.key === "uncategorized")
        && groups.find((g) => g.key === shelfKey)?.rows.includes(ids.plain), groups.map((g) => g.key));
    await closeLibrary();
    await page.unroute("**/bundle-library/v1/bundles", allPlaced);

    await openLibrary();
    groups = await list(() => window.__list.groups());
    const favorites = groups.find((g) => g.key === "favorites");
    check("Favorites shows even with no starred bundle, with a hint",
        favorites && (favorites.rows.length || favorites.empty === "Star a bundle (☆) to list it here as well."), favorites);
    await page.locator(".bl-overlay .bl-search").fill("zzqx no such bundle");
    await until(() => window.__list.emptyState() === "No bundles match.");
    groups = await list(() => window.__list.groups());
    check("a search with no match keeps Favorites and says so below it",
        JSON.stringify(groups.map((g) => [g.key, g.empty])) === '[["favorites",null]]', groups);
    await page.locator(".bl-overlay .bl-search").fill("");
    await until(() => !window.__list.emptyState());

    // Favorites that becomes empty while collapsed stays collapsed.
    await page.locator(`.bl-overlay .bl-group[data-group="uncategorized"] .bl-list-item[data-id="${ids.plain}"] .bl-star`).click();
    await until((id) => window.__list.row("favorites", id), ids.plain);
    await page.locator('.bl-overlay .bl-group[data-group="favorites"] .bl-group-toggle').click();
    await page.locator(`.bl-overlay .bl-group[data-group="uncategorized"] .bl-list-item[data-id="${ids.plain}"] .bl-star`).click();
    await until((id) => !window.__list.group("favorites").rows.includes(id), ids.plain);
    let fav = await list(() => window.__list.group("favorites"));
    await closeLibrary();
    await openLibrary();
    const favAgain = await list(() => window.__list.group("favorites"));
    check("a collapsed Favorites stays, collapsed, when its last bundle is unstarred and the library opens again",
        fav?.collapsed && fav.sign === "+" && favAgain?.collapsed, { fav, favAgain });
    await page.locator('.bl-overlay .bl-group[data-group="favorites"] .bl-group-toggle').click();

    // ---- dropping a bundle out of its category ---------------------------------------------
    // A search leaves only the test bundles: Plain is the only uncategorized one.
    await page.locator(".bl-overlay .bl-search").fill(PREFIX);
    await until((id) => window.__list.row("uncategorized", id), ids.plain);
    const before = await list(() => ({ footer: window.__list.footerHeight(), top: window.__list.firstRowTop() }));
    await list(([key, id]) => window.__list.startDrag(key, id), [shelfKey, ids.placed]);
    const during = await list(() => ({ zone: window.__list.zone(), footer: window.__list.footerHeight(), top: window.__list.firstRowTop() }));
    check("dragging a bundle that is in a category shows the place under the list, and nothing moves",
        during.zone && during.footer === before.footer && during.top === before.top, { before, during });
    await list(([key, id]) => window.__list.row(key, id).dispatchEvent(new DragEvent("dragend", { bubbles: true })),
        [shelfKey, ids.placed]);
    check("it goes away when the drag ends", !(await list(() => window.__list.zone())));
    await list(([key, id]) => window.__list.startDrag(key, id), [`uncategorized`, ids.plain]);
    check("an uncategorized bundle has nothing to leave: no place is shown", !(await list(() => window.__list.zone())));
    await list(([key, id]) => window.__list.row(key, id).dispatchEvent(new DragEvent("dragend", { bubbles: true })),
        ["uncategorized", ids.plain]);

    // the last uncategorized bundle goes into the category, then comes back by the place under the list
    let lit = await list(([id, to]) => {
        window.__list.startDrag("uncategorized", id);
        const target = window.__list.groupOf(to);
        for (const type of ["dragenter", "dragover", "drop"]) {
            target.dispatchEvent(new DragEvent(type, { dataTransfer: window.__list.data, bubbles: true, cancelable: true }));
        }
        return true;
    }, [ids.plain, shelfKey]);
    await until(([key, id]) => window.__list.row(key, id) && !window.__list.group("uncategorized"), [shelfKey, ids.plain]);
    groups = await list(() => window.__list.groups());
    const gone = !groups.some((g) => g.key === "uncategorized");
    await list(([key, id]) => window.__list.startDrag(key, id), [shelfKey, ids.plain]);
    await list(() => window.__list.dropOnZone());
    await until((id) => window.__list.row("uncategorized", id), ids.plain);
    let stored = await settledTo(ids.plain, null);
    check("moving the last uncategorized bundle hides Uncategorized; dropping it under the list brings it back",
        lit && gone && stored.category === null && !(await list(() => window.__list.zone())), { gone, category: stored.category });

    // a real mouse drag onto the place under the list
    const placedRow = page.locator(`.bl-overlay .bl-group[data-group="${shelfKey}"] .bl-list-item[data-id="${ids.placed}"]`);
    let rowBox = null;
    for (let i = 0; i < 20 && !rowBox; i++) { // the list may be drawn again just then (the drop's list read)
        await placedRow.waitFor({ state: "visible" });
        rowBox = await placedRow.boundingBox();
    }
    await page.mouse.move(rowBox.x + 60, rowBox.y + rowBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(rowBox.x + 70, rowBox.y + rowBox.height / 2 + 10, { steps: 5 });
    const shown = await until(() => window.__list.zone(), null, 3000);
    const zoneBox = await page.locator(".bl-overlay .bl-drop-zone").boundingBox();
    await page.mouse.move(zoneBox.x + zoneBox.width / 2, zoneBox.y + zoneBox.height / 2, { steps: 10 });
    await page.mouse.up();
    await until((id) => window.__list.row("uncategorized", id), ids.placed);
    stored = await settledTo(ids.placed, null);
    check("a mouse drag onto that place takes the bundle out of its category",
        shown && stored.category === null && !(await list(() => window.__list.zone())), { shown, category: stored.category });
    await shot("list-dropped.png");
    await api("PUT", `/bundles/${ids.placed}/category`, { category: shelf.id });
    await closeLibrary();
    await openLibrary();
    await page.locator(".bl-overlay .bl-search").fill(PREFIX);
    await until(([key, id]) => window.__list.row(key, id), [shelfKey, ids.placed]);

    // a mouse drag dropped where nothing takes it
    const again = await page.locator(`.bl-overlay .bl-group[data-group="${shelfKey}"] .bl-list-item[data-id="${ids.placed}"]`).boundingBox();
    const paneBox = await page.locator(".bl-overlay .bl-modal-editor").boundingBox();
    await page.mouse.move(again.x + 60, again.y + again.height / 2);
    await page.mouse.down();
    await page.mouse.move(again.x + 70, again.y + again.height / 2 + 10, { steps: 5 });
    await until(() => window.__list.zone(), null, 3000);
    await page.mouse.move(paneBox.x + paneBox.width / 2, paneBox.y + paneBox.height / 2, { steps: 10 });
    await page.mouse.up();
    await until(() => !window.__list.zone(), null, 3000);
    stored = await server(ids.placed);
    check("a drag dropped elsewhere changes nothing and the place goes away",
        stored.category === shelf.id && !(await list(() => window.__list.zone())), stored.category);

    // the row it started from is drawn again (the list changed): the place goes away too
    await list(([key, id]) => window.__list.startDrag(key, id), [shelfKey, ids.placed]);
    await page.locator(".bl-overlay .bl-search").fill(`${PREFIX} Placed`);
    await until(() => !window.__list.zone(), null, 3000);
    check("when the list is drawn again during a drag, the place goes away", !(await list(() => window.__list.zone())));
    // a drag whose row went away sends no dragend; the next pointer move ends it
    await list(([key, id]) => window.__list.startDrag(key, id), [shelfKey, ids.placed]);
    await list(([key, id]) => window.__list.row(key, id).remove(), [shelfKey, ids.placed]);
    await page.waitForTimeout(400);
    await page.mouse.move(10, 10);
    await page.mouse.move(20, 20);
    check("with no dragend, the next pointer move ends the drag", await until(() => !window.__list.zone(), null, 3000));
    await page.locator(".bl-overlay .bl-search").fill(PREFIX);
    await until(([key, id]) => window.__list.row(key, id), [shelfKey, ids.placed]);
    await list(([key, id]) => window.__list.startDrag(key, id), [shelfKey, ids.placed]);
    await page.keyboard.press("Escape");
    check("Esc ends a drag that is left over, and keeps the library open",
        !(await list(() => window.__list.zone())) && await overlay.isVisible());
    await page.locator(".bl-overlay .bl-search").fill("");

    // ---- the menus with the keyboard ----------------------------------------------------------
    await page.locator(".bl-overlay .bl-sort-button").focus();
    await page.keyboard.press("ArrowDown");
    let focused = await list(() => window.__list.focused());
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    const sorted = await list(() => ({ focused: window.__list.focused(), open: !!window.__list.openMenu() }));
    check("the sort menu opens on ↓ at the current choice; ↓ and Enter choose, and the focus goes back to its button",
        focused.text.includes("Name A→Z") && !sorted.open && sorted.focused.label === "Sort: name Z→A", { focused, sorted });
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Home");
    await page.keyboard.press("Enter");
    check("Home goes to the first choice", (await list(() => window.__list.focused())).label === "Sort: name A→Z");

    await page.locator(".bl-overlay .bl-tag-button").focus();
    await page.keyboard.press("Enter");
    focused = await list(() => window.__list.focused());
    const menuBox = await list(() => {
        const r = window.__list.openMenu().getBoundingClientRect();
        const items = window.__list.openMenu().querySelector(".bl-menu-list");
        return { top: r.top, bottom: r.bottom, height: innerHeight, scrolls: items.scrollHeight > items.clientHeight };
    });
    check("the tag menu opens on Enter with its search box focused, inside the window and scrolling when long",
        focused.className.includes("bl-menu-search") && menuBox.top >= 0 && menuBox.bottom <= menuBox.height && menuBox.scrolls,
        { focused, menuBox });
    await shot("list-tag-menu.png");
    await page.keyboard.type("listta");
    const narrowed = await list(() => [...window.__list.openMenu().querySelectorAll(".bl-menu-item[role=menuitemradio]")]
        .map((i) => i.dataset.value)); // the tag choices; "Manage tags…" stays below them
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await until(() => window.__list.chip());
    check("typing narrows the tags; ↓ and Enter set the filter, shown as a chip",
        JSON.stringify(narrowed) === '["","listtag"]' && (await list(() => window.__list.chip())) === "Tag: listtag×"
        && (await list(() => window.__list.groups().flatMap((g) => g.rows))).every((id) => id === ids.plain), narrowed);
    await page.locator(".bl-overlay .bl-tag-button").click();
    await page.keyboard.press("Escape");
    const afterEsc = await list(() => ({ open: !!window.__list.openMenu(), focused: window.__list.focused() }));
    check("Esc closes the menu only and gives the focus back to its button",
        !afterEsc.open && await overlay.isVisible() && afterEsc.focused.className.includes("bl-tag-button"), afterEsc);
    await page.getByRole("button", { name: "Clear the tag filter" }).click();
    check("the chip's × clears the filter", !(await list(() => window.__list.chip())));
    const labels = await list(() => ["bl-new-category", "bl-sort-button", "bl-tag-button", "bl-trash-button"]
        .map((c) => document.querySelector(`.bl-overlay .${c}`)).map((b) => [b.getAttribute("aria-label"), b.title]));
    check("every tool has a name and a tip", labels.every(([label, title]) => label && title), labels);
    await closeLibrary();

    // ---- names as code, safely -----------------------------------------------------------------
    const safe = await ev(async (module) => {
        const { codeList } = await import(`${module}/dom.js`);
        const box = document.createElement("div");
        box.append("⚠ no ", ...codeList(["<img src=x onerror=window.__pwned=1>", "use frame"]));
        document.body.append(box);
        await new Promise((r) => setTimeout(r, 200));
        const result = { text: box.textContent, codes: box.querySelectorAll("code.bl-code").length,
            images: box.querySelectorAll("img").length, pwned: window.__pwned ?? null };
        box.remove();
        return result;
    }, MODULE);
    check("a name that looks like HTML is shown as text in code",
        safe.text === "⚠ no <img src=x onerror=window.__pwned=1>, use frame" && safe.codes === 2 && safe.images === 0
        && safe.pwned === null, safe);

    // ---- the picker ----------------------------------------------------------------------------
    await ev(async (module) => {
        const { openLibrary } = await import(`${module}/library_modal.js`);
        openLibrary({ onPick: () => {} });
    }, MODULE);
    await overlay.waitFor();
    await page.evaluate(LIST_HELPERS);
    await until(() => document.querySelector(".bl-overlay .bl-group"));
    const picker = await ev(() => ({ title: document.querySelector(".bl-overlay .bl-modal-title").textContent,
        favorites: !!window.__list.group("favorites"), pick: !!document.querySelector(".bl-overlay .bl-pick") }));
    check("the picker is titled Bundle Library and shows Favorites too",
        picker.title === "Bundle Library" && picker.favorites && picker.pick, picker);
    await closeLibrary();

    await finish({ expectRemoved: 3 });
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
