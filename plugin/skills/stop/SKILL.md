Stop the background SeeWhatISee watch loop started by `/SeeWhatISeeWatch`.

## Steps

1. Stop the watcher by running:
   ```
   scripts/watch.sh --stop
   ```
2. Relay the script's output to the user (it will say either "Stopping existing watcher" or "No existing watcher to stop").

## Notes

- This does NOT affect captures already taken — `latest.json` and the PNG/HTML files are still on disk.
- The user can restart the watcher at any time with `/SeeWhatISeeWatch`.
