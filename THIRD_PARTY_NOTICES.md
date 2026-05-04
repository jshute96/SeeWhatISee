# Third-party notices

The SeeWhatISee extension itself is MIT-licensed (see `LICENSE`).
This file lists third-party assets bundled with the extension and
their license terms.

## Material Symbols icons (Apache License 2.0)

Three icons from Google's Material Symbols set (outlined variant)
are embedded inline as `<symbol>` elements in `src/capture.html`:

| Symbol id          | Source icon | Upstream path |
|--------------------|-------------|----------------|
| `pin-icon`         | `push_pin`  | `symbols/web/push_pin/materialsymbolsoutlined/push_pin_24px.svg` |
| `pin-off-icon`     | `keep_off`  | `symbols/web/keep_off/materialsymbolsoutlined/keep_off_24px.svg` |
| `new-window-icon`  | `new_window`| `symbols/web/new_window/materialsymbolsoutlined/new_window_24px.svg` |

- Copyright: Copyright Google LLC.
- Upstream: <https://github.com/google/material-design-icons>
- License: Apache License 2.0
  (<https://www.apache.org/licenses/LICENSE-2.0>)
- Modifications: the SVG path data is reproduced verbatim. The
  containing `<symbol>` wrapper, `viewBox` attribute, and
  `fill="currentColor"` are added so the icons can be re-used via
  `<use href="#…">` and inherit the Ask menu's text colour.

The Apache 2.0 license requires retaining attribution and the
license text. Attribution lives in this file; the full license
text is short and reproduced below for convenience:

> Licensed under the Apache License, Version 2.0 (the "License");
> you may not use this file except in compliance with the License.
> You may obtain a copy of the License at
>
> http://www.apache.org/licenses/LICENSE-2.0
>
> Unless required by applicable law or agreed to in writing,
> software distributed under the License is distributed on an
> "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND,
> either express or implied. See the License for the specific
> language governing permissions and limitations under the
> License.

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
