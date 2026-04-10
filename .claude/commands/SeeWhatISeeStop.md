Stop the background SeeWhatISee screenshot watch loop started by `/SeeWhatISeeWatch`.

## Steps

1. Stop the watcher by running:
   ```
   scripts/watch.sh --stop
   ```
2. Relay the script's output to the user (it will say either "Stopping existing watcher" or "No existing watcher to stop").

## Notes

- This does NOT affect screenshots already taken — `latest.json` and the PNGs are still on disk.
- The user can restart the watcher at any time with `/SeeWhatISeeWatch`.
