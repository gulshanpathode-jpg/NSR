/**
 * content/imageModal.js - On-page full-resolution image viewer (gallery).
 *
 * Renders a modal overlay ON the LossControl360 page (not in the side panel)
 * showing one or more images at full resolution, with zoom + pan and
 * prev/next navigation. It is driven by the SHOW_IMAGE_MODAL message (see
 * content/content.js):
 *   · Order Photos thumbnails open the whole gallery (all photos in the
 *     current on-page order), starting at the clicked one.
 *   · A verify question's "source photo" links open a gallery of just that
 *     question's reference photos, starting at the clicked one.
 *
 * Why on the page (and not the side panel):
 *   The image is served from photoHandler.ashx, which requires the LC360
 *   session cookies. This content script runs ON the LC360 page, which is
 *   same-origin with photoHandler and already carries those cookies - so a
 *   plain <img src="…photoHandler…"> just loads. No blob fetch, no 403.
 *
 * The overlay carries its own injected styles (it can't share the side
 * panel's CSS) under a single #nsr-image-modal-style tag, and lives in a
 * #nsr-image-modal-overlay element appended to <body>.
 *
 * Public API: window.NSR_IMAGE_MODAL.show(images, startIndex)
 *   images     - array of image URLs (a single string is also accepted)
 *   startIndex - which image to open first (default 0)
 */

(() => {
  if (window.__NSR_IMAGE_MODAL_LOADED__) return;
  window.__NSR_IMAGE_MODAL_LOADED__ = true;

  const STYLE_ID = 'nsr-image-modal-style';
  const OVERLAY_ID = 'nsr-image-modal-overlay';

  const MIN_SCALE = 0.25;
  const MAX_SCALE = 8;
  const STEP = 0.25;          // button zoom increment
  const WHEEL_STEP = 0.0015;  // wheel sensitivity (per deltaY unit)

  // Gallery state.
  let images = [];
  let index = 0;

  // Per-image view state (scale + pan offset) and drag bookkeeping.
  let scale = 1;
  let tx = 0;
  let ty = 0;
  let dragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let panStartX = 0;
  let panStartY = 0;
  let imgEl = null;
  let stageEl = null;

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${OVERLAY_ID} {
        position: fixed; inset: 0; z-index: 2147483646;
        display: flex; align-items: center; justify-content: center;
        background: rgba(15, 23, 42, 0.82);
        backdrop-filter: blur(2px);
        -webkit-backdrop-filter: blur(2px);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        animation: nsr-im-fade 0.12s ease-out;
        outline: none;
      }
      @keyframes nsr-im-fade { from { opacity: 0; } to { opacity: 1; } }
      #${OVERLAY_ID} .nsr-im-stage {
        position: relative;
        width: 92vw; height: 88vh;
        display: flex; align-items: center; justify-content: center;
        overflow: hidden;
        cursor: grab;
      }
      #${OVERLAY_ID} .nsr-im-stage.is-dragging { cursor: grabbing; }
      #${OVERLAY_ID} .nsr-im-img {
        max-width: 92vw; max-height: 88vh;
        user-select: none; -webkit-user-drag: none;
        transform-origin: center center;
        transition: transform 0.05s linear;
        will-change: transform;
        box-shadow: 0 12px 48px rgba(0,0,0,0.5);
        background: #fff;
      }
      #${OVERLAY_ID} .nsr-im-toolbar {
        position: fixed; top: 16px; right: 16px; z-index: 3;
        display: flex; align-items: center; gap: 6px;
        background: rgba(15, 23, 42, 0.9);
        border: 1px solid rgba(255,255,255,0.16);
        border-radius: 10px; padding: 6px;
      }
      #${OVERLAY_ID} .nsr-im-btn {
        appearance: none; border: 0; cursor: pointer;
        width: 34px; height: 34px; border-radius: 7px;
        background: rgba(255,255,255,0.10); color: #f8fafc;
        font-size: 18px; line-height: 1; font-weight: 600;
        display: flex; align-items: center; justify-content: center;
        transition: background 0.1s ease;
      }
      #${OVERLAY_ID} .nsr-im-btn:hover { background: rgba(255,255,255,0.22); }
      #${OVERLAY_ID} .nsr-im-btn.nsr-im-close { font-size: 20px; }
      #${OVERLAY_ID} .nsr-im-zoomlabel {
        min-width: 48px; text-align: center; color: #e2e8f0;
        font-size: 12px; font-variant-numeric: tabular-nums;
        padding: 0 4px; user-select: none;
      }
      /* Prev / next gallery arrows */
      #${OVERLAY_ID} .nsr-im-nav {
        position: fixed; top: 50%; transform: translateY(-50%); z-index: 3;
        appearance: none; border: 0; cursor: pointer;
        width: 56px; height: 84px; border-radius: 12px;
        background: rgba(15,23,42,0.78); color: #f8fafc;
        border: 1px solid rgba(255,255,255,0.16);
        font-size: 26px; line-height: 1; font-weight: 600;
        display: flex; align-items: center; justify-content: center;
        transition: background 0.1s ease;
      }
      #${OVERLAY_ID} .nsr-im-nav:hover { background: rgba(15,23,42,0.95); }
      #${OVERLAY_ID} .nsr-im-prev { left: 16px; }
      #${OVERLAY_ID} .nsr-im-next { right: 16px; }
      #${OVERLAY_ID} .nsr-im-counter {
        position: fixed; top: 18px; left: 50%; transform: translateX(-50%); z-index: 3;
        color: #e2e8f0; font-size: 13px; font-weight: 600;
        font-variant-numeric: tabular-nums;
        background: rgba(15,23,42,0.78); padding: 5px 12px; border-radius: 999px;
        user-select: none;
      }
      #${OVERLAY_ID} .nsr-im-hint {
        position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); z-index: 3;
        color: rgba(226,232,240,0.78); font-size: 12px;
        background: rgba(15,23,42,0.7); padding: 5px 12px; border-radius: 999px;
        user-select: none; pointer-events: none;
      }
    `;
    document.head.appendChild(style);
  }

  function applyTransform() {
    if (!imgEl) return;
    imgEl.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    const label = document.querySelector(`#${OVERLAY_ID} .nsr-im-zoomlabel`);
    if (label) label.textContent = `${Math.round(scale * 100)}%`;
  }

  function clampScale(s) {
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
  }

  // Fit-to-screen: reset zoom + pan to the default centered view.
  function resetView() {
    scale = 1; tx = 0; ty = 0;
    applyTransform();
  }

  function zoomBy(delta) {
    scale = clampScale(scale + delta);
    if (scale === 1) { tx = 0; ty = 0; }   // snap pan back when fully zoomed out
    applyTransform();
  }

  function updateCounter() {
    const counter = document.querySelector(`#${OVERLAY_ID} .nsr-im-counter`);
    if (counter) counter.textContent = `${index + 1} / ${images.length}`;
  }

  // Load image at the given gallery position (wraps around the ends). Each
  // navigation resets zoom/pan back to fit-to-screen.
  function goTo(i) {
    if (!images.length) return;
    const n = images.length;
    index = ((i % n) + n) % n;   // wrap-around
    if (imgEl) imgEl.src = images[index];
    resetView();
    updateCounter();
  }

  function next() { goTo(index + 1); }
  function prev() { goTo(index - 1); }

  function close() {
    const overlay = document.getElementById(OVERLAY_ID);
    if (overlay) overlay.remove();
    document.removeEventListener('keydown', onKeydown, true);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    imgEl = null;
    stageEl = null;
    dragging = false;
    images = [];
    index = 0;
  }

  function onKeydown(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
    else if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomBy(STEP); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomBy(-STEP); }
    else if (e.key === '0') { e.preventDefault(); resetView(); }
  }

  function onWheel(e) {
    e.preventDefault();
    zoomBy(-e.deltaY * WHEEL_STEP);
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    dragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    panStartX = tx;
    panStartY = ty;
    if (stageEl) stageEl.classList.add('is-dragging');
  }

  function onPointerMove(e) {
    if (!dragging) return;
    tx = panStartX + (e.clientX - dragStartX);
    ty = panStartY + (e.clientY - dragStartY);
    applyTransform();
  }

  function onPointerUp() {
    dragging = false;
    if (stageEl) stageEl.classList.remove('is-dragging');
  }

  function show(input, startIndex) {
    // Normalise input to a clean URL array (a bare string is fine too).
    const list = Array.isArray(input) ? input.filter(Boolean) : (input ? [input] : []);
    if (!list.length) return false;

    // Rebuild from scratch each open so view state is always fit-to-screen.
    close();
    injectStyles();
    images = list;
    index = Math.min(Math.max(0, startIndex | 0), images.length - 1);
    scale = 1; tx = 0; ty = 0;

    const multi = images.length > 1;

    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    // Focusable so we can pull keyboard focus onto the page (the click that
    // opened the modal happened in the side panel, so focus is there, not
    // here - without this the arrow keys are dead until the user clicks the
    // page once).
    overlay.tabIndex = -1;
    overlay.innerHTML = `
      <div class="nsr-im-toolbar">
        <button class="nsr-im-btn" data-act="out" title="Zoom out (-)">&minus;</button>
        <span class="nsr-im-zoomlabel">100%</span>
        <button class="nsr-im-btn" data-act="in" title="Zoom in (+)">+</button>
        <button class="nsr-im-btn" data-act="reset" title="Fit to screen (0)">⤢</button>
        <button class="nsr-im-btn nsr-im-close" data-act="close" title="Close (Esc)">&times;</button>
      </div>
      ${multi ? `<div class="nsr-im-counter"></div>` : ''}
      ${multi ? `<button class="nsr-im-nav nsr-im-prev" data-act="prev" title="Previous (←)">&#8249;</button>` : ''}
      ${multi ? `<button class="nsr-im-nav nsr-im-next" data-act="next" title="Next (→)">&#8250;</button>` : ''}
      <div class="nsr-im-stage">
        <img class="nsr-im-img" alt="Inspection photo" draggable="false" />
      </div>
      <div class="nsr-im-hint">${multi ? '← → to browse · ' : ''}scroll to zoom · drag to pan · Esc to close</div>
    `;

    stageEl = overlay.querySelector('.nsr-im-stage');
    imgEl = overlay.querySelector('.nsr-im-img');

    // Toolbar + nav buttons (all carry data-act).
    overlay.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const act = btn.dataset.act;
        if (act === 'in') zoomBy(STEP);
        else if (act === 'out') zoomBy(-STEP);
        else if (act === 'reset') resetView();
        else if (act === 'next') next();
        else if (act === 'prev') prev();
        else if (act === 'close') close();
      });
    });

    // Click on the dim backdrop (but not the image/toolbar/nav) closes.
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target === stageEl) close();
    });

    // Zoom + pan interactions live on the stage.
    stageEl.addEventListener('wheel', onWheel, { passive: false });
    stageEl.addEventListener('pointerdown', onPointerDown);
    // Track move/up on window so a fast drag that leaves the stage still works.
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);

    document.addEventListener('keydown', onKeydown, true);
    document.body.appendChild(overlay);

    // Pull focus onto the page so ←/→/Esc/zoom keys work right away, without
    // the user first having to click the page.
    try { window.focus(); } catch (_) {}
    overlay.focus({ preventScroll: true });

    // goTo sets the src, resets the view, and fills the counter.
    goTo(index);
    return true;
  }

  window.NSR_IMAGE_MODAL = { show, close };
  console.log('[NSR] Image modal loaded');
})();
