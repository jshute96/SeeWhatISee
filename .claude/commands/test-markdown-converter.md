Test the HTML→markdown converter against one or more real web pages
or local HTML files, then surface any issues you find so we can fix
them in the main conversation.

Targets come in as space-separated arguments below — each is either:
- An `http(s)://` URL (will be fetched with curl), OR
- A path to a local `.html` file (absolute or relative to the repo root).

## Steps

1. If no targets were passed, print a brief usage reminder and stop.
   Otherwise continue.

2. First, make sure the converter is built so the helper script can
   import it:
   - Run `npm run build` once at the start. Don't rebuild per target.

3. For each target, launch a background Agent (all in parallel, in
   one message with multiple Agent tool uses) that:
   - Runs `scripts/test-md-slice.mjs <target> --out tmp/md-convert-<slug>.md`
     (generate the slug from the target: for URLs, strip protocol
     and replace non-alphanumerics with `-`; for file paths, use
     the basename without extension; cap at 60 chars to keep
     filenames sane).
   - Reads the generated report.
   - Examines each slice: is the converter output faithful to the
     input HTML? Beyond the automated flags the script already
     emits, look for structural issues the heuristics might miss —
     dropped content, miscounted nesting, mangled links, run-on
     blocks, etc.
   - Appends a `## Agent review` section to the same report file
     with a categorized issue list:
     ```
     ## Agent review

     ### Blocking
     - <issue> (slice N)

     ### Significant
     - <issue> (slice N)

     ### Cosmetic / Notes
     - <note>
     ```
   - Returns a one-line summary: `Report at tmp/md-convert-<slug>.md — B blocking, S significant, C cosmetic`.

   Give each agent this context:
   - **Working directory:** `/home/jshute/dev/SeeWhatISee`.
   - **The helper script does all the deterministic work** (fetching,
     stripping noise, slicing at balanced tag boundaries, running
     the converter, running cheap sanity checks). The agent's
     judgment-based work is just reading the output and categorizing
     issues that heuristics miss.
   - **Don't re-fetch the page** — the script did it.
   - If the helper exits with code 2 (bot-challenge page), record that
     in the report and stop cleanly; don't try to retry.
   - **Ground truth:** for URLs matching `github.com/<owner>/<repo>/blob/<ref>/<path>.md`,
     the corresponding raw markdown at `raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>.md`
     is the authoritative output — use it when judging structural
     fidelity. Fetch it with curl if needed. For other pages, judge
     by reader expectation.

4. Do NOT poll, sleep, or check on the background agents — you'll be
   notified automatically when each completes. While agents run, you
   may continue on other work, but DO NOT launch your own slice tests
   or read agent transcripts.

5. Once all agents finish:
   - Read each `tmp/md-convert-*.md` report with the Read tool.
   - Consolidate all issues into a prioritized list in the main
     conversation: blocking first, then significant, then cosmetic.
     For each issue, cite the source report and slice number so the
     user can trace it.
   - Propose which issues you'll fix and wait for the user to direct
     you. Don't start fixing until they approve.

## Tips

- Pass `--selector "<spec>"` to the helper if the default
  auto-detection misses a site's main content container.
- Passing `--max-slices N` lowers the slice count when testing
  small pages; the default of 3 is usually right.
- If no useful HTML comes back (bot challenge, bad URL), a clean
  report that says so is better than a spurious issue list.

## Targets

$ARGUMENTS
