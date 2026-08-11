// Shared popover-menu mechanics for the Capture page's tool column.
//
// Both column menus — Zoom and More… — are absolute-positioned
// inside `.highlight-controls`, so opening one paints over the gap
// beside the column instead of pushing the image sideways. This
// module owns everything they have in common so the two can't drift
// apart in behaviour:
//
//   - inline `top` aligned with the owning button (`offsetTop` is
//     relative to the column, so the alignment survives page scroll
//     and prompt growth);
//   - `hidden` toggling plus the button's `aria-expanded`;
//   - Escape closes and returns focus to the button;
//   - a mousedown anywhere else closes it.
//
// The outside-click closer has two details that keep it from
// fighting the button's own toggle:
//
//   - it listens on `mousedown` in the capture phase and is only
//     registered while the menu is open, so it never sees the
//     mousedown of the gesture that opened the menu — which would
//     otherwise close it before the click landed;
//   - a mousedown on the owning button is ignored here and left to
//     the button's click handler. Without that carve-out both would
//     fire and the menu would close, then immediately reopen.
//
// The dismissing press still reaches whatever was underneath it, so
// clicking the image to dismiss doesn't cost an extra click.
//
// The Ask destination menu (`ask.ts`) deliberately keeps its own
// dismissal: it isn't a column popover — different anchor, different
// owner — and it dismisses on a deferred `click` rather than
// `mousedown`. Left alone rather than folded in here, so this module
// stays about the two menus that have to look and behave identically.

export interface MenuPopover {
  isOpen(): boolean;
  open(): void;
  close(): void;
  toggle(): void;
}

export function createMenuPopover(opts: {
  /** The popover element. Starts `hidden`; its CSS must anchor it
   *  against the column (`position: absolute`). */
  menu: HTMLElement;
  /** The button that owns it — supplies the vertical alignment,
   *  carries `aria-expanded`, and takes focus back on Escape. */
  button: HTMLButtonElement;
  /** Run just before the menu is shown — used by Zoom to refresh
   *  its check marks. */
  onBeforeOpen?(): void;
}): MenuPopover {
  const { menu, button } = opts;

  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    close();
    button.focus();
  };

  const onOutsideDown = (e: MouseEvent): void => {
    const target = e.target as Node | null;
    if (target && (menu.contains(target) || button.contains(target))) return;
    close();
  };

  // Calling `open()` on an already-open menu is harmless: the DOM
  // de-dupes `addEventListener` on an identical
  // (type, callback, capture) triple, so a redundant open can't leak
  // a listener. (`close()` guards on `hidden` and is idempotent too.)
  function open(): void {
    opts.onBeforeOpen?.();
    menu.style.top = button.offsetTop + 'px';
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onOutsideDown, true);
  }

  function close(): void {
    if (menu.hidden) return;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('mousedown', onOutsideDown, true);
  }

  return {
    isOpen: () => !menu.hidden,
    open,
    close,
    toggle: () => {
      if (menu.hidden) open();
      else close();
    },
  };
}
