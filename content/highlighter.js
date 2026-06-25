/**
 * content/highlighter.js - Scroll-to-question + yellow highlight effect.
 *
 * When the user clicks an AI answer card in the side panel, we:
 *   1. Locate the question row in the page DOM.
 *   2. Smoothly scroll it to roughly the vertical center of the viewport.
 *   3. Apply a temporary yellow glow that fades out over ~2 seconds.
 *
 * The animation uses a single injected <style> tag with CSS keyframes so it's
 * cleanly removable and doesn't leak styles into the rest of the page.
 *
 * Public API: window.NSR_HIGHLIGHTER.focusQuestion(questionUid)
 */

(() => {
  if (window.__NSR_HIGHLIGHTER_LOADED__) return;
  window.__NSR_HIGHLIGHTER_LOADED__ = true;

  const STYLE_ID = '__nsr_highlight_style__';
  const CLASS = '__nsr_highlight_active__';

  function ensureStyleInjected() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      @keyframes nsr-flash {
        0%   { background-color: rgba(254, 240, 138, 0); box-shadow: 0 0 0 0 rgba(250, 204, 21, 0); }
        12%  { background-color: rgba(254, 240, 138, 0.95); box-shadow: 0 0 0 4px rgba(250, 204, 21, 0.45); }
        70%  { background-color: rgba(254, 240, 138, 0.75); box-shadow: 0 0 0 4px rgba(250, 204, 21, 0.25); }
        100% { background-color: rgba(254, 240, 138, 0);    box-shadow: 0 0 0 0 rgba(250, 204, 21, 0); }
      }
      .${CLASS} {
        animation: nsr-flash 2000ms ease-out forwards;
        border-radius: 6px;
        transition: background-color 200ms ease-out;
      }
    `;
    document.head.appendChild(style);
  }

  /**
   * Resolve a question UID back to the <tr> row in the form.
   * The UID is usually the value of an <a name="..."> anchor inside .leftCol.
   */
  function findRowForQuestion(questionUid) {
    if (!questionUid) return null;

    // Try anchor lookup first (NSR's native identifier)
    const anchor = document.querySelector(`a[name="${CSS.escape(questionUid)}"]`);
    if (anchor) {
      const row = anchor.closest('tr');
      if (row) return row;
    }

    // Fallback: any element with matching id
    const byId = document.getElementById(questionUid);
    if (byId) {
      const row = byId.closest('tr');
      if (row) return row;
    }

    return null;
  }

  /**
   * Scroll a row into view, attempting to center it vertically.
   * scrollIntoView with block:'center' handles most nested-scroll situations
   * because the browser walks up the ancestor scroll chain.
   */
  function scrollRowIntoView(row) {
    try {
      row.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    } catch (_) {
      // Older Edge / quirks: fall back to plain
      row.scrollIntoView();
    }
  }

  /**
   * Apply the flash animation. If the row already has the class (e.g., user
   * clicked twice quickly) we remove and re-add to restart the animation.
   */
  function flashRow(row) {
    ensureStyleInjected();
    row.classList.remove(CLASS);
    // Force reflow so the animation can re-trigger
    // eslint-disable-next-line no-unused-expressions
    row.offsetWidth;
    row.classList.add(CLASS);
    setTimeout(() => row.classList.remove(CLASS), 2100);
  }

  /**
   * Public entry: scroll-to + flash. Returns true on success, false if the
   * question wasn't found in the DOM.
   */
  function focusQuestion(questionUid) {
    const row = findRowForQuestion(questionUid);
    if (!row) {
      console.warn('[NSR] focusQuestion: row not found for', questionUid);
      return false;
    }
    scrollRowIntoView(row);
    // Slight delay so the flash starts after the scroll animation has begun
    setTimeout(() => flashRow(row), 250);
    return true;
  }

  window.NSR_HIGHLIGHTER = { focusQuestion, findRowForQuestion };
  console.log('[NSR] Highlighter loaded');
})();
