<p><img src="https://github.com/jshute96/SeeWhatISee/blob/main/src/icons/icon-128.png?raw=true" alt="icon"></p>

# SeeWhatISee Gemini Extension

## Chrome extension

SeeWhatISee is the ultimate Chrome extension screenshot tool for vibe-coding: Share screenshots, HTML, or selected text with your coding agent — CLI or web.

**[Install from the Chrome Web Store](https://chromewebstore.google.com/detail/seewhatisee/mdfeigicgahogllcdiibkeidfllhddae).**

> [!TIP]
> Pin the extension on your toolbar using **Pin to toolbar** on the **Manage extension** page, or using the "Extensions" (puzzle piece) toolbar icon.

Learn more at https://github.com/jshute96/SeeWhatISee.
Development happens in that repository.  Issues and PRs should be filed in that repository.

This GitHub project is the released version of the Gemini extension for SeeWhatISee.

## Gemini skills

- `/see-what-i-see` — read the latest snapshot and describe it
- `/see-what-i-see-watch` — watch for new snapshots to appear, and then look at them when they appear
- `/see-what-i-see-xtract` — alias for `/see-what-i-see` (useful because Gemini shows auto-completes in reverse alphabetical order)

If you've added a prompt with the snapshot, Gemini will follow it.

You can also add prompts after the commands above and they'll be applied
on each snapshot. For example,

- `/see-what-i-see` `What font is the heading on this page?`
- `/see-what-i-see-watch` `Just report the snapshot filenames`

## Installation

Install the Gemini extension:

```bash
gemini extensions install https://github.com/jshute96/SeeWhatISee-gemini
```

Add permissions in `$HOME/.gemini/settings.json` to avoid permission prompts:

```
{
  "tools": {
    "allowed": [
      "run_shell_command($HOME/.gemini/extensions/see-what-i-see/skills/see-what-i-see/scripts/copy-last-snapshot.sh)",
      "run_shell_command($HOME/.gemini/extensions/see-what-i-see/skills/see-what-i-see-watch/scripts/watch-and-copy.sh)",
      "run_shell_command($HOME/.gemini/extensions/see-what-i-see/skills/see-what-i-see-xtract/scripts/copy-last-snapshot.sh)"
    ]
  }
}
```

#### Manual install

If `gemini extensions install` directly from GitHub doesn't work, clone the release repo and install the extension from files.

```bash
git clone https://github.com/jshute96/SeeWhatISee-gemini.git
gemini extension install SeeWhatISee-gemini
```

## Development

This GitHub project stores the released version of the Gemini extension.

The development project is https://github.com/jshute96/SeeWhatISee.

This project can be used alone for experimentation.

## License

The extension and skills are MIT-licensed (see `LICENSE`).
