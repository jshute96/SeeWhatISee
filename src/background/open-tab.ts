/**
 * Shared "open a tab next to the tab the user was on" helper.
 *
 * Every extension surface that opens a page of ours (Capture page,
 * upload landing card, error page) wants the same placement: right of
 * the opener, `openerTabId` linked so Chrome groups it with the page
 * it came from.
 *
 * The subtlety this centralizes: placement must name the opener's
 * window explicitly. `chrome.tabs.create` with no `windowId` puts the
 * tab in Chrome's *current* window — for a service worker that's the
 * last-focused normal window, which is not always the opener's window
 * (the opener can live in an app/popup-type window, or focus can move
 * between the active-tab lookup and the create). When they disagree,
 * Chrome rejects the call with "Tab opener must be in the same window
 * as the updated tab." and no tab opens at all.
 */

/** The only fields `tabPlacement` ever sets. */
type Placement = Pick<
  chrome.tabs.CreateProperties,
  'windowId' | 'index' | 'openerTabId'
>;

/**
 * Placement fields for a tab opened from `opener`: same window, one
 * slot to its right, linked as its opener. Fields are omitted when
 * the corresponding value is missing, so an absent/partial opener
 * just lets Chrome pick the position.
 *
 * Async because of the window-type check: an opener in a popup / app
 * window *would* accept the new tab, but it would land in a
 * chromeless window with no tab strip, hiding our page behind the
 * page the user was looking at. For those we return no placement at
 * all so Chrome opens the page in a real browser window.
 */
export async function tabPlacement(
  opener: chrome.tabs.Tab | undefined,
): Promise<Placement> {
  const props: Placement = {};
  if (opener?.windowId !== undefined) {
    if (!(await isNormalWindow(opener.windowId))) return props;
    props.windowId = opener.windowId;
  }
  if (opener?.index !== undefined) props.index = opener.index + 1;
  if (opener?.id !== undefined) props.openerTabId = opener.id;
  return props;
}

/**
 * Whether `windowId` is a regular tabbed browser window. A lookup
 * failure (window closed between the tab query and now) counts as
 * "no" — the caller then skips placement, which is what we'd want
 * for a vanished window anyway.
 */
async function isNormalWindow(windowId: number): Promise<boolean> {
  try {
    const win = await chrome.windows.get(windowId);
    return win.type === 'normal';
  } catch {
    return false;
  }
}

/**
 * `chrome.tabs.create` that degrades to an unplaced tab rather than
 * failing outright: on any rejection, if placement fields were set,
 * retry once without them. At every call site the page itself
 * matters far more than where it lands, and the placement inputs are
 * the parts that can go stale (the opener's window or tab closing
 * between the active-tab lookup and the create).
 *
 * A create that carried no placement re-throws instead of retrying
 * an identical call. If the retry also fails, the *original* error
 * propagates — it's the one that describes the real problem.
 *
 * Assumes a rejected `create` left no tab behind, which holds for
 * the placement errors this targets (Chrome validates the window and
 * opener before creating anything). A hypothetical reject-after-
 * create would leave an orphan tab.
 */
export async function createTabWithPlacement(
  props: chrome.tabs.CreateProperties,
): Promise<chrome.tabs.Tab> {
  try {
    return await chrome.tabs.create(props);
  } catch (err) {
    const { windowId, index, openerTabId, ...rest } = props;
    if (
      windowId === undefined &&
      index === undefined &&
      openerTabId === undefined
    ) {
      throw err;
    }
    console.info(
      '[SeeWhatISee] placed tab create failed, retrying unplaced:',
      err,
    );
    try {
      return await chrome.tabs.create(rest);
    } catch {
      throw err;
    }
  }
}
