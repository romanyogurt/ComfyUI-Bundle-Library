import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import "./english.mjs"; // the English catalog, as the page has it

import {
    SourceOptions, choiceTargets, resolveChoice, sourceKey, sourceLabel, targetVerdicts, uncheckedText,
} from "../../web/choices.js";

const FIXTURE = JSON.parse(readFileSync(new URL("../fixtures/choices.json", import.meta.url), "utf8"));
const SOURCE = { node: "LoraLoader", input: "lora_name" };

test("a choice resolves as the server resolves it (tests/fixtures/choices.json)", () => {
    for (const c of FIXTURE.resolve) {
        const lookup = c.lookup && { options: [], paths: false, ...c.lookup };
        const resolved = resolveChoice(c.value, c.source ? SOURCE : null, lookup);
        assert.deepEqual(resolved, { output: c.output, state: c.state }, c.case);
    }
});

test("a source not answered yet is pending, not wrong", () => {
    assert.deepEqual(resolveChoice("euler", SOURCE, null), { output: "euler", state: "pending" });
    assert.equal(uncheckedText(SOURCE, null), null);
});

test("why a value cannot be checked, by what was answered", () => {
    const said = (lookup, failure = null) => uncheckedText(SOURCE, lookup, failure);
    assert.equal(said({ state: "read", options: [] }), null);
    assert.equal(uncheckedText(null, null), null); // typed freely: nothing to check
    assert.equal(said({ state: "not_found", reason: "no_node" }), "Can't check: this ComfyUI has no node LoraLoader.");
    assert.equal(said({ state: "not_found", reason: "no_input", label: "Load LoRA" }),
        "Can't check: Load LoRA has no input lora_name on this ComfyUI.");
    assert.equal(said({ state: "unsupported", reason: "multiselect", label: "Load LoRA" }),
        "Can't check (Load LoRA › lora_name: several options are chosen at once).");
    assert.equal(said({ state: "error", reason: "failed", label: "Load LoRA" }),
        "Can't check: this ComfyUI could not read the inputs of Load LoRA.");
    assert.equal(said(null, "Could not reach ComfyUI."), "Can't check: Could not reach ComfyUI.");
    assert.equal(sourceLabel(SOURCE), "LoraLoader › lora_name"); // no display name known: the class name
    assert.equal(sourceKey(SOURCE), "LoraLoader\nlora_name");
    assert.equal(sourceKey(null), "");
});

// A graph as the frontend's objects hold it: nodes with inputs, outputs and widgets; links by id.
function graph(nodes, links, extra = {}) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    return { links: new Map(links.map((l) => [l.id, l])), getNodeById: (id) => byId.get(id), nodes, ...extra };
}
const dropdown = (id, type, input, values, title = type) => ({
    id, type, title, inputs: [{ name: input, widget: { name: input } }], widgets: [{ name: input, options: { values } }],
});
const link = (id, origin, target, slot = 0) => ({ id, origin_id: origin, target_id: target, target_slot: slot });
const loader = (links) => ({ id: 1, type: "BundleLibraryLoad", outputs: [{ links }] });

test("the inputs a choice reaches: at the top, through a Reroute, into subgraphs at any depth", () => {
    const unet = dropdown(10, "UNETLoader", "unet_name", ["a.safetensors"], "Load Diffusion Model");
    const pick = dropdown(11, "KSamplerSelect", "sampler_name", ["euler"]);
    const reroute = { id: 12, type: "Reroute", inputs: [{ name: "" }], outputs: [{ links: [5] }] };
    const any = { id: 13, type: "ShowAny", inputs: [{ name: "anything" }] }; // an input with no options to tell
    // a subgraph whose input 0 goes to a dropdown inside, and to a subgraph inside it
    const deep = graph([dropdown(30, "CLIPLoader", "clip_name", ["t5.safetensors"])], [link(31, -10, 30)],
        { inputs: [{ linkIds: [31] }] });
    const inner = graph([dropdown(20, "VAELoader", "vae_name", ["ae.safetensors"]),
        { id: 21, type: "Nested", isSubgraphNode: () => true, subgraph: deep, inputs: [{ name: "clip" }] }],
    [link(22, -10, 20), link(23, -10, 21)], { inputs: [{ linkIds: [22, 23] }] });
    const sub = { id: 14, type: "uuid-of-the-subgraph", isSubgraphNode: () => true, subgraph: inner, inputs: [{ name: "x" }] };
    const top = graph([unet, pick, reroute, any, sub, dropdown(15, "Other", "x", ["y"])],
        [link(1, 1, 10), link(2, 1, 11), link(3, 1, 12), link(5, 12, 11), link(6, 1, 13), link(7, 1, 14), link(8, 1, 99)]);
    const found = choiceTargets(top, loader([1, 2, 3, 6, 7, 8]), 0);
    const named = found.map((t) => (t.unknown ? "?" : `${t.node.type}.${t.input}`));
    assert.deepEqual(named, ["UNETLoader.unet_name", "KSamplerSelect.sampler_name", "KSamplerSelect.sampler_name",
        "ShowAny.anything", "VAELoader.vae_name", "CLIPLoader.clip_name", "?"]);
    assert.deepEqual(found[0].options, ["a.safetensors"]);
    assert.equal(found[3].options, null);
    assert.deepEqual(targetVerdicts("a.safetensors", found), ["ok", "mismatch", "mismatch", "unchecked", "mismatch",
        "mismatch", "unknown"]);
    // one output carries one spelling to every input it reaches (CH05)
    assert.deepEqual(targetVerdicts("euler", found.slice(1, 3)), ["ok", "ok"]);
    assert.deepEqual(choiceTargets(top, loader([]), 0), []);
    assert.deepEqual(choiceTargets(top, { outputs: [] }, 0), []);
});

test("links as an object, as older graphs hold them; a link seen twice counts once", () => {
    const pick = dropdown(11, "KSamplerSelect", "sampler_name", ["euler"]);
    const plain = { links: { 1: link(1, 1, 11) }, getNodeById: (id) => (id === 11 ? pick : null) };
    assert.equal(choiceTargets(plain, loader([1, 1]), 0).length, 1);
});

// ---- what the page knows of the sources (R020-01) -----------------------------------------------

/** A server whose answers come when the test says: each ask waits for answer(i, …). */
function server() {
    const asks = [];
    return {
        asks,
        read: (source) => new Promise((resolve, reject) => asks.push({ source, resolve, reject })),
        answer: (i, options) => asks[i].resolve({ state: "read", options, paths: false }),
        fail: (i, message) => asks[i].reject(new Error(message)),
    };
}
const settle = () => new Promise((done) => setImmediate(done));

test("each source is read once for everything that shows it, and again after a refresh", async () => {
    const remote = server();
    let changes = 0;
    const known = new SourceOptions(remote.read, () => { changes += 1; });
    const other = { node: "KSampler", input: "scheduler" };
    known.get(SOURCE);
    known.get(SOURCE);
    known.get(other);
    await settle();
    assert.equal(remote.asks.length, 2, "one ask per source");
    assert.deepEqual(known.get(SOURCE), { done: false, answer: null, failure: null, asked: 0 });
    remote.answer(0, ["a.safetensors"]);
    await settle();
    assert.equal(changes, 1);
    assert.deepEqual(known.get(SOURCE).answer.options, ["a.safetensors"]);
    known.get(SOURCE);
    await settle();
    assert.equal(remote.asks.length, 2, "answered: not asked again until a refresh");
    known.refresh();
    const kept = known.get(SOURCE);
    await settle();
    assert.equal(remote.asks.length, 3, "asked again after the refresh");
    assert.deepEqual(kept.answer.options, ["a.safetensors"], "the last answer stays until the new one comes");
    remote.answer(2, ["b.safetensors"]);
    await settle();
    assert.deepEqual(known.get(SOURCE).answer.options, ["b.safetensors"]);
    assert.equal(changes, 2);
});

test("an answer asked for before the latest refresh is dropped, whenever it comes", async () => {
    const remote = server();
    let changes = 0;
    const known = new SourceOptions(remote.read, () => { changes += 1; });
    known.get(SOURCE); // ask 0
    known.refresh();
    known.get(SOURCE); // ask 1, after the refresh
    await settle();
    remote.answer(1, ["new.safetensors"]);
    await settle();
    remote.answer(0, ["old.safetensors"]); // the old list, coming last
    await settle();
    assert.deepEqual(known.get(SOURCE).answer.options, ["new.safetensors"]);
    assert.equal(changes, 1, "only the answer taken redraws");
    known.refresh();
    known.get(SOURCE); // ask 2
    await settle();
    remote.fail(2, "Could not reach ComfyUI.");
    await settle();
    assert.deepEqual(known.get(SOURCE), { done: true, answer: null, failure: "Could not reach ComfyUI.", asked: 2 });
});
