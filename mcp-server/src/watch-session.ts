// The server's half of the watch protocol — publishing a watch session so the
// extension's Capture page can show and stop it, and `SeeWhatISee.py --stop`
// can reach it. The protocol itself is ../../docs/watch-protocol.md.
//
// A session outlives the runs that hold it. Here the holders are `watch` tool
// calls (a run each, with a gap in between while the client works through what
// it was handed) and a stream subscription (one long hold, no gaps).
//
// Every record this writes carries `kind: "server"`, which is how the rest of
// the protocol knows a signal would be aimed at a process the watch is only
// one part of. That also means this never writes `.watch.pid`: an older
// `--stop` reads only that file, and would SIGTERM the whole server.

import fs from 'node:fs';
import path from 'node:path';

export const STATUS_FILE = '.watch-status.json';
export const STOP_FILE = 'watch-stop.json';
/** The `kind` every record this module writes carries. */
export const SESSION_KIND = 'server';

/** Lease a live holder publishes, and how often it is pushed out. */
const LIVE_LEASE_MS = 90_000;
const LEASE_REFRESH_MS = 30_000;
/**
 * Lease left behind between two `watch` calls. It has to cover the client's
 * turn — describing the capture, answering a follow-up — before it calls
 * again, so it is minutes rather than seconds. Matches the script's.
 */
const GAP_GRACE_MS = 300_000;

/** Why a watch ended, as reported to whoever was watching. */
export type StopReason = 'requested' | 'replaced';

export interface StatusRecord {
  sessionStarted: string;
  pid: number | null;
  expires: string;
  resumeAfter?: string;
  kind?: string;
}

function statusPath(dir: string): string {
  return path.join(dir, STATUS_FILE);
}

function stopPath(dir: string): string {
  return path.join(dir, STOP_FILE);
}

function isoIn(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

function removeQuietly(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    // Already gone, or never ours to remove.
  }
}

/** The status file's contents, or null if there isn't a usable record. */
export function readStatus(dir: string): StatusRecord | null {
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(statusPath(dir), 'utf8'));
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const rec = data as Record<string, unknown>;
  if (typeof rec.sessionStarted !== 'string') return null;
  return {
    sessionStarted: rec.sessionStarted,
    pid: typeof rec.pid === 'number' ? rec.pid : null,
    expires: typeof rec.expires === 'string' ? rec.expires : '',
    resumeAfter: typeof rec.resumeAfter === 'string' ? rec.resumeAfter : undefined,
    kind: typeof rec.kind === 'string' ? rec.kind : undefined,
  };
}

/** Whether a record still stands for a watch someone could stop. */
export function isLive(rec: StatusRecord | null): boolean {
  if (!rec) return false;
  const deadline = Date.parse(rec.expires);
  return deadline > Date.now();
}

/** The `sessionStarted` a pending stop request names, if there is one. */
export function readStopRequest(dir: string): string | null {
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(stopPath(dir), 'utf8'));
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const session = (data as Record<string, unknown>).sessionStarted;
  return typeof session === 'string' ? session : null;
}

/**
 * Ask a session to stop, the way the Capture page's button does.
 *
 * The file channel reaches every kind of watcher: a script run polls for this
 * file while it watches, and a server watches the directory for it.
 */
export function writeStopRequest(dir: string, session: string, pid: number | null): void {
  const payload = `${JSON.stringify({
    sessionStarted: session,
    requestedAt: new Date().toISOString(),
    pid,
  })}\n`;
  try {
    fs.writeFileSync(stopPath(dir), payload);
  } catch {
    // Nothing to do: a request we can't write is a stop we can't make, and
    // the caller reports what it sees afterwards either way.
  }
}

/**
 * Expire a record's lease without taking the record away.
 *
 * What a stop nobody was there to answer leaves behind: the Capture page stops
 * showing a watch now rather than when the gap lease would have run out, while
 * the record stays, since it is what lets the session's next run recognize the
 * request as its own.
 */
export function expireLease(dir: string, rec: StatusRecord): void {
  const target = statusPath(dir);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify({ ...rec, expires: new Date().toISOString() })}\n`);
    fs.renameSync(tmp, target);
  } catch {
    removeQuietly(tmp);
  }
}

/**
 * This server's hold on the watch slot.
 *
 * Reference-counted over its holders, so a client that both subscribes and
 * calls `watch` publishes one session rather than fighting itself. The last
 * holder to leave decides how it ends: a `watch` call hands the session on
 * for its successor, anything else releases it.
 */
export class WatchSession {
  private session: string | null = null;
  /**
   * The session this server last held, kept across the gap between two `watch`
   * calls. The script needs `resumeAfter` to prove a run continues a session
   * because each run is a different process; this one is the same process
   * throughout, so it simply remembers — and a client's cursor moving around
   * doesn't turn its watch into a different watch.
   */
  private lastSession: string | null = null;
  private runs = 0;
  private streams = 0;
  private leaseTimer: ReturnType<typeof setInterval> | null = null;
  private dirWatcher: fs.FSWatcher | null = null;
  private listeners = new Set<(reason: StopReason) => void>();
  /** Set when the watch ended without a holder there to hear it. */
  private stoppedWhileIdle = false;

  constructor(private readonly dir: string, private readonly enabled: boolean) {}

  /** The session id currently published by this server, if any. */
  get current(): string | null {
    return this.session;
  }

  /**
   * Whether `session` is this server's own — held right now, or handed on
   * between two `watch` calls. Ours is ours to end outright, without asking
   * by file and waiting to see whether anyone answered.
   */
  owns(session: string): boolean {
    return session === this.session || session === this.lastSession;
  }

  /** Whether a stop landed that a stream subscriber hasn't been told about. */
  get pendingStop(): boolean {
    return this.stoppedWhileIdle;
  }

  clearPendingStop(): void {
    this.stoppedWhileIdle = false;
  }

  /** Called when the watch ends for a reason the holder didn't ask for. */
  onStopped(cb: (reason: StopReason) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * Take the slot for a `watch` call. `after` is the call's cursor: matching
   * the published `resumeAfter` proves this call is the next iteration of that
   * session, so it continues rather than replacing it.
   */
  beginRun(after: string | undefined): void {
    this.runs += 1;
    this.claim(after);
  }

  /**
   * End a `watch` call. `resumeAfter` is the last record it returned, which is
   * what the client is told to pass back — so the successor call can prove
   * itself. Null when the call returned nothing to resume from.
   */
  endRun(resumeAfter: string | null): void {
    this.runs = Math.max(0, this.runs - 1);
    if (this.runs > 0 || this.streams > 0) return;
    this.handBack(resumeAfter);
  }

  /** Take the slot for a stream subscription, which holds it until it ends. */
  beginStream(): void {
    this.streams += 1;
    if (this.streams === 1) this.claim(undefined);
  }

  endStream(): void {
    this.streams = Math.max(0, this.streams - 1);
    if (this.streams === 0 && this.runs === 0) this.release();
  }

  /** Give up the slot entirely — a stop we performed, or shutdown. */
  release(): void {
    this.stopTimers();
    // `lastSession` as well as the live one: between two `watch` calls the
    // session is published but not held, and a client disconnecting there
    // means nobody is coming back for it. (A crash leaves it, which is what
    // lets a restarted server resume through `resumeAfter`.)
    const held = this.session ?? this.lastSession;
    const published = held === null ? null : readStatus(this.dir);
    if (published !== null && published.sessionStarted === held) {
      removeQuietly(statusPath(this.dir));
    }
    this.session = null;
    this.lastSession = null;
    this.runs = 0;
    this.streams = 0;
  }

  // ---- internals ----

  private claim(after: string | undefined): void {
    if (!this.enabled) return;
    if (this.session === null) {
      const published = readStatus(this.dir);
      // Our own session, still published, is the one to continue. Failing
      // that, a record whose `resumeAfter` is this call's cursor is a session
      // this server held before it restarted, and can pick up again. Anything
      // else belongs to another watcher, and taking the slot from it is the
      // takeover the protocol expects.
      const mine = published !== null && published.sessionStarted === this.lastSession;
      const resumed =
        published !== null && after !== undefined && published.resumeAfter === after;
      this.session =
        published !== null && (mine || resumed)
          ? published.sessionStarted
          : new Date().toISOString();
      this.lastSession = this.session;
    }
    // A request naming anything else is a leftover from a watch that is over,
    // and this server is the only one here to clear it.
    const stale = readStopRequest(this.dir);
    if (stale !== null && stale !== this.session) removeQuietly(stopPath(this.dir));
    this.publishLive();
    // A request already on disk when we claim is one aimed at the session we
    // just adopted — written while this server was between calls. Nothing has
    // changed in the directory since, so the watcher below would never fire
    // for it; check once, here.
    this.checkForStop();
    // That request was for the session just adopted, so there is nothing left
    // to hold: no lease to keep pushing out, and nothing to watch for.
    if (this.session === null) return;
    if (!this.leaseTimer) {
      this.leaseTimer = setInterval(() => {
        // A record that stopped naming us means another watcher took the
        // slot; the directory watcher below normally catches that first.
        if (!this.stillOurs()) this.stopped('replaced');
        else this.publishLive();
      }, LEASE_REFRESH_MS);
      this.leaseTimer.unref?.();
    }
    this.watchDirectory();
  }

  private publishLive(): void {
    this.write({
      sessionStarted: this.session!,
      pid: process.pid,
      expires: isoIn(LIVE_LEASE_MS),
      kind: SESSION_KIND,
    });
  }

  private handBack(resumeAfter: string | null): void {
    if (!this.enabled || this.session === null) return;
    this.stopTimers();
    if (!this.stillOurs()) {
      this.session = null;
      return;
    }
    this.write({
      sessionStarted: this.session,
      pid: null,
      expires: isoIn(GAP_GRACE_MS),
      // Omitted when the call returned nothing to resume from. This server
      // remembers the session either way; the field is for a successor
      // process, and claiming a cursor we didn't emit would strand it.
      ...(resumeAfter === null ? {} : { resumeAfter }),
      kind: SESSION_KIND,
    });
    // The record stays; this server just isn't holding it right now. The next
    // `watch` call adopts it, and a stop landing meanwhile waits for that call.
    this.session = null;
  }

  /**
   * Written to a temp file and renamed into place, so a reader never catches
   * it half-written — the same rule the script follows, and the reason the
   * Capture page can read it on any timer it likes.
   */
  private write(rec: StatusRecord): void {
    const target = statusPath(this.dir);
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(tmp, `${JSON.stringify(rec)}\n`);
      fs.renameSync(tmp, target);
    } catch {
      removeQuietly(tmp);
      // A record we can't publish costs the Capture page's button, never the
      // watching itself.
    }
  }

  private stillOurs(): boolean {
    const published = readStatus(this.dir);
    return published !== null && published.sessionStarted === this.session;
  }

  /**
   * Watch the capture directory for the two files that can end this session:
   * a stop request naming it, and a status record that stops naming it.
   */
  private watchDirectory(): void {
    if (this.dirWatcher) return;
    try {
      this.dirWatcher = fs.watch(this.dir, (_event, name) => {
        if (name === STOP_FILE || name === STATUS_FILE) this.checkForStop();
      });
      this.dirWatcher.unref?.();
    } catch {
      // No directory watch: the lease timer still catches displacement, and a
      // stop request is caught on the next claim.
    }
  }

  private checkForStop(): void {
    if (this.session === null) return;
    if (readStopRequest(this.dir) === this.session) {
      // Take the request with us, so it can't outlive the session it stopped.
      removeQuietly(stopPath(this.dir));
      this.stopped('requested');
      return;
    }
    if (!this.stillOurs()) this.stopped('replaced');
  }

  private stopped(reason: StopReason): void {
    // Read before releasing: giving up the slot resets the holder counts, and
    // whether a subscriber was holding it decides who has to be told.
    const hadSubscriber = this.streams > 0;
    if (reason === 'requested') this.release();
    else {
      // Displaced: the record is the new watcher's now, so drop everything
      // except the memory that we are no longer watching.
      this.stopTimers();
      this.session = null;
    }
    // Either way this session is over: a later call starts a new one rather
    // than re-adopting the one that was just stopped.
    this.lastSession = null;
    // A subscriber has no call in flight to return through, so it learns by
    // reading the stream — the flag is what the next read reports, and it
    // survives until then. Its hold ends here too: the subscription is still
    // open, but the watch it was holding is over, and leaving it counted
    // would let a later `watch` call keep a stopped watch alive.
    if (hadSubscriber) {
      this.stoppedWhileIdle = true;
      this.streams = 0;
    }
    for (const cb of [...this.listeners]) {
      try {
        cb(reason);
      } catch {
        // One holder's bug shouldn't strand the others.
      }
    }
  }

  private stopTimers(): void {
    if (this.leaseTimer) {
      clearInterval(this.leaseTimer);
      this.leaseTimer = null;
    }
    this.dirWatcher?.close();
    this.dirWatcher = null;
  }
}
