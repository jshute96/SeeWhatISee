// SeeWhatISee MCP server.
//
// Exposes the same operations as `skills/SeeWhatISee.sh` over MCP, plus a
// subscribable resource that pushes notifications when new captures arrive.
//
// Source-dir resolution mirrors the shell script: `--directory` startup
// override, then `.SeeWhatISee` in cwd or $HOME (parsed for `directory=...`),
// then `$HOME/Downloads/SeeWhatISee`. $SNAP_REAL_HOME overrides $HOME.
//
// See ../docs/mcp-server.md for the full design.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

export const STREAM_URI = 'seewhatisee://captures/stream';
const LOG_FILE = 'log.json';
const DEFAULT_WATCH_DEFAULT_MS = 60 * 1000;
const DEFAULT_WATCH_MAX_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Source-dir resolution. Mirrors SeeWhatISee.sh.
// ---------------------------------------------------------------------------

export interface ResolveOpts {
  /** Explicit override (typically the --directory CLI flag at startup). */
  explicitDir?: string;
  /** Working dir for the cwd-side .SeeWhatISee lookup. Defaults to process.cwd(). */
  cwd?: string;
  /** Override for $HOME / $SNAP_REAL_HOME. Used by tests. */
  homeDir?: string;
}

export function resolveSourceDir(opts: ResolveOpts = {}): string {
  if (opts.explicitDir) return opts.explicitDir;
  const home =
    opts.homeDir ?? process.env.SNAP_REAL_HOME ?? process.env.HOME ?? os.homedir();
  const cwd = opts.cwd ?? process.cwd();
  for (const candidate of [
    path.join(cwd, '.SeeWhatISee'),
    path.join(home, '.SeeWhatISee'),
  ]) {
    const dir = readConfigFile(candidate);
    if (dir) return dir;
  }
  return path.join(home, 'Downloads', 'SeeWhatISee');
}

function readConfigFile(filePath: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  let dir: string | null = null;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || raw.startsWith('#')) continue;
    if (!raw.startsWith('directory=')) {
      throw new Error(`Unrecognized option in ${filePath} line ${i + 1}: ${raw}`);
    }
    let v = raw.slice('directory='.length).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    dir = v;
  }
  return dir;
}

// ---------------------------------------------------------------------------
// log.json read + path rewrite.
// ---------------------------------------------------------------------------

interface ArtifactObject {
  filename: string;
  [key: string]: unknown;
}

export interface CaptureRecord {
  timestamp: string;
  screenshot?: ArtifactObject;
  contents?: ArtifactObject;
  selection?: ArtifactObject;
  prompt?: string;
  url?: string;
  title?: string;
  imageUrl?: string;
  [key: string]: unknown;
}

function readAllRecords(logPath: string): CaptureRecord[] {
  let text: string;
  try {
    text = fs.readFileSync(logPath, 'utf8');
  } catch (e: unknown) {
    if ((e as { code?: string }).code === 'ENOENT') return [];
    throw e;
  }
  if (!text) return [];
  const out: CaptureRecord[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as CaptureRecord);
    } catch {
      // Defensive: skip malformed lines so a partially-written tail doesn't
      // hose the whole read. The extension writes whole files via the
      // downloads API, so this shouldn't happen in practice.
    }
  }
  return out;
}

function rewriteFilenames(rec: CaptureRecord, sourceDir: string): CaptureRecord {
  const out: CaptureRecord = { ...rec };
  for (const key of ['screenshot', 'contents', 'selection'] as const) {
    const v = out[key];
    if (v && typeof v.filename === 'string' && !path.isAbsolute(v.filename)) {
      out[key] = { ...v, filename: path.join(sourceDir, v.filename) };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Path containment for read_file / get_file_info.
// ---------------------------------------------------------------------------

function ensureUnderSource(filename: string, sourceDir: string): string {
  if (typeof filename !== 'string' || !filename) {
    throw new McpError(ErrorCode.InvalidParams, 'filename is required');
  }
  if (!path.isAbsolute(filename)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `filename must be an absolute path: ${filename}`,
    );
  }
  // Lexical containment check first — does not touch the filesystem.
  // Catches paths trivially outside the source dir before we leak any
  // information about whether they exist.
  const normalizedFile = path.resolve(filename);
  const normalizedSource = path.resolve(sourceDir);
  const lexRel = path.relative(normalizedSource, normalizedFile);
  if (lexRel.startsWith('..') || path.isAbsolute(lexRel)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `filename is outside the source dir: ${filename}`,
    );
  }
  // Realpath check: catches symlinks (file or directory) that escape after
  // the lexical check passes. If the source dir doesn't exist, treat any
  // claim of containment as outside.
  let realSource: string;
  try {
    realSource = fs.realpathSync(normalizedSource);
  } catch {
    throw new McpError(
      ErrorCode.InvalidParams,
      `filename is outside the source dir: ${filename}`,
    );
  }
  let realFile: string;
  try {
    realFile = fs.realpathSync(normalizedFile);
  } catch (e: unknown) {
    if ((e as { code?: string }).code === 'ENOENT') {
      // Lexical check already passed, so the file is inside the source
      // dir — it just doesn't exist. Safe to disclose that.
      throw new McpError(ErrorCode.InvalidParams, `file not found: ${filename}`);
    }
    throw e;
  }
  const realRel = path.relative(realSource, realFile);
  if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `filename is outside the source dir: ${filename}`,
    );
  }
  return realFile;
}

// ---------------------------------------------------------------------------
// Tiny ext -> mime map. Covers everything the extension actually writes.
// ---------------------------------------------------------------------------

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
};

function mimeFor(filename: string): string {
  return MIME_BY_EXT[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// Watcher — single shared fs.watch over log.json (and its parent dir, so we
// pick up the "file created" event when log.json doesn't exist yet). The
// `LogWatcher` is reference-counted: it starts on the first listener and
// stops when the last one leaves.
// ---------------------------------------------------------------------------

type ChangeListener = () => void;

class LogWatcher {
  private fileWatcher: fs.FSWatcher | null = null;
  private dirWatcher: fs.FSWatcher | null = null;
  private listeners = new Set<ChangeListener>();

  constructor(private readonly sourceDir: string) {}

  add(cb: ChangeListener): void {
    this.listeners.add(cb);
    if (this.listeners.size === 1) this.start();
  }

  remove(cb: ChangeListener): void {
    if (!this.listeners.delete(cb)) return;
    if (this.listeners.size === 0) this.stop();
  }

  private start(): void {
    try {
      fs.mkdirSync(this.sourceDir, { recursive: true });
    } catch {
      // If we can't create it, the dir watch will fail too; let it surface.
    }
    const logPath = path.join(this.sourceDir, LOG_FILE);
    // Parent dir watch catches "log.json created" events when the file
    // didn't exist when we started watching.
    try {
      this.dirWatcher = fs.watch(this.sourceDir, (_event, fname) => {
        if (fname === LOG_FILE) {
          // If the file just appeared, swap in a direct file watcher
          // (more reliable for subsequent in-place rewrites on Linux).
          if (!this.fileWatcher) this.attachFileWatcher(logPath);
          this.notify();
        }
      });
    } catch {
      // ignore — fall back to file-only watch
    }
    this.attachFileWatcher(logPath);
  }

  private attachFileWatcher(logPath: string): void {
    if (this.fileWatcher) return;
    try {
      this.fileWatcher = fs.watch(logPath, () => this.notify());
    } catch {
      // log.json doesn't exist yet; dir watcher handles creation.
    }
  }

  private notify(): void {
    // Snapshot: a listener might unsubscribe inside its own callback.
    for (const cb of [...this.listeners]) {
      try {
        cb();
      } catch {
        // swallow — one listener's bug shouldn't break the rest
      }
    }
  }

  private stop(): void {
    this.fileWatcher?.close();
    this.fileWatcher = null;
    this.dirWatcher?.close();
    this.dirWatcher = null;
  }
}

// ---------------------------------------------------------------------------
// Server factory.
// ---------------------------------------------------------------------------

export interface ServerOpts {
  sourceDir: string;
  /** Default `watch` timeout when caller doesn't specify one (ms). */
  watchDefaultTimeoutMs?: number;
  /** Hard upper bound for `watch` timeouts (ms). */
  watchMaxTimeoutMs?: number;
}

export function createServer(opts: ServerOpts): Server {
  const sourceDir = opts.sourceDir;
  const watchDefaultMs = opts.watchDefaultTimeoutMs ?? DEFAULT_WATCH_DEFAULT_MS;
  const watchMaxMs = opts.watchMaxTimeoutMs ?? DEFAULT_WATCH_MAX_MS;
  const logPath = path.join(sourceDir, LOG_FILE);

  const logWatcher = new LogWatcher(sourceDir);
  let streamSubscribers = 0;
  let streamListener: ChangeListener | null = null;

  const server = new Server(
    { name: 'seewhatisee', version: '0.1.0' },
    {
      capabilities: {
        tools: {},
        resources: { subscribe: true, listChanged: false },
        prompts: {},
      },
    },
  );

  // -------- tools --------

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'get_latest',
        description:
          "Return the most recent capture record from the SeeWhatISee log. " +
          "The record carries absolute paths to any screenshot / HTML / selection file.",
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      },
      {
        name: 'watch',
        description:
          "Return new capture records. With `after`, emits every record strictly newer " +
          "than that timestamp immediately. If nothing is pending, blocks for up to " +
          "`timeout_ms` waiting for the next capture. For long-running watches, " +
          "subscribe to the `seewhatisee://captures/stream` resource instead.",
        inputSchema: {
          type: 'object',
          properties: {
            after: {
              type: 'string',
              description: 'Timestamp of a prior record; return all newer records.',
            },
            timeout_ms: {
              type: 'number',
              minimum: 0,
              maximum: watchMaxMs,
              description: `Max ms to block waiting for the next capture. Default ${watchDefaultMs}.`,
            },
          },
          additionalProperties: false,
        },
      },
      {
        name: 'read_file',
        description:
          "Read a byte range from a captured file. Returns base64-encoded bytes. " +
          "`filename` must resolve inside the configured source dir.",
        inputSchema: {
          type: 'object',
          properties: {
            filename: { type: 'string', description: 'Absolute path from a capture record.' },
            offset: { type: 'number', minimum: 0 },
            length: { type: 'number', minimum: 1 },
          },
          required: ['filename'],
          additionalProperties: false,
        },
      },
      {
        name: 'get_file_info',
        description:
          "Return {size, mimeType, capturedAt} for a captured file without reading it. " +
          "`filename` must resolve inside the configured source dir.",
        inputSchema: {
          type: 'object',
          properties: {
            filename: { type: 'string', description: 'Absolute path from a capture record.' },
          },
          required: ['filename'],
          additionalProperties: false,
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    switch (name) {
      case 'get_latest':
        return handleGetLatest();
      case 'watch':
        return await handleWatch(args as Record<string, unknown>);
      case 'read_file':
        return handleReadFile(args as Record<string, unknown>);
      case 'get_file_info':
        return handleGetFileInfo(args as Record<string, unknown>);
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  });

  function handleGetLatest() {
    const records = readAllRecords(logPath);
    if (records.length === 0) {
      const exists = fileExists(logPath);
      throw new McpError(
        ErrorCode.InvalidRequest,
        exists
          ? `${logPath} is empty. No captures yet.`
          : `${logPath} not found. No captures yet?`,
      );
    }
    const latest = rewriteFilenames(records[records.length - 1], sourceDir);
    return jsonContent(latest);
  }

  async function handleWatch(args: Record<string, unknown>) {
    const after = typeof args.after === 'string' ? args.after : undefined;
    let timeoutMs =
      typeof args.timeout_ms === 'number' ? args.timeout_ms : watchDefaultMs;
    timeoutMs = Math.max(0, Math.min(timeoutMs, watchMaxMs));

    // Drain pending. If `after` matches a record, return everything after it.
    // If `after` doesn't match any record (e.g. caller's known timestamp is
    // not in the log), match the shell script's lenient semantics and fall
    // through to the blocking wait — don't error.
    if (after) {
      const all = readAllRecords(logPath);
      const idx = all.findIndex((r) => r.timestamp === after);
      if (idx >= 0 && idx < all.length - 1) {
        const pending = all.slice(idx + 1).map((r) => rewriteFilenames(r, sourceDir));
        return jsonContent({ records: pending });
      }
    }

    const next = await waitForNext(after, timeoutMs);
    const records = next ? [rewriteFilenames(next, sourceDir)] : [];
    return jsonContent({ records });
  }

  function waitForNext(
    after: string | undefined,
    timeoutMs: number,
  ): Promise<CaptureRecord | null> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (val: CaptureRecord | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        logWatcher.remove(onChange);
        resolve(val);
      };
      const onChange = () => {
        const all = readAllRecords(logPath);
        if (all.length === 0) return; // log truncated; wait for next change
        const last = all[all.length - 1];
        // Ignore no-op changes (e.g. the same record we already saw).
        if (after && last.timestamp === after) return;
        finish(last);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      logWatcher.add(onChange);
    });
  }

  function handleReadFile(args: Record<string, unknown>) {
    const filename = String(args.filename ?? '');
    const offset = typeof args.offset === 'number' ? args.offset : 0;
    const length = typeof args.length === 'number' ? args.length : undefined;
    if (offset < 0) {
      throw new McpError(ErrorCode.InvalidParams, 'offset must be >= 0');
    }
    const real = ensureUnderSource(filename, sourceDir);
    const fd = fs.openSync(real, 'r');
    try {
      const stat = fs.fstatSync(fd);
      const totalSize = stat.size;
      const start = Math.min(offset, totalSize);
      const want = length ?? Math.max(0, totalSize - start);
      const buf = Buffer.alloc(want);
      const bytesRead = want > 0 ? fs.readSync(fd, buf, 0, want, start) : 0;
      const eof = start + bytesRead >= totalSize;
      return jsonContent({
        bytes: buf.subarray(0, bytesRead).toString('base64'),
        totalSize,
        eof,
      });
    } finally {
      fs.closeSync(fd);
    }
  }

  function handleGetFileInfo(args: Record<string, unknown>) {
    const filename = String(args.filename ?? '');
    const real = ensureUnderSource(filename, sourceDir);
    const stat = fs.statSync(real);
    return jsonContent({
      size: stat.size,
      mimeType: mimeFor(real),
      capturedAt: stat.mtime.toISOString(),
    });
  }

  // -------- resources --------

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: STREAM_URI,
        name: 'Capture stream',
        description:
          'Read returns the latest capture record (or { record: null } if none yet). ' +
          'Subscribe to receive a `notifications/resources/updated` notification on every new capture.',
        mimeType: 'application/json',
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    if (req.params.uri !== STREAM_URI) {
      throw new McpError(ErrorCode.InvalidRequest, `Unknown resource: ${req.params.uri}`);
    }
    const records = readAllRecords(logPath);
    const payload =
      records.length === 0
        ? { record: null }
        : rewriteFilenames(records[records.length - 1], sourceDir);
    return {
      contents: [
        { uri: STREAM_URI, mimeType: 'application/json', text: JSON.stringify(payload) },
      ],
    };
  });

  server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    if (req.params.uri !== STREAM_URI) {
      throw new McpError(ErrorCode.InvalidRequest, `Unknown resource: ${req.params.uri}`);
    }
    streamSubscribers += 1;
    if (streamSubscribers === 1) {
      streamListener = () => {
        // Best-effort: if the transport is gone the notify fails silently.
        server.sendResourceUpdated({ uri: STREAM_URI }).catch(() => {});
      };
      logWatcher.add(streamListener);
    }
    return {};
  });

  server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
    if (req.params.uri !== STREAM_URI) {
      throw new McpError(ErrorCode.InvalidRequest, `Unknown resource: ${req.params.uri}`);
    }
    // The MCP spec's subscribe/unsubscribe doesn't carry a subscription ID;
    // we just balance counts. Going below zero is treated as zero.
    streamSubscribers = Math.max(0, streamSubscribers - 1);
    if (streamSubscribers === 0 && streamListener) {
      logWatcher.remove(streamListener);
      streamListener = null;
    }
    return {};
  });

  // Tear the watcher down on transport disconnect so a long-running parent
  // (tests; future supervisor) doesn't leak inotify slots.
  server.onclose = () => {
    if (streamListener) {
      logWatcher.remove(streamListener);
      streamListener = null;
    }
    streamSubscribers = 0;
  };

  // -------- prompts --------

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: 'see-what-i-see',
        description:
          'Read the latest screenshot or HTML snapshot taken by the SeeWhatISee Chrome extension and describe what you see.',
      },
      {
        name: 'see-what-i-see-watch',
        description:
          'Watch for new captures from the SeeWhatISee Chrome extension. Each time a screenshot or HTML snapshot is taken, describe what you see and start watching for the next one.',
      },
    ],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    if (req.params.name === 'see-what-i-see') {
      return {
        description: 'Describe the latest SeeWhatISee capture.',
        messages: [
          { role: 'user', content: { type: 'text', text: PROMPT_SEE } },
        ],
      };
    }
    if (req.params.name === 'see-what-i-see-watch') {
      return {
        description: 'Watch for new SeeWhatISee captures and describe each one.',
        messages: [
          { role: 'user', content: { type: 'text', text: PROMPT_WATCH } },
        ],
      };
    }
    throw new McpError(ErrorCode.InvalidRequest, `Unknown prompt: ${req.params.name}`);
  });

  return server;
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function fileExists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function jsonContent(payload: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  };
}

// ---------------------------------------------------------------------------
// Prompt bodies. Mirror the SKILL.md templates in skills/. Kept here as
// string constants for v1; future work: hook into skills/generate-skills.py
// so these are generated from the same templates the skills are.
// ---------------------------------------------------------------------------

const JSON_RECORD_BLOCK = `The JSON record contains \`{timestamp, url, title}\` plus any of:
  - \`screenshot\` — object describing a captured PNG, with:
    - \`filename\` — absolute path.
    - \`hasHighlights: true\` means the user drew red markup (boxes and/or lines) on top of the screenshot to call attention to specific regions.
    - \`hasRedactions: true\` means the user blacked out at least one region. Those are deliberately hidden as irrelevant or private — don't comment about them unless asked.
    - \`isCropped: true\` means the PNG covers only a region the user selected.
  - \`contents\` — object describing a captured whole-page HTML snapshot, with:
    - \`filename\` — absolute path.
    - \`isEdited: true\` means the user edited the captured HTML before saving, so it didn't come exactly from the website.
  - \`selection\` — object describing the user's selected text in the page, with:
    - \`filename\` — absolute path.
    - \`format\` — one of \`"html"\`, \`"text"\`, \`"markdown"\`.
    - \`isEdited: true\` — same as \`contents.isEdited\`.
  - \`prompt\` — the user's instruction for this capture.
  - \`imageUrl\` — URL of a specific image the user captured, inside the page.

  A record may have any subset of \`screenshot\` / \`contents\` / \`selection\`, or none of them (meaning the URL and optional \`prompt\` are the whole payload).

  **Look at referenced files only. Don't go fishing for others unless asked to.**`;

const PROCESS_BLOCK = `Process the capture:
  - If \`screenshot\` is present, read \`screenshot.filename\`.
    - **If \`screenshot.hasHighlights\` is \`true\`, the user has drawn red markup to call attention to specific regions. Focus your description on those marked areas. If a \`prompt\` is present, it is likely referring to those regions specifically — interpret it in that context.**
  - If \`contents\` is present, don't read the file up front (HTML can be large); wait until you know what to look for.
  - If \`selection\` is present, don't read the file until you know what to look for.
  - **If \`prompt\` is present, treat it as the user's instruction for this capture and act on it directly.** Use the screenshot, HTML, selection, and/or \`url\` as the subject of that instruction. If no files were saved, the \`url\` is what the prompt is about.
  - If \`prompt\` is absent:
    - For screenshots, briefly describe what you see and mention the source \`url\`. When \`screenshot.hasHighlights\` is \`true\`, lead with what's highlighted.
    - For HTML-only captures, report that you have an HTML snapshot from the source \`url\` and ask the user what they want to know.
    - For selection-only captures, quote or summarize the selected fragment and mention the source \`url\`.
    - For URL-only captures (no files), report the \`url\` and ask the user what they want to know about it.`;

const PROMPT_SEE = `Read the latest screenshot or HTML snapshot taken by the SeeWhatISee Chrome extension and make it available as context so the user can ask questions about what they see.

You can't run this autonomously since it requires the user to have just clicked the extension. Only run it when asked to.

**If you get any failures, just report them. Don't try to find other solutions.**

## Steps

1. Call the \`get_latest\` tool. It returns one JSON record.
  - If the call fails, the SeeWhatISee Chrome extension probably hasn't taken any captures yet.
  - The record has absolute paths already filled in for \`screenshot\`, \`contents\`, and \`selection\`.

2. ${JSON_RECORD_BLOCK}

3. ${PROCESS_BLOCK}`;

const PROMPT_WATCH = `Watch for new captures from the SeeWhatISee Chrome extension. Each time a screenshot or HTML snapshot is taken, describe what you see and start watching for the next one.

**If you get any failures, just report them. Don't try to find other solutions.**

## Getting snapshots in a loop

Prefer the subscription path when the client supports it; fall back to polling otherwise.

### Subscription path (preferred)

1. Subscribe to the resource \`seewhatisee://captures/stream\`.
2. Each \`notifications/resources/updated\` notification means a new capture arrived. Read the resource to fetch the latest record, then process it as described below.
3. Continue until the user tells you to stop.

### Polling path (fallback)

1. Call the \`watch\` tool with no arguments. It blocks for up to ~60s and returns \`{ records: [...] }\`.
2. Process each returned record as described below.
3. Call \`watch\` again with \`after = <last record's timestamp>\` to catch up on anything that arrived while you were processing, then block for the next.
4. Continue until the user tells you to stop.

## Process each snapshot

1. ${JSON_RECORD_BLOCK}

2. ${PROCESS_BLOCK}`;
