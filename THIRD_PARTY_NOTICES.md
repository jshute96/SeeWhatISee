# Third-party notices

The SeeWhatISee extension itself is MIT-licensed (see `LICENSE`).
This file lists third-party assets bundled with the extension and
their license terms.

## Bundled JavaScript / CSS libraries

The build step (`scripts/build.mjs`) copies the following
third-party files verbatim from `node_modules/` into `dist/`,
where they are loaded by the Capture page's edit dialog:

| File in `dist/`         | Source package              | License      |
|-------------------------|-----------------------------|--------------|
| `marked.umd.js`         | [`marked`](https://marked.js.org) | MIT          |
| `highlight.min.js`      | [`@highlightjs/cdn-assets`](https://highlightjs.org/) | BSD-3-Clause |
| `highlight-theme.css`   | [`@highlightjs/cdn-assets`](https://highlightjs.org/) (`styles/github.min.css`) | BSD-3-Clause |
| `codejar.js`            | [`codejar`](https://medv.io/codejar/) | MIT          |

Full license texts are in each package's `LICENSE` file under
`node_modules/`.

## Provider brand logos (used as Ask-button icons for links to those sites)

The Capture page's per-provider Ask buttons display each
destination site's brand logo. The bundled files are downloaded
from each provider's published `link rel="icon"`:

| File                       | Source                              |
|----------------------------|-------------------------------------|
| `src/icons/claude.svg`     | <https://claude.ai/favicon.ico>     |
| `src/icons/gemini.svg`     | <https://gemini.google.com/>        |
| `src/icons/chatgpt.ico`    | <https://chatgpt.com/favicon.ico>   |
| `src/icons/google.ico`     | <https://www.google.com/favicon.ico> |

Logos are unmodified copies. They're trademarks of their
respective owners (Anthropic, Google, OpenAI) and are used here
as nominative identifiers — pointing the user at "the button that
sends to <site>" — with no implied endorsement.
