// A virtual clock shared by every simulated peer and the simulated server.
//
// Without it the checks can only observe what happens in the first few real
// milliseconds — which is precisely where the interesting recovery logic ISN'T:
// the answer watchdog is 8 s, negotiation retries back off to 6 s, ICE restarts
// wait 8–15 s, the invite times out at 60 s. Virtual time makes those reachable
// (and deterministic) instead of untested.
export class VirtualClock {
    constructor() {
        this.now = 0;
        this.seq = 0;
        this.timers = new Map();
    }

    setTimeout(fn, delay = 0, ...args) {
        const id = ++this.seq;
        this.timers.set(id, { at: this.now + Math.max(0, Number(delay) || 0), fn, args, interval: null });
        return id;
    }

    setInterval(fn, delay = 0, ...args) {
        const id = ++this.seq;
        const period = Math.max(1, Number(delay) || 1);
        this.timers.set(id, { at: this.now + period, fn, args, interval: period });
        return id;
    }

    clearTimeout(id) { this.timers.delete(id); }
    clearInterval(id) { this.timers.delete(id); }

    hasTimers() { return this.timers.size > 0; }

    nextAt() {
        let best = Infinity;
        for (const t of this.timers.values()) if (t.at < best) best = t.at;
        return best;
    }

    /** Fires every timer due at the next timestamp. Returns how many ran. */
    fireNext() {
        const at = this.nextAt();
        if (!Number.isFinite(at)) return 0;
        this.now = Math.max(this.now, at);
        const due = [];
        for (const [id, t] of this.timers) if (t.at <= this.now) due.push([id, t]);
        due.sort((a, b) => (a[1].at - b[1].at) || (a[0] - b[0]));
        for (const [id, t] of due) {
            if (t.interval) t.at = this.now + t.interval;
            else this.timers.delete(id);
            try { t.fn(...t.args); } catch (e) { /* surfaced by the check's assertions */ }
        }
        return due.length;
    }
}

/** Lets queued promise callbacks run before the clock jumps forward again. */
export async function drainMicrotasks(rounds = 12) {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
}
