// Browser scenarios for choice fields (0.2.0): the editor's card (a value typed
// or chosen from the source's options, the source chosen, changed or cleared,
// what is said of the value), saving, Revert and duplicating with the source,
// and the Load Bundle node: COMBO outputs, the source and what is wrong, also
// where the output goes. Set-up and safety notes are in harness.cjs.
const { startSession } = require("./harness.cjs");

const MODULE = "/extensions/ComfyUI-Bundle-Library";
const NAME = "[test] Choices";

// Read-outs of the editor's choice cards and of the source picker.
const CHOICE_HELPERS = () => {
    const $ = (selector, root = document) => root.querySelector(selector);
    window.__choice = {
        card: (name) => $(`.bl-overlay .bl-field[data-field="${name}"]`),
        read(name) {
            const card = this.card(name);
            if (!card) return null;
            const list = $(".bl-choice-list", card);
            return {
                value: $(".bl-choice-value", card).value,
                status: $(".bl-choice-status", card).textContent,
                state: $(".bl-choice-status", card).dataset.state,
                source: $(".bl-source-chip", card)?.firstChild?.textContent ?? null,
                canOpen: !$(".bl-choice-open", card).disabled,
                listOpen: !list.hidden,
                options: [...list.querySelectorAll(".bl-choice-option")].map((o) => o.textContent),
                current: $(".bl-choice-option.current", card)?.textContent ?? null,
                hint: $(".bl-choice-list .bl-hint", card)?.textContent ?? null,
            };
        },
        editorState: () => $(".bl-overlay .bl-state")?.textContent ?? null,
        picker() {
            const box = $(".bl-source-picker");
            if (!box) return null;
            return {
                note: $(".bl-picker-note", box).hidden ? "" : $(".bl-picker-note", box).textContent,
                nodes: [...box.querySelectorAll(".bl-source-node")].map((n) => n.dataset.node),
            };
        },
    };
};

(async () => {
    const session = await startSession("choice");
    const { page, ev, check, shot } = session;
    await page.addInitScript(CHOICE_HELPERS);
    await ev(CHOICE_HELPERS);
    const api = (method, route, body) => ev(([m, r, b]) => window.__bl.request(m, r, b), [method, route, body]);
    const read = (name) => ev((n) => window.__choice.read(n), name);
    const card = (name) => page.locator(`.bl-overlay .bl-field[data-field="${name}"]`);
    const settle = (ms = 400) => page.waitForTimeout(ms);
    const until = async (predicate, arg, timeout = 8000) => {
        await page.waitForFunction(predicate, arg, { timeout }).catch(() => {});
    };

    const fields = [
        { name: "sampler", type: "choice", value: "euler", source: { node: "KSampler", input: "sampler_name" } },
        { name: "lora", type: "choice", value: "missing.safetensors", source: { node: "LoraLoader", input: "lora_name" } },
        { name: "style", type: "choice", value: "warm" },
        { name: "elsewhere", type: "choice", value: "x", source: { node: "Gone Pack (x)", input: "model" } },
        { name: "prompt", type: "text", value: "a cat" },
    ];
    const id = (await api("POST", "/bundles", { name: NAME, tags: ["test"], fields })).id;
    await ev(async ([module, bundle]) => (await import(`${module}/library_modal.js`)).openLibrary({ selected: bundle }),
        [MODULE, id]);
    await until(() => window.__choice?.read("sampler")?.state === "ok"
        && window.__choice.read("lora")?.state === "mismatch" && window.__choice.read("elsewhere")?.state === "not_found");

    // ---- what each card says of its value (CH06) ------------------------------------------------
    let sampler = await read("sampler");
    check("a choice among its source's options says so, and offers them",
        sampler.state === "ok" && /^One of the options \(\d+ on this ComfyUI\)\.$/.test(sampler.status) && sampler.canOpen
        && sampler.source === "KSampler › sampler_name", sampler);
    const lora = await read("lora");
    check("one whose source has no options here says so, with ⚠; saving is not held back",
        lora.state === "mismatch" && lora.status.startsWith("⚠ Load LoRA (Model and CLIP) › lora_name has no options")
        && !lora.canOpen, lora);
    const style = await read("style");
    check("one typed freely says it is not checked, and offers to choose a source",
        style.state === "no_source" && style.status.startsWith("Typed freely") && style.source === null
        && await card("style").locator(".bl-choice-pick").textContent() === "Options from…", style);
    const elsewhere = await read("elsewhere");
    check("one whose source this ComfyUI does not have cannot be checked, and says why",
        elsewhere.state === "not_found" && elsewhere.status === "Can't check: this ComfyUI has no node Gone Pack (x)."
        && elsewhere.source === "Gone Pack (x) › model", elsewhere);
    check("reading the options is no change", await ev(() => window.__choice.editorState()) === "Saved");
    await shot("choice-cards.png");

    // ---- the list: all options at first, narrowed by typing; the value kept until one is taken (CH07) --
    await card("sampler").locator(".bl-choice-open").click();
    sampler = await read("sampler");
    check("the list opens with every option, the value marked", sampler.listOpen && sampler.options.length > 10
        && sampler.current === "euler", { count: sampler.options.length, current: sampler.current });
    await shot("choice-list.png");
    await page.keyboard.press("Escape");
    check("Escape closes the list only, not the library", !(await read("sampler")).listOpen
        && await ev(() => !!document.querySelector(".bl-overlay")));
    const box = card("sampler").locator(".bl-choice-value");
    await box.fill("dpmpp_2m");
    sampler = await read("sampler");
    check("a value typed is checked as it is typed", sampler.state === "ok" && sampler.value === "dpmpp_2m", sampler);
    await box.fill("dpmpp_2");
    sampler = await read("sampler");
    check("typing opens the list", sampler.listOpen, sampler.options.length);
    await box.press("Escape");
    await box.press("ArrowDown"); // opens it again, still narrowed by what was typed
    sampler = await read("sampler");
    const narrowed = sampler.options;
    check("typed text narrows the list", narrowed.length > 1 && narrowed.every((o) => o.includes("dpmpp_2")), narrowed);
    await box.press("ArrowDown");
    await box.press("Enter");
    sampler = await read("sampler");
    check("↓ and Enter take an option", sampler.value === narrowed[0] && !sampler.listOpen && sampler.state === "ok", sampler);
    await box.fill("dpmpp_2m_typo");
    sampler = await read("sampler");
    check("a value not among the options is kept, with ⚠", sampler.value === "dpmpp_2m_typo" && sampler.state === "mismatch"
        && sampler.status.startsWith("⚠ Not among the options of KSampler › sampler_name"), sampler);
    check("a changed value is a change", (await ev(() => window.__choice.editorState())) === "● Unsaved changes");

    // ---- choosing a source keeps the value (CH07) ---------------------------------------------------
    await card("style").locator(".bl-choice-pick").click();
    await until(() => (window.__choice.picker()?.nodes.length ?? 0) > 10);
    let picker = await ev(() => window.__choice.picker());
    check("the source picker lists the nodes with a dropdown, the first 80 drawn",
        picker.nodes.length === 80 && /^\d+ more nodes: filter to find them\.$/.test(picker.note), picker.note);
    await page.locator(".bl-source-picker .bl-picker-filter").fill("ksampler");
    picker = await ev(() => window.__choice.picker());
    check("its filter finds nodes by name", picker.nodes.includes("KSampler") && picker.nodes.includes("KSamplerSelect"),
        picker.nodes);
    const seed = page.locator('.bl-source-picker .bl-source-node[data-node="KSampler"] .bl-source-input[data-input="seed"]');
    check("an input a choice cannot take options from is not offered", await seed.count() === 0);
    await shot("choice-picker.png");
    await page.locator('.bl-source-picker .bl-source-node[data-node="KSampler"] .bl-source-input[data-input="scheduler"]').click();
    await until(() => window.__choice.read("style")?.state === "mismatch");
    let styled = await read("style");
    check("a source chosen: the value stays, and is checked against its options",
        styled.value === "warm" && styled.source === "KSampler › scheduler" && styled.state === "mismatch", styled);
    await card("style").locator(".bl-source-chip .bl-chip-x").click();
    styled = await read("style");
    check("the source cleared: the value stays, typed freely", styled.value === "warm" && styled.state === "no_source"
        && styled.source === null, styled);

    // ---- Revert, Save, and the source kept by both duplicates (CH07) ------------------------------
    await page.locator(".bl-overlay .bl-revert").click();
    await until(() => window.__choice.read("sampler")?.value === "euler" && window.__choice.read("sampler")?.state === "ok");
    check("Revert brings back the values and sources as saved", (await read("sampler")).value === "euler"
        && (await read("style")).source === null && (await ev(() => window.__choice.editorState())) === "Saved");
    await card("style").locator(".bl-choice-pick").click();
    await until(() => (window.__choice.picker()?.nodes.length ?? 0) > 10);
    await page.locator(".bl-source-picker .bl-picker-filter").fill("KSamplerSelect");
    await page.locator('.bl-source-picker .bl-source-node[data-node="KSamplerSelect"] .bl-source-input[data-input="sampler_name"]').click();
    await until(() => window.__choice.read("style")?.state === "mismatch");
    check("a source given, nothing else changed, is a change to save",
        (await ev(() => window.__choice.editorState())) === "● Unsaved changes");
    await page.locator(".bl-overlay .bl-save").click();
    await until(() => window.__choice.editorState() === "Saved");
    const saved = await api("GET", `/bundles/${id}`);
    check("saved with its source; the value as it was",
        JSON.stringify(saved.fields[2]) === JSON.stringify({ name: "style", type: "choice", value: "warm",
            source: { node: "KSamplerSelect", input: "sampler_name" } }) && saved.schema_version === 4, saved.fields[2]);
    const copy = await api("POST", `/bundles/${id}/duplicate`, { mode: "structure" });
    check("duplicated without values, a choice keeps its source", copy.fields[0].value === ""
        && JSON.stringify(copy.fields[0].source) === JSON.stringify(fields[0].source), copy.fields[0]);
    await page.keyboard.press("Escape");
    await settle();

    // ---- the node: COMBO outputs, the source, and what is wrong where it goes (CH07) --------------
    const node = await ev(async ([bundle]) => {
        const load = window.__bl.add("BundleLibraryLoad", [100, 100]);
        await window.__bl.pick(load, bundle);
        window.__node = load;
        return window.__bl.outs(load);
    }, [id]);
    check("the choices are COMBO outputs", JSON.stringify(node.slice(0, 4).map((o) => o.type))
        === JSON.stringify(["COMBO", "COMBO", "COMBO", "COMBO"]) && node[4].type === "STRING", node);
    const blocks = () => ev(() => Object.fromEntries([...window.__node.bundlePanel.rows.querySelectorAll(".bl-choice-block")]
        .map((b) => [b.dataset.field, [...b.children].map((c) => c.textContent)])));
    await until(() => window.__node.bundlePanel.rows.querySelector('.bl-choice-block[data-field="elsewhere"] .bl-choice-note'));
    let shown = await blocks();
    check("the preview shows each choice's value and source", JSON.stringify(shown.sampler)
        === JSON.stringify(["samplereuler", "KSampler › sampler_name"]), shown);
    check("…one not among its source's options, not connected", shown.lora?.[2]
        === "not among the options of Load LoRA (Model and CLIP) › lora_name on this ComfyUI (not connected)", shown.lora);
    check("…one that cannot be checked", shown.elsewhere?.[2] === "Can't check: this ComfyUI has no node Gone Pack (x).",
        shown.elsewhere);
    await ev(() => {
        const sampler = window.__bl.add("KSampler", [700, 100]);
        window.__sampler = sampler;
        window.__node.connect(0, sampler, sampler.findInputSlot("sampler_name"));
    });
    await settle(800);
    shown = await blocks();
    check("linked to a dropdown that has it: no warning", shown.sampler?.length === 2, shown.sampler);
    await ev(() => window.__node.connect(0, window.__sampler, window.__sampler.findInputSlot("scheduler")));
    await until(() => window.__node.bundlePanel.rows.querySelector('.bl-choice-block[data-field="sampler"]')?.children.length === 3);
    shown = await blocks();
    check("a second target that does not have it: ⚠ for that target", shown.sampler?.[2] === "⚠ Not among the options of KSampler › scheduler",
        shown.sampler);
    await shot("choice-node.png");
    await ev(() => {
        const slot = window.__sampler.findInputSlot("scheduler");
        window.__sampler.disconnectInput(slot);
    });
    await until(() => window.__node.bundlePanel.rows.querySelector('.bl-choice-block[data-field="sampler"]')?.children.length === 2);
    check("that link removed: the warning goes", (await blocks()).sampler?.length === 2);
    await ev(() => window.__node.connect(1, window.__sampler, window.__sampler.findInputSlot("sampler_name")));
    await until(() => window.__node.bundlePanel.rows.querySelector('.bl-choice-block[data-field="lora"] .bl-bad'));
    shown = await blocks();
    check("linked, one not among its source's options says the run will fail",
        shown.lora?.[2] === "⚠ not among the options of Load LoRA (Model and CLIP) › lora_name on this ComfyUI; running will fail",
        shown.lora);
    const run = await ev(() => {
        const preview = window.__bl.add("PreviewAny", [700, 500]); // the output the run is for: Load Bundle runs for it
        window.__node.connect(1, preview, 0);
        return window.__bl.run();
    });
    const error = run.status === 200 ? (run.errors?.[0]?.exception_message ?? "") : JSON.stringify(run.body);
    check("…and it does, with the reason", error.includes("'lora' is 'missing.safetensors', not one of Load LoRA (Model and CLIP)'s lora_name here"),
        error.slice(0, 300));
    await ev(() => window.__bl.app.graph.clear());

    await session.finish();
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
