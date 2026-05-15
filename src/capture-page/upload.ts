// Upload-image landing flow for the Capture page.
//
// `handleUploadFlow(ctx)` runs when the page is opened with
// `?upload=true` (from the More-submenu "Upload image to Capture..."
// entry). It reveals the landing card, wires the file picker, and on
// a successful FileReader + decode + `initializeUploadSession` round-
// trip flips the page back into its normal capture-rendering mode by
// invoking `ctx.onSessionReady()`.
//
// Errors (non-image, decode failure, FileReader failure, SW
// rejection) surface in `#upload-error` below the Choose-image
// button; the button stays functional so the user can pick a
// different file without reloading the tab.

export interface UploadContext {
  /** Caller-supplied "the synthetic session is in place" hook. Runs
   *  after this module has hidden the landing card, scrubbed
   *  `?upload=true` from the URL, and unhidden the main-content
   *  blocks. The caller's hook is responsible for clearing
   *  `staleMode` and re-entering `loadData()`. */
  onSessionReady(): Promise<void>;
}

/**
 * Reveal the upload-landing card and wire the file picker. Steps on
 * a chosen file:
 *
 *   1. FileReader → data URL.
 *   2. Decode-validate the data URL via `<img>` so a corrupt /
 *      0-byte / mislabeled file fails here rather than rendering
 *      a broken-image preview after the navigation.
 *   3. `initializeUploadSession` to the SW (it synthesizes a
 *      `DetailsSession` and stashes it under our tab's key).
 *   4. Strip `?upload=true` from the URL via `replaceState` so a
 *      reload doesn't re-trigger this branch (we now have a real
 *      session and want the normal path).
 *   5. Unhide every `[data-capture-main]` block and call
 *      `ctx.onSessionReady()` so the page re-enters its happy-path
 *      load.
 *
 * Resolves once the picker and its listeners are wired (the file-
 * pick itself runs inside the change listener). The caller awaits
 * this just to mark the flow's entry point — the picker is async on
 * its own.
 */
export async function handleUploadFlow(ctx: UploadContext): Promise<void> {
  const landing = document.getElementById('upload-landing') as HTMLDivElement;
  const chooseBtn = document.getElementById('upload-choose-btn') as HTMLButtonElement;
  const fileInput = document.getElementById('upload-file-input') as HTMLInputElement;
  const errorEl = document.getElementById('upload-error') as HTMLDivElement;

  landing.hidden = false;

  function showError(msg: string): void {
    errorEl.textContent = msg;
    errorEl.style.display = 'block';
  }
  function clearError(): void {
    errorEl.textContent = '';
    errorEl.style.display = 'none';
  }

  chooseBtn.addEventListener('click', () => {
    clearError();
    fileInput.click();
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    // Always reset so the user can re-pick the same file after an
    // error path (the change event won't fire on identical
    // selections otherwise).
    const resetInput = (): void => { fileInput.value = ''; };

    if (!file.type.startsWith('image/')) {
      showError('Not a supported image format.');
      resetInput();
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => {
      showError('Could not read file. Try again.');
      resetInput();
    };
    reader.onload = async () => {
      const dataUrl = reader.result as string;
      // Decode-validate before we ship the bytes off to the SW.
      // The `accept="image/*"` attribute and the MIME-prefix check
      // above only filter on declared type — a 0-byte file or a
      // `.png` carrying garbage bytes still passes both. Loading
      // through `<img>` and waiting for `onload` / `onerror` runs
      // the same decode the Capture page would do, so anything that
      // would render as a broken-image placeholder fails here with
      // a clear message instead.
      const decodable = await new Promise<boolean>((resolve) => {
        const probe = new Image();
        probe.onload = () => resolve(probe.naturalWidth > 0 && probe.naturalHeight > 0);
        probe.onerror = () => resolve(false);
        probe.src = dataUrl;
      });
      if (!decodable) {
        showError('Not a valid image (could not decode).');
        resetInput();
        return;
      }
      let initRes: { ok?: boolean; error?: string } | undefined;
      try {
        initRes = await chrome.runtime.sendMessage({
          action: 'initializeUploadSession',
          dataUrl,
          filename: file.name,
          mimeType: file.type,
        });
      } catch (err) {
        showError(`Upload failed: ${err instanceof Error ? err.message : String(err)}`);
        resetInput();
        return;
      }
      if (!initRes?.ok) {
        showError(`Upload failed: ${initRes?.error ?? 'no response from background'}`);
        resetInput();
        return;
      }
      // Synthetic session is now in place. Hide the landing, scrub
      // `?upload=true` from the URL (so reloads don't loop us back
      // here), unhide the main-content blocks the no-session
      // branch hid, and hand off to the caller's happy-path
      // re-render.
      landing.hidden = true;
      window.history.replaceState({}, document.title, window.location.pathname);
      document
        .querySelectorAll<HTMLElement>('[data-capture-main]')
        .forEach((el) => {
          el.hidden = false;
        });
      await ctx.onSessionReady();
    };
    reader.readAsDataURL(file);
  });
}
