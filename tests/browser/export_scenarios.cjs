// Browser scenarios for exporting bundles as a ZIP (Phase 8a): from the batch
// panel and from the editor, the download the browser makes, what the ZIP
// holds (checked with Python's zipfile), a bundle left out with the reason, and
// an editor with changes not exporting its draft. When the test server's
// container is known (BL_TEST_CONTAINER, BL_TEST_LIBRARY), the bundle files in
// the ZIP are compared with the stored ones byte for byte.
// Set-up and safety notes are in harness.cjs.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { startSession } = require("./harness.cjs");

const PREFIX = "[test] Export";
const CONTAINER = process.env.BL_TEST_CONTAINER;
const LIBRARY = process.env.BL_TEST_LIBRARY;

/** What a ZIP holds: its entry names, its manifest, and the SHA-256 of each entry's bytes. */
function inspect(zip) {
    const script = "import hashlib, json, sys, zipfile\n"
        + "z = zipfile.ZipFile(sys.argv[1])\n"
        + "print(json.dumps({'names': sorted(z.namelist()), 'manifest': json.loads(z.read('manifest.json')),\n"
        + "    'sha256': {n: hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist()}}))";
    return JSON.parse(execFileSync("python3", ["-c", script, zip], { encoding: "utf8" }));
}

/** The SHA-256 of a bundle file as the test server stores it, or null without its container. */
function stored(bundleId) {
    if (!CONTAINER || !LIBRARY) return null;
    return execFileSync("docker", ["exec", CONTAINER, "sha256sum", `${LIBRARY}/bundles/${bundleId}.json`],
        { encoding: "utf8" }).split(" ")[0];
}

(async () => {
    const session = await startSession("export");
    const { page, ev, check, shot, out, finish } = session;
    const overlay = page.locator(".bl-overlay");
    const button = (name, scope = overlay) => scope.getByRole("button", { name, exact: true });
    const until = (fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
    const api = (method, route, body) => ev(([m, r, b]) => window.__bl.request(m, r, b), [method, route, body ?? null]);
    const row = (id) => page.locator(`.bl-overlay .bl-list-item[data-id="${id}"]`).first();
    const command = (id) => ev((c) => window.__bl.app.extensionManager.command.execute(c), id);
    const result = () => ev(() => {
        const box = document.querySelector(".bl-overlay .bl-batch-result:not(.waiting)");
        return box ? { title: box.querySelector(".bl-batch-title")?.textContent ?? null,
            summary: box.querySelector(".bl-batch-summary")?.textContent ?? null,
            skipped: [...box.querySelectorAll('[data-outcome="skipped"] .bl-batch-outcome-row')].map((r) => r.textContent),
            link: box.querySelector(".bl-export-download")?.getAttribute("href") ?? null } : null;
    });
    /** Click `trigger` and take the download it starts: its file name and the saved file. */
    const download = async (trigger) => {
        const [file] = await Promise.all([page.waitForEvent("download", { timeout: 20000 }), trigger()]);
        const saved = path.join(out, file.suggestedFilename());
        await file.saveAs(saved);
        return { name: file.suggestedFilename(), path: saved };
    };

    const shelf = await api("POST", "/categories", { name: `${PREFIX} shelf` });
    const make = async (name, color, category = null) => (await api("POST", "/bundles", {
        name, tags: ["test"], category, fields: [await ev(([c, l]) => window.__bl.image("ref", c, l), [color, name]),
            { name: "prompt", type: "text", value: name }] })).id;
    const ids = { one: await make(`${PREFIX} one`, "#b3261e", shelf.id), two: await make(`${PREFIX} two`, "#1a56db"),
        three: await make(`${PREFIX} three`, "#15803d") };

    await command("BundleLibrary.Open");
    await overlay.waitFor();
    await page.locator(".bl-overlay .bl-search").fill(PREFIX);
    await until(() => document.querySelectorAll(".bl-overlay .bl-list-item").length >= 3);

    // ---- several bundles from the batch panel -----------------------------------------------------------
    await row(ids.one).click();
    await row(ids.two).click({ modifiers: ["Control"] });
    await button("Export ZIP").waitFor();
    let file = await download(() => button("Export ZIP").click());
    let zip = inspect(file.path);
    let shown = await result();
    const entries = zip.manifest.bundles;
    check("Export ZIP downloads the selected bundles, the files they use and a manifest",
        /^bundle-library-\d{8}-\d{6}\.zip$/.test(file.name) && JSON.stringify(entries.map((b) => b.id).sort())
            === JSON.stringify([ids.one, ids.two].sort()) && zip.manifest.assets.length === 2
        && zip.manifest.format === "comfyui-bundle-library/export", { name: file.name, names: zip.names });
    check("the manifest names each bundle's category and the hash of its file as it is in the ZIP",
        entries.find((b) => b.id === ids.one)?.category === `${PREFIX} shelf` && entries.find((b) => b.id === ids.two)?.category === null
        && entries.every((b) => zip.sha256[b.file] === b.sha256), entries);
    if (CONTAINER && LIBRARY) {
        check("each bundle file in the ZIP is the stored file byte for byte",
            entries.every((b) => b.sha256 === stored(b.id)), entries.map((b) => [b.id, b.sha256, stored(b.id)]));
    } else {
        check("each bundle file in the ZIP is the stored file (skipped: no BL_TEST_CONTAINER/BL_TEST_LIBRARY)", true);
    }
    check("the result says what went and offers the download again",
        shown?.title === "Exported" && shown.summary.startsWith("2 bundles and 2 files") && shown.summary.endsWith(file.name)
        && /\/export\/[A-Za-z0-9_-]{22}\?name=/.test(shown.link ?? ""), shown);
    await shot("export-result.png");
    await button("Done").click();

    // ---- a bundle gone to the trash since it was selected ----------------------------------------------
    await row(ids.three).click({ modifiers: ["Control"] });
    await until(() => document.querySelectorAll(".bl-overlay .bl-batch-name").length === 3);
    const before = await api("GET", `/bundles/${ids.two}`);
    await api("DELETE", `/bundles/${ids.two}?expected_revision=${before.revision}`); // as from another tab
    file = await download(() => button("Export ZIP").click());
    zip = inspect(file.path);
    shown = await result();
    check("a bundle in the trash by then is left out, with the reason",
        zip.manifest.bundles.length === 2 && !zip.manifest.bundles.some((b) => b.id === ids.two)
        && shown?.skipped.length === 1 && shown.skipped[0].includes("In the trash."), { shown, bundles: zip.manifest.bundles.length });
    await button("Done").click();
    await page.keyboard.press("Escape"); // the selection

    // ---- one bundle from the editor ------------------------------------------------------------------------
    await row(ids.three).click();
    await until(() => document.querySelector(".bl-overlay .bl-name-input")?.value.endsWith("three"));
    const exportButton = page.locator(".bl-overlay .bl-export");
    file = await download(() => exportButton.click());
    zip = inspect(file.path);
    check("the editor's export button downloads that bundle, named after it",
        file.name === `${PREFIX} three.zip` && zip.manifest.bundles.length === 1 && zip.manifest.bundles[0].id === ids.three,
        { name: file.name });
    await button("Done").click();
    await until(() => document.querySelector(".bl-overlay .bl-name-input")?.value.endsWith("three"));
    await page.locator(".bl-overlay .bl-note-input").fill("not saved");
    const dirty = await ev(() => {
        const b = document.querySelector(".bl-overlay .bl-export");
        return { disabled: b.disabled, title: b.title };
    });
    check("with changes in the editor it waits: the draft is not what would go", dirty.disabled
        && dirty.title === "Save or revert your changes first", dirty);
    await button("Revert").click();

    await page.keyboard.press("Escape");
    await finish({ expectRemoved: 2 }); // the third is in the trash: its entry is removed there
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
