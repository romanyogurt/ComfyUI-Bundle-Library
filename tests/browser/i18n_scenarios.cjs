// Browser scenarios for the Korean screens (Phase 9a): with ComfyUI's language
// set to Korean (Comfy.Locale "ko"), the node panel, the sidebar, the library
// window, the editor, the panes, the questions and the results show the text
// of the Korean catalog (locales/ko/bundle_library.json, which the page gets
// from the server), and no English text of the English catalog is left in view:
// not in the text, nor in a title, aria-label or placeholder. ComfyUI's own
// translations of the pack (locales/ko) name the node and the command. Checked
// as DOM text: headless Chromium has no Korean font. The English screens are
// the other suites'. Last, the catalogs when the server does not give them at
// first (R31-02). Set-up and safety notes are in harness.cjs.
const fs = require("fs");
const path = require("path");
const { startSession } = require("./harness.cjs");

const PREFIX = "[test] I18n";
const MODULE = "/extensions/ComfyUI-Bundle-Library";
// The requests for the catalogs refused on purpose (R31-02)
const BUSY = { text: /^Failed to load resource: the server responded with a status of 503 /,
    url: /\/api\/bundle-library\/v1\/messages/ };

(async () => {
    const read = (lang) => JSON.parse(fs.readFileSync(path.join(__dirname, `../../locales/${lang}/bundle_library.json`), "utf8"));
    const [EN, KO] = [read("en"), read("ko")];
    // The English texts that Korean shows otherwise (each form of a message, unless its Korean is the same): exact
    // ones, and those with places as patterns (only when enough of their own words are left to tell them apart).
    const forms = (message) => (typeof message === "string" ? [message] : Object.values(message ?? {}));
    const english = Object.entries(EN).flatMap(([id, message]) => forms(message).filter((text) => !forms(KO[id]?.text).includes(text)));
    const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const exact = new Set(english.filter((k) => !/\{\w+\}/.test(k)).map((k) => k.trim()));
    const patterns = english.filter((k) => /\{\w+\}/.test(k) && k.replace(/\{\w+\}|[^A-Za-z]/g, "").length >= 4)
        .map((k) => new RegExp(`^${k.trim().split(/\{\w+\}/).map(escape).join(".+?")}$`, "s"));
    const isEnglish = (text) => exact.has(text) || patterns.some((p) => p.test(text));

    const session = await startSession("i18n", { expectedErrors: [BUSY] });
    const { page, ev, check, finish } = session;
    const overlay = page.locator(".bl-overlay");
    const button = (name, scope = overlay) => scope.getByRole("button", { name, exact: true });
    const until = (fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
    const api = (method, route, body) => ev(([m, r, b]) => window.__bl.request(m, r, b), [method, route, body ?? null]);
    const command = (id) => ev((c) => window.__bl.app.extensionManager.command.execute(c), id);
    const row = (id) => page.locator(`.bl-overlay .bl-list-item[data-id="${id}"]`).first();
    /**
     * Every text a user may read under `selector` ("node": the node's panel, which ComfyUI attaches only when it
     * draws the canvas): the text in view, and titles, labels and placeholders.
     */
    const texts = (selector) => ev((sel) => {
        const found = [];
        const roots = sel === "node" ? [window.__node.bundlePanel.root] : document.querySelectorAll(sel);
        for (const root of roots) {
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                const text = node.textContent.trim();
                if (text && !node.parentElement?.closest("[hidden]")) found.push(text);
            }
            for (const element of [root, ...root.querySelectorAll("[title], [aria-label], [placeholder]")]) {
                for (const name of ["title", "aria-label", "placeholder"]) {
                    const value = element.getAttribute(name)?.trim();
                    if (value) found.push(value);
                }
            }
        }
        return [...new Set(found)];
    }, selector);
    /** Check that what `selector` shows has no English of the dictionary left, and has `korean` in it. */
    const korean = async (label, selector, expected) => {
        const seen = await texts(selector);
        const left = seen.filter(isEnglish);
        const missing = expected.filter((text) => !seen.includes(text));
        check(`${label}: in Korean, no English of the dictionary left`, seen.length > 0 && !left.length && !missing.length,
            { left, missing });
    };

    // ---- data, and ComfyUI in Korean -------------------------------------------------------------------
    const shelf = await api("POST", "/categories", { name: `${PREFIX} shelf` });
    const make = async (name, fields, category = null) => (await api("POST", "/bundles", {
        name, tags: ["test"], category, fields })).id;
    const ids = {
        A: await make(`${PREFIX} A`, [await ev(() => window.__bl.image("ref", "#7c3aed", "A")), { name: "prompt", type: "text",
            value: "a" }], shelf.id),
        B: await make(`${PREFIX} B`, [{ name: "prompt", type: "text", value: "b" }]),
    };
    await api("PUT", `/bundles/${ids.A}/favorite`, { favorite: true });
    // ComfyUI in Korean from the start, as a user's own setting has it: the page reads its settings with the
    // language set (writes of settings stay blocked), so ComfyUI names the nodes in Korean as it loads them.
    const speak = (lang) => page.route("**/api/settings", async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        const response = await route.fetch();
        return route.fulfill({ response, json: { ...(await response.json()), "Comfy.Locale": lang } });
    });
    await speak("ko");
    await session.reload();
    const locale = await ev(async (module) => (await import(`${module}/i18n.js`)).locale(), MODULE);
    check("the pack follows ComfyUI's language setting", locale === "ko", locale);
    const sent = await ev(async () => (await window.__bl.request("GET", "/messages?lang=ko")).messages);
    check("the server sends the catalogs of English and Korean, a translation as its text alone",
        sent?.en?.["trash.empty_confirm"] === "Empty the trash?" && sent?.ko?.["trash.empty_confirm"] === "휴지통을 비울까요?",
        sent && Object.keys(sent));
    const served = await ev(async () => (await (await fetch("/i18n")).json()).ko ?? null);
    check("ComfyUI serves the pack's own Korean (locales/ko): the node and the command",
        served?.nodeDefs?.BundleLibraryLoad?.display_name === "번들 불러오기"
        && served?.commands?.BundleLibrary_Open?.label === "Bundle Library 열기", served && Object.keys(served));

    // ---- the node --------------------------------------------------------------------------------------
    const node = await ev(() => {
        window.__node = window.__bl.add("BundleLibraryLoad", [80, 80]);
        return { title: window.__node.title };
    });
    await ev((id) => window.__bl.pick(window.__node, id), ids.A);
    await until(() => window.__node.bundlePanel.root.querySelector(".bl-tile"));
    await korean("the node's panel", "node", ["미리 보기 숨기기", "Bundle Library 열기"]);
    check("a new node is named in Korean by ComfyUI (locales/ko)", node.title === "번들 불러오기", node);

    // ---- the sidebar ------------------------------------------------------------------------------------
    await command("Workspace.ToggleSidebarTab.bundle-library");
    await until(() => document.querySelector(".bl-sidebar-group"));
    await korean("the sidebar", ".bl-sidebar", ["★ 즐겨찾기", "라이브러리 열기"]);
    await command("Workspace.ToggleSidebarTab.bundle-library");

    // ---- the window, the list and the editor -------------------------------------------------------------
    await command("BundleLibrary.Open");
    await overlay.waitFor();
    await page.locator(".bl-overlay .bl-search").fill(PREFIX);
    await until((n) => document.querySelectorAll(".bl-overlay .bl-list-item").length >= n, 3);
    await korean("the window and its list", ".bl-overlay", ["+ 새 번들", "이름·태그·필드·텍스트 검색",
        "왼쪽에서 번들을 고르거나, + 새 번들로 만드세요.", "새 카테고리", "ZIP에서 번들 가져오기", "휴지통"]);
    await row(ids.A).click();
    await until(() => document.querySelector(".bl-overlay .bl-name-input")?.value.endsWith(" A"));
    await korean("the editor", ".bl-overlay", ["저장", "되돌리기", "복제", "삭제", "저장됨", "카테고리", "+ 태그", "메모 (선택)",
        "+ 필드 추가 ▾", "이미지", "텍스트"]);
    await page.locator(".bl-overlay .bl-note-input").fill("changed");
    await korean("an editor with changes", ".bl-overlay", ["● 저장하지 않은 변경", "먼저 변경을 저장하거나 버리세요."]);
    await button("되돌리기").click();
    await button("+ 필드 추가 ▾").click();
    await korean("the menu of field types", ".bl-overlay", ["텍스트", "정수", "불리언 (참/거짓)"]);
    await page.keyboard.press("Escape");
    await button("라이브러리에서 고르기…", page.locator(".bl-overlay .bl-field").nth(0)).click();
    await until(() => document.querySelector(".bl-overlay .bl-picker-tile"));
    await korean("the picker of stored files", ".bl-overlay .bl-picker", ["라이브러리에서 이미지 고르기", "지금 파일",
        "파일·번들 이름으로 거르기"]);
    await page.keyboard.press("Escape");

    // ---- several bundles, and the export --------------------------------------------------------------------
    await row(ids.B).click({ modifiers: ["Control"] });
    await until(() => document.querySelectorAll(".bl-overlay .bl-batch-name").length === 2);
    await korean("the panel of several bundles", ".bl-overlay", ["번들 2개 선택됨", "★ 즐겨찾기에 추가", "ZIP으로 내보내기",
        "휴지통으로 옮기기…"]);
    const [download] = await Promise.all([page.waitForEvent("download", { timeout: 20000 }),
        button("ZIP으로 내보내기").click()]);
    const zip = path.join(session.out, "i18n.zip");
    await download.saveAs(zip);
    await until(() => document.querySelector(".bl-overlay .bl-batch-result:not(.waiting)"));
    await korean("the export's result", ".bl-overlay", ["내보냈습니다", "다시 내려받기", "확인"]);
    await button("확인").click();
    await page.keyboard.press("Escape"); // the selection

    // ---- the import's preview ---------------------------------------------------------------------------------
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.locator(".bl-overlay .bl-import-button").click()]);
    await chooser.setFiles(zip);
    await until(() => document.querySelector(".bl-overlay .bl-import-go"), undefined, 30000);
    await korean("the import's preview", ".bl-overlay", ["이미 있음", "그대로 두기", "파일에 적힌 대로 (같은 이름의 카테고리, 없으면 만듦)",
        "번들 2개 가져오기"]);
    await button("취소").click();

    // ---- tags, trash, and the questions ----------------------------------------------------------------------
    await page.locator(".bl-overlay .bl-tag-button, .bl-overlay [aria-label='태그로 거르기']").first().click();
    await page.getByRole("menuitem", { name: "태그 관리…" }).click();
    await until(() => document.querySelector(".bl-overlay .bl-tags-panel [data-tag]"));
    await korean("the tags pane", ".bl-overlay", ["태그", "이름 바꾸기…", "삭제…"]);
    await page.locator('.bl-overlay [data-tag="test"]').getByRole("button", { name: "이름 바꾸기…" }).click();
    await until(() => document.querySelector(".bl-overlay .bl-layer"));
    await korean("a question", ".bl-overlay .bl-layer", ["'test' 이름 바꾸기", "다음", "취소"]);
    await button("취소", page.locator(".bl-overlay .bl-layer")).click();
    await page.locator(".bl-overlay .bl-trash-button").click();
    await until(() => document.querySelector(".bl-overlay .bl-trash .bl-hint"));
    await korean("the trash", ".bl-overlay", ["휴지통", "휴지통 비우기", "쓰이지 않는 파일 정리…"]);
    await button("쓰이지 않는 파일 정리…").click();
    await until(() => document.querySelector(".bl-overlay .bl-layer"));
    await korean("the clean-up question", ".bl-overlay .bl-layer", ["쓰이지 않는 파일 정리"]);
    await page.keyboard.press("Escape");
    await page.locator(".bl-overlay .bl-new-category").click();
    await until(() => document.querySelector(".bl-overlay .bl-layer"));
    await korean("the new-category question", ".bl-overlay .bl-layer", ["새 카테고리", "카테고리 이름", "만들기"]);
    await page.keyboard.press("Escape");
    await row(ids.B).click();
    await until(() => document.querySelector(".bl-overlay .bl-name-input")?.value.endsWith(" B"));
    await button("삭제").click();
    await until(() => document.querySelector(".bl-overlay .bl-layer"));
    await korean("the delete question", ".bl-overlay .bl-layer", [`'${PREFIX} B' 번들을 지울까요?`, "삭제", "취소"]);
    await button("취소", page.locator(".bl-overlay .bl-layer")).click();

    // ---- what the server says, in Korean too (Phase 9b) -------------------------------------------------
    await page.locator(".bl-overlay .bl-new-category").click();
    await until(() => document.querySelector(".bl-overlay .bl-layer .bl-ask-input"));
    await page.locator(".bl-overlay .bl-layer .bl-ask-input").fill(`${PREFIX} shelf`);
    await button("만들기", page.locator(".bl-overlay .bl-layer")).click();
    await until(() => document.querySelector(".bl-overlay .bl-layer .bl-error")?.textContent);
    const refused = await ev(() => document.querySelector(".bl-overlay .bl-layer .bl-error").textContent);
    check("a refusal of the server is said in Korean, the name in it as it is",
        refused === `'${PREFIX} shelf' 카테고리가 이미 있습니다.`, refused);
    await page.keyboard.press("Escape");
    await row(ids.A).click();
    await row(ids.B).click({ modifiers: ["Control"] });
    await until(() => document.querySelectorAll(".bl-overlay .bl-batch-name").length === 2);
    const b = await api("GET", `/bundles/${ids.B}`);
    await api("DELETE", `/bundles/${ids.B}?expected_revision=${b.revision}`); // as from another tab
    await Promise.all([page.waitForEvent("download", { timeout: 20000 }), button("ZIP으로 내보내기").click()]);
    await until(() => document.querySelector(".bl-overlay .bl-batch-result:not(.waiting) [data-outcome='skipped']"));
    const skipped = await ev(() => document.querySelector(".bl-overlay [data-outcome='skipped'] .bl-dim")?.textContent);
    check("a bundle's reason from the server is said in Korean", skipped === "휴지통에 있습니다.", skipped);
    await korean("the export's result with a bundle left out", ".bl-overlay", ["빠짐 (1)"]);
    await button("확인").click();

    await page.keyboard.press("Escape");
    await ev(() => window.__bl.app.graph.clear());

    // ---- the catalogs when the server does not give them at first (R31-02, 0.0.32) ---------------------------
    let outage = 0; // how many of the next requests for catalogs to refuse
    let turnedAway = 0;
    await page.route("**/api/bundle-library/v1/messages*", (route) => {
        if (outage <= 0) return route.fallback();
        outage -= 1;
        turnedAway += 1;
        return route.fulfill({ status: 503, contentType: "text/plain", body: "busy" });
    });
    const NOTICE = "Could not load the messages of Bundle Library";
    const notices = () => ev(() => [...document.querySelectorAll(".p-toast-message")].map((e) => e.textContent).join(" | "));
    const sidebarButton = () => ev(() => document.querySelector(".bl-sidebar .bl-btn.primary")?.textContent);
    const sidebarSays = (text, timeout) => until((t) => document.querySelector(".bl-sidebar .bl-btn.primary")?.textContent === t,
        text, timeout);
    outage = 1;
    await session.reload();
    await command("BundleLibrary.Open");
    await overlay.waitFor();
    const newButton = await ev(() => document.querySelector(".bl-overlay .bl-new")?.textContent);
    check("one request for the catalogs refused at the start: asked again there, the text as always",
        turnedAway === 1 && newButton === "+ 새 번들" && !(await notices()).includes(NOTICE), { turnedAway, newButton });
    await page.keyboard.press("Escape");

    outage = Infinity; // until the page has drawn without them
    turnedAway = 0;
    await session.reload();
    const told = await notices();
    check("refused through the start: the page says so, once (in English: its catalog is what did not come)",
        turnedAway >= 3 && told.split(NOTICE).length === 2, { turnedAway, told });
    await ev(() => {
        window.__node = window.__bl.add("BundleLibraryLoad", [80, 80]);
    });
    await ev((id) => window.__bl.pick(window.__node, id), ids.A);
    await until(() => window.__node.bundlePanel.root.querySelector(".bl-tile"));
    await command("Workspace.ToggleSidebarTab.bundle-library");
    await until(() => document.querySelector(".bl-sidebar-group"));
    const meanwhile = [await sidebarButton(), await ev(() => window.__node.bundlePanel.toggle.title)];
    outage = 0;
    const came = await sidebarSays("라이브러리 열기", 40000); // the next try is 5, 15 or 30 seconds after the last
    check("meanwhile the ids show; asked again later, the catalogs are drawn without a reload",
        meanwhile.join() === "library.open,node.preview_hide" && came, { meanwhile, turnedAway });
    await korean("the node's panel when the catalogs came", "node", ["미리 보기 숨기기", "Bundle Library 열기"]);
    await until(() => document.querySelector(".bl-sidebar-group")); // the tab is drawn again: its list comes after its button
    await korean("the sidebar when the catalogs came", ".bl-sidebar", ["★ 즐겨찾기", "라이브러리 열기"]);
    await command("Workspace.ToggleSidebarTab.bundle-library");
    await ev(() => window.__bl.app.graph.clear());

    // A language chosen later comes the same way: the page in English, then Korean while it is refused twice
    await page.unroute("**/api/settings");
    await speak("en");
    await session.reload();
    outage = 2;
    turnedAway = 0;
    await ev(async (module) => (await import(`${module}/i18n.js`)).useLocale(() => "ko"), MODULE);
    await command("Workspace.ToggleSidebarTab.bundle-library");
    await until(() => document.querySelector(".bl-sidebar-group"));
    const first = await sidebarButton();
    const cameLater = await sidebarSays("라이브러리 열기", 15000);
    check("a language chosen later: English until its catalog came, asked again, then the tab in it",
        first === "Open library" && cameLater && turnedAway === 2, { first, turnedAway });
    await command("Workspace.ToggleSidebarTab.bundle-library");

    await finish({ expectRemoved: 1 }); // B is in the trash: its entry is removed there
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
