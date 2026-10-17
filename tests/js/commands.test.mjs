import assert from "node:assert/strict";
import test from "node:test";

import "./english.mjs"; // the English catalog, as the page has it

import { Commands, Slot } from "../../web/commands.js";

/** A promise with its resolve and reject, to answer a request when the test says so. */
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

test("a slot shows one thing at a time; an old token changes nothing", () => {
    const slot = new Slot();
    const first = slot.show();
    assert.ok(slot.shows(first));
    const second = slot.show();
    assert.ok(!slot.shows(first) && slot.shows(second));
    assert.equal(slot.hide(first), false, "the first was replaced: hiding it does not hide the second");
    assert.ok(slot.shows(second));
    assert.equal(slot.hide(second), true);
    assert.ok(!slot.shows(second) && !slot.open);
    assert.equal(slot.hide(second), false, "only once");
});

test("one command holds the window; another is refused until it ends", async () => {
    const changes = [];
    const commands = new Commands((ticket) => changes.push(ticket?.kind ?? null));
    const answer = deferred();
    const first = commands.hold({ kind: "save", wait: "Wait until the bundle is saved." }, () => answer.promise);
    assert.equal(commands.waiting, "Wait until the bundle is saved.");
    let ran = false;
    assert.equal(await commands.hold({ kind: "batch", wait: "w" }, () => { ran = true; }), undefined);
    assert.ok(!ran, "the second command did not run");
    answer.resolve("saved");
    assert.equal(await first, "saved", "hold resolves to what the work returns");
    assert.equal(commands.running, null);
    assert.deepEqual(changes, ["save", null]);
});

test("a command that throws lets go of the window too", async () => {
    const commands = new Commands();
    await assert.rejects(commands.hold({ kind: "delete", wait: "w" }, async () => { throw new Error("boom"); }), /boom/);
    assert.equal(commands.running, null);
    assert.equal(await commands.hold({ kind: "delete", wait: "w" }, async () => "again"), "again");
});

test("a ticket owns the pane content it was started for, until the pane shows something else", async () => {
    const commands = new Commands();
    const view = commands.pane.show();
    const answer = deferred();
    let owned = null;
    const run = commands.hold({ kind: "duplicate", wait: "w" }, async (ticket) => {
        assert.equal(ticket.view, view);
        await answer.promise;
        owned = commands.owns(ticket);
    });
    commands.pane.show(); // e.g. the pane was given to something else
    answer.resolve();
    await run;
    assert.equal(owned, false);
});

test("a command may take the pane content it shows as its own", async () => {
    const commands = new Commands();
    commands.pane.show();
    await commands.hold({ kind: "batch", wait: "w" }, async (ticket) => {
        ticket.view = commands.pane.show(); // its waiting view
        assert.ok(commands.owns(ticket));
    });
});

test("stopping the wait frees the window; the late answer comes to a stopped ticket", async () => {
    const commands = new Commands();
    commands.pane.show();
    const answer = deferred();
    let ticket = null;
    let lateOwned = null;
    const run = commands.hold({ kind: "batch", wait: "w" }, async (t) => {
        ticket = t;
        await answer.promise;
        lateOwned = commands.owns(t);
        return "late";
    });
    assert.equal(commands.stop(ticket), true);
    assert.equal(commands.running, null, "free again");
    assert.equal(commands.stop(ticket), false, "only once");
    let second = false;
    await commands.hold({ kind: "save", wait: "w" }, async () => { second = true; });
    assert.ok(second, "another command can run meanwhile");
    answer.resolve();
    assert.equal(await run, "late");
    assert.equal(lateOwned, false, "a stopped ticket does not own the pane");
    assert.ok(ticket.stopped);
});

test("a command still out after stallMs is offered to stop; one that answered in time is not", async () => {
    const commands = new Commands();
    const slow = deferred();
    const stalled = [];
    const run = commands.hold({ kind: "batch", wait: "w", stallMs: 20, onStall: (t) => stalled.push(t.kind) },
        () => slow.promise);
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(stalled, ["batch"]);
    slow.resolve();
    await run;

    const quick = [];
    await commands.hold({ kind: "batch", wait: "w", stallMs: 20, onStall: () => quick.push(1) }, async () => {});
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(quick, []);
});

test("the question slot: a late answer to a cancelled question does not close the next one", () => {
    const commands = new Commands();
    const a = commands.question.show();
    assert.ok(commands.question.hide(a)); // A cancelled
    const b = commands.question.show(); // B opened
    assert.equal(commands.question.hide(a), false, "A's late finish leaves B alone");
    assert.ok(commands.question.shows(b));
});

test("a closed window: what it showed and asked is gone, so a late answer owns nothing (R22-06)", async () => {
    const commands = new Commands();
    const answer = deferred();
    let owned = null;
    const out = commands.hold({ kind: "export", wait: "Wait." }, async (ticket) => {
        ticket.view = commands.pane.show();
        await answer.promise;
        owned = commands.pane.shows(ticket.view); // where the result would be drawn and downloaded
    });
    const asked = commands.question.show();
    commands.end();
    answer.resolve();
    await out;
    assert.equal(owned, false);
    assert.equal(commands.question.shows(asked), false);
});
