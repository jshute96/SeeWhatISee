Read the latest screenshot taken by the SeeWhatISee Chrome extension and make it available as context so the user can ask questions about what they see.

You can't run this autonomously since it requires the user to have just clicked the extension. Only run it when asked to.

## Steps

1. Read `~/Downloads/SeeWhatISee/latest.json` to find the most recent capture. It contains `{timestamp, filename, url}`.
   * If that file doesn't exist, report an error that the SeeWhatISee
     Chrome extension hasn't taken any screenshots yet — nothing in
     `~/Downloads/SeeWhatISee/`.
2. Read the image file at `~/Downloads/<filename>` using the Read tool. (`filename` already includes the `SeeWhatISee/` subdir prefix, so don't double it.)
3. Briefly describe what you see (and mention the source `url` from `latest.json`) and ask the user what they'd like to know about it.
