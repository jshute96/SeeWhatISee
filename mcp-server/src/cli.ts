// Bin entrypoint. Parses argv, resolves the source dir, hooks up stdio.
//
// Invocation (in an MCP client config):
//   "command": "npx", "args": ["-y", "@see-what-i-see/mcp-server"]
//   "command": "seewhatisee-mcp", "args": ["--directory", "/some/path"]

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createServer, resolveSourceDir } from './server.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let explicitDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      printUsage();
      return;
    }
    if (arg === '--directory') {
      explicitDir = argv[++i];
      if (!explicitDir) {
        process.stderr.write('--directory requires a path\n');
        process.exit(2);
      }
      continue;
    }
    process.stderr.write(`Unknown option: ${arg}\n`);
    printUsage();
    process.exit(2);
  }
  const sourceDir = resolveSourceDir({ explicitDir });
  const server = createServer({ sourceDir });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function printUsage(): void {
  process.stderr.write(
    `Usage: seewhatisee-mcp [--directory DIR]

Speaks the Model Context Protocol over stdio. Configure an MCP client
to invoke this binary; the client owns its lifecycle.

Options:
  --directory DIR   Source dir holding log.json + captures. Overrides
                    .SeeWhatISee config and the default
                    $HOME/Downloads/SeeWhatISee.
  --help            Print this message.
`,
  );
}

main().catch((e) => {
  process.stderr.write(`${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
