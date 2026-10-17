import assert from "node:assert/strict";
import test from "node:test";

import { EditorModel, editable, numberProblem, summaryOf, tooLarge } from "../../web/editor_model.js";

const SHA = "a".repeat(64);

function stored(fields, extra = {}) {
    return {
        id: "1b4e28ba-2fa1-4d2b-883f-0016d3cca427", name: "Bundle", tags: ["x"], note: "", revision: 3,
        updated_at: "2026-10-17T00:00:00Z", fields, ...extra,
    };
}

const intField = (value, extra = {}) => ({ name: "seed", type: "int", value, ...extra });

test("numbers: what does not parse, and why", () => {
    assert.equal(numberProblem("int", "20"), null);
    assert.equal(numberProblem("int", "1.5"), "Enter a whole number.");
    assert.equal(numberProblem("int", ""), "Enter a whole number.", "an empty box is not 'too large'");
    assert.equal(numberProblem("int", "9007199254740993"), tooLarge());
    assert.equal(numberProblem("float", "1.5"), null);
    assert.equal(numberProblem("float", ""), "Enter a number.");
    assert.equal(numberProblem("float", "1e400"), "Enter a number.");
});

test("a stored bundle as it came is not a change", () => {
    const model = new EditorModel(stored([intField(20), { name: "on", type: "boolean", value: true }]));
    assert.equal(model.dirty, false);
    assert.equal(model.changed, false);
    assert.equal(model.blocker, null);
});

test("an invalid number typed is a change the state, Revert and the lock all see (R15-09)", () => {
    const model = new EditorModel(stored([intField(20)]));
    const field = model.draft.fields[0];
    model.setNumber(field, "1.5");
    assert.equal(model.dirty, false, "the value to save is still 20");
    assert.equal(model.changed, true, "but leaving would lose what was typed");
    assert.equal(model.blocker, "Fix the marked values first.");
    assert.equal(field.text, "1.5", "the text is kept in the model, so drawing the card again shows it");
    assert.equal(field.problem, "Enter a whole number.");
    model.revert();
    const fresh = model.draft.fields[0];
    assert.equal(fresh.text, "20");
    assert.equal(fresh.problem, null);
    assert.equal(model.changed, false);
});

test("a whole number beyond the safe range comes with its text; it is not a change until edited", () => {
    const model = new EditorModel(stored([intField(2 ** 60, { value_text: String(2n ** 60n) })], { warnings: ["seed"] }));
    const field = model.draft.fields[0];
    assert.equal(field.text, String(2n ** 60n));
    assert.match(field.problem, /Change this value before saving/);
    assert.equal(model.changed, false, "a warning the bundle came with is not a change");
    assert.equal(model.blocker, "Fix the marked values first.");
    assert.ok(!("value_text" in editable(model.draft).fields[0]));
    model.setNumber(field, "5");
    assert.equal(model.changed, true);
    assert.equal(model.blocker, null);
    model.setNumber(field, String(2n ** 60n)); // typed back as it came
    assert.equal(model.changed, false, "typing back the original text brings its value back");
});

test("a new draft nobody touched goes without asking; a chosen category makes it one to keep", () => {
    const model = new EditorModel(null, "New bundle 2");
    assert.equal(model.draft.name, "New bundle 2");
    assert.equal(model.untouched, true);
    assert.equal(model.changed, true, "a new bundle is always unsaved");
    model.pendingCategory = "c1";
    assert.equal(model.untouched, false);
    model.pendingCategory = null;
    const field = model.addField("int");
    assert.equal(model.untouched, false);
    model.removeField(field);
    assert.equal(model.untouched, true, "back as it started");
});

test("fields: names, keys, moves and the notes about their names", () => {
    const model = new EditorModel(stored([{ name: "prompt", type: "text", value: "hi" }]));
    const added = model.addField("text");
    assert.equal(added.name, "text_1");
    assert.equal(added.origin, null);
    assert.notEqual(added.key, model.draft.fields[0].key);
    assert.equal(model.moveField(added, -1), true);
    assert.equal(model.draft.fields[0], added);
    assert.equal(model.moveField(added, -1), false, "already first");
    added.name = "prompt";
    const notes = model.nameNotes();
    assert.equal(notes.get(added.key).problem, "Another field is also named 'prompt'.");
    assert.equal(model.blocker, "Fix the marked field names first.");
    added.name = "@x";
    assert.equal(model.nameNotes().get(added.key).problem, "Names starting with '@' are reserved.");
    const original = model.draft.fields[1];
    original.name = "positive";
    assert.match(model.nameNotes().get(original.key).renamed, /Renamed from 'prompt'/);
});

test("tags: blank and repeated ones are not added", () => {
    const model = new EditorModel(stored([]));
    assert.equal(model.addTag("  "), false);
    assert.equal(model.addTag("X"), false, "x is there, in another case");
    assert.equal(model.addTag(" portrait "), true);
    assert.deepEqual(model.draft.tags, ["x", "portrait"]);
    model.removeTag(0);
    assert.deepEqual(model.draft.tags, ["portrait"]);
});

test("uploads: only the last file chosen for a field counts, and it is a change until it ends", () => {
    const model = new EditorModel(stored([{ name: "ref", type: "image", asset: null }]));
    const field = model.draft.fields[0];
    const first = model.startUpload(field, "a.png");
    const second = model.startUpload(field, "b.png");
    assert.ok(first.controller.signal.aborted, "the earlier upload is stopped");
    assert.equal(model.changed, true);
    assert.equal(model.blocker, "Wait for the upload to finish.");
    assert.equal(model.endUpload(field, first, { asset: { sha256: SHA } }), false, "a stopped upload's answer is ignored");
    assert.equal(field.asset, null);
    assert.equal(model.endUpload(field, second, { asset: { sha256: SHA, original_name: "b.png" } }), true);
    assert.equal(field.asset.sha256, SHA);
    assert.equal(model.uploads.size, 0);
    assert.equal(model.dirty, true);
});

test("uploads: a failure is kept on the field; removing the field stops its upload", () => {
    const model = new EditorModel(stored([{ name: "ref", type: "image", asset: null }]));
    const field = model.draft.fields[0];
    const transfer = model.startUpload(field, "a.png");
    assert.equal(model.endUpload(field, transfer, { error: "Only PNG, JPEG and WebP images are accepted." }), true);
    assert.equal(field.fileError, "Only PNG, JPEG and WebP images are accepted.");
    model.startUpload(field, "c.png");
    assert.equal(field.fileError, null, "a new file clears it");
    const running = model.uploads.get(field.key);
    model.removeField(field);
    assert.ok(running.controller.signal.aborted);
    assert.equal(model.uploads.size, 0);
});

test("loading another bundle stops the uploads of the draft dropped", () => {
    const model = new EditorModel(stored([{ name: "ref", type: "image", asset: null }]));
    const transfer = model.startUpload(model.draft.fields[0], "a.png");
    model.load(stored([], { revision: 4 }));
    assert.ok(transfer.controller.signal.aborted);
    assert.equal(model.uploads.size, 0);
    assert.equal(model.saved.revision, 4);
});

test("a read-only bundle cannot be saved, whatever is changed", () => {
    const model = new EditorModel(stored([], { read_only: "has data this version does not know: extra" }));
    assert.equal(model.readOnly, "has data this version does not know: extra");
    assert.equal(model.blocker, "This version of Bundle Library cannot change this bundle.");
});

test("the summary handed to a node is the stored bundle's, shaped like the list's", () => {
    const bundle = stored([
        { name: "prompt", type: "text", value: "x".repeat(300) },
        { name: "ref", type: "image", asset: { sha256: SHA, width: 4, height: 4 } },
        { name: "empty", type: "audio", asset: null },
        { name: "seed", type: "int", value: 2 ** 60, value_text: String(2n ** 60n) },
        { name: "on", type: "boolean", value: true },
    ]);
    const summary = summaryOf(bundle);
    assert.deepEqual(Object.keys(summary).sort(), ["fields", "id", "name", "revision", "tags", "updated_at"]);
    assert.deepEqual(summary.fields.map((f) => [f.name, f.type]), bundle.fields.map((f) => [f.name, f.type]));
    assert.equal(summary.fields[0].preview.length, 200);
    assert.equal(summary.fields[1].preview.sha256, SHA);
    assert.equal(summary.fields[2].preview, null);
    assert.equal(summary.fields[3].preview, String(2n ** 60n), "exact text, as the server gives it");
    assert.equal(summary.fields[4].preview, true);
    const model = new EditorModel(bundle);
    model.draft.fields[0].value = "changed, not saved";
    assert.equal(model.summary().fields[0].preview.length, 200, "the stored bundle, not the draft");
    assert.equal(new EditorModel(null).summary(), null);
});
