// Bundle src/cli.ts into a single dist/seewhatisee-mcp.js with a node shebang.
// Output filename matches the package's `bin` name so manual installs
// (e.g. someone pointing an MCP client at the file by path) read sensibly.
// Run after `tsc`. Produces the file shipped to users via npm + npx.

import { build } from 'esbuild';
import { chmod } from 'node:fs/promises';

await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist/seewhatisee-mcp.js',
  // ESM bundles can reference CommonJS deps via createRequire; the SDK and
  // its transitive deps don't need any special shimming today.
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
});

await chmod('dist/seewhatisee-mcp.js', 0o755);
