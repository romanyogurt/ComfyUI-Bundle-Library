// Browser scenarios for answers that arrive late or out of order (Phase 6.5):
// opening bundles, searching, saving and uploading in the library modal.
// Chosen requests are sent at once but their answers are held back until the
// scenario releases them, so the page sees a stale answer after a newer one.
// Set-up and safety notes are in harness.cjs.
const { startSession } = require("./harness.cjs");

const API = "/api/bundle-library/v1";

const RACE_HELPERS = () => {
    const $ = (selector, root = document) => root.querySelector(selector);
    window.__race = {
        pane: () => $(".bl-overlay .bl-modal-editor > .bl-empty-state")?.textContent ?? null,
        selected: () => $(".bl-overlay .bl-list-item.selected")?.dataset.id ?? null,
        items: () => [...document.querySelectorAll(".bl-overlay .bl-list-item")].map((item) => item.dataset.id),
        status: () => $(".bl-overlay .bl-status")?.textContent ?? null,
        state() {
            const editor = $(".bl-overlay .bl-editor");
            if (!editor) return null;
            const save = [...editor.querySelectorAll(".bl-editor-head > button")].find((b) => b.textContent === "Save");
            return {
                name: $(".bl-name-input", editor).value,
                state: $(".bl-state", editor).textContent,
                note: $(".bl-note-input", editor).value,
                inert: editor.inert,
                save: !save.disabled,
                saveTitle: save.title,
                focusInEditor: editor.contains(document.activeElement),
            };
        },
        card: (name) => $(`.bl-overlay .bl-field[data-field="${name}"]`),
        thumb(name) { return this.card(name)?.querySelector("img.bl-image-thumb")?.getAttribute("src") ?? null; },
        uploading(name) {
            const upload = this.card(name)?.querySelector(".bl-upload");
            return upload ? { text: upload.firstChild.textContent, bar: !!upload.querySelector("progress") } : null;
        },
        /** Drop a new image on the card of field `name`; resolves to the image's SHA-256. */
        async drop(name, color, label) {
            const file = await window.__bl.makeImage(color, label);
            const data = new DataTransfer();
            data.items.add(file);
            this.card(name).dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
            return window.__bl.sha256(file);
        },
    };
};

/**
 * Hold back the answers to the bundle-library requests that `match` picks
 * (by URL and method): each is sent at once, and its answer reaches the page
 * only after release(). Other requests pass untouched.
 */
async function holdAnswers(page, match) {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const held = [];
    const delivered = [];
    const handler = async (route) => {
        const request = route.request();
        if (!match(new URL(request.url()), request.method())) return route.fallback();
        held.push(request);
        const answer = await route.fetch();
        await gate;
        // The page may have given up on the request meanwhile (an aborted upload).
        delivered.push(await route.fulfill({ response: answer }).then(() => true, () => false));
    };
    await page.route(`**${API}/**`, handler);
    return {
        held,
        delivered,
        async release() {
            release();
            const end = Date.now() + 10000;
            while (delivered.length < held.length && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
            await page.waitForTimeout(300); // let the page handle what arrived
            await page.unroute(`**${API}/**`, handler);
        },
    };
}

(async () => {
    const session = await startSession("race");
    const { page, ev, check, shot, finish } = session;
    const ids = await ev(() => window.__bl.createTestBundles());
    await page.evaluate(RACE_HELPERS);
    const race = (fn, arg) => ev(fn, arg);
    const until = (fn, arg, timeout = 10000) =>
        page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
    /** Wait for a condition on this side (the held requests), not in the page. */
    const settle = async (predicate, timeout = 5000) => {
        const end = Date.now() + timeout;
        while (!predicate() && Date.now() < end) await page.waitForTimeout(50);
        return predicate();
    };
    const item = (id) => page.locator(`.bl-overlay .bl-list-item[data-id="${id}"]`);
    const overlay = page.locator(".bl-overlay");
    const button = (name, scope = overlay) => scope.getByRole("button", { name, exact: true });
    const note = page.locator(".bl-overlay .bl-note-input");
    const editing = (name) => until((n) => window.__race.state()?.name === n, name);
    const api = (method, route) => ev(([m, r]) => window.__bl.request(m, r), [method, route]);

    await ev(() => window.__bl.app.extensionManager.command.execute("BundleLibrary.Open"));
    await overlay.waitFor();
    await until((n) => window.__race.items().length >= n, 5);

    // ---- opening: a late answer does not replace a newer choice ----------------
    let hold = await holdAnswers(page, (url, method) => method === "GET" && url.pathname === `${API}/bundles/${ids.A}`);
    await item(ids.A).click();
    await until(() => window.__race.pane() === "Loading…");
    const loading = await race(() => ({ pane: window.__race.pane(), selected: window.__race.selected() }));
    check("opening a bundle shows Loading… with it selected, not the editor before it",
        loading.pane === "Loading…" && loading.selected === ids.A, loading);
    await item(ids.B).click();
    await editing("[test] B (blue)");
    await note.fill("edited while A was still loading");
    await hold.release();
    let st = await race(() => ({ ...window.__race.state(), selected: window.__race.selected() }));
    check("A's late answer is dropped: B stays open with the edit, selected",
        st.name === "[test] B (blue)" && st.note === "edited while A was still loading" && st.selected === ids.B
        && st.state === "● Unsaved changes", { name: st.name, note: st.note, selected: st.selected === ids.B });

    // ---- saving: the editor takes no input until the answer is in ----------------
    hold = await holdAnswers(page, (url, method) => method === "PUT" && url.pathname === `${API}/bundles/${ids.B}`);
    await button("Save").click();
    await until(() => window.__race.state()?.state === "Saving…");
    st = await race(() => window.__race.state());
    check("while saving the editor is locked and says Saving…",
        st.state === "Saving…" && st.inert && !st.save && !st.focusInEditor, st);
    await note.click({ force: true });
    await page.keyboard.type(" and more");
    st = await race(() => window.__race.state());
    check("typing during the save changes nothing", st.note === "edited while A was still loading", st.note);
    await page.keyboard.press("Escape");
    const kept = await race(() => ({ open: !!document.querySelector(".bl-overlay"), status: window.__race.status() }));
    check("Escape during the save keeps the modal open and says why",
        kept.open && kept.status === "Wait until the bundle is saved.", kept);
    await item(ids.C).click();
    await page.waitForTimeout(200);
    st = await race(() => ({ ...window.__race.state(), selected: window.__race.selected() }));
    check("another bundle does not open during the save", st.name === "[test] B (blue)" && st.selected === ids.B, st.name);
    await hold.release();
    await until(() => window.__race.state()?.state === "Saved");
    st = await race(() => window.__race.state());
    const stored = await api("GET", `/bundles/${ids.B}`);
    check("after the answer: Saved, unlocked, and the note is what was sent",
        st.state === "Saved" && !st.inert && st.note === "edited while A was still loading"
        && stored.note === "edited while A was still loading", { state: st.state, inert: st.inert, stored: stored.note });

    // ---- searching: a late answer does not replace a newer query ----------------
    const search = page.locator(".bl-overlay .bl-search");
    hold = await holdAnswers(page, (url, method) => method === "GET" && url.searchParams.get("q") === "Red dress");
    await search.fill("Red dress");
    const heldSearch = await settle(() => hold.held.length === 1);
    await search.fill("Cat mascot");
    const narrowed = await until((c) => JSON.stringify(window.__race.items()) === JSON.stringify([c]), ids.C);
    await hold.release();
    const listed = await race(() => window.__race.items());
    check("the list follows the last query even when an older answer comes after it",
        heldSearch && narrowed && JSON.stringify(listed) === JSON.stringify([ids.C]),
        { heldSearch, narrowed, listed: listed.length });
    await search.fill("");
    await until((n) => window.__race.items().length >= n, 5);

    // ---- uploads: only the file chosen last counts --------------------------------
    await item(ids.A).click();
    await editing("[test] A (red)");
    let first = true;
    hold = await holdAnswers(page, (url, method) => {
        if (method !== "POST" || url.pathname !== `${API}/assets`) return false;
        const take = first;
        first = false;
        return take; // only the first upload's answer is late
    });
    const older = await race(() => window.__race.drop("ref_1", "#0f766e", "older"));
    await settle(() => hold.held.length === 1);
    const during = await race(() => ({ uploading: window.__race.uploading("ref_1"), save: window.__race.state().saveTitle }));
    check("an upload shows its file, a progress bar and holds Save back",
        during.uploading?.text === "Uploading older.png…" && during.uploading.bar && during.save === "Wait for the upload to finish.",
        during);
    const newer = await race(() => window.__race.drop("ref_1", "#7c2d12", "newer"));
    await until((sha) => window.__race.thumb("ref_1")?.includes(sha), newer);
    await hold.release();
    const after = await race(() => ({ thumb: window.__race.thumb("ref_1"), uploading: window.__race.uploading("ref_1"),
        state: window.__race.state() }));
    check("the late answer of the older upload is dropped: the newer file stays",
        after.thumb?.includes(newer) && !after.thumb.includes(older) && after.uploading === null
        && after.state.save && after.state.saveTitle === "Save (Ctrl+S)", { thumb: after.thumb, uploading: after.uploading });

    // ---- cancelling an upload -----------------------------------------------------
    hold = await holdAnswers(page, (url, method) => method === "POST" && url.pathname === `${API}/assets`);
    await race(() => window.__race.drop("ref_2", "#4338ca", "cancelled"));
    await until(() => window.__race.uploading("ref_2") !== null);
    const thumbBefore = await race(() => window.__race.thumb("ref_2"));
    await button("Cancel upload", page.locator('.bl-overlay .bl-field[data-field="ref_2"]')).click();
    const cancelled = await race(() => ({ uploading: window.__race.uploading("ref_2"), thumb: window.__race.thumb("ref_2"),
        status: window.__race.status(), saveTitle: window.__race.state().saveTitle }));
    await hold.release();
    const settled = await race(() => window.__race.thumb("ref_2"));
    check("Cancel upload stops it: the field keeps its file and Save is free again",
        cancelled.uploading === null && cancelled.thumb === thumbBefore && settled === thumbBefore
        && cancelled.status === "Cancelled the upload of cancelled.png." && cancelled.saveTitle === "Save (Ctrl+S)", cancelled);

    // ---- removing a field stops its upload ------------------------------------------
    hold = await holdAnswers(page, (url, method) => method === "POST" && url.pathname === `${API}/assets`);
    await race(() => window.__race.drop("ref_2", "#be185d", "removed"));
    await until(() => window.__race.uploading("ref_2") !== null);
    await button("✕", page.locator('.bl-overlay .bl-field[data-field="ref_2"]')).click();
    await button("Remove", page.locator(".bl-overlay .bl-layer")).click();
    await hold.release();
    const removed = await race(() => ({ card: !!window.__race.card("ref_2"), state: window.__race.state() }));
    check("removing a field stops its upload; nothing is left waiting",
        !removed.card && removed.state.saveTitle === "Save (Ctrl+S)", removed.state);
    await shot("race-uploads.png");

    await button("Revert").click();
    await page.keyboard.press("Escape");
    await overlay.waitFor({ state: "detached" });
    const restored = await api("GET", `/bundles/${ids.A}`);
    check("nothing of the uploads reached the saved bundle",
        restored.revision === 1 && restored.fields.find((f) => f.name === "ref_2")?.asset !== null, restored.revision);
    await finish({ expectRemoved: 5 });
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
