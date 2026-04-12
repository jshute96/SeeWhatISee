Features
* For html snapshots, capture other files too, like ^S SavePage does.
* Record and save video
* Flash the screen when it snapshots
* Avoid making 3 files show up as Chrome downloads each time
* Countdown clock on the icon for delayed screenshot
* Add a way to get a longer delay (once). Maybe with a long-click. Maybe user-chosen delay.
* Re-add the "Clear log history" action somewhere. It's currently hidden.

Claude plugin
* (Check if the permission prompt issues below still exist, tryign on a clean install.)
* Re-run of `watch.sh --after ...` still causes a permission prompt, why?
* Reading the screenshots from `~/Downloads/SeeWhatISee` causes a permission prompt once per session
* Full github tree gets downloaded in `.claude/plugins/marketplaces/see-what-i-see-marketplace/`, can I avoid this?
  - Maybe a separate repository for just the "released" version of the plugin.

Gemini plugin
* It has copies of the code from Claude skills. Can I share this somehow?
* Watching doesn't work because asynchronous background commands aren't supported.

Release and Packaging
* Publish Chrome extension
* Update docs
* Custom icon

Wishlist
* I wanted shift-click on the icon for selecting between screenshot and screenshot-with-details. Chrome doesn't give allow getting click modifiers.
