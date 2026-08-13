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
//     and prompt growth), then slid up as far as needed to keep the
//     menu inside the window — and re-run on a window resize;
//   - `hidden` toggling plus the button's `aria-expanded`;
//   - closing returns focus to the button whenever focus is inside
//     the menu (Escape, an item pick, an outside click after
//     arrowing in);
//   - a mousedown anywhere else closes it;
//   - arrow-key navigation over the items (`menu-keys.ts`), plus
//     first-item focus when the menu was opened from the keyboard.
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

import { createMenuKeyNav } from './menu-keys.js';

// Breathing room between the menu and a window edge it gets pinned
// against, so a pinned menu doesn't look welded to the frame. Given
// up (down to 0) when the menu is too tall to fit with it.
const VIEWPORT_MARGIN_PX = 4;

export interface MenuPopover {
  isOpen(): boolean;
  /** `focusFirstItem` puts focus straight on the first item — pass it
   *  when the open came from the keyboard, so the user doesn't have
   *  to press Down before picking. */
  open(opts?: { focusFirstItem?: boolean }): void;
  close(): void;
  toggle(opts?: { focusFirstItem?: boolean }): void;
  /** Re-run the keyboard-open first-item focus. For a menu whose
   *  items are enabled asynchronously (More…'s annotation-transfer
   *  rows), the focus at open time can find nothing pickable; the
   *  owner calls this once the flags have settled. A no-op unless
   *  the menu is open, the open was keyboard-driven, and focus is
   *  still outside the menu. */
  refocusFirstItem(): void;
}

export function createMenuPopover(opts: {
  /** The popover element. Starts `hidden`; its CSS must anchor it
   *  against the column (`position: absolute`). */
  menu: HTMLElement;
  /** The button that owns it — supplies the vertical alignment,
   *  carries `aria-expanded`, and takes focus back on Escape. */
  button: HTMLButtonElement;
  /** Selector for the menu's item rows, for arrow-key navigation. */
  itemSelector: string;
  /** Run just before the menu is shown — used by Zoom to refresh
   *  its check marks. */
  onBeforeOpen?(): void;
}): MenuPopover {
  const { menu, button } = opts;
  const keyNav = createMenuKeyNav({ menu, itemSelector: opts.itemSelector });
  // Whether the current open came from the keyboard, so a late
  // `refocusFirstItem()` can tell "nothing was focusable yet" from
  // "the user opened this with the mouse and wants nothing focused".
  let openedFromKeyboard = false;

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      // `close()` does the focus handoff — and only when focus is
      // actually inside the menu, so an Escape pressed with the caret
      // in the prompt doesn't yank it onto the button.
      close();
      return;
    }
    // Bubble phase, and only registered while the menu is open, so
    // the arrows reach the page's own handlers whenever no menu has
    // a claim on them.
    keyNav.handleKey(e);
  };

  const onOutsideDown = (e: MouseEvent): void => {
    const target = e.target as Node | null;
    if (target && (menu.contains(target) || button.contains(target))) return;
    close();
  };

  // Registered on `open()` rather than at init, and that ordering is
  // load-bearing: `zoom.ts` installs its own resize listener at init
  // time, which re-grows the prompt and re-fits the image — a
  // relayout that moves the tool column. Registering later means this
  // one always runs after it and reads a settled `offsetTop`.
  //
  // Unthrottled on purpose: the no-move case costs a single
  // `getBoundingClientRect`, and the heavy work in a resize burst is
  // zoom's re-fit, not this.
  const onResize = (): void => { reposition(); };

  // Calling `open()` on an already-open menu is harmless: the DOM
  // de-dupes `addEventListener` on an identical
  // (type, callback, capture) triple, so a redundant open can't leak
  // a listener. (`close()` guards on `hidden` and is idempotent too.)
  function open(openOpts?: { focusFirstItem?: boolean }): void {
    opts.onBeforeOpen?.();
    menu.hidden = false;
    // Unhidden first: placement has to measure the menu, and a
    // `hidden` element has no box. Both happen in the same task, so
    // the browser never paints the pre-clamp position.
    reposition();
    button.setAttribute('aria-expanded', 'true');
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onOutsideDown, true);
    window.addEventListener('resize', onResize);
    openedFromKeyboard = openOpts?.focusFirstItem === true;
    if (openedFromKeyboard) keyNav.focusFirst();
  }

  function refocusFirstItem(): void {
    if (menu.hidden || !openedFromKeyboard) return;
    // Already inside — the user has arrowed on since the open, and
    // yanking focus back to the top would undo that.
    if (menu.contains(document.activeElement)) return;
    keyNav.focusFirst();
  }

  /**
   * Place the menu: aligned with its button, then slid up as far as
   * needed to stay inside the window. The palette sits low on the
   * page, so button-aligned near the bottom used to push the menu
   * past the window — extending the document and popping a scrollbar
   * under the click that opened it.
   *
   * Re-derives from the button rather than adjusting in place, so
   * it's idempotent and safe to re-run: a resize (or a window that
   * grew back) returns to button alignment before re-clamping.
   */
  function reposition(): void {
    menu.style.top = `${button.offsetTop}px`;
    clampIntoViewport();
  }

  /**
   * Slide the menu up until it fits, in preference order: button
   * alignment, then the edge margin, then flush at 0. Only the
   * vertical offset moves, so a shifted menu keeps its column anchor
   * and can't cover the button that owns it.
   *
   * Slides up **only** — never down. Go through `reposition()`, which
   * restores button alignment first; calling this directly after the
   * window grew would leave the menu where the last shrink parked it.
   */
  function clampIntoViewport(): void {
    // Iterated, because the move can invalidate its own measurement:
    // an overflowing menu extends the document, so sliding it back
    // inside shrinks `scrollHeight`, and a page scrolled to the
    // bottom then gets its `scrollTop` clamped — which shifts every
    // viewport coordinate, this menu's included. A second pass
    // settles that. The cap is a belt-and-braces bound on that
    // feedback loop, not a fix for an oscillation: each pass's
    // perturbation is smaller than the last (the document can only
    // shrink), and it always pushes content *down*, so bailing after
    // an unverified third write can leave the menu a few pixels low
    // but never above the top of the window.
    for (let pass = 0; pass < 3; pass++) {
      const rect = menu.getBoundingClientRect();
      // `clientHeight`, not `innerHeight`: it excludes a horizontal
      // scrollbar, which would otherwise count as usable space and
      // let the last item hide behind it.
      const viewportH = document.documentElement.clientHeight;

      // Highest position that keeps `margin` px clear at both edges,
      // or the margin itself when the menu is too tall for that.
      const fitTop = (margin: number): number =>
        Math.min(rect.top, Math.max(margin, viewportH - margin - rect.height));
      let desiredTop = fitTop(VIEWPORT_MARGIN_PX);
      // A menu between "viewport minus both margins" and "viewport"
      // tall fits the window but not the margins. Retrying at zero
      // gets it fully inside — worth more than the breathing room,
      // since hanging over the edge is what brings the scrollbar
      // back. Taller than the window, this lands at 0: the top-pinned
      // case, with no margin wasted above content the user can't
      // reach anyway.
      if (desiredTop + rect.height > viewportH) desiredTop = fitTop(0);

      const shift = desiredTop - rect.top;
      // Sub-pixel residue isn't worth another layout pass.
      if (Math.abs(shift) < 1) return;
      // `rect` is viewport-relative and `style.top` is relative to
      // the column, so only the *delta* crosses between them — which
      // is also what makes this correct at any page scroll position.
      // Read back from `style.top` rather than `offsetTop`, which
      // rounds to whole pixels and would drift the base each pass.
      // `Number.isFinite`, not `||`: a previous pass may have written
      // a legitimate `0px`, and `0 || fallback` would silently swap
      // the base for the button's offset and move the menu by that
      // whole distance in one hop.
      const parsedTop = parseFloat(menu.style.top);
      const currentTop = Number.isFinite(parsedTop) ? parsedTop : button.offsetTop;
      menu.style.top = `${currentTop + shift}px`;
    }
  }

  function close(): void {
    if (menu.hidden) return;
    // Hand focus back to the opener whenever it's inside the menu —
    // hiding the element it sits on would otherwise drop focus to
    // `<body>`. Covers every close path (item pick, Escape, an
    // outside mousedown after arrowing in) from one place, so the
    // callers don't each need their own `focus()`.
    if (menu.contains(document.activeElement)) button.focus();
    menu.hidden = true;
    openedFromKeyboard = false;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('mousedown', onOutsideDown, true);
    window.removeEventListener('resize', onResize);
  }

  return {
    isOpen: () => !menu.hidden,
    open,
    close,
    refocusFirstItem,
    toggle: (toggleOpts) => {
      if (menu.hidden) open(toggleOpts);
      else close();
    },
  };
}
