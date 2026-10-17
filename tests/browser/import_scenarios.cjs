// Browser scenarios for importing an export ZIP (Phase 8b): the import button
// and its file picker; the upload, which holds the window until it ends or is
// cancelled; the preview (how each bundle of the file stands here, the files,
// the choices), left with Cancel or by opening a bundle (the server drops the
// upload either way); the three choices for bundles here already (skip,
// overwrite with one back from the trash, copy) and the category modes (as in
// the file, one category); and files the import refuses (not a ZIP, a bundle
// whose bytes are not what the manifest says, a newer format). When the test
// server's container is known (BL_TEST_CONTAINER, BL_TEST_LIBRARY), it also
// checks that a left preview's upload is gone from the server.
// Set-up and safety notes are in harness.cjs.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { startSession } = require("./harness.cjs");

const PREFIX = "[test] Import";
const BASE = process.env.COMFY_URL || "http://127.0.0.1:8189";
const CONTAINER = process.env.BL_TEST_CONTAINER;
const LIBRARY = process.env.BL_TEST_LIBRARY;
// The refusals provoked on purpose: the browser reports them as console errors.
const REFUSED = { text: /^Failed to load resource: the server responded with a status of 4\d\d /,
    url: /\/api\/bundle-library\/v1\/import(\/|$)/ };

/**
 * Write `target`: the ZIP `source` with `edit` applied, Python run with
 * `entries` (name → bytes) and `manifest` (the manifest, as a dict).
 */
function rewrite(source, target, edit) {
    const script = "import json, sys, zipfile\n"
        + "src = zipfile.ZipFile(sys.argv[1])\n"
        + "entries = {n: src.read(n) for n in src.namelist()}\n"
        + "manifest = json.loads(entries['manifest.json'])\n"
        + `${edit}\n`
        + "entries['manifest.json'] = json.dumps(manifest).encode()\n"
        + "with zipfile.ZipFile(sys.argv[2], 'w', zipfile.ZIP_DEFLATED) as out:\n"
        + "    for n, data in entries.items():\n"
        + "        out.writestr(n, data)\n";
    execFileSync("python3", ["-I", "-c", script, source, target]);
    return target;
}

/**
 * Delete a stored file (one the session made, no bundle uses) and its
 * thumbnails from the test server's library, as if it had never been there;
 * false without its container. The cleanup API keeps a file uploaded this
 * recently: a draft may be using it.
 */
function forget(sha256) {
    if (!CONTAINER || !LIBRARY) return false;
    for (const folder of [`${LIBRARY}/assets/sha256/${sha256.slice(0, 2)}`, `${LIBRARY}/thumbs/${sha256.slice(0, 2)}`]) {
        // rm -f: a thumbnail may not have been made yet
        execFileSync("docker", ["exec", CONTAINER, "sh", "-c", 'rm -f "$1"/"$2".* "$1"/"$2"_*', "sh", folder, sha256]);
    }
    return true;
}

/** Whether the test server still holds the upload `token`, or null without its container. */
function held(token) {
    if (!CONTAINER || !LIBRARY) return null;
    try {
        execFileSync("docker", ["exec", CONTAINER, "test", "-e", `${LIBRARY}/tmp/imports/${token}.zip`]);
        return true;
    } catch {
        return false;
    }
}

(async () => {
    const session = await startSession("import", { expectedErrors: [REFUSED] });
    const { page, ev, check, shot, out, finish } = session;
    const overlay = page.locator(".bl-overlay");
    const button = (name, scope = overlay) => scope.getByRole("button", { name, exact: true });
    const until = (fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
    const api = (method, route, body) => ev(([m, r, b]) => window.__bl.request(m, r, b), [method, route, body ?? null]);
    const command = (id) => ev((c) => window.__bl.app.extensionManager.command.execute(c), id);
    const status = () => ev(() => document.querySelector(".bl-overlay .bl-status")?.textContent ?? "");
    /** Resolves once the page has asked the server to drop the upload `token`. */
    const dropping = (token) => page.waitForResponse((r) => r.request().method() === "DELETE"
        && new URL(r.url()).pathname === `/api/bundle-library/v1/import/${token}`, { timeout: 5000 }).then((r) => r.ok(), () => false);
    /** What the import pane shows, or null. */
    const pane = () => ev(() => {
        const box = document.querySelector(".bl-overlay .bl-import");
        if (!box) return null;
        const go = box.querySelector(".bl-import-go");
        return {
            title: box.querySelector(".bl-trash-title")?.textContent ?? null,
            summary: box.querySelector(".bl-batch-summary")?.textContent ?? null,
            files: box.querySelector(".bl-batch-summary + .bl-hint")?.textContent ?? null,
            rows: Object.fromEntries([...box.querySelectorAll(".bl-import-item")].map((r) => [r.dataset.id, {
                conflict: r.dataset.conflict, state: r.querySelector(".bl-import-state").textContent,
                warn: r.querySelector(".bl-list-warn")?.textContent ?? null }])),
            conflicts: [...box.querySelectorAll('input[name="bl-import-conflict"]')].map((i) => i.value + (i.checked ? "*" : "")),
            modes: [...box.querySelectorAll('input[name="bl-import-mode"]')].map((i) => i.value + (i.checked ? "*" : "")),
            go: go && { text: go.textContent, disabled: go.disabled },
            error: box.querySelector(".bl-error")?.textContent ?? null,
        };
    });
    /** What an import's result shows, by outcome, or null while there is none. */
    const result = () => ev(() => {
        const box = document.querySelector(".bl-overlay .bl-batch-result:not(.waiting)");
        return box ? {
            title: box.querySelector(".bl-batch-title")?.textContent ?? null,
            summary: box.querySelector(".bl-batch-summary")?.textContent ?? null,
            groups: Object.fromEntries([...box.querySelectorAll("[data-outcome]")].map((g) => [g.dataset.outcome,
                [...g.querySelectorAll(".bl-batch-outcome-row")].map((r) => ({ id: r.dataset.id, text: r.textContent }))])),
            notes: [...box.querySelectorAll(".bl-hint, .bl-warn")].map((h) => h.textContent),
            error: box.querySelector(".bl-error")?.textContent ?? null,
        } : null;
    });
    /**
     * Choose `file` with the import button and wait for the pane to show what
     * came back; resolves to the upload's answer (null when it was refused).
     */
    const upload = async (file) => {
        const answered = page.waitForResponse((r) => r.request().method() === "POST"
            && new URL(r.url()).pathname === "/api/bundle-library/v1/import", { timeout: 30000 });
        const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.locator(".bl-overlay .bl-import-button").click()]);
        await chooser.setFiles(file);
        const res = await answered;
        await until(() => document.querySelector(".bl-overlay .bl-import .bl-import-go, .bl-overlay .bl-import .bl-error"));
        return res.ok() ? res.json() : null;
    };
    /** Import what the pane shows and wait for the result. */
    const runImport = async () => {
        await page.locator(".bl-overlay .bl-import-go").click();
        await until(() => document.querySelector(".bl-overlay .bl-batch-result:not(.waiting)"), undefined, 30000);
        return result();
    };

    // ---- set-up: three bundles exported, then each made to stand differently here --------------------
    const shelf = await api("POST", "/categories", { name: `${PREFIX} shelf` });
    const box = await api("POST", "/categories", { name: `${PREFIX} box` });
    const make = async (name, color, category = null) => api("POST", "/bundles", {
        name, tags: ["test"], category, fields: [await ev(([c, l]) => window.__bl.image("ref", c, l), [color, name]),
            { name: "prompt", type: "text", value: name }] });
    const one = await make(`${PREFIX} one`, "#9a3412", shelf.id);
    const two = await make(`${PREFIX} two`, "#1e40af");
    const three = await make(`${PREFIX} three`, "#166534");
    const made = await api("POST", "/export", { ids: [one.id, two.id, three.id] });
    const zip = path.join(out, "export.zip");
    fs.writeFileSync(zip, Buffer.from(await (await fetch(`${BASE}/api/bundle-library/v1/export/${made.token}?name=export.zip`))
        .arrayBuffer()));
    // one in the trash (and its category gone), two as it was, three gone for good with its file.
    const inTrash = async (id) => (await api("GET", "/trash")).trash.find((e) => e.id === id);
    await api("DELETE", `/bundles/${one.id}?expected_revision=${one.revision}`);
    const trashed = await inTrash(one.id);
    await api("DELETE", `/categories/${shelf.id}`);
    await api("DELETE", `/bundles/${three.id}?expected_revision=${three.revision}`);
    await api("DELETE", `/trash/${three.id}?expected_revision=${(await inTrash(three.id)).revision}`);
    const fresh = forget(three.fields[0].asset.sha256) ? 1 : 0; // the files the import will bring

    await command("BundleLibrary.Open");
    await overlay.waitFor();
    await page.locator(".bl-overlay .bl-search").fill(PREFIX);
    await until(() => document.querySelectorAll(".bl-overlay .bl-list-item").length >= 1);

    // ---- the upload holds the window; Cancel upload stops it -------------------------------------------
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    await page.route("**/api/bundle-library/v1/import", async (route) => {
        await gate;
        await route.continue().catch(() => {}); // cancelled meanwhile
    });
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.locator(".bl-overlay .bl-import-button").click()]);
    await chooser.setFiles(zip);
    await until(() => document.querySelector(".bl-overlay .bl-import .bl-progress"));
    await page.keyboard.press("Escape");
    const whileUploading = { open: await overlay.count() === 1, status: await status(),
        disabled: await ev(() => document.querySelector(".bl-overlay .bl-import-button").disabled) };
    check("while the file is uploaded the window waits: it does not close and the import button is off",
        whileUploading.open && whileUploading.status === "Wait until the file is uploaded, or cancel the upload."
        && whileUploading.disabled, whileUploading);
    await button("Cancel upload").click();
    await until(() => !document.querySelector(".bl-overlay .bl-import"));
    check("Cancel upload stops it and says so", (await status()) === "Cancelled the upload of export.zip.", await status());
    release();
    await page.unroute("**/api/bundle-library/v1/import");

    // ---- the preview: nothing has changed yet ----------------------------------------------------------
    let preview = await upload(zip);
    let shown = await pane();
    check("the preview shows each bundle of the file as it stands here",
        shown?.rows[one.id]?.state === "here already, in the trash" && shown.rows[two.id]?.state === "here already"
        && shown.rows[three.id]?.state === "new here" && shown.summary === "3 bundles · 1 new here · 2 here already",
        shown && { rows: shown.rows, summary: shown.summary });
    check(`and the files: ${fresh ? "the one that is not here comes with the file, " : ""}the others are here already`,
        shown?.files?.startsWith(`${fresh} new file${fresh === 1 ? "" : "s"} (`) && shown.files.endsWith(`· ${3 - fresh} here already`)
        && preview.assets.new === fresh, shown?.files);
    check("bundles here already are left as they are unless chosen otherwise; categories go as in the file",
        JSON.stringify(shown?.conflicts) === JSON.stringify(["skip*", "overwrite", "copy"])
        && shown.modes[0] === "zip*" && shown.modes.includes("one") && shown.go?.text === "Import 3 bundles",
        shown && { conflicts: shown.conflicts, modes: shown.modes, go: shown.go });
    const untouched = await api("GET", `/bundles/${two.id}`);
    check("the upload changed nothing", untouched.revision === two.revision && held(preview.token) !== false,
        { revision: untouched.revision });
    await shot("import-preview.png");
    let drop = dropping(preview.token);
    await button("Cancel").click();
    await until(() => !document.querySelector(".bl-overlay .bl-import"));
    check("Cancel leaves it, and the server drops the upload", (await status()) === "Nothing was imported."
        && await drop && held(preview.token) !== true, { status: await status(), held: held(preview.token) });

    // ---- leaving a preview another way also drops it ---------------------------------------------------
    preview = await upload(zip);
    drop = dropping(preview.token);
    await page.locator(`.bl-overlay .bl-list-item[data-id="${two.id}"]`).first().click();
    await until(() => document.querySelector(".bl-overlay .bl-name-input")?.value.endsWith("two"));
    check("opening a bundle instead drops the upload too", await drop && held(preview.token) !== true,
        { held: held(preview.token) });

    // ---- overwrite, categories as in the file -----------------------------------------------------------
    await upload(zip);
    await page.locator('.bl-overlay input[name="bl-import-conflict"][value="overwrite"]').check();
    shown = await runImport();
    const groups = shown?.groups ?? {};
    check("overwrite: the new one comes, the others are replaced with the file's version",
        JSON.stringify(groups.new?.map((r) => r.id)) === JSON.stringify([three.id])
        && JSON.stringify((groups.overwritten ?? []).map((r) => r.id).sort()) === JSON.stringify([one.id, two.id].sort()),
        shown);
    check("one in the trash comes back, and the result says so",
        (groups.overwritten ?? []).find((r) => r.id === one.id)?.text.includes("back from the trash")
        && !(groups.overwritten ?? []).find((r) => r.id === two.id)?.text.includes("back from the trash"), groups.overwritten);
    check("the category of the file is made again, and the file that was not here came",
        shown?.notes.includes(`Categories made: ${PREFIX} shelf.`)
        && shown.summary === `3 imported · ${fresh} new file${fresh === 1 ? "" : "s"}`,
        shown && { notes: shown.notes, summary: shown.summary });
    let library = await api("GET", "/bundles");
    const shelfAgain = library.categories.find((c) => c.name === `${PREFIX} shelf`);
    const backOne = await api("GET", `/bundles/${one.id}`);
    check("on the server: one is out of the trash, a revision on, in the category made again; three is as exported",
        backOne.deleted_at === null && backOne.revision === trashed.revision + 1 && shelfAgain
        && library.bundles.find((b) => b.id === one.id)?.category === shelfAgain.id
        && (await api("GET", `/bundles/${three.id}`)).revision === three.revision,
        { revision: backOne.revision, trashed: trashed.revision, shelf: shelfAgain?.id });
    const listed = await until((ids) => ids.every((id) => document.querySelector(`.bl-overlay .bl-list-item[data-id="${id}"]`)),
        [one.id, two.id, three.id]);
    check("the list shows them", listed);
    await shot("import-result.png");
    await button("Done").click();

    // ---- copy, all into one category ---------------------------------------------------------------------
    await upload(zip);
    shown = await pane();
    check("now all three are here already", Object.values(shown?.rows ?? {}).every((r) => r.conflict === "active"),
        shown?.rows);
    await page.locator('.bl-overlay input[name="bl-import-conflict"][value="copy"]').check();
    await page.locator('.bl-overlay input[name="bl-import-mode"][value="one"]').check();
    await page.locator(".bl-overlay .bl-import-category").selectOption(box.id);
    shown = await runImport();
    const copies = (shown?.groups.copied ?? []).map((r) => r.id);
    library = await api("GET", "/bundles");
    check("copy: each comes beside the one here, under a new id, all in the category chosen",
        copies.length === 3 && copies.every((id) => ![one.id, two.id, three.id].includes(id))
        && copies.every((id) => library.bundles.find((b) => b.id === id)?.category === box.id)
        && library.bundles.find((b) => b.id === one.id)?.category === shelfAgain?.id, { copies });
    await button("Done").click();

    // ---- skip ---------------------------------------------------------------------------------------------
    await upload(zip);
    shown = await runImport();
    check("skip: those here already are left as they are",
        shown?.groups.skipped?.length === 3 && shown.summary === "0 imported · 3 left as they are · 0 new files"
        && (await api("GET", `/bundles/${two.id}`)).revision === untouched.revision + 1, shown);
    await button("Done").click();

    // ---- a refused import changes nothing ------------------------------------------------------------
    const count = async () => (await api("GET", "/bundles")).bundles.filter((b) => b.name.startsWith(PREFIX)).length;
    const before = await count();
    preview = await upload(zip);
    await page.locator('.bl-overlay input[name="bl-import-conflict"][value="copy"]').check();
    await page.locator('.bl-overlay input[name="bl-import-mode"][value="one"]').check();
    await page.locator(".bl-overlay .bl-import-category").selectOption(box.id);
    await api("DELETE", `/categories/${box.id}`); // as from another tab, meanwhile
    drop = dropping(preview.token);
    shown = await runImport();
    check("a refused import (the category chosen is gone) says why, changes nothing and drops the upload",
        shown?.title === "Nothing was imported" && shown.error === `Category not found: ${box.id}`
        && (await count()) === before && await drop && held(preview.token) !== true, shown);
    await button("Done").click();

    // ---- files the import refuses -----------------------------------------------------------------------
    const notZip = path.join(out, "not-a-zip.zip");
    fs.writeFileSync(notZip, "not a zip");
    await upload(notZip);
    shown = await pane();
    check("a file that is not a ZIP is refused, with the reason",
        shown?.error?.startsWith("This is not an export this version can read: not a ZIP file"), shown?.error);
    await button("Done").click();
    await upload(rewrite(zip, path.join(out, "newer.zip"), "manifest['version'] = 2"));
    shown = await pane();
    check("so is an export of a newer format",
        shown?.error === "This export was made by a newer Bundle Library (format version 2); update the node pack to import it.",
        shown?.error);
    await button("Done").click();
    preview = await upload(rewrite(zip, path.join(out, "tampered.zip"),
        `entries['bundles/${two.id}.json'] = entries['bundles/${two.id}.json'].replace(b'two', b'TWO')`));
    shown = await pane();
    check("a bundle whose bytes are not what the manifest says is left out, with the reason; the others can come",
        shown?.rows[two.id]?.state === "left out"
        && shown.rows[two.id].warn === "⚠ The file is not what the manifest says (its SHA-256 differs)."
        && shown.go?.text === "Import 2 bundles", shown && { row: shown.rows[two.id], go: shown.go });
    await button("Cancel").click();
    await until(() => !document.querySelector(".bl-overlay .bl-import"));

    await page.keyboard.press("Escape");
    await finish({ expectRemoved: 6 }); // the three, and their copies
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
