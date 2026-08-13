// Shared arrow-key navigation for the Capture page's popup menus —
// the column's Zoom and More… popovers and the Ask destination menu.
//
// They're built by different modules and don't share
// markup (buttons vs. `<li>`s, different item classes), so this
// module is deliberately about *behaviour* only: hand it the menu
// element and a selector for its items, and it answers keydowns.
//
// Behaviour follows the usual menu conventions:
//
//   - Down / Up move to the next / previous enabled item and wrap.
//     With focus outside the menu (the usual case just after a mouse
//     click opened it, when focus is still on the owning button),
//     Down lands on the first item and Up on the last.
//   - Tab / Shift+Tab do the same as Down / Up, so an open menu keeps
//     Tab inside itself. Without this the two menu families disagree:
//     the Ask menu is the DOM sibling right after its button, so Tab
//     falls into its rows, while the column popovers are appended at
//     the *end* of `.highlight-controls` and Tab from the Zoom button
//     walks the rest of the palette instead. Handling the key makes
//     the behaviour a property of "a menu is open" rather than of
//     where the markup happens to sit. Escape (or a pick) is the way
//     out.
//   - Home / End jump to the ends.
//   - Enter / Space fire the focused item — but only for items that
//     aren't real `<button>`s, since the browser already turns those
//     keys into a click and synthesizing a second one would fire the
//     item twice.
//
// Disabled items are skipped rather than focused-and-inert, so
// arrowing never parks on a dead row.

export interface MenuKeyNav {
  /** Handle one keydown, moving focus (or firing an item) if the key
   *  is one of ours. `preventDefault` is called for the keys it
   *  takes. */
  handleKey(e: KeyboardEvent): void;
  /** Focus the first enabled item, if there is one. Used when the
   *  menu was opened from the keyboard. */
  focusFirst(): void;
}

/**
 * True when a `click` came from Space / Enter on a focused button
 * rather than from the mouse. Keyboard activations carry
 * `detail === 0` (there's no click count to report); real mouse
 * clicks are 1 or more. Used to open a menu keyboard-style (first
 * item focused) and to run mousedown-driven handlers that a keyboard
 * press never reaches.
 *
 * A heuristic, not a proof: programmatic `.click()` and
 * assistive-technology activations also report 0, as do touch-derived
 * clicks on some platforms. All the false positive costs is a menu
 * that opens with its first item already focused, so it's the right
 * side to err on.
 */
export function isKeyboardClick(e: MouseEvent): boolean {
  return e.detail === 0;
}

/** Rows that are present but not pickable. Covers both spellings the
 *  page uses: `disabled` on the `<button>` items, `aria-disabled` on
 *  the Ask menu's `<li>`s (which can't carry the real attribute). */
function isEnabled(el: HTMLElement): boolean {
  if ((el as HTMLButtonElement).disabled) return false;
  return el.getAttribute('aria-disabled') !== 'true';
}

/** `<input>` types that hold no text, so no undoable edit can live in
 *  them. Written as an exclusion list because every other type — the
 *  date / number / search family included — does take typing. */
const NON_TEXT_INPUT_TYPES = new Set([
  'button', 'checkbox', 'color', 'file', 'hidden',
  'image', 'radio', 'range', 'reset', 'submit',
]);

/** Somewhere a caret lives, so the text the user types — and the undo
 *  of that text — belongs to it. Used here for arrow keys, and by
 *  `undo-scope.ts` to decide whether `Ctrl+Z` is the browser's. */
export function isTextEntry(el: Element | null): boolean {
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) {
    return !NON_TEXT_INPUT_TYPES.has(el.type);
  }
  return el instanceof HTMLElement && el.isContentEditable;
}

/** Broader than `isTextEntry`: any form control that has its own
 *  meaning for the arrow keys (a radio group steps through its
 *  options, a range slider moves). The menu nav leaves those alone;
 *  `Ctrl+Z` doesn't care, since none of them holds undoable text. */
function ownsArrowKeys(el: HTMLElement): boolean {
  return isTextEntry(el) || el instanceof HTMLInputElement;
}

export function createMenuKeyNav(opts: {
  menu: HTMLElement;
  /** Selector matching the menu's item rows — headings and
   *  separators must not match it. */
  itemSelector: string;
}): MenuKeyNav {
  // Re-queried per keypress rather than cached: the Ask menu builds
  // its rows asynchronously and the More menu's disabled flags change
  // between opens.
  const items = (): HTMLElement[] =>
    Array.from(opts.menu.querySelectorAll<HTMLElement>(opts.itemSelector))
      .filter(isEnabled);

  const focusAt = (list: HTMLElement[], index: number): void => {
    list[index]?.focus();
  };

  return {
    focusFirst(): void {
      focusAt(items(), 0);
    },

    handleKey(e: KeyboardEvent): void {
      // Modified presses belong to the page's own shortcuts (Alt+±
      // zoom, Ctrl+Arrow caret motion in the prompt, Shift+Arrow /
      // Shift+Home text selection), not to us. Shift is allowed
      // through for Tab alone, where it's the direction, not a
      // separate chord.
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.shiftKey && e.key !== 'Tab') return;
      const list = items();
      if (list.length === 0) return;
      const active = document.activeElement as HTMLElement | null;
      // Focus can still be parked in the prompt textarea with a menu
      // open — Tab moves within the menu, but the menu doesn't take
      // focus off the field to begin with. Arrows there are the
      // caret's, not the menu's; a stray open shouldn't make the
      // field feel broken. Tab is left alone for the same reason: it
      // should walk on out of the field, not jump into the menu.
      if (active && !opts.menu.contains(active) && ownsArrowKeys(active)) return;
      // -1 when focus is outside the menu — the state a mouse-opened
      // menu is in, with focus still on the owning button.
      const current = list.indexOf(active as HTMLElement);

      const forward = (): number =>
        current < 0 ? 0 : (current + 1) % list.length;
      const backward = (): number =>
        current < 0 ? list.length - 1 : (current - 1 + list.length) % list.length;

      let next: number;
      switch (e.key) {
        case 'ArrowDown':
          next = forward();
          break;
        case 'ArrowUp':
          next = backward();
          break;
        case 'Tab':
          next = e.shiftKey ? backward() : forward();
          break;
        case 'Home':
          next = 0;
          break;
        case 'End':
          next = list.length - 1;
          break;
        case 'Enter':
        case ' ': {
          if (current < 0) return;
          const item = list[current]!;
          // A focused `<button>` gets its click from the browser;
          // stepping in here would fire the item twice.
          if (item instanceof HTMLButtonElement) return;
          e.preventDefault();
          item.click();
          return;
        }
        default:
          return;
      }

      // Swallowed even if the focus call finds nothing, so an arrow
      // aimed at the menu never falls through to scroll the page.
      e.preventDefault();
      focusAt(list, next);
    },
  };
}
