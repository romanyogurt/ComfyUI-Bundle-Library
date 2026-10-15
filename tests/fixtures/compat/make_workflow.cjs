// Saves a workflow with a Load Bundle node, as the running node version and
// frontend write it, for the compatibility fixtures. Run against the test
// server with the release to capture (see README.md):
//     NODE_PATH=... node tests/fixtures/compat/make_workflow.cjs <out folder>
// The output is committed; it is not made again.
const fs = require("fs");
const path = require("path");
const { startSession } = require("../../browser/harness.cjs");

(async () => {
    const out = process.argv[2];
    fs.mkdirSync(out, { recursive: true });
    const session = await startSession("compat-workflow");
    const { ev, check, finish } = session;
    const made = await ev(async () => {
        const b = window.__bl;
        const ref = await b.image("ref", "#7c3aed", "compat");
        const bundle = await b.request("POST", "/bundles", { name: "[test] Compat workflow", tags: ["compat"], fields: [
            { name: "prompt", type: "text", value: "Saved by an older release." },
            ref,
            { name: "seed", type: "int", value: 42 },
            { name: "flag", type: "boolean", value: true },
        ] });
        b.app.graph.clear();
        const loader = b.add("BundleLibraryLoad", [80, 80]);
        await b.pick(loader, bundle.id);
        const text = b.add("PreviewAny", [520, 60]);
        const image = b.add("PreviewImage", [520, 260]);
        const seed = b.add("PreviewAny", [520, 520]);
        loader.connect(0, text, 0);
        loader.connect(1, image, 0);
        loader.connect(2, seed, 0);
        const asset = await (await fetch(`/api/bundle-library/v1/assets/${bundle.fields[1].asset.sha256}`)).arrayBuffer();
        return {
            workflow: b.app.graph.serialize(),
            spec: b.spec(loader),
            bundle,
            png: Array.from(new Uint8Array(asset)),
        };
    });
    fs.writeFileSync(path.join(out, "workflow.json"), JSON.stringify(made.workflow, null, 2) + "\n");
    fs.writeFileSync(path.join(out, "workflow-bundle.json"), JSON.stringify(made.bundle, null, 2) + "\n");
    fs.writeFileSync(path.join(out, "workflow-ref.png"), Buffer.from(made.png));
    check("captured a workflow with three linked outputs", made.workflow.links.length === 3, made.spec);
    await ev(() => window.__bl.app.graph.clear());
    await finish({ expectRemoved: 1 });
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
