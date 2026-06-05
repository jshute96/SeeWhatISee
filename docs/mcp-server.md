# MCP server

A local MCP (Model Context Protocol) server that exposes the same
"read the latest capture" / "watch for new captures" operations as the
`SeeWhatISee.sh` skill backend, but as a structured server any
MCP-aware client can call.

## Why

- **Reach beyond Claude Code and Gemini CLI.** Claude Desktop, Cursor,
  Zed, Continue and other MCP clients can use SeeWhatISee without each
  one needing its own per-tool skill wrapper.
- **Structured I/O.** Typed tool schemas instead of stdout-line parsing
  of a shell script.
- **Real push notifications for watch.** Subscriptions replace the
  current `--loop` polling + per-line notification scrape.
- **Future extensibility.** Server-side helpers (HTML→markdown
  extraction, thumbnailing, search) become feasible without changing
  every wrapper.

The shell scripts and SKILL.md wrappers stay; the MCP server is an
*additional* surface, not a replacement (at least for v1).

## Stack and layout

- **Language:** TypeScript, using the official
  `@modelcontextprotocol/sdk` package.
- **Bundling:** `esbuild` or `tsup` to a single bundled
  `dist/server.js` — code + deps in one file. No native modules in the
  hot path.
- **Distribution:** publish as `@see-what-i-see/mcp-server` on npm; users
  invoke via `npx -y @see-what-i-see/mcp-server`.
- **Repo layout:** `mcp-server/` at the repo root.
  - `mcp-server/src/server.ts` — single source file (server probably
    won't grow past one file).
  - `mcp-server/package.json` — local manifest, declares the SDK
    dependency and the `build` / `start` scripts.
  - `mcp-server/dist/server.js` — bundled output; `.gitignore`d.
- **Runtime:** Node ≥ 20 (matches Node SEA support era; also what
  most MCP clients ship with).

## Source-dir resolution

Mirrors `SeeWhatISee.sh` exactly so users don't need separate config.
Resolved **once** at server startup; tool calls don't take per-call
directory overrides — the server has one source dir for its whole
lifetime.

- An optional CLI arg `--directory DIR` on the server itself overrides
  everything (passed via `args` in the user's MCP config).
- Otherwise, parse `.SeeWhatISee` in `cwd` then `$HOME` for a
  `directory=...` line.
- Otherwise, default to `$HOME/Downloads/SeeWhatISee`.
- `$SNAP_REAL_HOME` overrides `$HOME` if present (same reason as the
  shell script — snap-installed clients mangle `$HOME`).

No `--copy-to-dir` equivalent. MCP clients read the absolute paths the
tools return directly; they don't have the workspace-sandbox limitation
the Gemini CLI does.

## How files are returned by `get_latest` / `watch`

Captured files are exposed as **resources**, not raw paths. Each tool
call returns, per record:

- A **JSON metadata block** (a `text` content block) — the record with
  each artifact's on-disk `filename` dropped, leaving its capture flags
  (`hasHighlights`, `format`, …). The flags are keyed by role.
- Per artifact, a **`resource_link`** content block — `name` is the role
  (`screenshot` / `contents` / `selection`), carrying the file's
  `file://` `uri` and `mimeType` (plus `size` when the file is on disk).

The locator is **not duplicated**: the `uri` / `mimeType` live only on
the `resource_link`; the metadata block joins to it by role. A link is a
reference, not the bytes — it costs no context until read. Clients with
their own file tool can open the `file://` path directly.

### Inlining

The bytes can also come back inline — as an `image` content block for
images, or an embedded `resource` block otherwise (so HTML / markdown
arrive as files, not assistant text). Inline content is returned **in
addition to** the `resource_link`, never instead of it.

- **`return_inline: true`** — inline every artifact.
- **`return_inline: false`** — links only.
- **Omitted (default)** — inline only a `selection` of 10 KB or smaller
  (selections are usually tiny; this saves a round-trip). Everything else
  is link-only.

If an artifact's file is missing or escapes the source dir, inlining is
skipped for that artifact (its link still stands) rather than failing the
whole call.

## Capabilities

### Tools

#### `get_latest`

Returns the most recent record from `log.json`.

- **Input:** `{ return_inline?: boolean }`.
- **Output:** a JSON metadata block plus a `resource_link` per artifact
  (and optional inline content) — see
  [How files are returned](#how-files-are-returned-by-get_latest--watch).
  The metadata mirrors `SeeWhatISee.sh --get-latest` (see
  `skills/json-record.template.md`) except each artifact's `filename` is
  dropped; the file's locator rides on its `resource_link`.
- **Errors:** structured error if `log.json` is missing or empty
  (parallel to the shell script's "No captures yet" messages).

#### `watch`

Returns new capture records — drains any pending, then blocks for the
next one if none are pending.

- **Input:**
  - `after?: string` — timestamp from a prior record. Returns all
    records strictly newer than this in the array. If absent or `null`,
    pending state is "empty" — falls straight through to the blocking
    wait.
  - `timeout_ms?: number` — max time to block waiting for a new
    capture. Default and cap discussed below.
  - `return_inline?: boolean` — same meaning as on `get_latest`.
- **Output:** the content blocks for each new record, concatenated (same
  per-record shape as `get_latest`). A single `{ records: [] }` text
  block if the timeout fired with nothing new.
- **Behavior:**
  - With `after`: behaves like `--watch --after <ts>` (without
    `--catch-up-one`) — emit *all* records newer than `after`,
    immediately, then return.
  - With `after` and no newer records: fall through to the blocking
    wait, return up to one record (or empty on timeout).
  - Without `after`: blocking wait only — return up to one record or
    empty on timeout.
- **Why a single tool, not two:** matches the "drain + wait" loop a
  client naturally writes. Splitting it into `pending_since` +
  `wait_for_next` would force every caller to compose them.

##### `watch` timeout — how long can it block?

- **Server side:** we don't need a small cap. The watcher just sits on
  an `fs.watch` event and a `setTimeout`; an hours-long block costs
  nothing locally.
- **Client side is the real limit.** Each MCP client picks its own
  per-request timeout — typically 30–60 s. The server can advertise a
  long timeout, but if the client times the RPC out, the call dies
  regardless.
- **Recommended defaults:** default `timeout_ms` to ~60 s; allow values
  up to ~10 minutes. Document the tradeoff in the tool description so
  the model knows that for genuinely long waits it should either
  call `watch` in a loop or use the subscription resource.
- **For minutes-to-hours waits, use the subscription.** That's what
  `seewhatisee://captures/stream` is for — no per-request timeout,
  server pushes whenever a capture arrives.

There are no separate file-reading tools. Files are read through the
resources interface below (or the client's own file tool at the
`file://` path, or `return_inline`).

### Resources

#### `file://…` captured files

Any file under the source dir can be read as a resource.

- **`resources/read`** on a `file://` URI returns the contents — `text`
  for text/HTML/markdown/JSON, a base64 `blob` for images and other
  binaries.
- **Not listed.** `resources/list` does *not* enumerate captured files
  (it would dump the whole capture history). Clients discover files via
  the `resource_link` blocks in tool results and read them by URI;
  `resources/read` accepts any in-dir `file://` whether listed or not.
- **Constraint:** the URI must resolve (after symlink resolution) inside
  the configured source dir. Everything else is rejected with a
  structured error — no arbitrary file reads.

#### `seewhatisee://captures/stream` *(subscribable)*

The push-notification equivalent of `--watch --loop`.

- Client calls `resources/subscribe` with this URI once.
- Server fires `notifications/resources/updated` whenever a new
  record appears in `log.json`.
- Client calls `resources/read` on the URI to fetch the latest record
  payload after each notification.
- On unsubscribe (or client disconnect), the watcher tears down.

**Fallback when the client doesn't support subscriptions:** the same
client can still poll with the `watch` tool. Both code paths live in
the server; only the client's capabilities decide which one gets used.

### Prompts

Both prompts are exposed via MCP's `prompts/list` and surface as slash
commands in clients that render prompts (Claude Desktop, Claude Code).
They are the MCP-side equivalents of today's two main SKILL.md files.

#### `see-what-i-see`

- **Args:** none.
- **Renders to:** instructions that tell the model to call
  `get_latest`, then process the returned record according to the
  same rules as today's `skills/json-record.template.md` +
  `skills/process.template.md` blocks.

#### `see-what-i-see-watch`

- **Args:** none.
- **Renders to:** instructions to subscribe to
  `seewhatisee://captures/stream` (preferred), or fall back to looping
  on the `watch` tool with `after = <last record's timestamp>` if the
  client doesn't support subscriptions. Then process each delivered
  record using the same template blocks.

No `see-what-i-see-stop` equivalent — the client owns the
subscription's lifecycle and tears it down on its own.

## Sharing the prompt body with the SKILL.md templates

The MCP prompt bodies share the same `[[json-record.template.md]]` and
`[[process.template.md]]` blocks as the SKILL.md files, generated through
the same pipeline so wording can't drift.

Pipeline (edit the leftmost; everything to the right regenerates):

```
skills/mcp-server.{see,watch}.md         (templates, edit these)
        │  skills/generate-skills.py
        ▼
mcp-server/prompts/{see-what-i-see,see-what-i-see-watch}.md  (committed)
        │  mcp-server/build-prompts.mjs
        ▼
mcp-server/src/prompts.generated.ts      (gitignored — TS strings)
        │  tsc + esbuild
        ▼
mcp-server/dist/seewhatisee-mcp.js       (single-file bundle, prompts inlined)
```

- The `.md` templates carry YAML frontmatter (`name`, `description`)
  alongside the body, so both the `prompts/list` description and the
  `prompts/get` body come from the same source.
- `skills/generate-skills.py` validates `mcp-server/prompts/*.md` against
  the templates as part of `npm run test:skills` (root-level script,
  wired into `npm test`); drift fails the check.
- `mcp-server/build-prompts.mjs` runs from `postinstall` (which also
  runs `tsc`), so a fresh `npm install` leaves `dist/` ready for a
  direct `node --test tests/<file>.mjs` invocation. `pretest` and
  `build` also re-run it on every test / build.

## Differences from `SeeWhatISee.sh`

| Concern              | `SeeWhatISee.sh`                          | MCP server                          |
|----------------------|-------------------------------------------|-------------------------------------|
| Single read          | `--get-latest`                            | `get_latest` tool                   |
| Drain + wait         | `--watch [--after TS]` (one-shot)         | `watch` tool with `after`           |
| Streaming loop       | `--watch --loop`                          | `captures/stream` subscription      |
| Stop watcher         | `--stop` + `.watch.pid`                   | client-managed; unsubscribe / exit  |
| Inline selection     | `--print_selection`                       | small selections inline by default; otherwise `return_inline`, or `resources/read` on the selection's `file://` URI |
| Workspace copy       | `--copy-to-dir DIR`                       | not needed; clients read in place   |
| Source dir override  | `--directory DIR`                         | `--directory` server arg (startup only — no per-call override) |

## Decisions

- **Single bundled file.** `esbuild` or `tsup` produces one
  `dist/server.js`; no transitive `node_modules` at the user's end.
- **`fs.watch` for the watcher.** Stdlib, no extra dependency, fine
  for watching one file.
- **No server-side processing (markdown extraction, OCR, etc.).** The
  server's job is to expose captures; transformation lives client-side
  (or in the extension).
- **Subscription cleanup on client crash.** Track per-client subscribe
  state; on stdio EOF tear everything down. Worth a unit test.

## Possible future features

- **`seewhatisee://latest` resource.** A read-only resource that
  resolves to the latest record (same content as `get_latest`'s
  output). Would let clients with an `@`-mention UI attach the latest
  capture by reference. Skipped in v1 — `get_latest` covers the same
  ground for the prompts we ship.
- **Single-binary distribution.** Bun `--compile` for cross-platform
  binaries published to GitHub Releases, for users without Node.
- **`list_recent_captures` / `search_captures` tools.** Multi-record
  queries beyond "latest" and "after a timestamp".

## Cross-references

- [`docs/cli_commands.md`](cli_commands.md) — the shell-script commands
  this server parallels.
- [`docs/claude-plugin.md`](claude-plugin.md) — how the SKILL.md
  surface is wired in Claude Code today.
- [`skills/SeeWhatISee.sh`](../skills/SeeWhatISee.sh) — the unified
  backend whose flag surface this server mirrors.
- [`skills/json-record.template.md`](../skills/json-record.template.md)
  and [`skills/process.template.md`](../skills/process.template.md) —
  shared template blocks that the MCP prompts should be generated
  from.
