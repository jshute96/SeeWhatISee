# Watch protocol — showing and stopping a watch script

How the Capture page knows a `/see-what-i-see-watch` loop is running,
and how its Stop button ends one.

- The extension and the script talk only through files in the capture
  directory (`~/Downloads/SeeWhatISee` by default) — no ports, no
  native messaging.
- Script to script — `--stop`, or one watcher replacing another — the
  request goes by signal instead; see [below](#asking-by-signal--stop-and-takeovers).

Code: `skills/SeeWhatISee.py` (script side),
`src/capture/watch-status.ts` (protocol),
`src/capture-page/watch-status.ts` (UI).

## The files

| File | Written by | Meaning |
|------|-----------|---------|
| `.watch.pid` | watch script | the original lock — one line, the pid of the run in flight |
| `.watch-status.json` | watch script, `--stop` | the watch session: who it is, and whether it is live |
| `watch-stop.json` | extension, `--stop` | please exit |

Every `--watch` run takes part, streaming and single-shot alike.

- `--no-pid-lockfile` is the opt-out, for running watchers in parallel
  on one directory. Such a run publishes nothing and can't be stopped
  this way.
- Neither can the MCP server's `watch` — it holds its subscription
  in-process, with no pid lock and nothing on disk (see
  [mcp-server.md](mcp-server.md)).

### `.watch-status.json`

While a run is in flight:

```json
{"sessionStarted": "2026-08-30T12:00:00.123456Z", "pid": 12345,
 "expires": "2026-08-30T12:04:30Z"}
```

Between two runs of a single-shot loop:

```json
{"sessionStarted": "2026-08-30T12:00:00.123456Z", "pid": null,
 "expires": "2026-08-30T12:09:12Z",
 "resumeAfter": "2026-08-30T12:04:12.482Z"}
```

- **`sessionStarted`** — when the session began, and its identity. Set
  once, adopted unchanged by every later run, named by a stop request.
  Compared as an exact string, never re-parsed into a date and
  re-serialized: microsecond precision would not survive a round trip
  through JavaScript's `Date`.
- **`pid`** — the run in flight, or `null` in a gap. What `--stop` and
  a replacing watcher signal, when there is one.
- **`expires`** — the freshness deadline, and the whole of it. There is
  no separate heartbeat field to reason about.
- **`resumeAfter`** — the `--after` value the next run of this session
  is expected to carry. Only single-shot runs write it; a `--loop`
  watcher has no gaps.
- No version field. A file without one is the shape above; a later
  script can add one if it ever has something to distinguish.

### `watch-stop.json`

```json
{"sessionStarted": "2026-08-30T12:00:00.123456Z",
 "requestedAt": "2026-08-30T12:05:00Z", "pid": 12345}
```

- **`sessionStarted` is the only field acted on**: honor the request if
  it names my session, delete it as a leftover if it doesn't — a
  request naming nobody included, since no run could ever act on it.
  There is no half-written case to allow for: `chrome.downloads` swaps
  the finished file into place.
- `requestedAt` and `pid` are there so a stray file explains itself.
  `pid` is null when the request was written into a gap.
- Written by the Capture page's Stop button via
  `chrome.downloads.download`, and by `--stop` when there is no live
  run to signal.
- **The only one of the three that isn't a dotfile.** That is a
  constraint, not a preference: `chrome.downloads.download` is the
  extension's only way to write a file, and it rejects leading dots
  outright with `Error: Invalid filename`.

### `.watch.pid` is frozen, and deprecated

- Every released version of the script parses the whole file as an
  integer, so nothing may be added to it — not a second line, not an
  annotation. That is why the session state went into a separate file.
- It stays strictly **process**-scoped: written on entry, removed on
  every exit, absent during a gap. That is what an old bundle expects,
  and the session file is where anything longer-lived belongs.
- It buys backwards compatibility and nothing else. Dropping it would
  break two cross-version cases, both against older scripts:
  - an older `--stop` wouldn't find a watcher a newer script started; and
  - an older watcher wouldn't take the slot from a newer one, leaving
    two watchers on the same `log.json`.
- The script reads it only as a fallback: no session file but a live
  pidfile means an old bundle's watcher holds the slot, so stop or
  displace that.
- To remove it later: drop the fallback in `watcher_pid` and the write
  in `claim_watch_slot` (plus its cleanup in `clear_watch_files`). The
  extension never reads or writes it, so nothing changes there.

## Sessions, not processes

A watch is not one process. The Gemini, generic and Antigravity loops
are a *series* of blocking runs, one per capture, driven by the agent
re-running the script with `--after <ts>`.

- The user starts, sees and stops a **session**; the script only ever
  is a **run**.
- Between two runs — the agent describing the capture it was just
  handed, and the user asking about it — no process is watching.
- Publishing only the run is what made a stop landing in that gap
  vanish, made the indicator flicker, and made `--stop` answer "nothing
  to stop" about a watch that was very much running.

So `.watch-status.json` describes the session, and outlives the runs
that take turns holding it.

### Identity is separate from liveness

- `sessionStarted` says *who*; `expires` says *whether anyone is there
  right now*. The Capture page reads only the second.
- Keeping them apart is what lets a session be recognizable long after
  it stops looking live: a run that comes back late still knows who it
  is, while the page has long since stopped claiming a watch is
  running.

### `resumeAfter` — proving a run is the next iteration

- A run that exits normally records the timestamp of the record it just
  emitted. That is exactly the value the agent is told to pass back as
  `--after`.
- A starting run compares its own `--after` with the file's
  `resumeAfter`. Equal → it is the next iteration of that session, and
  adopts it. Different, or no `--after` at all → it is a *different*
  watch, and takes the slot over.
- That answers two questions no timestamp comparison could: whether a
  gap stop is aimed at me, and whether the loop I belong to has been
  displaced by another one.
- If an agent drops or mangles `--after`, the match simply fails and
  the run reads as a new watch. Degraded, not broken.

### The two lease lengths

- **Running: `now + 90s`, refreshed every 30s** from the same 0.5s poll
  loop that watches `log.json`. This is a liveness proof, and its
  length is set by how long a SIGKILLed watcher's ghost may keep
  advertising itself.
- **In a gap: `now + 5 min`.** This one covers an agent thinking — describing a capture, answering a
  follow-up — before it re-runs the script. An active loop never
  reaches it, since every re-invocation rewrites the file.
- Too short a gap lease is the expensive mistake: the indicator would
  vanish mid-conversation and take the Stop button with it. Too long
  only leaves an abandoned watch advertised for a few minutes.

## What a run does on entry

1. **Read `.watch-status.json`.** A session whose `resumeAfter` matches
   my `--after` is mine: adopt its `sessionStarted`. Otherwise mint a
   new session, stamping `sessionStarted = now`.
2. **Displace whatever is still running.** A status file naming a live
   `pid` — or, for an old bundle's watcher, a live `.watch.pid` with no
   session file — gets the takeover signal and the escalation behind
   it. Only then is the slot free.
3. **Claim the slot**: rewrite the status file with my `pid` and the
   running lease, and write `.watch.pid`. Claiming *before* checking
   for a stop leaves no window where a request arrives, finds nobody
   published, and is discarded by the run that was starting.
4. **Read `watch-stop.json`.** Names my session → delete both files,
   say so on stderr, exit 3 without waiting for a capture. Names
   anything else → delete it as a leftover and start watching.
5. **Poll**, re-checking the stop file every 0.5s, so a request landing
   after step 4 is caught the ordinary way.

Step 2 applies **even when the session is mine**. Adopting a session is
not permission to share it with another process, and a live pid under
my own `sessionStarted` means the previous run never exited — wedged
somewhere, or the agent re-invoked without waiting for it. One watcher
per slot either way; the outgoing run reports being replaced.

## Stopping — the four sequences

Two triggers (the Capture page's Stop button, and `--stop`) times two
moments (during a run, and in a gap).

### Stop during a run

Both triggers reach a live process, and it answers within a second.

```
 page ── watch-stop.json ─▶ run: poll loop notices within 0.5s
 --stop ── SIGUSR1 ───────▶ run: handler
                            └─ deletes stop request, status file, pidfile
                               "Stopping: stop requested"
                               exit 3   (0 under --loop)
```

### Stop button in a gap

The request waits on disk for the next run, which honors it on entry.

```
run A ─emit T─▶ exit 0                              run B starts (--after T)
   status: sessionStarted=S, pid=null,
           resumeAfter=T, expires=now+5min
                       │                                  │
   page ── watch-stop.json {sessionStarted: S} ────────────┤
                                                           ├ resumeAfter==T → I am S
                                                           ├ request names S → mine
                                                           └ exit 3 on entry
```

- The loop stops at the agent's **next invocation**, not at the next
  capture — run B never waits.
- The page can hide the indicator as soon as it has written the
  request; it does not have to wait out the lease.

### `--stop` in a gap

`--stop` finds `pid: null` with a `resumeAfter`, which is a session
between runs — not the absence of one. It has nothing to signal, so it
writes the request itself.

```
--stop ─▶ status: pid=null, resumeAfter=T   (a session, between runs)
          ├ writes watch-stop.json {sessionStarted: S}
          ├ sets expires = now      → the page stops showing a watch
          └ leaves the status file  → run B can still recognize itself
```

- **It must not delete the status file.** That record is the only thing
  that lets run B know the request is its own. Delete it and run B
  mints a fresh session, finds a request naming a session that no
  longer exists, discards it, and the loop carries on.
- Zeroing `expires` is what separating identity from liveness bought:
  the record survives as identity while the page immediately stops
  claiming a live watch.

### A stop nobody comes back for

The agent never runs the script again — the user stopped it, or closed
the CLI.

- The status file sits there with `expires` in the past, so the page
  shows nothing and `--stop` reports no live run.
- Nothing needs to sweep it: the next watch either resumes it (matching
  `resumeAfter`) or overwrites it (not matching), so it is one file,
  not litter.
- A leftover `watch-stop.json` is inert for the same reason — it names
  a session that no run will ever adopt, and the next fresh run deletes
  it.

### What `--stop` reports

| State it finds | What it does | What it says |
|---|---|---|
| live `pid` | signals it | `Stopping existing watcher` |
| `pid: null` with `resumeAfter` | writes the request, zeroes the lease | `The watch on <dir> will stop when the agent next runs it` |
| no session, or an expired one | clears leftovers | `No watch to stop` |

## Asking by signal — `--stop` and takeovers

The stop file is the extension's channel. Between two copies of the
script — `--stop`, or a new watcher taking the slot — the request goes
by signal instead, whenever there is a live pid to send it to:

- **SIGUSR1** — please stop (`--stop`, i.e. `/see-what-i-see-stop`).
- **SIGUSR2** — a new watcher is taking the slot.

The watcher catches both and shuts down exactly as it answers a stop
file: files released, `Stopping: stop requested` or `Stopping: replaced
by a new watcher` on stderr, then exit 3 (0 with `--loop`).

Why these two signals:

- Their default disposition is *terminate*, so a watcher from an older
  bundle — no handler installed — still dies. Takeover can't be left
  to the outgoing watcher's cooperation.
- Nothing else sends them: terminals send SIGINT, supervisors and
  `timeout` send SIGTERM. So receiving one can only mean this script
  asked, which is what makes the clean exit code trustworthy.
- SIGTERM and SIGINT keep their old meaning — killed — and still exit
  143 after releasing the files.

The escalation, in `kill_pid`:

- SIGUSR1/2 first, with a couple of seconds' patience — it is the only
  stage that ends in a clean exit code, so it is worth waiting on.
- Then SIGTERM, then SIGKILL, half a second apart, for a watcher wedged
  somewhere its handler can't run.

So the clean exit code is best-effort. A watcher blocked writing to a
stdout nobody is draining doesn't reach its handler in time and takes
the SIGTERM instead, exiting 143 like any other kill.

### Exit codes a loop reads

Stopping a single-shot run stops the *run*. The loop stays stopped
because the run exits non-zero, which the skill tells the agent means
"do not restart":

- **3** — stopped on request: a `watch-stop.json` naming this session,
  a `--stop`, or a replacement watcher. All three print a
  `Stopping: ...` line on stderr saying which.
- **Any other non-zero** — killed or errored. The script's own error
  exits are 1 and 2; a signal it doesn't handle shows up as 128 + the
  signal number. SIGTERM and SIGINT it *does* handle, and both exit 143
  after releasing its files.
- A `--loop` watcher exits **0** on a stop request instead: the process
  ending is itself the end of the watch, with nobody left to misread
  the code.

## Who cleans up what

The extension deletes no files here. (It erases the *download record*
for its stop request once the file lands, so the request doesn't sit
in Chrome's download list pointing at a file the watcher is about to
remove — but the file itself is left for the script.) Every file
removal is the script's:

- **End of a session** (stop request, signal, takeover): drops
  `.watch.pid` and `.watch-status.json`, each only if it still names
  this run's session — checked, then deleted, so a run claiming the
  slot inside that window is repaired by its next heartbeat. A run acting on a stop request deletes that
  request first, so it can't outlive the session it stopped.
- **End of a run, session continuing**: drops `.watch.pid`, and
  rewrites the status file with `pid: null`, `resumeAfter` and the gap
  lease.
- **Startup**: overwrites a status file it didn't recognize as its own,
  and deletes a `watch-stop.json` naming any other session.
- **`--stop`**: ends a live session the same way; in a gap it writes a
  request instead and deliberately leaves the status file behind.
- **Orphaned `.watch-status.json.<pid>.tmp`**: swept by both startup
  and `--stop`, the two paths that can SIGKILL a run mid-write and
  leave one behind for good.

The status file is written to `.watch-status.json.<pid>.tmp` beside it
and renamed into place, so a reader never catches it half-written. Same
directory (the rename is only atomic within a filesystem) and
pid-suffixed, so two runs racing for the slot can't collide on it.

## The Capture page's side

- **Needs "Allow access to file URLs"** (off by default, in
  `chrome://extensions`). Detection is a `file://` read; without it the
  page reports no watcher and shows nothing. There is no probe-based
  fallback — a Stop button whose effect we could never confirm is
  worse than no button.
- Reads on load, and again whenever the page is brought back to the
  front (throttled). Not on a timer: the moment the user looks at the
  page is when the answer has to be right.
- **A watch exists iff `expires` is in the future.** One comparison,
  whether or not a run is in flight — the gap is no longer visible to
  the page at all.
- It also reads `watch-stop.json`: a request naming the session it is
  showing means that watch is over, however long the lease has left.
- **Only looks in the extension's own capture directory.** A watcher
  started with an explicit `--directory` somewhere else publishes a
  status file the page never sees, so it shows nothing — working as
  intended, not a bug.
- The indicator sits at the right end of the button row, after the Ask
  buttons, and is hidden whenever no watch is visible.
- **Stop** writes the request carrying the session id it is showing,
  then hides the indicator. Success is no longer inferred from an
  absent file, so a stop in a gap is reported honestly rather than as
  the "success it didn't have" the old rule produced.

## Version compatibility

|  | old script | new script |
|--|-----------|-----------|
| **old extension** | today's behaviour | publishes a session file nobody reads; expires on its own |
| **new extension** | no status file → no indicator, no Stop button | detect + stop, gaps included |

An old watcher is invisible to the Capture page rather than showing a
Stop button that silently does nothing. `--stop` by pid keeps working
in every combination, because nothing about `.watch.pid` changed.

Signals cross versions too, in both directions, at the cost of the
clean exit code:

- An old watcher has no SIGUSR1/2 handler, so it dies of the default
  disposition. The skills still read that non-zero exit as "stopped,
  don't re-run".
- An old `--stop`, or an old watcher taking the slot, sends SIGTERM. A
  new watcher handles that as a kill and exits 143 without a
  `Stopping: ...` line, so a routine replacement is reported to the
  user as an unexpected stop.
- An old script takes the slot through `.watch.pid` alone and knows
  nothing about the session file, so it strands one. The lease covers
  that: the page ignores it, and the next new-script run overwrites it.
