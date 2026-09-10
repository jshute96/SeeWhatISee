<p><img src="https://github.com/jshute96/SeeWhatISee/blob/main/src/icons/icon-128.png?raw=true" alt="icon"></p>

# SeeWhatISee Antigravity Plugin

## Chrome extension

SeeWhatISee is the ultimate Chrome extension screenshot tool for vibe-coding: Share screenshots, HTML, or selected text with your coding agent — CLI or web.

**[Install from the Chrome Web Store](https://chromewebstore.google.com/detail/seewhatisee/mdfeigicgahogllcdiibkeidfllhddae).**

> [!TIP]
> Pin the extension on your toolbar using **Pin to toolbar** on the **Manage extension** page, or using the "Extensions" (puzzle piece) toolbar icon.

Learn more at https://github.com/jshute96/SeeWhatISee.
Development happens in that repository.  Issues and PRs should be filed in that repository.

This GitHub project is the released version of the plugin for
[Google Antigravity](https://antigravity.google) — Google's agent-first IDE
and its companion `agy` CLI.

## Antigravity skills

- `/see-what-i-see` — read the latest snapshot and describe it
- `/see-what-i-see-watch` — watch for new snapshots to appear, and then look at them when they appear
- `/see-what-i-see-stop` — stop a running watch loop
- `/see-what-i-see-history` — find and analyze past snapshots

If you've added a prompt with the snapshot, the agent will follow it.

You can also add prompts after the commands above and they'll be applied
on each snapshot. For example,

- `/see-what-i-see` `What font is the heading on this page?`
- `/see-what-i-see-watch` `Just report the snapshot filenames`

## Installation

With the `agy` CLI, install straight from this repo:

```bash
agy plugin install https://github.com/jshute96/SeeWhatISee-antigravity
```

To update, run that same command again — `agy` has no plugin update
mechanism, and a reinstall is the only way to pick up a new version.

To uninstall: `agy plugin uninstall see-what-i-see`.

Antigravity also discovers plugins by directory, so you can instead clone
this repo and copy or symlink it into one of these:

| Scope          | Path                                          |
|----------------|-----------------------------------------------|
| All workspaces | `~/.gemini/config/plugins/see-what-i-see`     |
| One workspace  | `<workspace>/.agents/plugins/see-what-i-see`  |

```bash
git clone https://github.com/jshute96/SeeWhatISee-antigravity.git
mkdir -p ~/.gemini/config/plugins
ln -s "$(pwd)/SeeWhatISee-antigravity" ~/.gemini/config/plugins/see-what-i-see
```

## Development

This GitHub project stores the released version of the Antigravity plugin.

The development project is https://github.com/jshute96/SeeWhatISee.

This project can be used alone for experimentation.

## License

The extension and skills are MIT-licensed (see `LICENSE`).
