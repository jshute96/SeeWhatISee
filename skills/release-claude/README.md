<p><img src="https://github.com/jshute96/SeeWhatISee/blob/main/src/icons/icon-128.png?raw=true" alt="icon"></p>

# SeeWhatISee Claude Plugin

## Chrome extension

SeeWhatISee is the ultimate Chrome extension screenshot tool for vibe-coding: Share screenshots, HTML, or selected text with your coding agent — CLI or web.

**[Install from the Chrome Web Store](https://chromewebstore.google.com/detail/seewhatisee/mdfeigicgahogllcdiibkeidfllhddae).**

> [!TIP]
> Pin the extension on your toolbar using **Pin to toolbar** on the **Manage extension** page, or using the "Extensions" (puzzle piece) toolbar icon.

Learn more at https://github.com/jshute96/SeeWhatISee.

This GitHub project is the released version of the Claude CLI plugin for SeeWhatISee.

## Claude Code skills

- `/see-what-i-see` — read the latest snapshot and describe it
- `/see-what-i-see-watch` — watch for new snapshots to appear in the background, and then look at them when they appear
- `/see-what-i-see-stop` — stop a running watch loop

If you've added a prompt with the snapshot, Claude will follow it.

You can also add prompts after the commands above and they'll be applied
on each snapshot. For example,

- `/see-what-i-see` `What font is the heading on this page?`
- `/see-what-i-see-watch` `Just report the snapshot filenames`

## Installation

Add the marketplace and install the plugin:

```bash
/plugin marketplace add jshute96/SeeWhatISee-claude
/plugin install see-what-i-see@see-what-i-see-marketplace
```

### Avoiding permission prompts (Optional)

`/see-what-i-see-watch` triggers a permission prompt when it reads screenshot files after a background notification.

Add this to `$HOME/.claude/settings.json` to avoid those prompts.

```json
{
  "permissions": {
    "allow": [
      "Read(~/Downloads/SeeWhatISee/**)"
    ]
  }
}
```

## Development

This GitHub project stores the released version of the Claude plugin.

The development project is https://github.com/jshute96/SeeWhatISee.

This project can be used alone for experimentation.

### Using the local skills directly

If you start `claude` in this project directory, `.claude/settings.json`
includes configuration that disables (bypasses) the plugin, and symlinks to the
local skills in `.claude/skills`.  The local skills in this directory will
then be used instead of the installed plugin.

### Testing the Claude plugin locally

To load the plugin from this directory, set `--plugin-dir`:

```bash
claude --plugin-dir $(pwd)/plugin
```

### Updating the Claude plugin in marketplace

The plugin won't update if the version is the same.

To make an update possible, bump `plugins[0].version` in `.claude-plugin/marketplace.json`. That's the field Claude Code uses for cache invalidation on this relative-path plugin; `plugin.json` intentionally has no `version` field. See `docs/claude-plugin.md` for the full story.

Users still need to run `/plugin marketplace update` followed by `/plugin` to pick up the new version — third-party marketplaces do not auto-update on startup.

## License

The extension and skills are MIT-licensed (see `LICENSE`).
