// Routes the undo / redo keys (`Ctrl+Z`, and `Ctrl+Y` /
// `Ctrl+Shift+Z`) to one of the Capture page's two undo stacks — the
// image edits (popped by `#undo`) or the prompt textarea's own native
// text undo. See "Undo scope" in `docs/capture-page.md` for the full
// behaviour; this header covers the non-obvious "why"s.
//
// **Why the page takes the keys at all.** Chrome's default for
// `Ctrl+Z` pressed outside any field is to undo the last *text* edit
// and pull focus into the field that owned it — so before this, a
// drawing could never be undone from the keyboard, and trying moved
// the caret.
//
// **Why it can't route on focus.** Drawing doesn't move focus: the
// overlay's mousedown is `preventDefault`ed, which is what lets you
// draw and then type straight into the prompt without clicking it
// first. The textarea therefore still holds the caret mid-draw.
// Instead we track an invisible *scope* — which half of the page the
// user was last demonstrably working in.

import { isTextEntry } from './menu-keys.js';

export interface UndoScopeCtx {
  /** The image half of the page — palette, menus and image box. */
  imagePanel: HTMLElement;
  promptInput: HTMLTextAreaElement;
  /** Owns both "is there anything to undo" and the undo itself. */
  undoBtn: HTMLButtonElement;
  /** Put back the last undone image edit. No button to click, so
   *  unlike undo this is a direct call. */
  redo(): void;
  anyEditDialogOpen(): boolean;
  isStaleMode(): boolean;
  isPolylineActive(): boolean;
  endPolylineChain(): void;
}

type UndoScope = 'image' | 'prompt' | null;

export function initUndoScope(ctx: UndoScopeCtx): void {
  let scope: UndoScope = null;

  const claimFrom = (target: EventTarget | null): void => {
    if (!(target instanceof Node)) return;
    if (ctx.imagePanel.contains(target)) scope = 'image';
    else if (ctx.promptInput.contains(target)) scope = 'prompt';
  };

  // Capture phase: a drawing mousedown is `preventDefault`ed, and the
  // polyline router stops some of them propagating, so a bubble-phase
  // listener would miss exactly the interactions that matter most.
  document.addEventListener('mousedown', (e) => claimFrom(e.target), true);
  document.addEventListener('focusin', (e) => claimFrom(e.target));

  // Any actual text change is the prompt's, however it arrived —
  // typing, Ctrl+V, Ctrl+X, a drag-drop with no keystroke at all, or
  // the backslash+Enter `execCommand` swap (which is deliberately
  // written to land on the textarea's undo stack). A restored draft
  // assigns `.value` directly, which fires no `input`, so reopening a
  // capture doesn't claim the scope.
  ctx.promptInput.addEventListener('input', () => { scope = 'prompt'; });

  // Caret motion claims it too — arrows / Home / End change nothing
  // but do say the user's attention is back in the field.
  ctx.promptInput.addEventListener('keydown', (e) => {
    // Ctrl / Alt / Meta presses are somebody else's: `Ctrl+Z` itself,
    // the page's Alt shortcuts, Ctrl+Arrow word motion.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Already consumed by a capture-phase handler on the way down —
    // an arrow-key nudge during a drawing or pan drag, or the Escape
    // that ends a polyline chain. Those are image work that merely
    // passes through the textarea because the caret never left it.
    if (e.defaultPrevented) return;
    scope = 'prompt';
  });

  // Which of the two operations a press asks for, or null when it's
  // not one of ours. Both spellings of redo are accepted on every
  // platform — `Ctrl+Y` is the Windows / Linux convention and
  // `Ctrl+Shift+Z` (`Cmd+Shift+Z`) the Mac one, and taking both costs
  // nothing.
  const actionFor = (e: KeyboardEvent): 'undo' | 'redo' | null => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
    const key = e.key.toLowerCase();
    if (key === 'y') return e.shiftKey ? null : 'redo';
    if (key !== 'z') return null;
    return e.shiftKey ? 'redo' : 'undo';
  };

  document.addEventListener('keydown', (e) => {
    const action = actionFor(e);
    if (!action) return;
    // An edit dialog is its own little world with its own text
    // fields; the no-session error state has no image panel at all.
    // Both hand the key straight back to the browser.
    if (ctx.anyEditDialogOpen() || ctx.isStaleMode()) return;
    if (scope === 'image') {
      e.preventDefault();
      // Mirror what a *mouse* click on Undo does mid-chain: the
      // document mousedown router ends the chain before the click
      // lands, and a synthetic click alone would skip that. Redo
      // needs it for the same reason — an unfinished chain would
      // otherwise keep drawing over the restored state.
      if (ctx.isPolylineActive()) ctx.endPolylineChain();
      if (action === 'redo') {
        ctx.redo();
        return;
      }
      // A synthetic click rather than a direct call: the button
      // already carries the whole undo implementation *and* the
      // enabled state, and clicking it also lights the press flash,
      // so the keyboard path looks like the mouse one.
      ctx.undoBtn.click();
      return;
    }
    // The prompt keeps its own text undo *and* redo — the browser's,
    // on whichever spelling it recognizes.
    if (isTextEntry(document.activeElement)) return;
    // Only the `Z` chords get swallowed here, and only because of the
    // focus-jumping default described at the top. `Ctrl+Y` has no
    // such default to defend against, and taking it anyway would kill
    // a live browser shortcut for nothing (`Cmd+Y` is History on
    // macOS).
    if (e.key.toLowerCase() !== 'z') return;
    e.preventDefault();
  });
}
