# Watch protocol — showing and stopping a watch script

How the Capture page knows a `/see-what-i-see-watch` loop is running,
and how its Stop button ends one. Three files in the capture directory
(`~/Downloads/SeeWhatISee` by default) are the whole protocol; the two
sides never talk any other way.

Code: `skills/SeeWhatISee.py` (script side),
`src/capture/watch-status.ts` (protocol),
`src/capture-page/watch-status.ts` (UI).

## The files

| File | Written by | Meaning |
|------|-----------|---------|
| `.watch.pid` | watch script | the original lock — one line, the watcher's pid |
| `.watch-status.json` | watch script | a stoppable watcher is running |
| `watch-stop.json` | extension | please exit |

Only a watcher started with `--pid-lockfile` (what
`/see-what-i-see-watch` runs) takes part. A single-shot `--watch`
publishes nothing and can't be stopped this way, and neither can the
MCP server's `watch` — it holds its subscription in-process, with no
pid lock and nothing on disk (see [mcp-server.md](mcp-server.md)).

### `.watch.pid` is frozen, and deprecated

- Every released version of the script parses the whole file as an
  integer, so nothing may be added to it — not a second line, not an
  annotation. That is why the new state went into a separate file.
- It buys backwards compatibility and nothing else:
  `.watch-status.json` carries the same pid, written and removed at the
  same moments, plus a staleness check the pidfile can't have. The
  script finds the running watcher through the status file and falls
  back to the pidfile only when there is none — i.e. only for a watcher
  an older version started.
- **Keep writing it while old bundles are still installed.** Dropping
  it would break two cross-version cases, both against older scripts:
  - an older `--stop` wouldn't find a watcher a newer script started; and
  - an older watcher wouldn't take the slot from a newer one, leaving
    two watchers on the same `log.json`.
- To remove it later: drop the fallback line in `watcher_pid` and the
  write in `claim_watch_slot` (plus its cleanup in
  `clear_watch_files`). The extension never reads or writes it, so
  nothing changes there.

### `.watch-status.json`

```json
{"pid": 12345, "started": "2026-08-30T12:00:00Z", "heartbeat": "2026-08-30T12:04:30Z"}
```

- Written when the watcher claims the pid lock; removed on any clean
  exit (the same `atexit` / SIGTERM release the pidfile uses) — but
  only if it still names that process, so a watcher on its way out
  can't delete its replacement's file. (A sub-second window remains
  where it can: the outgoing process checks, the incoming one's rename
  lands, the outgoing one deletes. The next heartbeat rewrites it, and
  `--stop` finds the watcher by pid regardless.)
- Written to `.watch-status.json.<pid>.tmp` beside it and renamed into
  place, so a reader never catches it half-written. Same directory (the
  rename is only atomic within a filesystem) and pid-suffixed, so two
  watchers racing for the slot can't collide on it.
- `heartbeat` is refreshed from the same 0.5s poll loop that watches
  `log.json`, every 30s. A watcher blocked writing to stdout — an
  agent that stopped draining the pipe — therefore stops beating and
  stops noticing stop requests: after 90s it drops off the Capture
  page, and `--stop` by pid is the way out.
- The extension ignores a status file whose heartbeat is more than 90s
  old — that is what keeps the files a SIGKILLed watcher (or a power
  cut) left behind from advertising a watcher that isn't there.
- No version field. A file without one is version 0, the shape above;
  a later script can add one if it ever has something to distinguish.

### `watch-stop.json`

```json
{"pid": 12345, "started": "2026-08-30T12:00:00Z", "requestedAt": "2026-08-30T12:05:00Z"}
```

- Written by the Capture page's Stop button, via
  `chrome.downloads.download` — the only way the extension can put a
  file on disk.
- The contents name the watcher the request was aimed at. **The script
  doesn't check them**: any request is for whoever is watching now, and
  requests that predate a watcher are cleared before it starts. They
  are there so a stray file explains itself.
- **The only one of the three that isn't a dotfile.** That is a
  constraint, not a preference: `chrome.downloads.download` is the
  extension's only way to write a file, and it rejects leading dots
  outright with `Error: Invalid filename`.

## Who cleans up what

The extension deletes no files here. (It erases the *download record*
for its stop request once the file lands, so the request doesn't sit
in Chrome's download list pointing at a file the watcher is about to
remove — but the file itself is left for the script.) Every file
removal is the script's:

- **Clean exit** (signal, stop request, takeover): drops `.watch.pid`
  and `.watch-status.json`, each only if it still names this process.
  A watcher acting on a stop request deletes that request first, so it
  can't outlive the watcher it stopped.
- **Startup** (`--pid-lockfile`): clears a stale status file — one
  naming the watcher it just replaced, or a pid that is no longer
  alive — and any `watch-stop.json`, which by definition predates it.
- **`--stop`**: kills the watcher, then clears both files the same way,
  including after a watcher that died without cleaning up.

## The Capture page's side

- **Needs "Allow access to file URLs"** (off by default, in
  `chrome://extensions`). Detection is a `file://` read; without it the
  page reports no watcher and shows nothing. There is no probe-based
  fallback — a Stop button whose effect we could never confirm is
  worse than no button.
- Reads on load, and again whenever the page is brought back to the
  front (throttled). Not on a timer: the moment the user looks at the
  page is when the answer has to be right.
- **Only looks in the extension's own capture directory.** A watcher
  started with an explicit `--directory` somewhere else publishes a
  status file the page never sees, so it shows nothing — working as
  intended, not a bug.
- The indicator sits at the right end of the button row, after the Ask
  buttons, and is hidden whenever no watcher is visible.
- **Stop** writes the request, then waits up to 5s for
  `.watch-status.json` to disappear. Gone → the indicator disappears
  with it, silently; success needs no announcement. Still there →
  `Failed to stop watch script` in the page's status line
  (`#ask-status`), with the indicator left up. That message clears
  itself as soon as a later read finds the watcher gone.

## Version compatibility

|  | old script | new script |
|--|-----------|-----------|
| **old extension** | today's behaviour | publishes a status file nobody reads; cleaned up on exit |
| **new extension** | no status file → no indicator, no Stop button | detect + stop |

An old watcher is invisible to the Capture page rather than showing a
Stop button that silently does nothing. `--stop` by pid keeps working
in every combination, because nothing about `.watch.pid` changed.
