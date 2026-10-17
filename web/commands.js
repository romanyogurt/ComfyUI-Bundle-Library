// How the library window runs what waits for the server, and who owns the
// screen meanwhile. No DOM, so it runs under `node --test` as well as in the
// browser.
//
// - A place on the screen (the right pane, the question over the window)
//   shows one thing at a time, each with a number of its own (Slot). An answer
//   for something no longer shown changes nothing there: opening a bundle,
//   the result of a batch, a question answered after it was cancelled.
// - One command at a time holds the window (Commands.hold): a save, a
//   duplicate, a delete, a change to several bundles. The rest of the window
//   waits until it ends, or until the user stops waiting for it. Its ticket
//   names the pane content it was started for; the command changes the pane
//   only while it still owns it (Commands.owns).

/** One place on the screen that shows one thing at a time. */
export class Slot {
    constructor() {
        this.shown = 0;
        this.open = false;
    }

    /** Something new is shown: its number. What was shown before is gone. */
    show() {
        this.open = true;
        return ++this.shown;
    }

    /** Whether the thing numbered `token` is still the one shown. */
    shows(token) {
        return this.open && token === this.shown;
    }

    /** Take the thing numbered `token` away, if it is still shown; whether it was. */
    hide(token) {
        if (!this.shows(token)) return false;
        this.open = false;
        return true;
    }

    /** Nothing is shown any more, whatever it was (the window closed). */
    close() {
        this.open = false;
    }
}

export class Commands {
    /** `onChange(ticket)` is called when a command starts holding the window, and with null when it lets go. */
    constructor(onChange = () => {}) {
        this.onChange = onChange;
        this.pane = new Slot(); // the right pane: an editor, the trash, the batch panel or a result
        this.question = new Slot(); // the question (or picture) over the window
        this.running = null; // the ticket of the command holding the window
        this.count = 0;
    }

    /**
     * The window closed: what it showed is gone, so an answer still on its way
     * owns neither the pane nor a question, and changes nothing (R22-06).
     */
    end() {
        this.pane.close();
        this.question.close();
    }

    /** Why the window waits now, or null. */
    get waiting() {
        return this.running?.wait ?? null;
    }

    /**
     * Run `work(ticket)` holding the window, and resolve to what it returns;
     * to undefined, without running it, while another command holds the
     * window. `wait` says why the window waits. The ticket is
     * {token, kind, wait, view, stopped}: `view` is the pane content the
     * command was started for (what the pane shows now, unless given; the
     * command may set it when it shows its own). With `onStall`, it is called
     * once if the command still holds the window after `stallMs`.
     */
    async hold({ kind, wait, view = this.pane.shown, stallMs = 0, onStall = null }, work) {
        if (this.running) return undefined;
        const ticket = { token: ++this.count, kind, wait, view, stopped: false };
        this.running = ticket;
        this.onChange(ticket);
        const timer = onStall && stallMs > 0 ? setTimeout(() => {
            if (this.running === ticket) onStall(ticket);
        }, stallMs) : null;
        try {
            return await work(ticket);
        } finally {
            clearTimeout(timer);
            this.release(ticket);
        }
    }

    /**
     * Stop waiting for a command: the window is free again. The server may
     * still finish it; its answer then comes to a stopped ticket. Whether the
     * ticket held the window.
     */
    stop(ticket) {
        if (this.running !== ticket) return false;
        ticket.stopped = true;
        this.release(ticket);
        return true;
    }

    release(ticket) {
        if (this.running !== ticket) return;
        this.running = null;
        this.onChange(null);
    }

    /** Whether a command may still change the pane: nobody stopped waiting for it, and the pane shows what it was started for. */
    owns(ticket) {
        return !ticket.stopped && this.pane.shows(ticket.view);
    }
}
