---
name: see-what-i-see-help
description: Help for see-what-i-see skills
---

Print this help text, expanding the values of `$HOME`.
"""
These skills grab screenshots and HTML snapshots captured using the
SeeWhatISee Chrome extension.

Get the extension at https://github.com/jshute96/SeeWhatISee.

Commands:

* `/see-what-i-see`       - Grab the last written screenshot.
* `/see-what-i-see-watch` - Watch for new screenshots in the background.
                                Look at them when they appear.
* `/see-what-i-see-stop`  - Stop background watcher.
* `/see-what-i-see-help`  - See this help.

Fixing permission prompts:

If you get permissions prompts for `/see-what-i-see-watch`, you can fix them by
adding this to `$HOME/.claude/settings.json`.

```
  "permissions": {
    "allow": [
      "Bash($HOME/.claude/plugins/cache/see-what-i-see-marketplace/**)",
      "Read(~/Downloads/SeeWhatISee/**)"
    ]
  }
```
"""
