// SeeWhatISee MCP server.
//
// Exposes the same operations as `skills/SeeWhatISee.py` over MCP, plus a
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
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { ContentBlock } from '@modelcontextprotocol/sdk/types.js';

import { PROMPT_SEE, PROMPT_STOP, PROMPT_WATCH } from './prompts.generated.js';
import {
  expireLease,
  isLive,
  readStatus,
  writeStopRequest,
  SESSION_KIND,
  WatchSession,
  type StopReason,
} from './watch-session.js';

export const STREAM_URI = 'seewhatisee://captures/stream';
const LOG_FILE = 'log.json';

// Version reported to MCP clients. Read from package.json at runtime so it
// can't drift from the published package version (the release script bumps
// only package.json). Both the tsc output (dist/server.js) and the esbuild
// bundle (dist/seewhatisee-mcp.js) sit one level under the package root, so
// `../package.json` resolves the same way from either.
function readServerVersion(): string {
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      fs.readFileSync(path.join(dir, '..', 'package.json'), 'utf8'),
    ) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const SERVER_VERSION = readServerVersion();
const DEFAULT_WATCH_DEFAULT_MS = 60 * 1000;
const DEFAULT_WATCH_MAX_MS = 10 * 60 * 1000;
// How long `stop_watch` waits for a watch to let go of the slot before
// reporting the request as queued instead. Anything in flight answers within a
// poll or two; longer than that means nobody is there to answer.
const STOP_WAIT_MS = 2_000;
const STOP_POLL_MS = 100;
// fs.watch emits several raw events per logical capture: overlapping file + dir
// watchers both fire, an in-place write yields separate content/mtime events,
// and the browser's download can touch the dir multiple times. Coalesce a burst
// into one listener notification once writes go quiet.
const WATCH_DEBOUNCE_MS = 100;
// Canonical ISO-8601 UTC timestamp the extension writes (`toISOString()`). The
// stream cursor must match this so the lexical `>` compare stays chronological.
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// ---------------------------------------------------------------------------
// Source-dir resolution. Mirrors SeeWhatISee.py.
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
// Path containment for resource reads (file:// URIs) and inline file bytes.
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

function isImageMime(mime: string): boolean {
  return mime.startsWith('image/');
}

// Which MIME types we hand back as resource *text* rather than a base64 blob.
// Everything the extension writes that isn't an image is text-shaped.
function isTextMime(mime: string): boolean {
  return mime.startsWith('text/') || mime === 'application/json';
}

function fileUri(absPath: string): string {
  return pathToFileURL(absPath).href;
}

function statSizeOrUndefined(absPath: string): number | undefined {
  try {
    return fs.statSync(absPath).size;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Capture record -> MCP content blocks.
//
// A record's artifacts (screenshot / contents / selection) are exposed as
// resources, not raw paths. `get_latest` / `watch` return:
//   1. a JSON metadata text block — the record with each artifact's on-disk
//      `filename` dropped, leaving its capture flags (hasHighlights, format,
//      ...). The file's `uri` / `mimeType` are NOT duplicated here; they live
//      on the matching `resource_link` (joined by its `name` = role).
//   2. per artifact, a `resource_link` content block.
//   3. optionally, the file's bytes inline *in addition to* the link — an
//      `image` block for images, an embedded `resource` block otherwise (so
//      HTML / markdown arrive as files, not assistant text). Driven by
//      `return_inline`; small selections also inline by default.
// ---------------------------------------------------------------------------

// Selections are usually tiny text. At or below this size we inline them by
// default (no extra round-trip) unless the caller passed return_inline:false.
const SELECTION_INLINE_MAX_BYTES = 10 * 1024;

const ARTIFACT_KEYS = ['screenshot', 'contents', 'selection'] as const;

/**
 * The records following the resume cursor `after`, or null when no record
 * carries that timestamp.
 *
 * Positional, not a `timestamp > after` compare: the log is in append order,
 * and a record appended later can carry an earlier timestamp than one before
 * it (a Capture-page session pins its timestamp when the capture is *taken*,
 * so a slow save lands out of order). Comparing would skip those.
 *
 * Scanning backwards costs nothing and degrades well: the extension keeps
 * `log.json` timestamps unique, but against a log that repeats one, landing on
 * the last record carrying it still advances, where resuming after the first
 * would replay the rest on every call.
 *
 * Returning null rather than [] is what lets callers tell "you're up to date"
 * from "that cursor isn't in the log" — the latter has aged into a history file,
 * and they fall back to a chronological compare.
 */
function recordsAfterCursor(
  all: CaptureRecord[],
  after: string,
): CaptureRecord[] | null {
  for (let i = all.length - 1; i >= 0; i -= 1) {
    if (all[i].timestamp === after) return all.slice(i + 1);
  }
  return null;
}

/** Record with each artifact reduced to its capture flags (no locator). */
function flagsRecord(rec: CaptureRecord): Record<string, unknown> {
  const out: Record<string, unknown> = { ...rec };
  for (const key of ARTIFACT_KEYS) {
    const v = rec[key];
    if (v && typeof v.filename === 'string') {
      const { filename, ...flags } = v;
      out[key] = flags;
    }
  }
  return out;
}

/**
 * Record with artifacts rewritten to resource references ({ uri, mimeType,
 * size, ...flags }). Used by the `captures/stream` resource, whose JSON read
 * has no `resource_link` channel to carry the locator.
 */
function toResourceRecord(
  rec: CaptureRecord,
  sourceDir: string,
): Record<string, unknown> {
  const abs = rewriteFilenames(rec, sourceDir);
  const out: Record<string, unknown> = { ...abs };
  for (const key of ARTIFACT_KEYS) {
    const v = abs[key];
    if (v && typeof v.filename === 'string') {
      const { filename, ...flags } = v;
      const size = statSizeOrUndefined(filename);
      out[key] = {
        ...flags,
        uri: fileUri(filename),
        mimeType: mimeFor(filename),
        ...(size !== undefined ? { size } : {}),
      };
    }
  }
  return out;
}

/** The `resource_link` for an artifact file. */
function resourceLinkBlock(role: string, absPath: string): ContentBlock {
  const size = statSizeOrUndefined(absPath);
  return {
    type: 'resource_link',
    uri: fileUri(absPath),
    name: role,
    mimeType: mimeFor(absPath),
    ...(size !== undefined ? { size } : {}),
  };
}

/**
 * Inline content block for an artifact file (image, or embedded resource),
 * or null if the file is missing / escapes the source dir — in which case the
 * caller just keeps the resource_link rather than failing the whole call.
 */
function inlineContentBlock(absPath: string, sourceDir: string): ContentBlock | null {
  const mimeType = mimeFor(absPath);
  let buf: Buffer;
  try {
    buf = fs.readFileSync(ensureUnderSource(absPath, sourceDir));
  } catch {
    return null;
  }
  if (isImageMime(mimeType)) {
    return { type: 'image', data: buf.toString('base64'), mimeType };
  }
  const uri = fileUri(absPath);
  if (isTextMime(mimeType)) {
    return { type: 'resource', resource: { uri, mimeType, text: buf.toString('utf8') } };
  }
  return { type: 'resource', resource: { uri, mimeType, blob: buf.toString('base64') } };
}

/** Whether to inline an artifact, given the tri-state `return_inline` arg. */
function shouldInline(
  role: string,
  absPath: string,
  returnInline: boolean | undefined,
): boolean {
  if (returnInline === true) return true;
  if (returnInline === false) return false;
  // Default: auto-inline only small selections.
  if (role === 'selection') {
    const size = statSizeOrUndefined(absPath);
    return size !== undefined && size <= SELECTION_INLINE_MAX_BYTES;
  }
  return false;
}

/** Full content array for one capture record. */
function recordContent(
  rec: CaptureRecord,
  sourceDir: string,
  returnInline: boolean | undefined,
): ContentBlock[] {
  const abs = rewriteFilenames(rec, sourceDir);
  const blocks: ContentBlock[] = [
    { type: 'text', text: JSON.stringify(flagsRecord(rec)) },
  ];
  for (const key of ARTIFACT_KEYS) {
    const v = abs[key];
    if (!v || typeof v.filename !== 'string') continue;
    blocks.push(resourceLinkBlock(key, v.filename));
    if (shouldInline(key, v.filename, returnInline)) {
      const inline = inlineContentBlock(v.filename, sourceDir);
      if (inline) blocks.push(inline);
    }
  }
  return blocks;
}

/** Tri-state read of the `return_inline` arg: true / false / undefined. */
function inlineArg(args: Record<string, unknown>): boolean | undefined {
  return typeof args.return_inline === 'boolean' ? args.return_inline : undefined;
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
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

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

  // Schedule a single fan-out once the burst of raw fs events settles. Each new
  // event resets the timer, so a multi-write download notifies once, after the
  // file goes quiet.
  private notify(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.fanOut();
    }, WATCH_DEBOUNCE_MS);
  }

  private fanOut(): void {
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
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
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
  /**
   * Publish this server's watch in the capture directory, so the extension's
   * Capture page can show and stop it (see ../../docs/watch-protocol.md).
   * False runs the watch privately, alongside another watcher.
   */
  publishWatch?: boolean;
}

export function createServer(opts: ServerOpts): Server {
  const sourceDir = opts.sourceDir;
  const watchDefaultMs = opts.watchDefaultTimeoutMs ?? DEFAULT_WATCH_DEFAULT_MS;
  const watchMaxMs = opts.watchMaxTimeoutMs ?? DEFAULT_WATCH_MAX_MS;
  const logPath = path.join(sourceDir, LOG_FILE);

  const logWatcher = new LogWatcher(sourceDir);
  const watchSession = new WatchSession(sourceDir, opts.publishWatch !== false);
  let streamSubscribers = 0;
  let streamListener: ChangeListener | null = null;
  let streamStopUnsubscribe: (() => void) | null = null;

  const server = new Server(
    { name: 'seewhatisee', version: SERVER_VERSION },
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
          "Emits a JSON metadata block plus a `resource_link` for each screenshot / " +
          "HTML / selection file.",
        inputSchema: {
          type: 'object',
          properties: {
            return_inline: {
              type: 'boolean',
              description:
                'Whether to inline each file as a content block, in addition to its resource_link. true: inline every file. false: inline nothing. Omitted: auto-inline small text selections only.',
            },
          },
          additionalProperties: false,
        },
      },
      {
        name: 'watch',
        description:
          "Return new capture records. With `after`, emits every record following " +
          "the one with that timestamp immediately. If nothing is pending, blocks for up to " +
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
            return_inline: {
              type: 'boolean',
              description:
                'Whether to inline each file as a content block, in addition to its resource_link. true: inline every file. false: inline nothing. Omitted: auto-inline small text selections only.',
            },
          },
          additionalProperties: false,
        },
      },
      {
        name: 'stop_watch',
        description:
          "Stop the watch on the capture directory — this server's own, or a " +
          "/see-what-i-see-watch loop running elsewhere. Returns what it found: " +
          "the watch stopped, a request left for a watch that is between captures, " +
          "or no watch at all.",
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    switch (name) {
      case 'get_latest':
        return handleGetLatest(args as Record<string, unknown>);
      case 'watch':
        return await handleWatch(args as Record<string, unknown>);
      case 'stop_watch':
        return await handleStopWatch();
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  });

  function handleGetLatest(args: Record<string, unknown>) {
    const inline = inlineArg(args);
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
    return { content: recordContent(records[records.length - 1], sourceDir, inline) };
  }

  async function handleWatch(args: Record<string, unknown>) {
    const inline = inlineArg(args);
    const after = typeof args.after === 'string' ? args.after : undefined;
    let timeoutMs =
      typeof args.timeout_ms === 'number' ? args.timeout_ms : watchDefaultMs;
    timeoutMs = Math.max(0, Math.min(timeoutMs, watchMaxMs));

    // Claiming before reading is deliberate: it leaves no window where a stop
    // request arrives, finds nobody publishing, and is swept by the call that
    // was starting. A request already aimed at the session this call adopts
    // ends it here, without waiting for a capture.
    const stop: { reason: StopReason | null } = { reason: null };
    // Listening before claiming, so a request already waiting for this session
    // is heard as the claim finds it rather than after we start blocking.
    const heardStop = watchSession.onStopped((reason) => { stop.reason = reason; });
    watchSession.beginRun(after);
    try {
      return await runWatch();
    } finally {
      heardStop();
    }

    async function runWatch() {

    // Drain pending. If `after` matches a record, return everything after it.
    // If `after` doesn't match any record (e.g. caller's known timestamp is
    // not in the log), match the shell script's lenient semantics and fall
    // through to the blocking wait — don't error.
    // On the param being *present*, not truthy, so `after: ''` stays in the
    // cursored shape the way it does on the stream resource. No record carries
    // `''`, so it falls through to the wait's compare and drains from the start.
    // Drain before reporting a stop: captures that landed in the gap are the
    // client's whether or not the watch ended while they were waiting.
    const pending =
      after === undefined ? [] : recordsAfterCursor(readAllRecords(logPath), after) ?? [];
    if (stop.reason !== null) return finishWatch(pending);
    if (pending.length > 0) return finishWatch(pending);

    return finishWatch(await waitForNext(after, timeoutMs, () => stop.reason !== null));
    }

    // One exit for every way the call can end, so the session is always handed
    // on (or released) exactly once, and a stop is always reported.
    function finishWatch(records: CaptureRecord[]) {
      const last = records.length ? records[records.length - 1].timestamp : null;
      // Only a stop leaves nothing to resume from: a call that timed out
      // empty still belongs to a session its successor should continue, so it
      // hands back the cursor it came in with.
      watchSession.endRun(stop.reason !== null ? null : (last ?? after ?? null));
      if (stop.reason !== null) {
        return {
          content: [
            ...records.flatMap((r) => recordContent(r, sourceDir, inline)),
            ...jsonContent({ stopped: stop.reason }).content,
          ],
        };
      }
      if (records.length === 0) return jsonContent({ records: [] });
      return { content: records.flatMap((r) => recordContent(r, sourceDir, inline)) };
    }
  }

  /**
   * End the watch the capture directory publishes, whoever holds it.
   *
   * Always through the file channel — the same request the Capture page's Stop
   * button writes. A script run polls for it while it watches, and this server
   * watches the directory for it, so one route reaches both; signalling would
   * mean knowing which kinds of watcher may be signalled at all.
   */
  async function handleStopWatch() {
    const published = readStatus(sourceDir);
    if (published === null || (!isLive(published) && published.resumeAfter === undefined)) {
      return jsonContent({
        result: 'nothing',
        message: `No watch to stop on ${sourceDir}`,
      });
    }
    const kind = published.kind === SESSION_KIND ? 'server' : 'script';
    // Our own watch needs no request and no waiting: we are the one who would
    // answer it.
    if (watchSession.owns(published.sessionStarted)) {
      watchSession.release();
      return jsonContent({
        result: 'stopped',
        kind,
        message: 'Stopped the watch this server was running',
      });
    }
    writeStopRequest(sourceDir, published.sessionStarted, published.pid);
    if (await waitForRecordToClear(published.sessionStarted)) {
      return jsonContent({
        result: 'stopped',
        kind,
        message: `Stopped the ${kind === 'server' ? 'MCP server' : 'watch script'} watching ${sourceDir}`,
      });
    }
    // Nobody was in flight to answer — the watch is between captures, and its
    // next run finds the request on entry. Expire the lease meanwhile, so the
    // Capture page stops showing a watch now rather than when the gap lease
    // would have run out; the record itself stays, since it is what lets that
    // run recognize the request as its own.
    expireLease(sourceDir, published);
    return jsonContent({
      result: 'queued',
      kind,
      message: `The watch on ${sourceDir} will stop when it next runs`,
    });
  }

  /**
   * Wait briefly for the session to let go of the slot, or give up.
   *
   * The record is the only honest signal: the request file going away could
   * equally mean it was never written (`writeStopRequest` swallows its errors,
   * because a stop we can't ask for is reported by what happens next).
   */
  async function waitForRecordToClear(session: string): Promise<boolean> {
    const deadline = Date.now() + STOP_WAIT_MS;
    while (Date.now() < deadline) {
      const now = readStatus(sourceDir);
      if (now === null || now.sessionStarted !== session) return true;
      await new Promise((r) => setTimeout(r, STOP_POLL_MS));
    }
    return false;
  }

  // Block until the log gains records past the caller's cursor, then
  // resolve with ALL of them (not just the latest). Returning the whole batch
  // is what makes a burst safe: fs events are debounced and coalesced, so two
  // captures landing close together fan out as a single wake. If we resolved
  // with only the last record, the client would advance its cursor past the
  // intermediate one and never see it. The cursor is `after` when given,
  // otherwise the latest timestamp at the moment we start waiting (so a
  // pre-existing tail isn't re-emitted). Resolves with [] on timeout.
  function waitForNext(
    after: string | undefined,
    timeoutMs: number,
    isStopped: () => boolean,
  ): Promise<CaptureRecord[]> {
    const startRecords = readAllRecords(logPath);
    const baseline =
      after ??
      (startRecords.length ? startRecords[startRecords.length - 1].timestamp : '');
    return new Promise((resolve) => {
      let settled = false;
      const finish = (val: CaptureRecord[]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        logWatcher.remove(onChange);
        stopHeard();
        resolve(val);
      };
      const onChange = () => {
        const all = readAllRecords(logPath);
        // Positional while the baseline record is in the log, so an
        // out-of-order arrival still counts as fresh. That covers the
        // no-cursor call too: its baseline is the tail at the moment we
        // started waiting, which is a record like any other.
        //
        // The fallback is chronological, for a cursor that has aged into a
        // history file and for the empty log (baseline ''). ISO-8601 UTC timestamps
        // are fixed-width, so `>` compares chronologically, and it drops no-op
        // changes (the baseline's own record is not `>` itself) and skips a
        // truncated log until real records return.
        const fresh = recordsAfterCursor(all, baseline)
          ?? all.filter((r) => r.timestamp > baseline);
        if (fresh.length === 0) return;
        finish(fresh);
      };
      const timer = setTimeout(() => finish([]), timeoutMs);
      // A stop ends the wait as surely as a capture does — the session is
      // over, and blocking out the rest of the timeout would leave the client
      // waiting on a watch that no longer exists.
      const stopHeard = watchSession.onStopped(() => finish([]));
      if (isStopped()) finish([]);
      // Arm the watcher BEFORE the catch-up read, then read once. This closes
      // the gap where a capture lands after we snapshot `baseline` but before
      // the watcher is live: a write after `add` fires an fs event; a write
      // before it is already on disk for this read. Either way it's caught,
      // so we never block until the *next* change for a record that already
      // exists. `finish` is idempotent, so a later fs event is harmless.
      logWatcher.add(onChange);
      onChange();
    });
  }

  // -------- resources --------

  // Only the subscribable capture stream is listed. Individual captured files
  // are not enumerated — clients discover them through the `resource_link`
  // blocks in tool results and read them by URI (resources/read accepts any
  // `file://` under the source dir without it being listed).
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: STREAM_URI,
        name: 'Read capture stream (latest)',
        description:
          'Read returns the latest capture record (or { record: null } if none yet). ' +
          'Subscribe to receive a `notifications/resources/updated` notification on every new capture.',
        mimeType: 'application/json',
      },
    ],
  }));

  // The bare stream is a concrete resource (above); these templates let a
  // client construct the parameterized reads (and give Inspector-style UIs a
  // field to fill in): the cursored stream, and a captured file by its
  // `file://` path. `{+path}` uses reserved expansion so the path's slashes
  // aren't percent-encoded.
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      {
        uriTemplate: `${STREAM_URI}{?after}`,
        name: 'Read capture stream (cursored)',
        description:
          'Read every capture record following ?after=<ISO-8601 timestamp>, ' +
          'in log order, as { records: [...] }. An empty cursor (?after=) returns all ' +
          'records; omit `after` entirely for the latest record only.',
        mimeType: 'application/json',
      },
      {
        uriTemplate: 'file://{+path}',
        name: 'Read captured file',
        description:
          'Read a captured file by its file:// URI (taken from a capture record’s ' +
          'resource_link). Only paths under the capture source directory are ' +
          'readable; any other path is denied.',
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    if (uri === STREAM_URI || uri.startsWith(STREAM_URI + '?')) {
      const records = readAllRecords(logPath);
      const qIndex = uri.indexOf('?');
      const afterRaw =
        qIndex >= 0 ? new URLSearchParams(uri.slice(qIndex + 1)).get('after') : null;
      // Trim so a whitespace-only value (a workaround for UIs that won't send a
      // truly blank param) reads as the empty "from the start" cursor.
      const after = afterRaw === null ? null : afterRaw.trim();
      // A non-empty cursor must be a real timestamp — the compare is lexical, so
      // a malformed value would silently mis-order rather than erroring.
      if (after && !ISO_TIMESTAMP_RE.test(after)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid \`after\` cursor (expected an ISO-8601 UTC timestamp like ` +
            `2026-01-01T00:00:00.000Z): ${after}`,
        );
      }
      // Cursored drain: `?after=<ts>` returns every record the client hasn't
      // seen, in log order, so re-reading after each notification never misses
      // an intermediate capture — coalesced or even dropped pings are recovered
      // on the next read. Same cursor rule as the `watch` tool: positional from
      // the matching record, since the log is in append order and a slow save
      // can carry an earlier timestamp than the record before it.
      //
      // The fallback compare covers a cursor that has aged into a history file, and
      // the empty cursor (`?after=`) that a client bootstrapped on an empty log
      // uses — no record matches '', and every timestamp sorts after it, so the
      // whole log comes back. ISO-8601 UTC timestamps are fixed-width, so the
      // lexical compare is chronological.
      //
      // Branch on the param being *present* (not truthy) so `?after=` stays in
      // the cursored shape. With no cursor at all, return just the latest
      // record — the bootstrap a client reads once to seed its cursor.
      const payload =
        after !== null
          ? {
              records: (recordsAfterCursor(records, after)
                ?? records.filter((r) => r.timestamp > after)
              ).map((r) => toResourceRecord(r, sourceDir)),
            }
          : records.length === 0
            ? { record: null }
            : toResourceRecord(records[records.length - 1], sourceDir);
      // A watch stopped while the client was between reads has no other way to
      // reach it: the doorbell carries no payload, so the answer rides on the
      // read it wakes. Cleared once told, so it is reported exactly once.
      if (watchSession.pendingStop) {
        watchSession.clearPendingStop();
        Object.assign(payload as Record<string, unknown>, { stopped: true });
      }
      return {
        contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(payload) }],
      };
    }
    if (uri.startsWith('file:')) {
      let p: string;
      try {
        p = fileURLToPath(uri);
      } catch {
        throw new McpError(ErrorCode.InvalidParams, `Invalid file URI: ${uri}`);
      }
      const real = ensureUnderSource(p, sourceDir);
      const mimeType = mimeFor(real);
      const buf = fs.readFileSync(real);
      const contents = isTextMime(mimeType)
        ? [{ uri, mimeType, text: buf.toString('utf8') }]
        : [{ uri, mimeType, blob: buf.toString('base64') }];
      return { contents };
    }
    throw new McpError(ErrorCode.InvalidRequest, `Unknown resource: ${uri}`);
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
      // A subscription is a watch that holds the slot until it ends — the
      // `--loop` shape, with no gaps to lease across.
      watchSession.beginStream();
      // A stop reaches a subscriber the only way anything does: the doorbell,
      // then the read below tells it the watch is over.
      streamStopUnsubscribe = watchSession.onStopped(() => {
        server.sendResourceUpdated({ uri: STREAM_URI }).catch(() => {});
      });
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
      streamStopUnsubscribe?.();
      streamStopUnsubscribe = null;
      watchSession.endStream();
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
    streamStopUnsubscribe?.();
    streamStopUnsubscribe = null;
    streamSubscribers = 0;
    // The client is gone, so the watch it was holding is over. Releasing takes
    // the session record with it rather than leaving one to time out.
    watchSession.release();
  };

  // -------- prompts --------

  const prompts = [PROMPT_SEE, PROMPT_WATCH, PROMPT_STOP];
  const promptByName = new Map(prompts.map((p) => [p.name, p]));

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: prompts.map(({ name, description }) => ({
      name,
      description,
    })),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const prompt = promptByName.get(req.params.name);
    if (!prompt) {
      throw new McpError(ErrorCode.InvalidRequest, `Unknown prompt: ${req.params.name}`);
    }
    return {
      description: prompt.description,
      messages: [
        { role: 'user', content: { type: 'text', text: prompt.body } },
      ],
    };
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

