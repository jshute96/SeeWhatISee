Features
* For html snapshots, capture other files too, like ^S SavePage does.
* Record and save video
* Flash the screen when it snapshots
* Avoid making 2 files show up as Chrome downloads each time
* Add a way to get a longer delay (once). Maybe with a long-click. Maybe user-chosen delay.
* Maybe more drawing and annotation features
  - Add inline text
  - Add arrows
  - Auto-number annotations (box 1,2,3,etc)
  - Choose different colors
* Could we push snapshots to non-CLI consumers, that would pick them up by an API or MCP
  server rather than a command-line tool and local file access?
* Cleanup: We have a lot of overlap between multiple skills & commands, and the scripts
  underneath them.  Some blocks are intentionally the same across several of them.
  We could probably share more and be more consistent across them.

Claude plugin
* (Check if the permission prompt issues below still exist, trying on a clean install.)
* Re-run of `watch.sh --after ...` still causes a permission prompt, why?
* Reading the screenshots from `~/Downloads/SeeWhatISee` causes a permission prompt once per session
* Full github tree gets downloaded in `.claude/plugins/marketplaces/see-what-i-see-marketplace/`, can I avoid this?
  - Maybe a separate repository for just the "released" version of the plugin.

Gemini plugin
* Background watching doesn't work because asynchronous background commands aren't supported,
  so we just have a foreground version of the watch command for now.
* BUG: command doesn't work if multiple gemini's run in workspaces with the same name, because one of their tmp dirs has -1, and we don't know that. See copy-last-snapshot.sh.
* Annoying: gemini always prompts for permission to run copy-last-snapshot.sh, at least once per session.

Release and Packaging
* Publish Chrome extension
* Update docs

Wishlist
* I wanted shift-click on the icon for selecting between screenshot and screenshot-with-details. Chrome doesn't give any way to get click modifiers.
