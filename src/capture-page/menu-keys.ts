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

/** Somewhere a caret lives, so arrow keys belong to it. */
function isTextEntry(el: HTMLElement): boolean {
  return el instanceof HTMLTextAreaElement
    || el instanceof HTMLInputElement
    || el.isContentEditable;
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
      // Shift+Home text selection), not to us.
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const list = items();
      if (list.length === 0) return;
      const active = document.activeElement as HTMLElement | null;
      // Nothing is trapping Tab, so focus can be parked in the prompt
      // textarea with a menu still open. Arrows there are the caret's,
      // not the menu's — otherwise a stray open would make the field
      // feel broken.
      if (active && !opts.menu.contains(active) && isTextEntry(active)) return;
      // -1 when focus is outside the menu — the state a mouse-opened
      // menu is in, with focus still on the owning button.
      const current = list.indexOf(active as HTMLElement);

      let next: number;
      switch (e.key) {
        case 'ArrowDown':
          next = current < 0 ? 0 : (current + 1) % list.length;
          break;
        case 'ArrowUp':
          next = current < 0 ? list.length - 1 : (current - 1 + list.length) % list.length;
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
