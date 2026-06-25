/**
 * content/images.js - LC360 image extraction + label sorting.
 *
 * Public API: window.NSR_IMAGES
 *   · detectImagesPage()           → { supported, reason?, meta? }
 *   · extract()                    → { meta, images }
 *   · applyApiResults(results)     → { ok, images } | { ok:false, error }
 *   · restoreOriginal()            → { ok, images } | { ok:false, error }
 *   · fetchImageBlob(url)          → Promise<{ dataUrl, type, size }>
 *
 * Original-state tracking:
 *   We remember the order and labels of the photos as they appeared on the
 *   first successful extract. `restoreOriginal()` uses these to undo any
 *   API-driven reorder/rename. The state lives on window.__NSR_IMAGES_STATE__
 *   so it survives re-injection of the content scripts within the same page.
 *
 * Page contract:
 *   The "Order Photos" view lays out images as
 *     <ul id="sortable">
 *       <li>
 *         <img alt="Case Photo" src="…-175.jpg">
 *         <input id="…txtOtherDesc…" type="text">   ← label
 *         <input id="…hfPhotoID…"   type="hidden">  ← stable id
 *       </li>
 *       …
 *     </ul>
 *   This shape is the only thing we depend on; if LC360 ships a redesign the
 *   selectors below are the single point that needs to change.
 */

(() => {
  if (window.__NSR_IMAGES_LOADED__) return;
  window.__NSR_IMAGES_LOADED__ = true;

  // Persistent "snapshot" of the original page state so a later
  // restoreOriginal() can undo any rename/reorder.
  window.__NSR_IMAGES_STATE__ = window.__NSR_IMAGES_STATE__ || {
    originalOrder: [],     // photoId[], in original DOM order
    originalLabels: {},    // photoId → original label string
  };
  const STATE = window.__NSR_IMAGES_STATE__;

  // ── Selectors (single point of change if LC360 redesigns) ──────────

  const SEL = {
    sortable:    '#sortable',
    sortableLi:  '#sortable > li',
    img:         'img[alt="Case Photo"]',
    labelInput:  'input[type="text"][id*="txtOtherDesc"]',
    photoIdHid:  'input[type="hidden"][id*="hfPhotoID"]',
    caseInfo:    '.caseinfo-detail-item',
    headerLabel: '.mainSectionHeaderLabel',
  };

  // The page-title hint that confirms we're on the Order Photos view. Matched
  // case-insensitively as a substring against the .mainSectionHeaderLabel text
  // so trailing icons / badges / whitespace inside that element don't break it.
  const ORDER_PHOTOS_HINT = 'order photos';

  // ── Header-label probe (the authoritative "is this Order Photos?" check) ─

  /**
   * Walk every .mainSectionHeaderLabel on the page; return the first text
   * content that matches our hint. Returns null when nothing matches.
   *
   * This is the same detection strategy the Sync tab uses for NSR forms - it
   * keeps both capabilities reading the same on-page signal.
   */
  function findOrderPhotosHeader() {
    const labels = document.querySelectorAll(SEL.headerLabel);
    for (const el of labels) {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (text && text.toLowerCase().includes(ORDER_PHOTOS_HINT)) {
        return text;
      }
    }
    return null;
  }

  // ── Metadata scraping ──────────────────────────────────────────────

  /**
   * Pull survey number / insured / policy from the case-info bar at the top
   * of the page. The shape we have to parse is:
   *
   *   <div class="caseinfo-detail-item" title="Royal Arms Properties">
   *     <span> Insured Name: </span>
   *     Royal Arms Properties&nbsp;&nbsp;&nbsp;
   *   </div>
   *
   * The label is the <span>'s text and the value is everything that comes
   * AFTER the span - as text nodes (or other elements) trailing the span.
   * Concatenating textContent and stripping the label is fragile because
   * whitespace inside the span differs from whitespace in the parent's
   * full textContent (the outer .trim() doesn't equalise interior
   * whitespace). Walking siblings of the <span> avoids that problem
   * entirely.
   *
   * Falls back to "#NNNN" pulled from document.title for the survey number
   * when the info bar is missing.
   */
  function extractMetadata() {
    const meta = {
      surveyNumber: '',
      insuredName: '',
      policyNumber: '',
      surveyType: '',
      pageTitle: document.title || '',
    };

    const titleMatch = (document.title || '').match(/#(\d+)/);
    if (titleMatch) meta.surveyNumber = titleMatch[1];

    // survey_type comes from the page-context global `Utilant.CaseTypeName`,
    // assigned in an inline <script> block (Type.registerNamespace('Utilant')
    // followed by Utilant.CaseTypeName = "…";). The content script runs in an
    // isolated world and can't read window.Utilant directly, so we scrape the
    // assignment out of the inline script text instead.
    meta.surveyType = extractCaseTypeName();

    const detailItems = document.querySelectorAll(SEL.caseInfo);
    detailItems.forEach((item) => {
      const labelEl = item.querySelector('span');
      if (!labelEl) return;

      const labelText = (labelEl.textContent || '').trim().toLowerCase();
      const value     = readValueAfter(labelEl);
      if (!value) return;

      if (labelText.includes('insured'))      meta.insuredName  = value;
      else if (labelText.includes('policy'))  meta.policyNumber = value;
      else if (labelText.includes('survey'))  meta.surveyNumber = value || meta.surveyNumber;
    });

    return meta;
  }

  /**
   * Scrape `Utilant.CaseTypeName` out of the page's inline scripts.
   *
   * The General/Photos page emits an inline block like:
   *
   *   Type.registerNamespace('Utilant');
   *   Utilant.PolicyNumber = "WKFCC-12092-00";
   *   Utilant.CaseTypeName = "WKFC Property Standard";
   *   …
   *
   * We can't read window.Utilant from the isolated content-script world, so we
   * match the assignment text directly. The value may be single- or
   * double-quoted; we capture whichever is used and unescape \" / \'.
   * Returns '' when the assignment isn't present.
   */
  function extractCaseTypeName() {
    const RE = /Utilant\.CaseTypeName\s*=\s*(["'])((?:\\.|(?!\1).)*)\1/;
    const scripts = document.querySelectorAll('script');
    for (const s of scripts) {
      const text = s.textContent || '';
      if (text.indexOf('Utilant.CaseTypeName') === -1) continue;
      const m = text.match(RE);
      if (m) {
        return m[2]
          .replace(/\\(["'])/g, '$1')
          .replace(/\u00a0/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      }
    }
    return '';
  }

  /**
   * Return the cleaned text content of every sibling that comes after the
   * given element, joined with a single space. Strips &nbsp; characters and
   * collapses internal whitespace runs to a single space.
   *
   * For the LC360 case-info markup this returns "Royal Arms Properties"
   * (just the value), never the label prefix.
   */
  function readValueAfter(el) {
    if (!el || !el.parentNode) return '';
    let out = '';
    let n = el.nextSibling;
    while (n) {
      if (n.nodeType === Node.TEXT_NODE) {
        out += n.nodeValue;
      } else if (n.nodeType === Node.ELEMENT_NODE) {
        out += n.textContent || '';
      }
      n = n.nextSibling;
    }
    return out.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // ── Page detection ─────────────────────────────────────────────────

  /**
   * Quick check: does this look like an Order Photos page with at least one
   * photo? The page is recognised only when BOTH are true:
   *   · a .mainSectionHeaderLabel contains the text "Order Photos"
   *   · an #sortable grid with at least one <li> exists
   * The header check is the authoritative one - it matches the form-detection
   * strategy used by the Sync side of the panel.
   */
  function detectImagesPage() {
    const isLc360 = (window.NSR_FORMS && window.NSR_FORMS.isLc360Host)
      ? window.NSR_FORMS.isLc360Host(window.location.hostname)
      : window.location.hostname.endsWith('losscontrol360.com');
    if (!isLc360) {
      return { supported: false, reason: 'Not on LossControl360', hostname: window.location.hostname };
    }

    const matchedHeader = findOrderPhotosHeader();
    if (!matchedHeader) {
      return {
        supported: false,
        reason: 'Not on Order Photos page',
        meta: extractMetadata(),
      };
    }

    const sortable = document.querySelector(SEL.sortable);
    if (!sortable) {
      return {
        supported: false,
        reason: 'Order Photos header found but no photo grid',
        matchedHeader,
        meta: extractMetadata(),
      };
    }

    const count = sortable.querySelectorAll('li').length;
    if (count === 0) {
      return {
        supported: false,
        reason: 'No photos on this page',
        matchedHeader,
        meta: extractMetadata(),
      };
    }

    return { supported: true, count, matchedHeader, meta: extractMetadata() };
  }

  // ── Per-li helpers ─────────────────────────────────────────────────

  function getLabel(li) {
    const input = li.querySelector(SEL.labelInput);
    return input ? (input.value || '').trim() : '';
  }

  function getPhotoId(li) {
    const hid = li.querySelector(SEL.photoIdHid);
    return hid ? hid.value : (li.id || '');
  }

  /**
   * Write a label string into a single <li>'s input, firing the events any
   * framework bindings need. Used by both bulk applies and the per-image
   * label toggle in the side panel.
   */
  function setLabelOnLi(li, label) {
    const labelInput = li.querySelector(SEL.labelInput);
    if (!labelInput) return false;
    labelInput.value = (label == null ? '' : String(label));
    labelInput.dispatchEvent(new Event('input',  { bubbles: true }));
    labelInput.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function findLiByPhotoId(photoId) {
    if (!photoId) return null;
    const items = document.querySelectorAll(SEL.sortableLi);
    let found = null;
    items.forEach((li) => { if (!found && getPhotoId(li) === photoId) found = li; });
    return found;
  }

  /**
   * Ensure the originals snapshot exists. Called before any label/order
   * mutation so "Original" can always be restored even if the user jumps
   * straight to a label edit before sorting.
   */
  function ensureSnapshot() {
    const sortable = document.querySelector(SEL.sortable);
    if (!sortable) return;
    if (STATE.originalOrder.length > 0) return;
    const items = Array.from(sortable.querySelectorAll('li'));
    STATE.originalOrder = items.map((li) => getPhotoId(li));
    items.forEach((li) => { STATE.originalLabels[getPhotoId(li)] = getLabel(li); });
  }

  /**
   * Write a single photo's label by photoId. Returns { ok } so the side
   * panel can surface a toast on failure.
   */
  function setImageLabel(photoId, label) {
    ensureSnapshot();
    const li = findLiByPhotoId(photoId);
    if (!li) return { ok: false, error: 'Photo not found on page.' };
    const ok = setLabelOnLi(li, label);
    return ok ? { ok: true } : { ok: false, error: 'Label input not found.' };
  }

  /**
   * Apply a map of { photoId: labelString } to the page in one pass. Any
   * photoId not present in the map is left untouched. Returns the
   * re-extracted images array so the caller can refresh its state.
   */
  function applyLabelMap(labelMap) {
    const sortable = document.querySelector(SEL.sortable);
    if (!sortable) return { ok: false, error: 'Cannot find #sortable on this page.' };
    ensureSnapshot();
    const items = Array.from(sortable.querySelectorAll('li'));
    items.forEach((li) => {
      const pid = getPhotoId(li);
      if (labelMap && Object.prototype.hasOwnProperty.call(labelMap, pid)) {
        setLabelOnLi(li, labelMap[pid]);
      }
    });
    return { ok: true, images: extractFromSortableGrid() };
  }

  /**
   * Pull all photo rows into a plain array. URLs are absolutised against the
   * current origin so the side panel can fetch them as blobs without worrying
   * about relative paths.
   *
   * NOTE: `label` is returned as the *raw* textbox value (may be an empty
   * string). The display placeholder for an empty label - "(No label)" - is
   * applied in the UI layer (sidepanel renderGallery), NOT here. Persisting
   * the placeholder back into the data caused a bug where the original-order
   * "Restore" path would write the literal "(No label)" string back into the
   * input element instead of clearing it.
   */
  function extractFromSortableGrid() {
    const baseUrl = window.location.origin;
    const items = document.querySelectorAll(SEL.sortableLi);
    const images = [];

    items.forEach((li) => {
      const img = li.querySelector(SEL.img);
      if (!img) return;

      const thumbnailSrc = img.getAttribute('src') || '';
      // LC360 stores both a thumbnail ("-175.jpg") and a full-resolution
      // version at the same path without the "-175" suffix.
      const fullResSrc = thumbnailSrc.replace(/-175\.jpg/, '.jpg');

      const absolutise = (p) => (p && p.startsWith('http')) ? p : baseUrl + p;

      images.push({
        label:        getLabel(li),          // raw value, possibly ""
        photoId:      getPhotoId(li),
        thumbnailUrl: absolutise(thumbnailSrc),
        fullResUrl:   absolutise(fullResSrc),
      });
    });

    return images;
  }

  // ── Public actions ─────────────────────────────────────────────────

  /**
   * Read the photo grid and return { meta, images }. On the first successful
   * read we also snapshot the order + labels so restoreOriginal() can undo
   * later edits.
   */
  function extract() {
    const meta = extractMetadata();
    const matchedHeader = findOrderPhotosHeader();
    if (!matchedHeader) {
      return { error: 'NOT_ORDER_PHOTOS_PAGE', reason: 'Not on Order Photos page', meta };
    }

    const sortable = document.querySelector(SEL.sortable);
    if (!sortable || sortable.querySelectorAll('li').length === 0) {
      const reason = !sortable
        ? 'Order Photos header found but no photo grid'
        : 'No photos on this page';
      return { error: 'NOT_ORDER_PHOTOS_PAGE', reason, matchedHeader, meta };
    }

    const images = extractFromSortableGrid();

    if (STATE.originalOrder.length === 0 && images.length > 0) {
      STATE.originalOrder = images.map((img) => img.photoId);
      images.forEach((img) => { STATE.originalLabels[img.photoId] = img.label; });
    }

    return { meta, images, matchedHeader };
  }

  /**
   * Apply API ORDER to the page (AI sort), and write each photo's CHOSEN
   * label from labelMap. Labels are no longer forced to the AI value here -
   * the side panel owns the per-image AI/Original choice and passes the
   * resolved { photoId: label } map in. When labelMap is omitted, labels
   * are left exactly as they are on the page (order-only sort).
   *
   * Returns the re-extracted images array (in the new order).
   */
  function applyApiResults(results, labelMap) {
    const sortable = document.querySelector(SEL.sortable);
    if (!sortable) return { ok: false, error: 'Cannot find #sortable on this page.' };

    const items = Array.from(sortable.querySelectorAll('li'));
    if (items.length === 0) return { ok: false, error: 'No images found on page.' };

    // Snapshot originals if we haven't yet (e.g. user hit "Display Description"
    // before ever hitting "Refresh").
    ensureSnapshot();

    // 1. Labels: write each photo's chosen label (if a map was provided).
    if (labelMap) {
      items.forEach((li) => {
        const pid = getPhotoId(li);
        if (Object.prototype.hasOwnProperty.call(labelMap, pid)) {
          setLabelOnLi(li, labelMap[pid]);
        }
      });
    }

    // 2. Reorder: API-mentioned items first (in API order), then any leftovers
    const apiOrderIds = (results || []).map((r) => r.photoId);
    const ordered = [];
    apiOrderIds.forEach((photoId) => {
      const li = items.find((item) => getPhotoId(item) === photoId);
      if (li) ordered.push(li);
    });
    items.forEach((li) => {
      if (apiOrderIds.indexOf(getPhotoId(li)) === -1) ordered.push(li);
    });
    ordered.forEach((li) => sortable.appendChild(li));

    return { ok: true, images: extractFromSortableGrid() };
  }

  /**
   * Restore the original DOM ORDER. Labels follow labelMap when provided
   * (so per-image AI/Original choices survive an order change); when no map
   * is given, fall back to the original snapshot labels (full reset).
   * Safe to call repeatedly.
   */
  function restoreOriginal(labelMap) {
    const sortable = document.querySelector(SEL.sortable);
    if (!sortable) return { ok: false, error: 'Cannot find #sortable on this page.' };

    const items = Array.from(sortable.querySelectorAll('li'));
    if (items.length === 0) return { ok: false, error: 'No images found on page.' };

    // Labels
    items.forEach((li) => {
      const photoId = getPhotoId(li);
      if (labelMap && Object.prototype.hasOwnProperty.call(labelMap, photoId)) {
        // Caller-resolved choice (AI or original per photo).
        setLabelOnLi(li, labelMap[photoId]);
      } else if (!labelMap) {
        // Full reset to the original snapshot.
        const original = STATE.originalLabels[photoId];
        if (original != null) setLabelOnLi(li, original);
      }
      // If a map was given but this photo isn't in it, leave the label as-is.
    });

    // Order
    if (STATE.originalOrder.length > 0) {
      const sorted = items.slice().sort((a, b) =>
        STATE.originalOrder.indexOf(getPhotoId(a)) -
        STATE.originalOrder.indexOf(getPhotoId(b))
      );
      sorted.forEach((li) => sortable.appendChild(li));
    }

    return { ok: true, images: extractFromSortableGrid() };
  }

  /**
   * Fetch an image as a data URL. Runs in the content script so cookies on
   * the LC360 origin are sent automatically. The side panel can't do this
   * directly because its origin is chrome-extension://… .
   *
   * Returns a Promise so callers can await it.
   */
  function fetchImageBlob(imageUrl) {
    return fetch(imageUrl, { credentials: 'include' })
      .then((response) => {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.blob().then((blob) => ({ blob, type: blob.type, size: blob.size }));
      })
      .then(({ blob, type, size }) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve({ dataUrl: reader.result, type, size });
        reader.onerror   = () => reject(new Error('FileReader error for ' + imageUrl));
        reader.readAsDataURL(blob);
      }));
  }

  /**
   * Scroll the photo <li> for a given photoId to the center of the viewport
   * and apply a temporary highlight glow - mirrors the question highlighter
   * used by the Core Revised form flow.
   *
   * Returns true if the photo block was found and focused, false otherwise.
   */
  function focusImage(photoId) {
    if (!photoId) return false;

    const items = document.querySelectorAll(SEL.sortableLi);
    let target = null;
    items.forEach((li) => {
      if (!target && getPhotoId(li) === photoId) target = li;
    });
    if (!target) return false;

    ensureImageHighlightStyle();

    try {
      target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    } catch (_) {
      target.scrollIntoView();
    }

    const CLASS = '__nsr_img_highlight_active__';
    setTimeout(() => {
      target.classList.remove(CLASS);
      // Force reflow so the animation restarts if focused twice quickly.
      // eslint-disable-next-line no-unused-expressions
      target.offsetWidth;
      target.classList.add(CLASS);
      setTimeout(() => target.classList.remove(CLASS), 2100);
    }, 250);

    return true;
  }

  /**
   * Inject the highlight keyframes once. Kept self-contained in the image
   * module so it works even when highlighter.js isn't on the page.
   */
  function ensureImageHighlightStyle() {
    const STYLE_ID = '__nsr_img_highlight_style__';
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      @keyframes nsr-img-flash {
        0%   { box-shadow: 0 0 0 0 rgba(250, 204, 21, 0);   background-color: rgba(254, 240, 138, 0); }
        12%  { box-shadow: 0 0 0 4px rgba(250, 204, 21, 0.6); background-color: rgba(254, 240, 138, 0.5); }
        70%  { box-shadow: 0 0 0 4px rgba(250, 204, 21, 0.35); background-color: rgba(254, 240, 138, 0.3); }
        100% { box-shadow: 0 0 0 0 rgba(250, 204, 21, 0);   background-color: rgba(254, 240, 138, 0); }
      }
      .__nsr_img_highlight_active__ {
        animation: nsr-img-flash 2000ms ease-out forwards;
        border-radius: 8px;
        transition: background-color 200ms ease-out;
      }
    `;
    document.head.appendChild(style);
  }

  // ── Export ─────────────────────────────────────────────────────────

  window.NSR_IMAGES = {
    detectImagesPage,
    extract,
    applyApiResults,
    restoreOriginal,
    fetchImageBlob,
    focusImage,
    setImageLabel,
    applyLabelMap,
    extractCaseTypeName,
  };
})();
