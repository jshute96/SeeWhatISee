// Build script for the SeeWhatISee Chrome extension.
//
// What this does, end to end:
//   1. Wipes the dist/ directory so each build starts from a clean slate.
//   2. Copies src/icons/ -> dist/icons/ (the toolbar action icons in
//      16/48/128 sizes referenced by manifest.json).
//   3. Copies src/manifest.json -> dist/manifest.json verbatim. Chrome loads
//      the unpacked extension from dist/, so the manifest must live there.
//   4. Runs the TypeScript compiler (tsc) to compile src/*.ts -> dist/*.js.
//      With --watch, tsc keeps running and rebuilds on change.
//
// Run with `npm run build`. Pass --watch to keep tsc running.
//
// Note on watch mode: only TypeScript is watched. If you edit
// src/manifest.json, src/capture.html, or swap out icon files,
// re-run `npm run build`.

import { rm, mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const dist = resolve(root, 'dist');
const watch = process.argv.includes('--watch');

// 1. Clean dist/.
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

// 2. Copy icons.
await cp(resolve(root, 'src/icons'), resolve(dist, 'icons'), { recursive: true });

// 3. Copy the manifest into dist/ so Chrome can find it when loading
//    unpacked from dist/.
await cp(resolve(root, 'src/manifest.json'), resolve(dist, 'manifest.json'));

// 3b. Copy the capture-details extension page HTML into dist/. The
//     accompanying TypeScript controller (src/capture-page.ts) is
//     picked up by tsc along with the rest of src/.
await cp(resolve(root, 'src/capture.html'), resolve(dist, 'capture.html'));

// 3b-ii. Copy the options page HTML. The controller (src/options.ts)
//        compiles via tsc along with the rest of src/. Loaded as a
//        classic <script> in options.html — keep it as a non-module
//        TypeScript file (no top-level imports/exports).
await cp(resolve(root, 'src/options.html'), resolve(dist, 'options.html'));

// 3c. Copy the offscreen-document HTML into dist/. The accompanying
//     TypeScript (src/offscreen.ts) is picked up by tsc; the HTML
//     just hosts a <script> tag pointing at the compiled offscreen.js.
await cp(resolve(root, 'src/offscreen.html'), resolve(dist, 'offscreen.html'));

// 3d. Copy the marked UMD bundle into dist/. capture.html loads it via
//     a classic <script> tag before capture-page.js so the markdown
//     Preview mode (selection markdown dialog) can render via
//     `window.marked.parse(...)`. We ship the UMD build (not ESM)
//     because capture-page.ts is compiled as a non-module script —
//     turning it into a module would force a rewrite of how the
//     extension page wires up.
await cp(
  resolve(root, 'node_modules/marked/lib/marked.umd.js'),
  resolve(dist, 'marked.umd.js'),
);

// 3e. Copy the highlight.js "common" prebuilt bundle + a light theme
//     into dist/. capture.html loads them via classic <script>/<link>
//     tags; the bundle attaches `window.hljs` and includes the common
//     languages we need (xml for HTML, markdown, plaintext). We ship
//     @highlightjs/cdn-assets rather than the main `highlight.js`
//     package because the latter only exposes ESM / CJS entry points
//     — no prebuilt browser bundle — and capture-page.ts is a classic
//     script.
await cp(
  resolve(root, 'node_modules/@highlightjs/cdn-assets/highlight.min.js'),
  resolve(dist, 'highlight.min.js'),
);
await cp(
  resolve(root, 'node_modules/@highlightjs/cdn-assets/styles/github.min.css'),
  resolve(dist, 'highlight-theme.css'),
);

// 3f. Copy CodeJar into dist/ as a classic script. The upstream
//     package is ESM-only (`export function CodeJar`); we rewrite the
//     single top-level export into a `window.CodeJar` assignment so
//     capture.html can load it via `<script>` (matches the
//     `marked.umd.js` pattern). CodeJar has no runtime imports, so
//     the string rewrite is sufficient.
{
  const src = await readFile(
    resolve(root, 'node_modules/codejar/dist/codejar.js'),
    'utf8',
  );
  const wrapped = src.replace(
    /^export function CodeJar\(/m,
    'function CodeJar(',
  ) + '\nwindow.CodeJar = CodeJar;\n';
  // Fail-fast guards against a future upstream codejar release
  // reshaping its exports:
  //   - If the `export function CodeJar` we look for isn't present,
  //     the output is still valid JS but CodeJar is never assigned
  //     to `window.CodeJar`, silently breaking capture-page.js.
  //   - If any *other* top-level `export` slipped past the regex
  //     (e.g. codejar adds a second named export), a classic-script
  //     load of the bundle will throw a SyntaxError at parse time.
  // Both cases fail the build here with a clear message.
  if (wrapped === src + '\nwindow.CodeJar = CodeJar;\n') {
    throw new Error(
      'build.mjs: codejar transform did not match `export function CodeJar`; ' +
      'upstream likely reshaped the export — update scripts/build.mjs.',
    );
  }
  if (/^\s*export\b/m.test(wrapped)) {
    throw new Error(
      'build.mjs: codejar output still contains a top-level `export`; ' +
      'upstream added a second export — update scripts/build.mjs.',
    );
  }
  await writeFile(resolve(dist, 'codejar.js'), wrapped);
}

// 4. Run tsc. Watch mode keeps tsc running until the user Ctrl-C's; we
//    await its exit so signals route through the build script and a spawn
//    failure surfaces as a non-zero exit instead of being silently
//    swallowed. Non-watch mode just runs once and propagates the exit code.
if (watch) {
  const child = spawn('npx', ['tsc', '--watch'], { stdio: 'inherit', cwd: root });
  const code = await new Promise((res, rej) => {
    child.on('exit', (c) => res(c ?? 0));
    child.on('error', rej);
  });
  process.exit(code);
} else {
  const r = spawnSync('npx', ['tsc'], { stdio: 'inherit', cwd: root });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
