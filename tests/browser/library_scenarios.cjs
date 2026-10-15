// Browser scenarios for the library modal (Phase 4): the ways to open it,
// making and editing a bundle through the UI, the list, changes made
// elsewhere, the Load Bundle node's picker and a Nodes 2.0 smoke test.
// Set-up and safety notes are in harness.cjs.
const crypto = require("crypto");
const { startSession } = require("./harness.cjs");

const UI_NAME = "[test] UI made";
const TEXT = "첫 줄 first line\n\n  앞뒤 공백과 빈 줄을 그대로 둔다  \n";
const NOTE = "Made by the browser test.";
const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

// Read-outs of the modal. Installed once: this scenario never reloads the page.
const LIB_HELPERS = () => {
    const $ = (selector, root = document) => root.querySelector(selector);
    const shown = (element) => (element && !element.hidden ? element.textContent : null);
    window.__lib = {
        open: () => !!$(".bl-overlay"),
        focusInside: () => !!$(".bl-overlay")?.contains(document.activeElement),
        state() {
            const editor = $(".bl-overlay .bl-editor");
            if (!editor) return null;
            const head = [...$(".bl-editor-head", editor).querySelectorAll(":scope > button, :scope > .bl-menu-wrap > button")];
            return {
                name: $(".bl-name-input", editor).value,
                state: $(".bl-state", editor).textContent,
                buttons: Object.fromEntries(head.map((b) => [b.textContent, !b.disabled])),
                saveTitle: head.find((b) => b.textContent === "Save").title,
                tags: [...editor.querySelectorAll(".bl-chip")].map((chip) => chip.firstChild.textContent),
                note: $(".bl-note-input", editor).value,
                fields: [...editor.querySelectorAll(".bl-field")].map((card) => ({
                    name: $(".bl-field-name", card).value,
                    type: $(".bl-badge", card).textContent,
                    warn: shown($(".bl-warn", card)),
                    error: shown($(".bl-error", card)),
                    thumb: $("img.bl-image-thumb", card)?.getAttribute("src") ?? null,
                    text: $("textarea.bl-value-text", card)?.value ?? null,
                    checked: $("input[type=checkbox]", card)?.checked ?? null,
                    number: $("input.bl-number", card)?.value ?? null,
                    count: $(".bl-count", card)?.textContent ?? null,
                    up: !$("button[title='Move up']", card).disabled,
                    down: !$("button[title='Move down']", card).disabled,
                })),
            };
        },
        items: () => [...document.querySelectorAll(".bl-overlay .bl-list-item")].map((item) => ({
            id: item.dataset.id,
            name: $(".bl-list-name", item).textContent,
            warn: $(".bl-list-warn", item)?.textContent ?? null,
            selected: item.classList.contains("selected"),
        })),
        selected() { return this.items().find((i) => i.selected)?.id ?? null; },
        empty: () => $(".bl-overlay .bl-modal-list .bl-empty-state")?.textContent ?? null,
        pane: () => $(".bl-overlay .bl-modal-editor > .bl-empty-state")?.textContent ?? null,
        layer() {
            const layer = $(".bl-overlay .bl-layer");
            if (!layer) return null;
            return {
                title: $(".bl-confirm-title", layer)?.textContent ?? null,
                buttons: [...layer.querySelectorAll("button")].map((b) => b.textContent),
                viewer: !!$(".bl-viewer", layer),
            };
        },
        status: () => ({ text: $(".bl-overlay .bl-status")?.textContent ?? null, error: !!$(".bl-overlay .bl-status.error") }),
        footer: () => ({
            title: $(".bl-overlay .bl-modal-title")?.textContent ?? null,
            pick: $(".bl-overlay .bl-pick") ? !$(".bl-overlay .bl-pick").disabled : null,
            hint: $(".bl-overlay .bl-pick-hint")?.textContent ?? null,
        }),
        card: (index) => document.querySelectorAll(".bl-overlay .bl-field")[index],
        /** Drop `files` on field card `index`; true when the card lit up on dragover. */
        drop(index, files) {
            const card = this.card(index);
            const data = new DataTransfer();
            for (const file of files) data.items.add(file);
            card.dispatchEvent(new DragEvent("dragover", { dataTransfer: data, bubbles: true, cancelable: true }));
            const lit = card.classList.contains("drop-target");
            card.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
            return lit;
        },
        /** Whether a beforeunload event would make the browser ask. */
        unloadAsks() {
            const event = new Event("beforeunload", { cancelable: true });
            window.dispatchEvent(event);
            return event.defaultPrevented;
        },
        // What got past the modal: keydowns reaching window, pastes and drops reaching document.
        leaks: { keys: [], events: [] },
        takeLeaks() {
            const leaks = { keys: [...this.leaks.keys], events: [...this.leaks.events] };
            this.leaks.keys.length = 0;
            this.leaks.events.length = 0;
            return leaks;
        },
    };
    window.addEventListener("keydown", (e) => window.__lib.leaks.keys.push(e.key));
    for (const type of ["paste", "drop", "dragover"]) {
        document.addEventListener(type, () => window.__lib.leaks.events.push(type));
    }
};

(async () => {
    const session = await startSession("library");
    const { page, ev, check, shot, finish } = session;
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin });
    const ids = await ev(() => window.__bl.createTestBundles());
    await page.evaluate(LIB_HELPERS);
    let uploadRequests = 0;
    page.on("request", (r) => {
        if (r.method() === "POST" && new URL(r.url()).pathname.endsWith("/bundle-library/v1/assets")) uploadRequests++;
    });

    const overlay = page.locator(".bl-overlay");
    const editor = page.locator(".bl-overlay .bl-editor");
    const fields = page.locator(".bl-overlay .bl-field");
    const layerBox = page.locator(".bl-overlay .bl-layer");
    const button = (name, scope = overlay) => scope.getByRole("button", { name, exact: true });
    const item = (id) => page.locator(`.bl-overlay .bl-list-item[data-id="${id}"]`);
    const lib = (fn, arg) => ev(fn, arg);
    const state = () => lib(() => window.__lib.state());
    const until = (fn, arg) => page.waitForFunction(fn, arg, { timeout: 10000 }).then(() => true, () => false);
    const opened = () => overlay.waitFor({ timeout: 5000 }).then(() => true, () => false);
    const closed = () => overlay.waitFor({ state: "detached", timeout: 5000 }).then(() => true, () => false);
    const editing = (name) => until((n) => document.querySelector(".bl-overlay .bl-name-input")?.value === n, name);
    const savedState = () => until(() => document.querySelector(".bl-overlay .bl-state")?.textContent === "Saved");
    const command = (id) => ev((c) => window.__bl.app.extensionManager.command.execute(c), id);
    const api = (method, route, body) => ev(([m, r, b]) => window.__bl.request(m, r, b), [method, route, body ?? null]);
    const values = (bundle) => JSON.stringify(bundle.fields.map((f) => [f.name, f.type, f.type === "image" ? f.asset?.sha256 ?? null : f.value]));

    // ---- ways to open it ---------------------------------------------------
    await command("BundleLibrary.Open");
    const viaCommand = (await opened()) && await lib(() => ({ ...window.__lib.footer(), focused: document.activeElement?.classList.contains("bl-search") }));
    check("command opens the library (no picker footer, search focused)",
        viaCommand && viaCommand.title === "Bundle Library" && viaCommand.pick === null && viaCommand.focused, viaCommand);
    const composingEscape = await lib(() => {
        const event = new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true, cancelable: true });
        document.querySelector(".bl-overlay .bl-search").dispatchEvent(event);
        return window.__lib.open();
    });
    check("Escape that ends an IME composition leaves the modal open", composingEscape);
    await page.locator(".bl-overlay .bl-close").click();
    check("✕ closes it", await closed());

    await page.click(".comfy-menu-button-wrapper");
    await page.getByRole("menuitem", { name: "Extensions", exact: true }).first().hover();
    await page.getByRole("menuitem", { name: "Open Bundle Library", exact: true }).click();
    check("top menu Extensions > Open Bundle Library opens it", await opened());
    await page.keyboard.press("Escape");
    check("Escape closes it", await closed());

    await command("Workspace.ToggleSidebarTab.bundle-library");
    const sidebarB = page.locator(".bl-sidebar-item", { hasText: "[test] B (blue)" });
    await sidebarB.waitFor({ timeout: 5000 });
    await sidebarB.click();
    const viaSidebar = (await opened()) && (await editing("[test] B (blue)")) && await lib(() => window.__lib.selected());
    check("sidebar: a bundle name opens the library at that bundle", viaSidebar === ids.B, viaSidebar);
    await page.keyboard.press("Escape");
    await closed();

    // ---- an empty library --------------------------------------------------
    const emptyList = (route) => (route.request().method() === "GET"
        ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ bundles: [], errors: [] }) })
        : route.fallback());
    await page.route("**/bundle-library/v1/bundles", emptyList);
    await command("BundleLibrary.Open");
    await opened();
    await until(() => window.__lib.empty() !== null);
    const empty = await lib(() => ({ list: window.__lib.empty(), pane: window.__lib.pane() }));
    check("empty library: the list and the editor pane say how to start",
        empty.list === "No bundles yet. Create one with + New bundle."
        && empty.pane === "Select a bundle on the left, or create one with + New bundle.", empty);
    await page.keyboard.press("Escape");
    await closed();
    await page.unroute("**/bundle-library/v1/bundles", emptyList);

    // ---- making a bundle through the UI --------------------------------------
    await lib(() => window.__lib.takeLeaks());
    const nodesBefore = await ev(() => window.__bl.app.graph.nodes.length);
    await command("BundleLibrary.Open");
    await opened();
    await button("+ New bundle").click();
    let st = await state();
    check("+ New bundle: a draft 'New bundle', not saved yet; Save/Discard on, Duplicate/Delete off",
        st && /^New bundle( \d+)?$/.test(st.name) && st.state === "● New, not saved yet"
        && st.buttons.Save && st.buttons.Discard && !st.buttons["Duplicate ▾"] && !st.buttons.Delete, st);
    await page.keyboard.type(UI_NAME); // the name is selected, so typing replaces it
    await page.locator(".bl-overlay .bl-tag-input").fill("ui");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Test,UI"); // a comma adds a tag too; "UI" repeats "ui"
    await page.keyboard.press("Enter");
    await page.locator(".bl-overlay .bl-tag-input").fill("한글");
    const composingTags = await lib(() => {
        const event = new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true });
        document.querySelector(".bl-overlay .bl-tag-input").dispatchEvent(event);
        return window.__lib.state().tags;
    });
    await page.keyboard.press("Enter");
    const committedTags = (await state()).tags;
    check("Enter that ends an IME composition adds no tag; the next Enter does",
        JSON.stringify(composingTags) === JSON.stringify(["ui", "Test"]) && JSON.stringify(committedTags) === JSON.stringify(["ui", "Test", "한글"]),
        { composingTags, committedTags });
    await page.locator(".bl-overlay .bl-chip-x[title=\"Remove the tag '한글'\"]").click();
    await page.locator(".bl-overlay .bl-note-input").fill(NOTE);
    for (const [type, name] of [["Text", "prompt"], ["Image", "ref_file"], ["Image", "ref_paste"], ["Image", "ref_drop"],
        ["Boolean", "flag"], ["Integer", "steps"], ["Float", "cfg"]]) {
        await button("+ Add field ▾").click();
        await button(type).click();
        await page.keyboard.type(name); // a new field's name is focused and selected
    }
    st = await state();
    check("tags: Enter and comma add, case-insensitive repeats are dropped", JSON.stringify(st.tags) === JSON.stringify(["ui", "Test"]), st.tags);
    check("+ Add field adds each type with the typed name", JSON.stringify(st.fields.map((f) => [f.name, f.type])) === JSON.stringify([
        ["prompt", "text"], ["ref_file", "image"], ["ref_paste", "image"], ["ref_drop", "image"],
        ["flag", "boolean"], ["steps", "int"], ["cfg", "float"]]), st.fields.map((f) => [f.name, f.type]));
    await fields.nth(0).locator("textarea").fill(TEXT);
    const toggle = fields.nth(4).locator("input[type=checkbox]");
    const switchOff = await lib(() => {
        const card = window.__lib.card(4);
        return { role: card.querySelector("input[type=checkbox]").getAttribute("role"), text: card.querySelector(".bl-switch-text").textContent };
    });
    await toggle.check();
    const switchOn = await lib(() => window.__lib.card(4).querySelector(".bl-switch-text").textContent);
    check("a boolean is a switch that reads false, then true", switchOff.role === "switch" && switchOff.text === "false" && switchOn === "true",
        { switchOff, switchOn });
    await fields.nth(5).locator("input.bl-number").fill("4.5");
    st = await state();
    check("integer: 4.5 is refused on the card and blocks saving",
        st.fields[5].error === "Enter a whole number." && !st.buttons.Save && st.saveTitle === "Fix the marked values first.",
        { error: st.fields[5].error, save: st.buttons.Save, title: st.saveTitle });
    await fields.nth(5).locator("input.bl-number").fill("9007199254740993");
    st = await state();
    check("integer: past JavaScript's safe integers is refused with the range",
        st.fields[5].error === "Whole numbers must be within ±9,007,199,254,740,991." && !st.buttons.Save,
        { error: st.fields[5].error, save: st.buttons.Save });
    await fields.nth(5).locator("input.bl-number").fill("42");
    await fields.nth(6).locator("input.bl-number").fill("0.35");
    await fields.nth(6).locator(".bl-field-name").fill("prompt");
    st = await state();
    const twice = "Another field is also named 'prompt'.";
    check("a repeated field name marks both cards and blocks saving",
        st.fields[0].warn === twice && st.fields[6].warn === twice && !st.buttons.Save && st.saveTitle === "Fix the marked field names first.",
        { first: st.fields[0].warn, last: st.fields[6].warn, title: st.saveTitle });
    await page.keyboard.press("Control+s");
    const blocked = await lib(() => window.__lib.status());
    check("Ctrl+S on a blocked draft says why instead of saving", blocked.error && blocked.text === "Fix the marked field names first.", blocked);
    await fields.nth(6).locator(".bl-field-name").fill("@cfg");
    st = await state();
    check("a name starting with '@' is marked as reserved", st.fields[6].warn === "Names starting with '@' are reserved.", st.fields[6].warn);
    await fields.nth(6).locator(".bl-field-name").fill("cfg");

    const uploadsBefore = uploadRequests;
    const refused = await lib(async () => {
        const L = window.__lib;
        L.drop(1, [new File([new Uint8Array([71, 73, 70, 56, 57, 97])], "anim.gif", { type: "image/gif" })]);
        const gif = L.state().fields[1].error;
        L.drop(1, [new File([new Uint8Array(50 * 1024 * 1024 + 1)], "huge.png", { type: "image/png" })]);
        return { gif, huge: L.state().fields[1].error };
    });
    check("a GIF or a file over 50 MB is refused on the card without uploading",
        refused.gif === "Only PNG, JPEG and WebP images are accepted." && refused.huge === "The file is larger than 50 MB."
        && uploadRequests === uploadsBefore, { ...refused, uploads: uploadRequests - uploadsBefore });
    const damaged = await lib(async () => {
        const L = window.__lib;
        const png = await window.__bl.makeImage("#334155", "broken");
        L.drop(1, [new File([(await png.arrayBuffer()).slice(0, Math.floor(png.size / 2))], "broken.png", { type: "image/png" })]);
        for (let i = 0; i < 100 && !L.state().fields[1].error; i++) await window.__bl.sleep(100);
        return { error: L.state().fields[1].error, status: L.status() };
    });
    check("a damaged PNG is refused by the server; the card and the status line say why",
        damaged.error === "The image could not be decoded completely; the file may be damaged."
        && damaged.status.error && damaged.status.text === damaged.error && uploadRequests === uploadsBefore + 1, damaged);

    const fileBytes = Buffer.from(await lib(async () => {
        const file = await window.__bl.makeImage("#0f766e", "file");
        return [...new Uint8Array(await file.arrayBuffer())];
    }));
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), button("Choose an image…", fields.nth(1)).click()]);
    await chooser.setFiles({ name: "from-file.png", mimeType: "image/png", buffer: fileBytes });
    await fields.nth(1).locator("img.bl-image-thumb").waitFor();
    await lib(async () => {
        const file = await window.__bl.makeImage("#9333ea", "paste");
        await navigator.clipboard.write([new ClipboardItem({ "image/png": file })]);
        window.__lib.card(2).focus();
    });
    await page.keyboard.press("Control+v");
    await fields.nth(2).locator("img.bl-image-thumb").waitFor();
    const dropped = await lib(async () => {
        const file = await window.__bl.makeImage("#b45309", "drop", "dropped.png");
        return { lit: window.__lib.drop(3, [file]), sha: await window.__bl.sha256(file) };
    });
    await fields.nth(3).locator("img.bl-image-thumb").waitFor();
    st = await state();
    check("dragging a file over an image card highlights it", dropped.lit);
    check("file picker, Ctrl+V and drop each fill their own card",
        st.fields[1].thumb.includes(sha256(fileBytes)) && st.fields[2].thumb && st.fields[3].thumb.includes(dropped.sha),
        st.fields.slice(1, 4).map((f) => f.thumb));
    check("the text card counts characters and lines",
        st.fields[0].count === `${TEXT.length} characters · ${TEXT.split("\n").length} lines`, st.fields[0].count);
    await fields.nth(0).locator("textarea").fill("x");
    check("…in the singular for one", (await state()).fields[0].count === "1 character · 1 line", (await state()).fields[0].count);
    await fields.nth(0).locator("textarea").fill(TEXT);
    await shot("library-new-bundle.png");

    await page.keyboard.press("Control+s");
    const saved = await savedState() && await until(() => window.__lib.selected() !== null); // the list reloads after the save
    st = await state();
    const uiId = await lib(() => window.__lib.selected());
    check("Ctrl+S saves the new bundle and selects it in the list",
        saved && st.buttons.Revert === false && st.buttons["Duplicate ▾"] && st.buttons.Delete && !!uiId, { state: st.state, uiId });
    check("after the save re-rendered the editor the focus is still in the modal", await lib(() => window.__lib.focusInside()));
    const made = await api("GET", `/bundles/${uiId}`);
    const pasted = made.fields.find((f) => f.name === "ref_paste")?.asset;
    check("API: name, tags and note as entered",
        made.name === UI_NAME && JSON.stringify(made.tags) === JSON.stringify(["ui", "Test"]) && made.note === NOTE,
        { name: made.name, tags: made.tags, note: made.note });
    check("API: fields in order with exact values (text as typed, images by SHA-256)", values(made) === JSON.stringify([
        ["prompt", "text", TEXT], ["ref_file", "image", sha256(fileBytes)], ["ref_paste", "image", pasted?.sha256],
        ["ref_drop", "image", dropped.sha], ["flag", "boolean", true], ["steps", "int", 42], ["cfg", "float", 0.35]]), JSON.parse(values(made)));
    check("API: the pasted image is the 256×384 picture; file names are kept",
        pasted?.width === 256 && pasted?.height === 384 && made.fields[1].asset.original_name === "from-file.png"
        && made.fields[3].asset.original_name === "dropped.png", made.fields.filter((f) => f.type === "image").map((f) => f.asset));
    const leaks = await lib(() => window.__lib.takeLeaks());
    const nodesAfter = await ev(() => window.__bl.app.graph.nodes.length);
    check("nothing typed, pasted or dropped in the modal reached ComfyUI",
        leaks.keys.length === 0 && leaks.events.length === 0 && nodesAfter === nodesBefore, { leaks, nodesBefore, nodesAfter });
    await page.keyboard.press("Escape");
    check("Escape closes the modal right after a save (no question: nothing unsaved)", await closed());
    check("the open sidebar list picks up the new bundle",
        await until((name) => [...document.querySelectorAll(".bl-sidebar-item")].some((b) => b.textContent === name), UI_NAME));
    await command("Workspace.ToggleSidebarTab.bundle-library");

    // ---- the list: search, tags, sort ----------------------------------------
    await command("BundleLibrary.Open");
    await opened();
    await until((id) => window.__lib.items().some((i) => i.id === id), ids.A);
    const visible = () => lib(() => window.__lib.items().map((i) => i.id));
    const testIds = Object.values(ids).concat(uiId);
    const search = page.locator(".bl-overlay .bl-search");
    await search.fill("Blue shirt");
    await until((id) => !window.__lib.items().some((i) => i.id === id), ids.A);
    let shownIds = (await visible()).filter((id) => testIds.includes(id));
    check("search finds text values ('Blue shirt' → B only)", JSON.stringify(shownIds) === JSON.stringify([ids.B]), shownIds);
    await search.fill("ref_paste");
    await until((id) => window.__lib.items().some((i) => i.id === id), uiId);
    shownIds = (await visible()).filter((id) => testIds.includes(id));
    check("search finds field names ('ref_paste' → the UI bundle only)", JSON.stringify(shownIds) === JSON.stringify([uiId]), shownIds);
    await search.fill("zzqx no such bundle");
    check("a search without matches says so", await until(() => window.__lib.empty() === "No bundles match."));
    await search.fill("");
    await until((id) => window.__lib.items().some((i) => i.id === id), ids.A);
    const all = (await api("GET", "/bundles")).bundles;
    await page.locator(".bl-overlay .bl-tag-filter").selectOption("ui");
    const tagged = all.filter((b) => b.tags.some((t) => t.toLowerCase() === "ui")).map((b) => b.id).sort();
    shownIds = (await visible()).sort();
    check("tag filter 'ui' shows exactly the bundles tagged ui", JSON.stringify(shownIds) === JSON.stringify(tagged) && shownIds.includes(uiId), shownIds);
    const tagOptions = await lib(() => [...document.querySelectorAll(".bl-overlay .bl-tag-filter option")].map((o) => o.value));
    check("tag options list 'test' and 'Test' once", tagOptions.filter((t) => t.toLowerCase() === "test").length === 1, tagOptions);
    await page.locator(".bl-overlay .bl-tag-filter").selectOption("");
    await page.locator(".bl-overlay .bl-sort").selectOption("updated");
    shownIds = await visible();
    check("sort 'Recently updated' puts the newest bundle first", shownIds[0] === uiId, shownIds.slice(0, 3));
    await page.locator(".bl-overlay .bl-sort").selectOption("name");
    const names = await lib(() => window.__lib.items().map((i) => i.name));
    const byName = all.map((b) => b.name).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    check("sort 'By name' is alphabetical", JSON.stringify(names) === JSON.stringify(byName), names);

    // ---- editing a saved bundle ------------------------------------------------
    await item(uiId).click();
    await editing(UI_NAME);
    await fields.nth(1).locator("img.bl-image-thumb").click();
    const viewer = (await until(() => {
        const img = document.querySelector(".bl-overlay .bl-viewer img");
        return img?.complete && img.naturalWidth > 0;
    })) && await lib(() => {
        const img = document.querySelector(".bl-overlay .bl-viewer img");
        return { src: img.getAttribute("src"), width: img.naturalWidth, caption: document.querySelector(".bl-viewer-caption").textContent };
    });
    check("a thumbnail opens the full image in a viewer",
        viewer && viewer.src.includes(`/assets/${sha256(fileBytes)}`) && viewer.width === 256 && viewer.caption === "ref_file · from-file.png", viewer);
    await shot("library-viewer.png");
    await page.keyboard.press("Escape");
    const afterViewer = await lib(() => ({ layer: window.__lib.layer(), open: window.__lib.open() }));
    check("Escape closes the viewer first; the modal stays", afterViewer.layer === null && afterViewer.open, afterViewer);

    await fields.nth(0).locator(".bl-field-name").fill("prompt_main");
    st = await state();
    check("renaming a saved field warns about connected workflows",
        st.fields[0].warn === "Renamed from 'prompt': workflows connected to 'prompt' will show it as missing."
        && st.state === "● Unsaved changes", st.fields[0].warn);
    await fields.nth(0).locator(".bl-field-name").fill("prompt");
    st = await state();
    check("renaming it back clears the warning and the change", st.fields[0].warn === null && st.state === "Saved", st.state);
    await button("▼", fields.nth(0)).click();
    st = await state();
    check("▼ moves a field down; ▲ is off on the first card, ▼ on the last",
        st.fields[0].name === "ref_file" && st.fields[1].name === "prompt" && !st.fields[0].up && st.fields[0].down
        && !st.fields.at(-1).down && st.fields.at(-1).up, st.fields.map((f) => [f.name, f.up, f.down]));
    await page.keyboard.press("Control+s");
    await page.keyboard.press("Control+s"); // a second press while the first save runs must not save again
    await savedState();
    await page.waitForTimeout(500);
    const reordered = await api("GET", `/bundles/${uiId}`);
    check("Ctrl+S twice saves the new order once (revision 2, no conflict question)",
        reordered.fields.map((f) => f.name).join() === "ref_file,prompt,ref_paste,ref_drop,flag,steps,cfg" && reordered.revision === 2
        && (await lib(() => window.__lib.layer())) === null,
        { order: reordered.fields.map((f) => f.name), revision: reordered.revision });
    await button("✕", fields.nth(4)).click();
    let layer = await lib(() => window.__lib.layer());
    check("removing a saved field asks first",
        layer?.title === "Remove the field 'flag'?" && JSON.stringify(layer.buttons) === JSON.stringify(["Remove", "Cancel"]), layer);
    await button("Cancel", layerBox).click();
    st = await state();
    check("Cancel keeps the field (and the focus in the modal)",
        st.fields.length === 7 && st.fields[4].name === "flag" && st.state === "Saved" && await lib(() => window.__lib.focusInside()), st.state);
    await button("✕", fields.nth(4)).click();
    await button("Remove", layerBox).click();
    st = await state();
    check("Remove takes it out of the draft only", st.fields.length === 6 && !st.fields.some((f) => f.name === "flag")
        && st.state === "● Unsaved changes", st.fields.map((f) => f.name));
    await button("Revert", editor).click();
    st = await state();
    check("Revert brings the saved version back", st.fields.length === 7 && st.state === "Saved" && st.name === UI_NAME, st.state);

    // ---- unsaved changes -------------------------------------------------------
    await page.locator(".bl-overlay .bl-note-input").fill("changed, not saved");
    check("leaving the page with unsaved changes makes the browser ask", await lib(() => window.__lib.unloadAsks()));
    await item(ids.B).click();
    layer = await lib(() => window.__lib.layer());
    check("opening another bundle with unsaved changes asks first",
        layer?.title === "Discard unsaved changes?" && JSON.stringify(layer.buttons) === JSON.stringify(["Discard", "Cancel"]), layer);
    await page.keyboard.press("Escape");
    st = await state();
    check("Escape on the question keeps editing (the modal stays open)",
        (await lib(() => window.__lib.layer())) === null && st.name === UI_NAME && st.note === "changed, not saved"
        && await lib(() => window.__lib.open()), st.note);
    await page.locator(".bl-overlay .bl-close").click();
    layer = await lib(() => window.__lib.layer());
    await button("Cancel", layerBox).click();
    await page.mouse.click(8, 500); // the dimmed backdrop beside the dialog
    const backdrop = await lib(() => window.__lib.layer());
    await button("Cancel", layerBox).click();
    check("✕ and a click on the backdrop ask too",
        layer?.title === "Discard unsaved changes?" && backdrop?.title === "Discard unsaved changes?" && await lib(() => window.__lib.open()),
        { close: layer?.title, backdrop: backdrop?.title });
    await button("+ New bundle").click();
    await button("Discard", layerBox).click();
    st = await state();
    const untouched = await api("GET", `/bundles/${uiId}`);
    check("Discard drops the change and starts the new draft; nothing reached the server",
        st.state === "● New, not saved yet" && untouched.note === NOTE && untouched.revision === 2, { state: st.state, note: untouched.note });
    await button("Discard", editor).click();
    const discarded = await lib(() => ({ pane: window.__lib.pane(), status: window.__lib.status().text }));
    check("Discard on a new draft closes it", discarded.pane?.startsWith("Select a bundle") && discarded.status === "Discarded the new bundle.", discarded);
    check("with nothing unsaved the browser does not ask", !(await lib(() => window.__lib.unloadAsks())));

    // ---- a change made elsewhere ---------------------------------------------
    await item(uiId).click();
    await editing(UI_NAME);
    const putNote = async (note) => {
        const current = await api("GET", `/bundles/${uiId}`);
        return api("PUT", `/bundles/${uiId}`, { ...current, note, expected_revision: current.revision });
    };
    await page.locator(".bl-overlay .bl-note-input").fill("note from the editor");
    await putNote("note from elsewhere");
    await button("Save", editor).click();
    await until(() => window.__lib.layer()?.title === "This bundle was changed elsewhere");
    layer = await lib(() => window.__lib.layer());
    check("saving over a newer revision asks: Overwrite / Reload / Cancel",
        JSON.stringify(layer?.buttons) === JSON.stringify(["Overwrite", "Reload", "Cancel"]), layer);
    await shot("library-conflict.png");
    await button("Cancel", layerBox).click();
    st = await state();
    check("Cancel keeps the draft, unsaved", st.note === "note from the editor" && st.state === "● Unsaved changes", st.state);
    await button("Save", editor).click();
    await until(() => window.__lib.layer() !== null);
    await button("Reload", layerBox).click();
    await savedState();
    st = await state();
    check("Reload shows the other change and drops the draft", st.note === "note from elsewhere" && st.state === "Saved", st.note);
    await page.locator(".bl-overlay .bl-note-input").fill("the editor wins");
    const other = await putNote("elsewhere again");
    await button("Save", editor).click();
    await until(() => window.__lib.layer() !== null);
    await button("Overwrite", layerBox).click();
    await savedState();
    const overwritten = await api("GET", `/bundles/${uiId}`);
    check("Overwrite saves the draft over the other change",
        overwritten.note === "the editor wins" && overwritten.revision === other.revision + 1, { note: overwritten.note, revision: overwritten.revision });

    // ---- duplicate and delete --------------------------------------------------
    await button("Duplicate ▾", editor).click();
    await button("Duplicate with values").click();
    await editing(`${UI_NAME} copy`);
    const copyId = await lib(() => window.__lib.selected());
    const copy = await api("GET", `/bundles/${copyId}`);
    check("Duplicate with values: the copy opens, selected, with the same tags, note, fields and values",
        copyId && copyId !== uiId && values(copy) === values(overwritten) && copy.note === overwritten.note
        && JSON.stringify(copy.tags) === JSON.stringify(overwritten.tags), { copyId, name: copy.name });
    await item(uiId).click();
    await editing(UI_NAME);
    await button("Duplicate ▾", editor).click();
    await button("Duplicate structure only").click();
    await editing(`${UI_NAME} copy`);
    await until((id) => window.__lib.selected() !== id, copyId);
    const structureId = await lib(() => window.__lib.selected());
    const structure = await api("GET", `/bundles/${structureId}`);
    const twins = await lib(([a, b]) => window.__lib.items().filter((i) => i.id === a || i.id === b).map((i) => i.name),
        [copyId, structureId]);
    check("both copies may have the same name; the list tells them apart by the start of the id",
        structure.name === `${UI_NAME} copy` && twins.length === 2 && new Set(twins).size === 2
        && twins.every((label) => /^\[test\] UI made copy · [0-9a-f]{4,}$/.test(label)), twins);
    const blank = { text: "", boolean: false, int: 0, float: 0 };
    check("Duplicate structure only: the same fields with empty values",
        values(structure) === JSON.stringify(overwritten.fields.map((f) => [f.name, f.type, f.type === "image" ? null : blank[f.type]])),
        JSON.parse(values(structure)));
    // Fill the copy with other values (order: ref_file, prompt, ref_paste, ref_drop, flag, steps, cfg).
    const otherShas = [];
    for (const [index, color] of [[0, "#1d4ed8"], [2, "#be123c"], [3, "#a16207"]]) {
        otherShas.push(await lib(async ([i, c]) => {
            const file = await window.__bl.makeImage(c, `copy ${i}`);
            window.__lib.drop(i, [file]);
            return window.__bl.sha256(file);
        }, [index, color]));
        await fields.nth(index).locator("img.bl-image-thumb").waitFor();
    }
    await fields.nth(1).locator("textarea").fill("Other text for the copy");
    await fields.nth(5).locator("input.bl-number").fill("7");
    await fields.nth(6).locator("input.bl-number").fill("1.5");
    await button("Save", editor).click();
    await savedState();
    const filled = await api("GET", `/bundles/${structureId}`);
    check("the structure copy takes other values and saves them", values(filled) === JSON.stringify([
        ["ref_file", "image", otherShas[0]], ["prompt", "text", "Other text for the copy"], ["ref_paste", "image", otherShas[1]],
        ["ref_drop", "image", otherShas[2]], ["flag", "boolean", false], ["steps", "int", 7], ["cfg", "float", 1.5]]),
        JSON.parse(values(filled)));
    await button("Delete", editor).click();
    layer = await lib(() => window.__lib.layer());
    check("Delete asks first",
        layer?.title === `Delete '${UI_NAME} copy'?` && JSON.stringify(layer.buttons) === JSON.stringify(["Delete", "Cancel"]), layer);
    await button("Cancel", layerBox).click();
    check("Cancel keeps it", (await api("GET", `/bundles/${structureId}`)).id === structureId);
    await button("Delete", editor).click();
    await button("Delete", layerBox).click();
    await until(() => window.__lib.pane() !== null);
    const deleted = await lib((id) => ({
        listed: window.__lib.items().some((i) => i.id === id),
        status: window.__lib.status().text,
    }), structureId);
    const stillThere = await ev((id) => window.__bl.request("GET", `/bundles/${id}`).then(() => true, () => false), structureId);
    check("Delete removes it from the list and the library",
        !deleted.listed && !stillThere && deleted.status === `Deleted '${UI_NAME} copy'. It is in the trash.`, deleted);
    const ctrlO = await lib(() => {
        const event = new KeyboardEvent("keydown", { key: "o", ctrlKey: true, bubbles: true, cancelable: true });
        document.querySelector(".bl-overlay .bl-search").dispatchEvent(event);
        return event.defaultPrevented;
    });
    check("Ctrl+O is cancelled in the modal (no browser file dialog)", ctrlO);
    const editLeaks = await lib(() => window.__lib.takeLeaks());
    check("no key or paste from the editing session reached ComfyUI", editLeaks.keys.length === 0 && editLeaks.events.length === 0, editLeaks);
    await page.keyboard.press("Escape");
    await closed();

    // ---- the node's picker -----------------------------------------------------
    await ev(async (A) => {
        const b = window.__bl;
        b.app.graph.clear();
        const node = b.add("BundleLibraryLoad", [120, 120]);
        window.__node = node;
        await b.pick(node, A);
        node.connect(2, b.add("PreviewImage", [700, 120]), 0); // ref_2
    }, ids.A);
    const nodeState = () => ev(() => ({
        id: window.__node.widgets.find((w) => w.name === "bundle_id").value,
        outs: window.__bl.outs(window.__node).map((o) => [o.label, o.type, o.links]),
    }));
    await page.waitForTimeout(400);
    await page.locator(".bl-panel .bl-open").click();
    await opened();
    await editing("[test] A (red)");
    let footer = await lib(() => window.__lib.footer());
    check("📚 opens the picker at the node's bundle, ready to use",
        footer.title === "Bundle Library — pick a bundle" && footer.pick === true && footer.hint === "", footer);
    const bundleA = await api("GET", `/bundles/${ids.A}`);
    st = await state();
    check("the modal shows every value of A: the text, both images, the boolean",
        st.fields[0].text === bundleA.fields[0].value
        && st.fields[1].thumb?.includes(bundleA.fields[1].asset.sha256) && st.fields[2].thumb?.includes(bundleA.fields[2].asset.sha256)
        && st.fields[3].checked === true, st.fields.map((f) => [f.name, f.text ?? f.thumb ?? f.checked]));
    const marks = await lib((list) => Object.fromEntries(window.__lib.items().filter((i) => list.includes(i.id)).map((i) => [i.name, i.warn])),
        Object.values(ids));
    check("bundles without the connected ref_2 are marked",
        marks["[test] C (no ref_2)"] === "⚠ no ref_2" && marks["[test] D (ref_2 is text)"] === "⚠ no ref_2"
        && !marks["[test] A (red)"] && !marks["[test] B (blue)"] && !marks["[test] E (empty ref_2)"], marks);
    await item(ids.C).click();
    await editing("[test] C (no ref_2)");
    footer = await lib(() => window.__lib.footer());
    check("such a bundle can still be used, with a warning",
        footer.pick === true && footer.hint === "⚠ The node's connected output ref_2 is missing here or has another type; running would fail.", footer);
    await page.locator(".bl-overlay .bl-note-input").fill("draft");
    footer = await lib(() => window.__lib.footer());
    check("with unsaved changes 'Use this bundle' waits", footer.pick === false && footer.hint === "Save or revert your changes first.", footer);
    await button("Revert", editor).click();
    await item(ids.B).click();
    await editing("[test] B (blue)");
    await shot("library-picker.png");
    await button("Use this bundle").click();
    let ns = (await closed()) && await nodeState();
    check("'Use this bundle' points the node at B and keeps the ref_2 link", ns && ns.id === ids.B
        && JSON.stringify(ns.outs) === JSON.stringify([["prompt", "STRING", 0], ["ref_1", "IMAGE", 0], ["ref_2", "IMAGE", 1], ["use_bgm", "BOOLEAN", 0]]), ns);
    await page.locator(".bl-panel .bl-open").click();
    await opened();
    await editing("[test] B (blue)");
    await item(ids.E).dblclick();
    ns = (await closed()) && await nodeState();
    check("a double-click on a bundle picks it", ns && ns.id === ids.E, ns);
    await page.locator(".bl-panel .bl-open").click();
    await opened();
    await button("Cancel").click();
    ns = (await closed()) && await nodeState();
    check("Cancel closes the picker without changes", ns && ns.id === ids.E, ns);

    // ---- Nodes 2.0 -------------------------------------------------------------
    await ev(async () => {
        const b = window.__bl;
        b.app.graph.clear();
        await b.app.extensionManager.setting.set("Comfy.VueNodes.Enabled", true);
        await b.sleep(1200);
    });
    const vueId = await ev(async (A) => {
        const b = window.__bl;
        const node = b.add("BundleLibraryLoad", [120, 120]);
        window.__node = node;
        await b.sleep(800);
        await b.pick(node, A);
        await b.sleep(400);
        return String(node.id);
    }, ids.A);
    await lib(() => window.__lib.takeLeaks());
    await page.locator(`[data-node-id="${vueId}"] .bl-open`).click();
    const vueOpen = (await opened()) && (await editing("[test] A (red)")) && await lib(() => {
        const r = document.querySelector(".bl-modal").getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return { onTop: !!hit?.closest(".bl-modal"), ...window.__lib.footer() };
    });
    check("vue: 📚 opens the picker on top of the canvas", vueOpen && vueOpen.onTop && vueOpen.pick === true, vueOpen);
    await page.locator(".bl-overlay .bl-search").click();
    await page.keyboard.type("Blue shirt");
    await until((id) => !window.__lib.items().some((i) => i.id === id), ids.A);
    await item(ids.B).click();
    await editing("[test] B (blue)");
    await shot("vue-picker.png");
    await button("Use this bundle").click();
    await closed();
    await page.waitForTimeout(600);
    const vueLeaks = await lib(() => window.__lib.takeLeaks());
    ns = await nodeState();
    const vueText = await ev((id) => document.querySelector(`[data-node-id="${id}"]`)?.innerText ?? "", vueId);
    check("vue: typing in the modal stays in the modal", vueLeaks.keys.length === 0, vueLeaks);
    check("vue: 'Use this bundle' updates the node and its preview", ns.id === ids.B && vueText.includes("Blue shirt girl"), { id: ns.id, vueText });
    await ev(async () => {
        await window.__bl.app.extensionManager.setting.set("Comfy.VueNodes.Enabled", false);
        window.__bl.app.graph.clear();
    });

    await finish({ expectRemoved: 7 }); // A–E, the UI-made bundle and its copy
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
