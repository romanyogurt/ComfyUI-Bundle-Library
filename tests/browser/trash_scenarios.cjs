// Browser scenarios for the trash and the cleanup of unused files (Phase 7).
// Set-up and safety notes are in harness.cjs. What this scenario deletes for
// good must be its own: it empties the trash only when every entry is a
// bundle it made, and deletes unused files only when the list holds just the
// file it made. Deleting a file needs one older than the grace time: with
// BL_TEST_CONTAINER and BL_TEST_LIBRARY set (scripts/bundle-library-test-server.sh
// run sets them), the scenario back-dates its own file inside the test
// server's container; without them that step is skipped.
const { execFileSync } = require("child_process");
const { startSession } = require("./harness.cjs");

const KEPT = "[test] Trash kept";
const GONE = "[test] Trash gone";
const CONTAINER = process.env.BL_TEST_CONTAINER;
const LIBRARY = process.env.BL_TEST_LIBRARY;

const TRASH_HELPERS = () => {
    const $ = (selector, root = document) => root.querySelector(selector);
    window.__trash = {
        button: () => $(".bl-overlay .bl-trash-button")?.getAttribute("aria-label") ?? null,
        selected: () => !!$(".bl-overlay .bl-trash-button.selected"),
        rows: () => [...document.querySelectorAll(".bl-overlay .bl-trash-item")].map((row) => ({
            id: row.dataset.id,
            name: $(".bl-list-name", row).textContent,
            sub: $(".bl-list-sub", row).textContent,
            thumb: $("img", row)?.getAttribute("src") ?? null,
        })),
        empty: () => $(".bl-overlay .bl-trash .bl-empty-state")?.textContent ?? null,
        items: () => [...document.querySelectorAll(".bl-overlay .bl-list-item")].map((item) => item.dataset.id),
        status: () => $(".bl-overlay .bl-status")?.textContent ?? null,
        layer() {
            const layer = $(".bl-overlay .bl-layer");
            if (!layer) return null;
            return {
                title: $(".bl-confirm-title", layer)?.textContent ?? null,
                text: [...layer.querySelectorAll(".bl-confirm-text")].map((t) => t.textContent),
                files: [...layer.querySelectorAll(".bl-cleanup-file")].map((f) => f.dataset.sha256),
                buttons: [...layer.querySelectorAll("button")].map((b) => b.textContent),
            };
        },
    };
};

/** Back-date a stored file past the grace time, inside the test server's container. */
function age(sha256) {
    const script = "import glob, os, sys, time\nt = time.time() - 3 * 86400\n"
        + "for p in glob.glob(os.path.join(sys.argv[1], 'assets', 'sha256', sys.argv[2][:2], sys.argv[2] + '.*')):\n"
        + "    os.utime(p, (t, t))";
    execFileSync("docker", ["exec", CONTAINER, "python", "-c", script, LIBRARY, sha256]);
}

(async () => {
    const session = await startSession("trash");
    const { page, ev, check, shot, finish } = session;
    await page.evaluate(TRASH_HELPERS);
    const overlay = page.locator(".bl-overlay");
    const layerBox = page.locator(".bl-overlay .bl-layer");
    const button = (name, scope = overlay) => scope.getByRole("button", { name, exact: true });
    const row = (id) => page.locator(`.bl-overlay .bl-trash-item[data-id="${id}"]`);
    const until = (fn, arg, timeout = 10000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
    const api = (method, route, body) => ev(([m, r, b]) => window.__bl.request(m, r, b), [method, route, body]);
    const trashOf = async (id) => (await api("GET", "/trash")).trash.find((entry) => entry.id === id);
    const status = () => ev(() => window.__trash.status());
    const origin = new URL(page.url()).origin;
    const fileStatus = async (sha) => (await page.request.get(`${origin}/api/bundle-library/v1/assets/${sha}`)).status();

    // Two bundles, each with an image no other bundle has.
    const token = `${Date.now().toString(36)}`;
    const made = await ev(async ([kept, gone, token]) => {
        const b = window.__bl;
        const make = async (name, color) => {
            const bundle = await b.request("POST", "/bundles",
                { name, tags: ["test"], fields: [await b.image("ref", color, `${name.slice(-4)} ${token}`)] });
            return { id: bundle.id, sha: bundle.fields[0].asset.sha256 };
        };
        return { kept: await make(kept, "#0e7490"), gone: await make(gone, "#9d174d") };
    }, [KEPT, GONE, token]);
    const ours = new Set([made.kept.id, made.gone.id]);

    // ---- deleting puts a bundle in the trash ---------------------------------------
    await ev(() => window.__bl.app.extensionManager.command.execute("BundleLibrary.Open"));
    await overlay.waitFor();
    await until((id) => window.__trash.items().includes(id), made.kept.id);
    const countBefore = (await api("GET", "/trash")).trash.length;
    await page.locator(`.bl-overlay .bl-list-item[data-id="${made.kept.id}"]`).click();
    await until((name) => document.querySelector(".bl-overlay .bl-name-input")?.value === name, KEPT);
    await button("Delete", page.locator(".bl-overlay .bl-editor")).click();
    await button("Delete", layerBox).click();
    await until((name) => window.__trash.status() === `Deleted '${name}'. It is in the trash.`, KEPT);
    await until((n) => window.__trash.button() === `Trash (${n})`, countBefore + 1);
    const badge = await ev(() => document.querySelector(".bl-overlay .bl-trash-button .bl-count-badge").textContent);
    check("deleting a bundle says it is in the trash, and the trash button counts it",
        await ev(() => window.__trash.button()) === `Trash (${countBefore + 1})` && badge === String(countBefore + 1),
        { label: await ev(() => window.__trash.button()), badge });

    // ---- the trash view ---------------------------------------------------------------
    await button(`Trash (${countBefore + 1})`).click();
    let trashed = await trashOf(made.kept.id);
    await until((id) => window.__trash.rows().some((r) => r.id === id), trashed.id);
    let rows = await ev(() => window.__trash.rows());
    const kept = rows.find((r) => r.id === trashed.id);
    check("the trash lists the bundle: name, when it was deleted, its fields and a thumbnail",
        kept?.name === KEPT && /^Deleted \d{4}-\d\d-\d\d \d\d:\d\d · 1 field$/.test(kept.sub)
        && kept.thumb?.includes(made.kept.sha) && await ev(() => window.__trash.selected()), kept);
    await shot("trash.png");

    await button("Restore", row(trashed.id)).click();
    await until((id) => window.__trash.items().includes(id), made.kept.id);
    await until((id) => !window.__trash.rows().some((r) => r.id === id), trashed.id);
    check("Restore puts it back in the list under its id, and out of the trash",
        await status() === `Restored '${KEPT}'.` && (await api("GET", `/bundles/${made.kept.id}`)).name === KEPT,
        await status());

    // ---- restoring when another bundle has the name ------------------------------------
    let current = await api("GET", `/bundles/${made.kept.id}`);
    await api("DELETE", `/bundles/${made.kept.id}?expected_revision=${current.revision}`);
    const twin = await api("POST", "/bundles", { name: KEPT, tags: ["test"], fields: [] });
    ours.add(twin.id);
    trashed = await trashOf(made.kept.id);
    await button(await ev(() => window.__trash.button())).click(); // reads the trash again
    await until((id) => window.__trash.rows().some((r) => r.id === id), trashed.id);
    await button("Restore", row(trashed.id)).click();
    await until((id) => !window.__trash.rows().some((r) => r.id === id), trashed.id);
    await until((ids) => ids.every((id) => window.__trash.items().includes(id)), [made.kept.id, twin.id]);
    current = await api("GET", `/bundles/${made.kept.id}`);
    const labels = await ev((ids) => ids.map((id) => document.querySelector(
        `.bl-overlay .bl-list-item[data-id="${id}"] .bl-list-name`)?.textContent), [made.kept.id, twin.id]);
    check("a restored bundle keeps its id and name even when another bundle has the name; the list tells them apart",
        current.name === KEPT && current.id === made.kept.id && await status() === `Restored '${KEPT}'.`
        && labels.every((label) => label?.startsWith(`${KEPT} · `)) && labels[0] !== labels[1],
        { name: current.name, status: await status(), labels });

    // ---- deleting for good ---------------------------------------------------------------
    current = await api("GET", `/bundles/${made.gone.id}`);
    await api("DELETE", `/bundles/${made.gone.id}?expected_revision=${current.revision}`);
    trashed = await trashOf(made.gone.id);
    await button(await ev(() => window.__trash.button())).click();
    await until((id) => window.__trash.rows().some((r) => r.id === id), trashed.id);
    await button("Delete forever", row(trashed.id)).click();
    let layer = await ev(() => window.__trash.layer());
    check("Delete forever asks first", layer?.title === `Delete '${GONE}' for good?`
        && JSON.stringify(layer.buttons) === JSON.stringify(["Delete forever", "Cancel"]), layer);
    await button("Cancel", layerBox).click();
    check("Cancel keeps it in the trash", !!(await trashOf(made.gone.id)));
    await button("Delete forever", row(trashed.id)).click();
    await button("Delete forever", layerBox).click();
    await until((id) => !window.__trash.rows().some((r) => r.id === id), trashed.id);
    check("Delete forever removes it from the trash",
        !(await trashOf(made.gone.id)) && await status() === `Deleted '${GONE}' for good.`, await status());

    // ---- emptying the trash ----------------------------------------------------------------
    current = await api("GET", `/bundles/${twin.id}`);
    await api("DELETE", `/bundles/${twin.id}?expected_revision=${current.revision}`);
    await button(await ev(() => window.__trash.button())).click();
    await until(() => window.__trash.rows().length > 0);
    const { trash: before, errors } = await api("GET", "/trash");
    await button("Empty trash").click();
    layer = await ev(() => window.__trash.layer());
    const onlyOurs = !errors.length && before.every((entry) => ours.has(entry.id));
    if (onlyOurs) {
        await button("Empty trash", layerBox).click();
        await until(() => window.__trash.empty() === "The trash is empty.");
        const after = await api("GET", "/trash");
        check("Empty trash asks, then deletes every trashed bundle for good",
            layer?.title === "Empty the trash?" && after.trash.length === 0
            && await status() === `Emptied the trash: ${before.length} bundle${before.length === 1 ? "" : "s"} deleted for good.`
            && await ev(() => window.__trash.button()) === "Trash", { layer: layer?.title, status: await status() });
    } else {
        await button("Cancel", layerBox).click();
        const after = await api("GET", "/trash");
        check("Empty trash asks first (not emptied: the trash holds bundles this scenario did not make)",
            layer?.title === "Empty the trash?" && after.trash.length === before.length, layer?.title);
    }

    // ---- cleaning up unused files ------------------------------------------------------
    // The image of the bundle deleted for good is used by nothing now, but it is new.
    await button("Clean up unused files…").click();
    await until(() => window.__trash.layer() !== null);
    layer = await ev(() => window.__trash.layer());
    check("a file uploaded in the last 24 hours is kept even if unused",
        layer.title === "Clean up unused files" && !layer.files.includes(made.gone.sha)
        && layer.text.some((t) => / stored in the last 24 hours (is|are) kept: changes that are not saved yet may use them\.$/.test(t)),
        layer);
    await button(layer.buttons.at(-1), layerBox).click();
    if (CONTAINER && LIBRARY) {
        age(made.gone.sha);
        await button("Clean up unused files…").click();
        await until(() => window.__trash.layer() !== null);
        layer = await ev(() => window.__trash.layer());
        const onlyMine = JSON.stringify(layer.files) === JSON.stringify([made.gone.sha]);
        check("an older unused file is listed with its size, ready to delete",
            onlyMine && layer.text[0].startsWith("1 file (") && layer.buttons[0] === "Delete 1 file", layer);
        await shot("cleanup.png");
        if (onlyMine) {
            await button("Delete 1 file", layerBox).click();
            await until(() => /^Deleted 1 unused file \(/.test(window.__trash.status() ?? ""));
            check("Delete removes the file; the files in use stay",
                await fileStatus(made.gone.sha) === 404 && await fileStatus(made.kept.sha) === 200, await status());
        } else {
            await button("Cancel", layerBox).click();
        }
    } else {
        check("deleting an older unused file (skipped: no test server container to age the file in)", true);
    }

    await page.keyboard.press("Escape");
    await overlay.waitFor({ state: "detached" });
    await finish({ expectRemoved: 1 }); // the restored bundle; the others are gone for good
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
