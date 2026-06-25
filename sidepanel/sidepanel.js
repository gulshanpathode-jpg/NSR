/**
 * sidepanel/sidepanel.js - Controller for the Smart Fill side-panel UI.
 *
 * The side panel has three rail tabs: Sync (primary), Activity, Config.
 * The Sync tab hosts TWO sub-modes - form review and Order Photos - and
 * picks the right one based on which capability the active page exposes:
 *
 *   Page kind                                       → default mode  · mode strip?
 *   ───────────────────────────────────────────────────────────────────────────
 *   Supported NSR form (e.g. WKFC Cover)            → form          · hidden
 *   LC360 "Order Photos" page                       → images        · hidden
 *   Both at once (rare; an NSR form with #sortable) → form          · visible
 *   Neither                                         → form (warning)· hidden
 *
 * Workflows handled here:
 *   Form review:    SCRAPE_AND_VERIFY → buildEntries → Accept/Reject/
 *                   Reconsider → APPLY_ANSWER / REVERT_ANSWER /
 *                   FOCUS_QUESTION.
 *   Order Photos:   EXTRACT_IMAGES → render gallery → (search/filter) →
 *                   Display Description → FETCH_IMAGE_BLOB x N →
 *                   direct POST to IMAGES_API (multipart FormData) →
 *                   chrome.tabs.create on the results page.
 *                   Sort toggle: APPLY_API_RESULTS / RESTORE_IMAGES.
 *
 * Both flows share: Activity log, toast, footer status dot, detection card,
 * Config tab. Everything below is in a single IIFE-free module so the
 * mode-switch can directly call into either subsystem.
 */

'use strict';

// ═════════════════════════════════════════════════════════════════════
// 1. DOM cache
// ═════════════════════════════════════════════════════════════════════

const $ = (id) => document.getElementById(id);

const els = {
  // Detection (universal)
  detectionCard: $('detection-card'),
  detectionLabel: $('detection-label'),
  detectionName: $('detection-name'),
  detectionBadge: $('detection-badge'),
  detectionUrl: $('detection-url'),
  detectionSurveyType: $('detection-surveytype'),
  detectionSurveyTypeBlk: $('detection-surveytype-block'),

  // Mode strip
  modeStrip: $('mode-strip'),
  modePanelForm: document.querySelector('.mode-panel[data-mode-panel="form"]'),
  modePanelImages: document.querySelector('.mode-panel[data-mode-panel="images"]'),

  // ── Form-review subpanel ────────────────────────────────────────
  statusBadge: $('status-badge'),
  statusDesc: $('status-desc'),
  canvasTitle: $('canvas-title'),
  canvasSubtitle: $('canvas-subtitle'),
  canvasRing: $('canvas-ring'),
  ringProgress: $('ring-progress'),
  canvasProgressLabel: $('canvas-progress-label'),
  btnSync: $('btn-sync'),

  queueCard: $('queue-card'),
  queueHeading: $('queue-heading'),
  countPending: $('count-pending'),
  countAccepted: $('count-accepted'),
  countRejected: $('count-rejected'),
  btnRejectAll: $('btn-reject-all'),
  btnAcceptAll: $('btn-accept-all'),
  btnRefresh: $('btn-refresh'),
  suggestionList: $('suggestion-list'),
  btnSendFeedback: $('btn-send-feedback'),

  warningCard: $('warning-card'),
  warningBody: $('warning-body'),
  supportedList: $('supported-list'),

  filterCountAll: $('filter-count-all'),
  filterCountDifferent: $('filter-count-different'),
  filterCountMatched: $('filter-count-matched'),

  // ── Images subpanel ─────────────────────────────────────────────
  imgMetaCard: $('img-meta-card'),
  metaSurvey: $('meta-survey'),
  metaInsured: $('meta-insured'),
  metaPolicy: $('meta-policy'),

  imgToolbarCard: $('img-toolbar-card'),
  imgSearch: $('img-search'),
  imgCount: $('img-count'),
  btnSortOrig: $('btn-sort-original'),
  btnSortApi: $('btn-sort-api'),

  imgProgressCard: $('img-progress-card'),
  imgProgressLabel: $('img-progress-label'),
  imgProgressCount: $('img-progress-count'),
  imgProgressBar: $('img-progress-bar'),
  imgProgressDetail: $('img-progress-detail'),

  imgGalleryCard: $('img-gallery-card'),
  imgGallery: $('img-gallery'),

  imgFooter: $('img-footer'),
  btnDescribe: $('btn-img-describe'),

  imgStatusCard: $('img-status-card'),
  imgStatusTitle: $('img-status-title'),
  imgStatusBody: $('img-status-body'),

  // ── Shared chrome ───────────────────────────────────────────────
  activityList: $('activity-list'),
  btnClearLog: $('btn-clear-log'),
  connDot: $('conn-dot'),
  connText: $('conn-text'),
  toast: $('toast'),

  // Config: color pickers
  cfgColorForm: $('cfg-color-form'),
  cfgColorImage: $('cfg-color-image'),
  cfgColorCurrent: $('cfg-color-current'),
  swatchForm: $('swatch-form'),
  swatchImage: $('swatch-image'),
  swatchCurrent: $('swatch-current'),
};

// ═════════════════════════════════════════════════════════════════════
// 2. State
// ═════════════════════════════════════════════════════════════════════

const state = {
  // Combined detection { form, images, url, title, hostname }
  detection: null,
  // Which subpanel is showing
  mode: 'form',           // 'form' | 'images'

  // Form-review state
  pipeline: 'idle',       // 'idle' | 'scraping' | 'uploading' | 'analyzing' | 'complete' | 'error'
  entries: [],
  apiByQuestionId: {},
  apiStartMs: 0,
  filter: 'all',          // 'all' | 'different' | 'matched'
  // result_id returned by the verify API. Used to tie the feedback POST
  // back to the original AI run. Empty when no Sync has completed.
  resultId: '',
  feedbackSending: false,
  // caseID captured at pipeline-start, when state.detection.url is still the
  // LC360 form page. Source-photo reference links are built from this stable
  // value rather than the live state.detection.url, which gets overwritten by
  // every PAGE_DETECTED broadcast (tab switch / SPA navigation) and would
  // otherwise make the photo links vanish on the next card repaint.
  caseId: '',
  // URL of the page the current pipeline output (queue / saved / error
  // banner) belongs to. Used to clear that output when the side panel moves
  // to a different page, so an error from page A never shows on page B.
  pipelinePageKey: null,

  // Image-extraction state
  images: [],
  imgMeta: null,
  currentSort: 'original',
  apiResults: null,
  isImagesProcessing: false,
  imagesInitialised: false,    // first auto-extract has run
  // Per-image label choice after AI verification:
  //   labelChoice: { photoId → 'ai' | 'original' }   (persists across sorts)
  //   aiLabelById: { photoId → AI verifiedLabel }
  //   origLabelById: { photoId → original label at verify time }
  labelChoice: {},
  aiLabelById: {},
  origLabelById: {},

  // Shared
  activity: [],
};

const STATUS_DESCRIPTIONS = {
  idle: 'Open a supported NSR form to begin.',
  ready: 'Ready to sync the current form.',
  scraping: 'Reading questions from the page…',
  uploading: 'Processing...',
  analyzing: 'Matching AI answers to questions…',
  complete: 'AI analysis complete. Review answers below.',
  error: 'Something went wrong - see details below.',
  unsupported: 'This page is not a supported NSR form.',
};

// ═════════════════════════════════════════════════════════════════════
// 3. Shared helpers
// ═════════════════════════════════════════════════════════════════════

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/**
 * Extract the `caseID` query param from a NSR page URL.
 * Example URL:
 *   https://natsr.losscontrol360.com/pages/cases/default.aspx?caseID=40ce26de-...&caseFormID=...
 * The param is case-insensitive in practice ("caseID", "caseId", "caseid").
 */
function extractCaseId(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    const params = u.searchParams;
    return (
      params.get('caseID') ||
      params.get('caseId') ||
      params.get('caseid') ||
      params.get('CaseID') ||
      ''
    );
  } catch (_e) {
    // Fallback for malformed URLs - best-effort regex.
    const m = String(url).match(/[?&]case[Ii][Dd]=([0-9a-fA-F-]+)/);
    return m ? m[1] : '';
  }
}

/**
 * Build the photoHandler URL that returns the full-res image for a given
 * (caseID, photoID) pair, e.g.
 *   https://natsr.losscontrol360.com/images/photoHandler.ashx?caseID=<case>&ImageID=<photo>.jpg
 *
 * Returns '' if either id is missing.
 */
function buildPhotoHandlerUrl(caseId, photoId) {
  if (!caseId || !photoId) return '';
  return `https://natsr.losscontrol360.com/images/photoHandler.ashx`
    + `?caseID=${encodeURIComponent(caseId)}`
    + `&ImageID=${encodeURIComponent(photoId)}.jpg`;
}

/**
 * Open an image gallery in the on-page modal (NOT a new tab). Shared by both
 * flows: the verify "source photo" links (gallery = that question's reference
 * photos) and the Order Photos thumbnails (gallery = all photos in on-page
 * order).
 *
 *   images - a URL string, or an array of URL strings (the gallery).
 *   index  - which image to open first (default 0).
 *
 * The modal is rendered by content/imageModal.js running on the LC360 page,
 * because that page is same-origin with photoHandler and carries the session
 * cookies the image needs. We dispatch to the currently active tab (same as
 * the form Accept/Reject actions). If that tab isn't the LC360 page, the
 * content script is unreachable and we surface a "wrong page" note.
 */
function openImageOnPage(images, index = 0) {
  const gallery = Array.isArray(images) ? images.filter(Boolean) : (images ? [images] : []);
  if (!gallery.length) return;
  chrome.runtime.sendMessage(
    { action: 'SHOW_IMAGE_MODAL', images: gallery, index },
    (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.ok) {
        showToast("You're not on the LC360 page - switch to the inspection tab to view the image.");
      }
    }
  );
}

function setConnection(stateName /* 'idle'|'online'|'error' */, text) {
  els.connDot.className = `conn-dot ${stateName === 'online' ? 'is-online' : stateName === 'error' ? 'is-error' : ''
    }`;
  els.connText.textContent = text;
}

function showToast(message, ms = 2200) {
  els.toast.textContent = message;
  els.toast.classList.add('is-visible');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => els.toast.classList.remove('is-visible'), ms);
}

function logActivity(message, level = 'info') {
  const ts = new Date();
  state.activity.unshift({ ts, message, level });
  if (state.activity.length > 200) state.activity.pop();
  renderActivity();
}

// ═════════════════════════════════════════════════════════════════════
// 4. Tab navigation (rail)
// ═════════════════════════════════════════════════════════════════════

document.querySelectorAll('.rail-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const id = tab.dataset.tab;
    document.querySelectorAll('.rail-tab').forEach((t) => t.classList.toggle('is-active', t === tab));
    document.querySelectorAll('.tab-panel').forEach((p) => {
      p.classList.toggle('is-active', p.dataset.panel === id);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════
// 5. Mode switching (form ↔ images inside the Sync tab)
// ═════════════════════════════════════════════════════════════════════

function setMode(mode, opts) {
  const { auto = false } = opts || {};
  if (state.mode === mode && !auto) return;
  state.mode = mode;

  els.modePanelForm.classList.toggle('is-active', mode === 'form');
  els.modePanelImages.classList.toggle('is-active', mode === 'images');

  document.querySelectorAll('.mode-btn').forEach((btn) => {
    const active = btn.dataset.mode === mode;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  // First time we enter images-mode on a supported page, auto-extract.
  if (mode === 'images' && state.detection?.images?.supported && !state.imagesInitialised) {
    state.imagesInitialised = true;
    extractImages();
  }
}

document.querySelectorAll('.mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => setMode(btn.dataset.mode));
});

// ═════════════════════════════════════════════════════════════════════
// 6. Detection rendering (top card) + mode auto-selection
// ═════════════════════════════════════════════════════════════════════

/**
 * Update the universal detection card AND decide which sub-mode the user
 * should land on. Rules:
 *   · Form supported AND images supported → both modes available, default
 *     to form, show the mode strip.
 *   · Form supported only → form mode, no strip.
 *   · Images supported only → images mode, no strip.
 *   · Neither → form mode, no strip (the form subpanel will show the
 *     "Unsupported page" warning).
 */
function renderDetection() {
  const d = state.detection;
  if (!d) {
    els.detectionLabel.textContent = 'Detected Page';
    els.detectionName.textContent = 'Checking…';
    els.detectionBadge.textContent = 'DETECTING';
    els.detectionBadge.className = 'badge badge-idle';
    return;
  }

  const formOk = !!d.form?.supported;
  const imagesOk = !!d.images?.supported;

  // ── Decide which mode to show ────────────────────────────────────
  // If the user is actively in a mode, don't yank them out unless the
  // current mode lost its capability.
  let nextMode = state.mode;
  if (formOk && imagesOk) {
    els.modeStrip.style.display = 'flex';
    // Keep whichever mode they're on; if it's the very first detection,
    // default to form.
    if (!state.detection?.__seen) nextMode = 'form';
  } else if (formOk) {
    els.modeStrip.style.display = 'none';
    nextMode = 'form';
  } else if (imagesOk) {
    els.modeStrip.style.display = 'none';
    nextMode = 'images';
  } else {
    els.modeStrip.style.display = 'none';
    nextMode = 'form';
  }
  // Reset images-auto-extract flag when leaving an images-supported page,
  // so a future return triggers a fresh extract.
  if (!imagesOk) state.imagesInitialised = false;

  setMode(nextMode, { auto: true });

  // ── Render the detection-card content based on the active mode ───
  if (state.mode === 'form') {
    renderFormDetection(d);
  } else {
    renderImagesDetection(d);
  }

  // Mark that we've rendered once so the next PAGE_DETECTED doesn't
  // override the user's manual mode selection.
  d.__seen = true;
}

function renderSurveyType(d) {
  if (!els.detectionSurveyTypeBlk || !els.detectionSurveyType) return;
  // Prefer the detection root's caseTypeName (set by content.js); fall back
  // to the form record or the images metadata.
  const st =
    (d && d.caseTypeName) ||
    (d && d.form && d.form.caseTypeName) ||
    (d && d.images && d.images.meta && d.images.meta.surveyType) ||
    '';
  els.detectionSurveyType.textContent = st || '-';
  els.detectionSurveyTypeBlk.style.display = 'block';
}

function renderFormDetection(d) {
  const f = d.form;
  els.detectionLabel.textContent = 'Detected Form';

  if (f?.supported) {
    els.detectionName.textContent = f.form.name;
    els.detectionBadge.textContent = 'SUPPORTED';
    els.detectionBadge.className = 'badge badge-success';
    els.warningCard.style.display = 'none';
    els.btnSync.disabled = false;
    setStatusBadge('READY', 'idle');
    // Button label + ready copy depend on which backend flow this form uses.
    // verify         → "Sync & Verify with AI" (Core Revised, unchanged)
    // knowledge_base → "Save to SmartFill" (Cover, General Information)
    setSyncButtonForFlow(f.form.flow || 'verify');
  } else {
    els.detectionName.textContent = 'Unsupported page';
    els.detectionBadge.textContent = 'NOT SUPPORTED';
    els.detectionBadge.className = 'badge badge-warning';
    renderSupportedList(d);
    els.warningCard.style.display = 'block';

    // Surface the detected case type alongside the header so the inspector
    // can tell *why* a page is unsupported: a header we don't know vs. a
    // known header gated out by the page's case type.
    const ctName = (d && d.caseTypeName)
      || (f && f.caseTypeName)
      || '';
    const ctSuffix = ctName ? ` (case type: "${ctName}")` : '';

    let body;
    if (f?.reason === 'Unsupported form' && f.detectedHeader) {
      body = `Detected form header: "${f.detectedHeader}"${ctSuffix} - this is not in the supported list for this case type.`;
    } else if (f?.reason === 'Form header not found on page') {
      body = 'No form header (.mainSectionHeaderLabel) was found. Make sure the form is fully loaded.';
    } else {
      body = `The current tab is not a recognized NSR form page (${f?.reason || 'unknown'})${ctSuffix}.`;
    }
    els.warningBody.textContent = body;
    els.btnSync.disabled = true;
    setStatusBadge('UNSUPPORTED', 'warning');
    els.statusDesc.textContent = STATUS_DESCRIPTIONS.unsupported;
    // Reset to default verify label so the next supported page starts clean.
    setSyncButtonForFlow('verify');
  }

  renderSurveyType(d);
}

/**
 * Update the sync button's visible label and the canvas "Ready" copy to
 * match the flow the active form uses. The button still fires the same
 * `startPipeline()` handler - only the wording changes.
 */
function setSyncButtonForFlow(flow) {
  const labelSpan = els.btnSync.querySelector('span');
  if (flow === 'knowledge_base') {
    if (labelSpan) labelSpan.textContent = 'Save to SmartFill';
    els.statusDesc.textContent = 'Ready to save this page to SmartFill.';
  } else {
    // 'verify' and 'kb_then_verify' both use the single "Sync & Verify with
    // AI" button. For kb_then_verify that one click fires both the cover
    // (knowledge_base) save and the verify pass in sequence.
    if (labelSpan) labelSpan.textContent = 'Sync & Verify with AI';
    els.statusDesc.textContent = STATUS_DESCRIPTIONS.ready;
  }
}

function renderImagesDetection(d) {
  const im = d.images;
  els.detectionLabel.textContent = 'Detected Page';

  if (im?.supported) {
    const count = im.count ?? '?';
    els.detectionName.textContent = `Order Photos · ${count} image${count === 1 ? '' : 's'}`;
    els.detectionBadge.textContent = 'SUPPORTED';
    els.detectionBadge.className = 'badge badge-success';
    els.imgStatusCard.style.display = 'none';
  } else {
    els.detectionName.textContent = 'Not on Order Photos page';
    els.detectionBadge.textContent = 'NOT SUPPORTED';
    els.detectionBadge.className = 'badge badge-warning';
    hidePhotoUi();
    showImgStatusWarning(
      'Not on Order Photos page',
      'Navigate to a LossControl360 survey\'s <strong>Order Photos</strong> view to extract images.'
    );
  }

  renderSurveyType(d);
}

// Human-readable flow descriptions for the supported-forms list. Keeps the
// UI copy in one place instead of scattering strings through the renderer.
const FLOW_LABELS = {
  verify: 'AI review (Accept / Reject queue)',
  knowledge_base: 'Save to SmartFill',
  kb_then_verify: 'Save to SmartFill, then AI review',
};

/**
 * Render the "Supported forms" list inside the Unsupported-page warning.
 *
 * Registry-driven: reads window.NSR_FORMS.SUPPORTED_FORMS so the list always
 * matches what the extension can actually detect - add a form to the registry
 * and it shows up here automatically, no second edit needed.
 *
 * Case-type-aware: the LC360 page carries a `Utilant.CaseTypeName`. When we
 * know it (passed in via `detection`), each form is tagged as either
 * applicable to THIS page's case type ("on this page") or belonging to a
 * different case type ("other case type"), so the inspector can see at a
 * glance why the current page isn't matching.
 *
 * @param {object} [detection] - the current page detection blob. Optional;
 *        when omitted (cold start) the full registry is shown ungrouped.
 */
function renderSupportedList(detection) {
  if (!els.supportedList) return;
  els.supportedList.innerHTML = '';

  const FORMS = (typeof window !== 'undefined' && window.NSR_FORMS) || null;

  // Fallback: registry not loaded (shouldn't happen now that forms.js is
  // included before sidepanel.js, but keep the panel functional regardless).
  if (!FORMS || !Array.isArray(FORMS.SUPPORTED_FORMS)) {
    [
      'WKFC Cover',
      'WKFC: Core Revised',
      'General Information',
      'Dual: Habitational Property Form',
    ].forEach((name) => {
      const li = document.createElement('li');
      li.textContent = name;
      els.supportedList.appendChild(li);
    });
    return;
  }

  // The case type the current page reports, if any. Empty string when it
  // couldn't be scraped (older page, or Utilant.CaseTypeName missing).
  const currentCaseType =
    (detection && detection.caseTypeName)
    || (detection && detection.form && detection.form.caseTypeName)
    || (detection && detection.images && detection.images.meta && detection.images.meta.surveyType)
    || '';
  const currentCt = currentCaseType.replace(/\s+/g, ' ').trim();

  // The form header the page actually rendered (drives "matched here").
  const detectedHeader =
    (detection && detection.form && detection.form.detectedHeader) || '';
  const detectedHeaderLc = detectedHeader.replace(/\s+/g, ' ').trim().toLowerCase();

  // Group the registry by case type. A form with no `caseTypes` array is
  // universal; we label it "Any case type".
  const groups = new Map(); // caseTypeLabel -> [forms]
  const UNIVERSAL = 'Any case type';
  FORMS.SUPPORTED_FORMS.forEach((form) => {
    const cts = Array.isArray(form.caseTypes) && form.caseTypes.length
      ? form.caseTypes
      : [UNIVERSAL];
    cts.forEach((ct) => {
      if (!groups.has(ct)) groups.set(ct, []);
      groups.get(ct).push(form);
    });
  });

  // Order: the current page's case type first (so the relevant forms are at
  // the top), then the rest alphabetically, with universal forms last.
  const groupKeys = Array.from(groups.keys()).sort((a, b) => {
    if (currentCt && a === currentCt) return -1;
    if (currentCt && b === currentCt) return 1;
    if (a === UNIVERSAL) return 1;
    if (b === UNIVERSAL) return -1;
    return a.localeCompare(b);
  });

  groupKeys.forEach((ct) => {
    const applicableNow = !currentCt || ct === currentCt || ct === UNIVERSAL;

    // Group heading row (the case-type name + an applicability hint).
    const headLi = document.createElement('li');
    headLi.className = 'supported-group' + (applicableNow ? ' is-active' : '');
    const ctName = document.createElement('span');
    ctName.className = 'supported-group-name';
    ctName.textContent = ct;
    headLi.appendChild(ctName);
    if (currentCt) {
      const tag = document.createElement('span');
      tag.className = 'supported-group-tag ' + (applicableNow ? 'tag-here' : 'tag-other');
      tag.textContent = applicableNow ? 'this page' : 'other case type';
      headLi.appendChild(tag);
    }
    els.supportedList.appendChild(headLi);

    // Forms within the group.
    groups.get(ct).forEach((form) => {
      const li = document.createElement('li');
      li.className = 'supported-form';

      const nameWrap = document.createElement('span');
      nameWrap.className = 'supported-form-name';
      nameWrap.textContent = form.name || form.shortName || form.formId;

      // Mark the form that actually matched this page's header.
      const isMatchedHere =
        applicableNow &&
        detectedHeaderLc &&
        (form.titleHint || form.name || '').toLowerCase() &&
        detectedHeaderLc.includes((form.titleHint || form.name || '').toLowerCase());
      if (isMatchedHere) {
        li.classList.add('is-detected');
        const dot = document.createElement('span');
        dot.className = 'supported-form-match';
        dot.textContent = 'detected here';
        nameWrap.appendChild(dot);
      }

      const flowEl = document.createElement('span');
      flowEl.className = 'supported-form-flow';
      flowEl.textContent = FLOW_LABELS[form.flow] || form.flow || '';

      li.appendChild(nameWrap);
      li.appendChild(flowEl);
      els.supportedList.appendChild(li);
    });
  });

  // Footer note explaining the case-type gating, shown only when we know the
  // current case type (so the user understands the "other case type" tags).
  if (currentCt) {
    const note = document.createElement('li');
    note.className = 'supported-note';
    note.textContent =
      `This page reports case type "${currentCt}". Only forms for that case type ` +
      `(plus any-case-type forms) can be detected here.`;
    els.supportedList.appendChild(note);
  } else {
    const note = document.createElement('li');
    note.className = 'supported-note';
    note.textContent =
      'Case type could not be read from this page, so all forms are listed. ' +
      'If a form still shows unsupported, reload the page after the extension loads.';
    els.supportedList.appendChild(note);
  }
}

function requestDetection() {
  chrome.runtime.sendMessage({ action: 'REQUEST_DETECTION' }).catch(() => { });
}

// ═════════════════════════════════════════════════════════════════════
// 7. Message bus
// ═════════════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'PAGE_DETECTED') {
    const newUrl = msg.url || '';
    const hasOutput = !!state.pipelinePageKey;
    const onOwnerPage = hasOutput && newUrl === state.pipelinePageKey;

    // Leaving the page that owns the current verify/KB output: blank the
    // display so a result/error from page A doesn't bleed onto page B - but
    // KEEP the data in memory (state.entries + the Accept/Reject decisions)
    // so it can be restored when we come back. (Destroying it here was the
    // regression: switching tabs wiped the review queue.)
    if (hasOutput && !onOwnerPage) {
      clearFormOutputDisplay();
    }

    // We keep msg.tabId on the detection blob so any later operation that
    // must talk to the LC360 page (image fetches, scrape, apply) can pin
    // the request to *that* tab even if the user has tabbed away.
    state.detection = msg.detection
      ? { ...msg.detection, url: msg.url, title: msg.title, tabId: msg.tabId }
      : null;
    renderDetection();

    // Back on the page that owns the output: re-show the stored review queue
    // with every Accept/Reject decision intact.
    if (onOwnerPage && state.entries.length) {
      restoreFormOutput();
    }
  }
  if (msg.action === 'PIPELINE_PROGRESS') {
    handleProgress(msg);
  }
});

// ═════════════════════════════════════════════════════════════════════
// 8. Form-review subsystem
// ═════════════════════════════════════════════════════════════════════

function setRingProgress(percent) {
  const clamped = Math.max(0, Math.min(100, percent));
  const circumference = 175.93; // 2π * 28
  els.ringProgress.style.strokeDashoffset = circumference * (1 - clamped / 100);
  els.canvasProgressLabel.textContent = `${Math.round(clamped)}% COMPLETED`;
}

function setRingSpinning(on) {
  els.canvasRing.classList.toggle('is-spinning', !!on);
}

function setStatusBadge(label, kind) {
  els.statusBadge.textContent = label;
  els.statusBadge.className = `badge badge-${kind || 'idle'}`;
}

els.btnSync.addEventListener('click', startPipeline);

function startPipeline() {
  if (!state.detection?.form?.supported) {
    showToast('This page is not a supported NSR form');
    return;
  }
  state.pipeline = 'scraping';
  state.entries = [];
  state.apiByQuestionId = {};
  state.resultId = '';
  state.feedbackSending = false;
  // Snapshot the caseID now, while detection still points at the form page.
  // renderSourcePhotosHtml reads this so the reference links survive later
  // tab switches / SPA navigations that mutate state.detection.url.
  state.caseId = extractCaseId(state.detection?.url || '');
  // Remember which page this run's output belongs to, so it can be cleared
  // when the panel later moves to a different page.
  state.pipelinePageKey = state.detection?.url || '';
  els.queueCard.style.display = 'none';
  els.btnSync.disabled = true;
  if (els.btnSendFeedback) {
    els.btnSendFeedback.disabled = true;
    setFeedbackButtonLabel('Send Feedback');
  }
  setStatusBadge('IN PROGRESS', 'progress');
  els.statusDesc.textContent = STATUS_DESCRIPTIONS.scraping;
  els.canvasTitle.textContent = 'Reading form';
  els.canvasSubtitle.textContent = 'Extracting questions and current answers.';
  setRingProgress(10);
  setRingSpinning(true);
  setConnection('idle', 'Working…');
  state.apiStartMs = Date.now();
  logActivity('Sync started');

  chrome.runtime.sendMessage({ action: 'SCRAPE_AND_VERIFY' }, (resp) => {
    if (chrome.runtime.lastError) return handlePipelineError(chrome.runtime.lastError.message);
    if (!resp?.success) return handlePipelineError(resp?.error || 'Unknown error');
    handlePipelineSuccess(resp);
  });
}

function handleProgress(msg) {
  if (msg.stage) {
    state.pipeline = msg.stage;
    els.statusDesc.textContent = STATUS_DESCRIPTIONS[msg.stage] || msg.message || '';
  }
  if (msg.message) els.canvasSubtitle.textContent = msg.message;
  if (typeof msg.progress === 'number') setRingProgress(msg.progress);
  if (msg.stage === 'scraping') els.canvasTitle.textContent = 'Reading form';
  if (msg.stage === 'uploading') els.canvasTitle.textContent = 'Processing';
  if (msg.stage === 'analyzing') els.canvasTitle.textContent = 'Analyzing';
}

/**
 * Visually blank the form-review output (canvas, ring, status, queue,
 * feedback) back to its neutral "Ready" state - WITHOUT discarding the stored
 * result. Called when the side panel moves to a page that isn't the one the
 * current output belongs to, so a result/backend error never bleeds onto an
 * unrelated page. The data (state.entries + Accept/Reject decisions) stays in
 * memory; restoreFormOutput() re-shows it when we return to its page.
 */
function clearFormOutputDisplay() {
  setStatusBadge('IDLE', 'idle');
  els.statusDesc.textContent = '';
  els.canvasTitle.textContent = 'Ready';
  els.canvasSubtitle.innerHTML = 'Click <strong>Sync &amp; Verify</strong> to start.';
  setRingProgress(0);
  setRingSpinning(false);
  setConnection('idle', 'Idle');
  if (els.queueCard) els.queueCard.style.display = 'none';
  if (els.btnSendFeedback) els.btnSendFeedback.disabled = true;
}

/**
 * Re-show the stored review queue (and its Accept/Reject decisions) when the
 * panel returns to the page the verify run belongs to. Only the verify flow
 * keeps a queue; KB-only / error results have no entries to restore, so they
 * simply stay blanked (the user can re-run if needed).
 */
function restoreFormOutput() {
  if (!state.entries.length) return;
  setStatusBadge('COMPLETE', 'success');
  els.canvasTitle.textContent = 'Analysis complete';
  els.canvasSubtitle.textContent = `Review ${state.entries.length} AI answers below.`;
  setRingProgress(100);
  setRingSpinning(false);
  setConnection('online', 'Online');
  renderQueue();
  if (els.queueCard) els.queueCard.style.display = 'block';
  if (els.btnSendFeedback) els.btnSendFeedback.disabled = false;
}

function handlePipelineError(message) {
  state.pipeline = 'error';
  setStatusBadge('ERROR', 'error');
  els.statusDesc.textContent = message;
  els.canvasTitle.textContent = 'Sync failed';
  els.canvasSubtitle.textContent = message;
  setRingProgress(0);
  setRingSpinning(false);
  setConnection('error', 'Backend error');
  els.btnSync.disabled = false;
  if (els.btnSendFeedback) els.btnSendFeedback.disabled = true;
  logActivity(`Error: ${message}`, 'error');
}

function handlePipelineSuccess(resp) {
  state.pipeline = 'complete';
  const latency = Date.now() - state.apiStartMs;

  const flow = resp.flow || 'verify';

  // ── Chained flow abort (Dual form): cover save failed ───────────
  //   kb_then_verify runs the cover knowledge_base call first. If it fails
  //   the verify leg never ran, so there's no queue to show - render the
  //   same KB failure banners as the plain knowledge_base flow and stop.
  if (flow === 'kb_then_verify' && resp.coverFailed) {
    setRingSpinning(false);
    els.btnSync.disabled = false;
    state.entries = [];
    state.apiByQuestionId = {};
    state.resultId = '';
    if (els.queueCard) els.queueCard.style.display = 'none';
    if (els.btnSendFeedback) els.btnSendFeedback.disabled = true;

    const kb = resp.kbResult || {};
    setRingProgress(0);

    if (kb.kind === 'not_found') {
      setStatusBadge('NOT FOUND', 'warning');
      setConnection('error', 'Survey not found');
      els.canvasTitle.textContent = 'Survey not found';
      els.canvasSubtitle.textContent = kb.detail
        || `No survey found for survey_no: ${resp.surveyNumber || '-'}`;
      els.statusDesc.textContent = kb.detail || 'Survey not found in SmartFill.';
    } else if (kb.kind === 'invalid') {
      setStatusBadge('REJECTED', 'warning');
      setConnection('error', 'Request rejected');
      els.canvasTitle.textContent = 'Cover rejected - verify skipped';
      els.canvasSubtitle.textContent = kb.detail || 'The backend rejected the cover save.';
      els.statusDesc.textContent = kb.detail || 'Invalid request.';
    } else {
      setStatusBadge('ERROR', 'error');
      setConnection('error', 'Backend error');
      els.canvasTitle.textContent = kb.kind === 'network' ? 'Network error' : 'Cover save failed';
      els.canvasSubtitle.textContent = kb.detail
        || `HTTP ${kb.status || '???'} saving cover to SmartFill.`;
      els.statusDesc.textContent = kb.detail || 'Backend error.';
    }
    logActivity(`Cover save failed - verify skipped: ${kb.detail || 'unknown'}`, 'error');
    showToast(kb.detail || 'Cover save failed - verify skipped');
    return;
  }

  // ── SmartFill save flow (Cover, General Information) ─────────────
  //   No Accept/Reject queue - the backend returns either a saved-status
  //   record or a structured error (400 wrong page_type, 404 unknown
  //   survey). We surface that message verbatim in the canvas + status
  //   row, and show a toast.
  if (flow === 'knowledge_base') {
    setRingSpinning(false);
    els.btnSync.disabled = false;
    state.entries = [];
    state.apiByQuestionId = {};
    state.resultId = '';
    if (els.queueCard) els.queueCard.style.display = 'none';
    if (els.btnSendFeedback) els.btnSendFeedback.disabled = true;

    const kb = resp.kbResult || {};
    const formName = (resp.form && resp.form.name) || resp.pageType || 'SmartFill';

    if (kb.ok) {
      // 200: { status: "saved", survey_no, page_type }
      setStatusBadge('SAVED', 'success');
      setRingProgress(100);
      setConnection('online', 'Online');
      els.canvasTitle.textContent = 'Saved to SmartFill';
      els.canvasSubtitle.textContent =
        `${formName} for survey ${kb.survey_no || resp.surveyNumber || '-'} saved successfully.`;
      els.statusDesc.textContent = 'Saved to SmartFill.';
      logActivity(
        `Saved to SmartFill: ${formName} (survey ${kb.survey_no || resp.surveyNumber || '-'}, ${latency} ms)`,
        'success'
      );
      showToast('Saved to SmartFill');
      return;
    }

    // Failure paths. Each has its own banner copy so the user knows what
    // to fix - a wrong survey number vs. a backend-rejected page_type vs.
    // a network outage need different responses from the user.
    setRingProgress(0);
    setRingSpinning(false);
    els.btnSync.disabled = false;

    if (kb.kind === 'not_found') {
      // 404: { detail: "No survey found for survey_no: xyz" }
      setStatusBadge('NOT FOUND', 'warning');
      setConnection('error', 'Survey not found');
      els.canvasTitle.textContent = 'Survey not found';
      els.canvasSubtitle.textContent = kb.detail
        || `No survey found for survey_no: ${resp.surveyNumber || '-'}`;
      els.statusDesc.textContent = kb.detail || 'Survey not found in SmartFill.';
      logActivity(`SmartFill: ${kb.detail || 'survey not found'}`, 'error');
      showToast(kb.detail || 'Survey not found');
      return;
    }

    if (kb.kind === 'invalid') {
      // 400: { detail: "page_type must be 'general' or 'cover'" }
      setStatusBadge('REJECTED', 'warning');
      setConnection('error', 'Request rejected');
      els.canvasTitle.textContent = 'Backend rejected the request';
      els.canvasSubtitle.textContent = kb.detail || 'The backend rejected this request.';
      els.statusDesc.textContent = kb.detail || 'Invalid request.';
      logActivity(`SmartFill rejected: ${kb.detail || 'invalid request'}`, 'error');
      showToast(kb.detail || 'Request rejected');
      return;
    }

    // Network / unknown error.
    setStatusBadge('ERROR', 'error');
    setConnection('error', 'Backend error');
    els.canvasTitle.textContent = kb.kind === 'network' ? 'Network error' : 'Backend error';
    els.canvasSubtitle.textContent = kb.detail
      || `HTTP ${kb.status || '???'} from SmartFill.`;
    els.statusDesc.textContent = kb.detail || 'Backend error.';
    logActivity(`SmartFill error: ${kb.detail || 'unknown'}`, 'error');
    showToast(kb.detail || 'Backend error');
    return;
  }

  // ── Verify flow (Core Revised) - unchanged from the original path ──
  //   kb_then_verify successes also land here: the cover save already
  //   succeeded in the worker, so this is the verify leg's queue.
  if (flow === 'kb_then_verify' && resp.kbResult && resp.kbResult.ok) {
    logActivity(
      `Cover saved to SmartFill (survey ${resp.kbResult.survey_no || resp.surveyNumber || '-'})`,
      'success'
    );
  }
  setStatusBadge('COMPLETE', 'success');
  els.statusDesc.textContent = STATUS_DESCRIPTIONS.complete;
  els.canvasTitle.textContent = 'Analysis complete';
  els.canvasSubtitle.textContent = `Review ${resp.aiAnswers.length} AI answers below.`;
  setRingProgress(100);
  setRingSpinning(false);
  setConnection('online', 'Online');
  els.btnSync.disabled = false;

  // Capture the result_id from the verify response so the Send Feedback
  // button can tie its payload back to this AI run. Empty string when the
  // backend didn't send one (legacy shape).
  state.resultId = resp.resultId || '';

  resp.aiAnswers.forEach((aiItem) => {
    if (aiItem.type === 'question' && aiItem.questionId) {
      state.apiByQuestionId[aiItem.questionId] = aiItem;
    }
  });

  state.entries = buildEntries(resp.extracted.sections, state.apiByQuestionId);
  renderQueue();
  els.queueCard.style.display = 'block';
  // Feedback can be sent now that Sync finished. We don't gate on
  // result_id presence - the user can still submit feedback against an
  // empty id if the legacy backend is in play.
  if (els.btnSendFeedback) {
    els.btnSendFeedback.disabled = false;
    setFeedbackButtonLabel('Send Feedback');
  }
  logActivity(`Sync complete: ${state.entries.length} suggestions (${latency} ms)`, 'success');
}

// ─────────────────────────────────────────────────────────────────────
// 8.1  Entry model & mode derivation
// ─────────────────────────────────────────────────────────────────────
//
// Each AI response item now carries up to TWO independent suggestions:
//
//   formPass  - answer derived from form / knowledge-base pages.
//               Owns aiSourceLabels (which pages were consulted).
//   imagePass - answer derived from uploaded inspection images.
//               Owns aiSourcePhotoIds (which photos were used as evidence).
//
// Either pass may be null. When both are present they may agree or
// disagree. The entry's `mode` is computed once here from those facts:
//
//   caseA        both passes present and they disagree → 3-block view
//   caseB        both passes present and they agree    → verified merge
//   caseC-form   only formPass present                 → form-only block
//   caseC-image  only imagePass present                → image-only block
//   matched      every available pass already agrees with the inspector's
//                current value → minimal card, filtered into Matched tab
//
// `matchesCurrent` is true when every non-empty pass agrees with the
// current form value. It drives the Different / Matched filters.

/**
 * Decide whether a pass has a usable answer at all.
 *
 * The backend ships only `aiAnswer` on each pass - no per-pass options
 * array. So we read aiAnswer directly:
 *   radio    → non-empty string
 *   checkbox → array with at least one entry
 *   text/textarea/select → non-empty, non-"null" string
 */
function passHasAnswer(pass, inputType) {
  if (!pass) return false;
  const a = pass.aiAnswer;
  if (a == null) return false;
  if (inputType === 'checkbox') {
    return Array.isArray(a) && a.length > 0;
  }
  // radio / text / textarea / select all use a string aiAnswer.
  if (typeof a !== 'string') return false;
  const trimmed = a.trim();
  return trimmed !== '' && trimmed !== 'null';
}

/**
 * Structural comparison between two passes for the same question.
 *
 * Checkbox: compare aiAnswer as a SET of labels (order-independent).
 * Everything else: trimmed string equality on aiAnswer.
 *
 * Either pass being absent makes them "not equal" - callers that care
 * about Case-B sameness will have already verified both are present.
 */
function passesEqual(passA, passB, inputType) {
  if (!passA || !passB) return false;
  if (inputType === 'checkbox') {
    const a = Array.isArray(passA.aiAnswer) ? passA.aiAnswer : [];
    const b = Array.isArray(passB.aiAnswer) ? passB.aiAnswer : [];
    if (a.length !== b.length) return false;
    const setA = new Set(a.map((s) => String(s).trim()));
    for (const v of b) if (!setA.has(String(v).trim())) return false;
    return true;
  }
  return String(passA.aiAnswer ?? '').trim() === String(passB.aiAnswer ?? '').trim();
}

/**
 * Does a pass's answer match the question's current on-page answer?
 * Used to detect "matched" entries that don't need user action.
 *
 * Radio: compare AI's aiAnswer (label string) to the currently-selected
 *        option's label on the page.
 * Checkbox: compare set of label strings.
 * Text: trimmed string equality.
 */
function passMatchesCurrent(pass, question) {
  if (!pass) return false;
  if (question.inputType === 'radio') {
    const orig = (question.options || []).find((o) => o.selected);
    return String(orig?.label ?? '').trim() === String(pass.aiAnswer ?? '').trim();
  }
  if (question.inputType === 'checkbox') {
    const currentLabels = Array.isArray(question.answer) ? question.answer : [];
    const aiLabels = Array.isArray(pass.aiAnswer) ? pass.aiAnswer : [];
    if (currentLabels.length !== aiLabels.length) return false;
    const setCur = new Set(currentLabels.map((s) => String(s).trim()));
    for (const v of aiLabels) if (!setCur.has(String(v).trim())) return false;
    return true;
  }
  return String(question.answer ?? '').trim() === String(pass.aiAnswer ?? '').trim();
}

function buildEntries(sections, apiByQuestionId) {
  const entries = [];
  sections.forEach((section) => {
    section.questions.forEach((q) => {
      const ai = apiByQuestionId[q.questionId];
      if (!ai) return;

      // Pull the two passes off the API item. Empty objects are normalised
      // to null so downstream checks can be a simple truthy test.
      const formPass = passHasAnswer(ai.formPass, q.inputType) ? ai.formPass : null;
      const imagePass = passHasAnswer(ai.imagePass, q.inputType) ? ai.imagePass : null;

      // Drop entries with no usable suggestion from either source.
      if (!formPass && !imagePass) return;

      // Decide mode from the two passes + their structural equality.
      let mode;
      if (formPass && imagePass) {
        mode = passesEqual(formPass, imagePass, q.inputType) ? 'caseB' : 'caseA';
      } else if (formPass) {
        mode = 'caseC-form';
      } else {
        mode = 'caseC-image';
      }

      // matchesCurrent = every available pass already agrees with the
      // inspector's current value. If true, the card is "Matched" and
      // doesn't need action.
      const formMatchesCur = formPass ? passMatchesCurrent(formPass, q) : true;
      const imageMatchesCur = imagePass ? passMatchesCurrent(imagePass, q) : true;
      const matchesCurrent = formMatchesCur && imageMatchesCur;

      entries.push({
        uid: q.questionUid,
        sectionText: q.sectionText,
        subheader: q.subheader,
        question: q,
        formPass,
        imagePass,
        mode,
        matchesCurrent,
        // Status starts as 'matched' when nothing needs attention, otherwise
        // 'pending'. Action handlers move it to one of:
        //   accepted-form | accepted-image | accepted-verified | rejected
        status: matchesCurrent ? 'matched' : 'pending',
      });
    });
  });
  return entries;
}

// ─────────────────────────────────────────────────────────────────────
// 8.2  Value formatting (display helpers)
// ─────────────────────────────────────────────────────────────────────

function formatAnswer(value) {
  if (value == null || value === '') return '-';
  if (Array.isArray(value)) return value.length === 0 ? '-' : value.join(', ');
  return String(value);
}

/**
 * Format a single pass's answer for display. The backend sends aiAnswer
 * as a label string (radio / text / select) or an array of label strings
 * (checkbox); we render those forms directly.
 */
function formatPassAnswer(question, pass) {
  if (!pass) return '-';
  if (question.inputType === 'checkbox') {
    const labels = Array.isArray(pass.aiAnswer)
      ? pass.aiAnswer.filter((s) => s != null && String(s).trim() !== '')
      : [];
    return labels.length ? labels.join(', ') : '-';
  }
  return formatAnswer(pass.aiAnswer);
}

// ─────────────────────────────────────────────────────────────────────
// 8.3  Filter logic
// ─────────────────────────────────────────────────────────────────────

function applyFilter(entries) {
  if (state.filter === 'different') return entries.filter((e) => !e.matchesCurrent);
  if (state.filter === 'matched') return entries.filter((e) => e.matchesCurrent);
  return entries;
}

function updateFilterCounts() {
  const total = state.entries.length;
  const different = state.entries.filter((e) => !e.matchesCurrent).length;
  const matchedCnt = state.entries.filter((e) => e.matchesCurrent).length;
  els.filterCountAll.textContent = total;
  els.filterCountDifferent.textContent = different;
  els.filterCountMatched.textContent = matchedCnt;
}

document.querySelectorAll('.filter-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    state.filter = tab.dataset.filter;
    document.querySelectorAll('.filter-tab').forEach((t) => {
      const active = t === tab;
      t.classList.toggle('is-active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    renderQueue();
  });
});

// Delegated handler for the verify "source photo" buttons. Lives on the
// stable list container so it survives card repaints (which replace each
// card's innerHTML). Stops propagation so the card's focus-on-click handler
// doesn't also fire.
els.suggestionList.addEventListener('click', (e) => {
  const btn = e.target.closest('.source-photo-link');
  if (!btn) return;
  e.stopPropagation();
  // Build a gallery from all the source-photo buttons in THIS question's
  // references row, opening at the one that was clicked.
  const listEl = btn.closest('.source-photos-list');
  const buttons = listEl
    ? Array.from(listEl.querySelectorAll('.source-photo-link'))
    : [btn];
  const urls = buttons.map((b) => b.dataset.imageUrl).filter(Boolean);
  const index = Math.max(0, buttons.indexOf(btn));
  openImageOnPage(urls, index);
});

// ─────────────────────────────────────────────────────────────────────
// 8.4  Queue rendering
// ─────────────────────────────────────────────────────────────────────

function renderQueue() {
  const visible = applyFilter(state.entries);
  const emptyCopy = {
    all: {
      title: 'No suggestions yet',
      body: 'Run Sync to fetch AI-verified answers.'
    },
    different: {
      title: 'Nothing to review',
      body: 'Every answer is already verified - no conflicts found.'
    },
    matched: {
      title: 'No matches',
      body: 'No questions match yet - every suggestion needs review.'
    },
  }[state.filter];

  els.suggestionList.innerHTML = '';
  if (visible.length === 0) {
    els.suggestionList.innerHTML = `
      <div class="empty-state" style="padding:24px;">
        <div class="empty-icon">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="1.6"
               stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </div>
        <p>${emptyCopy.title}</p>
        <span>${emptyCopy.body}</span>
      </div>
    `;
  } else {
    // Order: pending first (the work), then accepted, then rejected, then
    // matched (already-correct, lowest priority).
    const order = {
      pending: 0,
      'accepted-form': 1, 'accepted-image': 1, 'accepted-verified': 1,
      rejected: 2,
      matched: 3,
    };
    const sorted = [...visible].sort((a, b) => order[a.status] - order[b.status]);
    sorted.forEach((entry) => els.suggestionList.appendChild(renderSuggestion(entry)));
  }
  updateFilterCounts();
  updateCounts();
  updateBulkBar();
}

function renderSuggestion(entry) {
  const node = document.createElement('div');
  node.className = `suggestion is-${entry.status} mode-${entry.mode}`;
  node.dataset.uid = entry.uid;
  fillSuggestion(node, entry);

  // Clicking the card (but not a button) scrolls the actual question into
  // view on the page and flashes it - same UX as before.
  node.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    focusQuestionInPage(entry.uid);
  });
  return node;
}

/**
 * Top-level filler. Decides which body layout to use based on status +
 * mode, then composes head, body, references and actions.
 */
function fillSuggestion(node, entry) {
  // Reset all status classes; one will be re-applied below.
  node.classList.remove(
    'is-pending',
    'is-accepted-form', 'is-accepted-image', 'is-accepted-verified',
    'is-rejected', 'is-matched'
  );
  node.classList.add(`is-${entry.status}`);

  // Re-apply mode class (lost on reset above)
  ['mode-caseA', 'mode-caseB', 'mode-caseC-form', 'mode-caseC-image', 'mode-matched'].forEach((c) => {
    node.classList.remove(c);
  });
  node.classList.add(`mode-${entry.mode}`);

  const head = renderHead(entry);
  const banner = renderStatusBanner(entry);
  const body = renderBody(entry);
  const references = renderReferencesRow(entry);
  const actions = renderActions(entry);

  node.innerHTML = [head, banner, body, references, actions]
    .filter(Boolean)
    .join('');
}

// ─────────────────────────────────────────────────────────────────────
// 8.5  Card chrome (head + status banner)
// ─────────────────────────────────────────────────────────────────────

function renderHead(entry) {
  const subhead = entry.subheader ? ` · ${escapeHtml(entry.subheader)}` : '';
  const statusPill = renderStatusPill(entry);
  return `
    <div class="suggestion-head">
      <div style="min-width:0;flex:1;">
        <div class="suggestion-section">${escapeHtml(entry.sectionText || 'General')}${subhead}</div>
        <div class="suggestion-question">${escapeHtml(entry.question.questionText || '(no label)')}</div>
      </div>
      ${statusPill}
    </div>
  `;
}

function renderStatusPill(entry) {
  const map = {
    pending: { label: 'Needs review', cls: 'is-pending' },
    'accepted-form': { label: 'Form applied', cls: 'is-accepted' },
    'accepted-image': { label: 'Image applied', cls: 'is-accepted' },
    'accepted-verified': { label: 'Verified applied', cls: 'is-accepted' },
    rejected: { label: 'Rejected', cls: 'is-rejected' },
    matched: { label: 'Matches', cls: 'is-matched' },
  };
  const m = map[entry.status] || map.pending;
  return `<span class="suggestion-status ${m.cls}">${m.label}</span>`;
}

/**
 * Big status banner shown across the top of the card body when the user
 * has taken an action. Hidden for pending and matched states (where the
 * body itself communicates the state).
 */
function renderStatusBanner(entry) {
  if (entry.status === 'pending' || entry.status === 'matched') return '';

  const map = {
    'accepted-form': {
      cls: 'banner-success',
      icon: 'check',
      text: 'Applied: page/form-based answer was written to the form.',
    },
    'accepted-image': {
      cls: 'banner-success',
      icon: 'check',
      text: 'Applied: AI answer was written to the form.',
    },
    'accepted-verified': {
      cls: 'banner-success',
      icon: 'check',
      text: 'Applied: verified answer was written to the form.',
    },
    rejected: {
      cls: 'banner-muted',
      icon: 'x',
      text: 'Rejected - no changes were made to this question.',
    },
  };
  const b = map[entry.status];
  if (!b) return '';
  const iconSvg = b.icon === 'check'
    ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2.4"
            stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`
    : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2.4"
            stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
  return `<div class="applied-banner ${b.cls}">${iconSvg}<span>${escapeHtml(b.text)}</span></div>`;
}

// ─────────────────────────────────────────────────────────────────────
// 8.6  Card body - branches on mode (and status for post-action layout)
// ─────────────────────────────────────────────────────────────────────

function renderBody(entry) {
  // After the user has taken an action, the body collapses to a compact
  // "current → applied value" or "current value preserved" view. The full
  // suggestion blocks would just be visual noise at this point.
  if (entry.status !== 'pending' && entry.status !== 'matched') {
    return renderPostActionBody(entry);
  }

  switch (entry.mode) {
    case 'caseA': return renderCaseABody(entry);
    case 'caseB': return renderCaseBBody(entry);
    case 'caseC-form': return renderCaseCBody(entry, 'form');
    case 'caseC-image': return renderCaseCBody(entry, 'image');
    case 'matched':
    default: return renderMatchedBody(entry);
  }
}

/**
 * Three-block layout: current / form suggestion / image suggestion.
 * Used when both passes exist and they disagree.
 */
function renderCaseABody(entry) {
  const current = renderAnswerBlock({
    kind: 'current',
    title: 'Current Form Value',
    helper: 'The answer currently saved on the inspection form.',
    value: formatAnswer(entry.question.answer),
  });
  const form = renderAnswerBlock({
    kind: 'form',
    title: 'Page / Form Suggestion',
    helper: 'This answer was extracted from the inspection form pages.',
    value: formatPassAnswer(entry.question, entry.formPass),
  });
  const image = renderAnswerBlock({
    kind: 'image',
    title: 'AI Suggestion',
    helper: 'This answer was identified from uploaded inspection images.',
    value: formatPassAnswer(entry.question, entry.imagePass),
  });
  const conflictHeader = `
    <div class="conflict-header" role="status">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2.4"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
        <line x1="12" y1="9" x2="12" y2="13"/>
        <line x1="12" y1="17" x2="12.01" y2="17"/>
      </svg>
      <span>Sources disagree - pick the answer to apply, or reject both.</span>
    </div>
  `;
  return `${conflictHeader}<div class="suggestion-blocks blocks-3">${current}${form}${image}</div>`;
}

/**
 * Two-block layout: current vs. merged verified suggestion.
 * Used when both passes exist and agree. Picks the form pass arbitrarily
 * as the "canonical" value since both are structurally identical.
 */
function renderCaseBBody(entry) {
  const current = renderAnswerBlock({
    kind: 'current',
    title: 'Current Form Value',
    helper: 'The answer currently saved on the inspection form.',
    value: formatAnswer(entry.question.answer),
  });
  const verified = renderAnswerBlock({
    kind: 'verified',
    title: 'Verified Suggested Answer',
    helper: 'Both page data and image analysis agree on this answer.',
    value: formatPassAnswer(entry.question, entry.formPass),
    icon: 'shield-check',
  });
  return `<div class="suggestion-blocks blocks-2">${current}${verified}</div>`;
}

/**
 * Two-block layout: current vs. the one pass that exists.
 * `which` is 'form' or 'image'.
 */
function renderCaseCBody(entry, which) {
  const pass = which === 'form' ? entry.formPass : entry.imagePass;
  const current = renderAnswerBlock({
    kind: 'current',
    title: 'Current Form Value',
    helper: 'The answer currently saved on the inspection form.',
    value: formatAnswer(entry.question.answer),
  });
  const suggestion = which === 'form'
    ? renderAnswerBlock({
      kind: 'form',
      title: 'Page / Form Suggestion',
      helper: 'This answer was extracted from the inspection form pages.',
      value: formatPassAnswer(entry.question, pass),
    })
    : renderAnswerBlock({
      kind: 'image',
      title: 'AI Suggestion',
      helper: 'This answer was identified from uploaded inspection images.',
      value: formatPassAnswer(entry.question, pass),
    });
  return `<div class="suggestion-blocks blocks-2">${current}${suggestion}</div>`;
}

/**
 * Compact one-row layout for already-correct questions.
 */
function renderMatchedBody(entry) {
  return `
    <div class="matched-row">
      <div class="matched-icon" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2.4"
             stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      </div>
      <div class="matched-text">
        <div class="matched-title">Matches</div>
        <div class="matched-value">${escapeHtml(formatAnswer(entry.question.answer))}</div>
      </div>
    </div>
  `;
}

/**
 * Post-action body - used for accepted-* and rejected statuses. Shows a
 * compact summary so the user can still see what was applied / what was
 * preserved, and click Reconsider to undo.
 */
function renderPostActionBody(entry) {
  let appliedTitle, appliedValue, appliedKind;
  switch (entry.status) {
    case 'accepted-form':
      appliedTitle = 'Applied Page / Form Answer';
      appliedValue = formatPassAnswer(entry.question, entry.formPass);
      appliedKind = 'form';
      break;
    case 'accepted-image':
      appliedTitle = 'Applied AI Answer';
      appliedValue = formatPassAnswer(entry.question, entry.imagePass);
      appliedKind = 'image';
      break;
    case 'accepted-verified':
      appliedTitle = 'Applied Verified Answer';
      appliedValue = formatPassAnswer(entry.question, entry.formPass);
      appliedKind = 'verified';
      break;
    case 'rejected':
      // Show the current value (preserved) instead of an applied value.
      return `
        <div class="suggestion-blocks blocks-1">
          ${renderAnswerBlock({
        kind: 'current',
        title: 'Current Form Value (Unchanged)',
        helper: 'No changes were applied. Click Reconsider to review again.',
        value: formatAnswer(entry.question.answer),
      })}
        </div>
      `;
    default:
      return '';
  }
  return `
    <div class="suggestion-blocks blocks-1">
      ${renderAnswerBlock({
    kind: appliedKind,
    title: appliedTitle,
    helper: 'This value is now on the inspection form. Click Reconsider to revert.',
    value: appliedValue,
  })}
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────
// 8.7  Reusable answer-block component
// ─────────────────────────────────────────────────────────────────────

/**
 * The unit of the new layout. Renders a single labelled answer card with
 * a kind-specific color treatment.
 *
 *   kind: 'current' | 'form' | 'image' | 'verified'
 *   title:  short header (e.g. "Current Form Value")
 *   helper: one-sentence helper text under the value
 *   value:  the actual answer to show
 *   icon:   optional 'shield-check' badge (used for verified blocks)
 */
function renderAnswerBlock({ kind, title, helper, value, icon }) {
  const iconHtml = icon === 'shield-check'
    ? `<span class="answer-block-icon" aria-hidden="true">
         <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2.4"
              stroke-linecap="round" stroke-linejoin="round">
           <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
           <polyline points="9 12 11 14 15 10"/>
         </svg>
       </span>`
    : '';
  return `
    <div class="answer-block answer-block--${escapeHtml(kind)}">
      <div class="answer-block-head">
        ${iconHtml}<span class="answer-block-title">${escapeHtml(title)}</span>
      </div>
      <div class="answer-block-value">${escapeHtml(value)}</div>
      ${helper ? `<div class="answer-block-helper">${escapeHtml(helper)}</div>` : ''}
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────
// 8.8  References row (source photos + related pages)
// ─────────────────────────────────────────────────────────────────────
//
// Photo references live on imagePass.aiSourcePhotoIds.
// Page-label references live on formPass.aiSourceLabels.
// We show both cleanly when both exist. After an action, references are
// hidden to keep the post-action card compact.

function renderReferencesRow(entry) {
  if (entry.status !== 'pending' && entry.status !== 'matched') return '';

  const photoIds = (entry.imagePass && Array.isArray(entry.imagePass.aiSourcePhotoIds))
    ? entry.imagePass.aiSourcePhotoIds
    : [];
  const labels = (entry.formPass && Array.isArray(entry.formPass.aiSourceLabels))
    ? entry.formPass.aiSourceLabels.filter((s) => typeof s === 'string' && s.trim() !== '')
    : [];

  const photosHtml = renderSourcePhotosHtml(photoIds);
  const labelsHtml = renderSourceLabelsHtml(labels);
  if (!photosHtml && !labelsHtml) return '';
  return `<div class="references-row">${photosHtml}${labelsHtml}</div>`;
}

/**
 * Clickable links to the case photos the image-pass AI used as evidence.
 * Returns '' when there are no photos, or when we can't build a
 * case-scoped URL because the page URL lacks caseID.
 */
function renderSourcePhotosHtml(photoIds) {
  if (!photoIds || photoIds.length === 0) return '';
  // Prefer the caseID snapshotted when the pipeline ran (state.caseId); fall
  // back to the live detection URL only if it wasn't captured. This keeps the
  // links stable when the active tab/URL changes after the queue is built.
  const caseId = state.caseId || extractCaseId(state.detection?.url || '');
  if (!caseId) return '';

  const links = photoIds.map((pid, i) => {
    const href = buildPhotoHandlerUrl(caseId, pid);
    if (!href) return '';
    // A button (not an <a target=_blank>): clicking opens the image in the
    // on-page modal via openImageOnPage(). data-image-url is read by the
    // delegated handler on els.suggestionList.
    return `
      <button type="button" class="source-photo-link"
         data-image-url="${escapeHtml(href)}"
         title="${escapeHtml(pid)}">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
          <circle cx="8.5" cy="8.5" r="1.5"/>
          <polyline points="21 15 16 10 5 21"/>
        </svg>
        <span>Image ${i + 1}</span>
      </button>
    `;
  }).join('');

  return `
    <div class="source-photos">
      <div class="source-photos-label">Source photos · ${photoIds.length}</div>
      <div class="source-photos-list">${links}</div>
    </div>
  `;
}

/**
 * Non-clickable pills listing the knowledge-base pages the form-pass AI
 * consulted (e.g. "Cover page", "General information page").
 */
function renderSourceLabelsHtml(labels) {
  if (!labels || labels.length === 0) return '';
  const pills = labels.map((label) => `
    <span class="source-label-pill" title="Reference page: ${escapeHtml(label)}">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
      </svg>
      <span>${escapeHtml(label)}</span>
    </span>
  `).join('');
  return `
    <div class="source-photos source-labels">
      <div class="source-photos-label">Related pages · ${labels.length}</div>
      <div class="source-photos-list">${pills}</div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────
// 8.9  Action buttons - switches on mode + status
// ─────────────────────────────────────────────────────────────────────

function renderActions(entry) {
  let buttons = '';

  // Post-action states: just a Reconsider button.
  if (entry.status === 'accepted-form' ||
    entry.status === 'accepted-image' ||
    entry.status === 'accepted-verified' ||
    entry.status === 'rejected') {
    buttons = `<button class="action-btn action-reconsider" data-act="reconsider">Reconsider</button>`;
  } else if (entry.status === 'matched') {
    // Nothing to do; show no buttons.
    buttons = '';
  } else {
    // Pending - branches on mode.
    switch (entry.mode) {
      case 'caseA':
        buttons = `
          <button class="action-btn action-reject" data-act="reject-both">Reject Both</button>
          <button class="action-btn action-apply-form" data-act="apply-form">Use Page / Form Answer</button>
          <button class="action-btn action-apply-image" data-act="apply-image">Use Image / AI Answer</button>
        `;
        break;
      case 'caseB':
        buttons = `
          <button class="action-btn action-reject" data-act="reject">Reject</button>
          <button class="action-btn action-apply-verified" data-act="apply-verified">Apply Verified Answer</button>
        `;
        break;
      case 'caseC-form':
        buttons = `
          <button class="action-btn action-reject" data-act="reject">Reject</button>
          <button class="action-btn action-apply-form" data-act="apply-form">Apply Page / Form Answer</button>
        `;
        break;
      case 'caseC-image':
        buttons = `
          <button class="action-btn action-reject" data-act="reject">Reject</button>
          <button class="action-btn action-apply-image" data-act="apply-image">Apply Image / AI Answer</button>
        `;
        break;
      default:
        buttons = '';
    }
  }
  return buttons ? `<div class="suggestion-actions">${buttons}</div>` : '';
}

// Event delegation: one listener on the suggestion list handles every
// button click on every card. Data-act tells us what to do.
els.suggestionList.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  e.stopPropagation();
  const card = btn.closest('.suggestion');
  if (!card) return;
  const entry = state.entries.find((x) => x.uid === card.dataset.uid);
  if (!entry) return;
  switch (btn.dataset.act) {
    case 'apply-form': return acceptForm(entry);
    case 'apply-image': return acceptImage(entry);
    case 'apply-verified': return acceptVerified(entry);
    case 'reject': return rejectEntry(entry);
    case 'reject-both': return rejectEntry(entry);
    case 'reconsider': return reconsiderEntry(entry);
  }
});

// ─────────────────────────────────────────────────────────────────────
// 8.10  Counts + bulk bar
// ─────────────────────────────────────────────────────────────────────

function updateCounts() {
  const pending = state.entries.filter((e) => e.status === 'pending').length;
  const accepted = state.entries.filter((e) =>
    e.status === 'accepted-form' ||
    e.status === 'accepted-image' ||
    e.status === 'accepted-verified'
  ).length;
  const rejected = state.entries.filter((e) => e.status === 'rejected').length;
  els.countPending.textContent = pending;
  els.countAccepted.textContent = accepted;
  els.countRejected.textContent = rejected;
}

function updateBulkBar() {
  const anyPending = state.entries.some((e) => e.status === 'pending');
  // Reject-all is a no-op on the form DOM, safe to expose. Accept-all
  // applies whichever pass is available for each pending entry (verified
  // > form > image), letting the user bulk-confirm AI suggestions at once.
  els.btnRejectAll.style.display = anyPending ? 'inline-flex' : 'none';
  els.btnAcceptAll.style.display = anyPending ? 'inline-flex' : 'none';
}

function repaintEntry(entry) {
  const node = els.suggestionList.querySelector(`.suggestion[data-uid="${CSS.escape(entry.uid)}"]`);
  if (node) fillSuggestion(node, entry);
  updateCounts();
  updateBulkBar();
}

// ─────────────────────────────────────────────────────────────────────
// 8.11  Action handlers
// ─────────────────────────────────────────────────────────────────────
//
// All three "apply" actions funnel into applyPass(), which builds an
// aiItem-shaped shim from the chosen pass and reuses the existing
// APPLY_ANSWER message + content-script writer. The writer is untouched.

function acceptForm(entry) {
  if (!entry.formPass) return;
  applyPass(entry, 'form');
}

function acceptImage(entry) {
  if (!entry.imagePass) return;
  applyPass(entry, 'image');
}

function acceptVerified(entry) {
  // formPass and imagePass are structurally identical in Case B, so
  // either works. Pick formPass arbitrarily.
  const pass = entry.formPass || entry.imagePass;
  if (!pass) return;
  applyPassWithShim(entry, pass, 'accepted-verified', 'verified');
}

function applyPass(entry, which) {
  const pass = which === 'form' ? entry.formPass : entry.imagePass;
  if (!pass) return;
  const newStatus = which === 'form' ? 'accepted-form' : 'accepted-image';
  applyPassWithShim(entry, pass, newStatus, which);
}

/**
 * Build an aiItem-shaped shim (the legacy shape the writer expects) from
 * a pass object, dispatch APPLY_ANSWER, and reflect the result in the UI.
 *
 *   pass        - { aiAnswer, ... } from formPass or imagePass
 *   newStatus   - the entry status to move to on success
 *   kindLabel   - 'form' | 'image' | 'verified' (used for activity log copy)
 */
function applyPassWithShim(entry, pass, newStatus, kindLabel) {
  const q = entry.question;
  const shim = {
    inputType: q.inputType,
    inputElementId: q.inputElementId,
    aiAnswer: pass.aiAnswer,
    options: synthesizeOptions(q, pass),
  };
  chrome.runtime.sendMessage(
    { action: 'APPLY_ANSWER', question: q, aiItem: shim },
    (resp) => {
      if (resp?.ok) {
        entry.status = newStatus;
        repaintEntry(entry);
        const label = truncate(q.questionText, 60);
        const verb = kindLabel === 'verified' ? 'Applied verified' :
          kindLabel === 'form' ? 'Applied form' :
            'Applied image';
        logActivity(`${verb}: "${label}"`, 'success');
      } else {
        showToast(`Failed: ${resp?.error || 'unknown'}`);
        logActivity(`Apply failed: ${resp?.error || 'unknown'}`, 'error');
      }
    }
  );
}

/**
 * Build the options[] array the writer expects, by projecting the pass's
 * aiAnswer (a label string or array of label strings) onto the question's
 * own options[] and stamping the aiSelected flag on the matched ones.
 *
 * Matching is case-insensitive and trim-tolerant - backend label casing
 * occasionally drifts from the on-page label.
 *
 * For text/textarea/select inputs there are no options to mark, so we
 * return the question's options unchanged (typically empty).
 */
function synthesizeOptions(question, pass) {
  const baseOptions = Array.isArray(question.options) ? question.options : [];
  if (question.inputType !== 'radio' && question.inputType !== 'checkbox') {
    return baseOptions;
  }
  const wanted = question.inputType === 'checkbox'
    ? new Set(
      (Array.isArray(pass.aiAnswer) ? pass.aiAnswer : [])
        .map((s) => String(s ?? '').trim().toLowerCase())
        .filter((s) => s !== '')
    )
    : new Set(
      pass.aiAnswer != null
        ? [String(pass.aiAnswer).trim().toLowerCase()]
        : []
    );
  return baseOptions.map((o) => ({
    ...o,
    aiSelected: wanted.has(String(o.label ?? '').trim().toLowerCase()),
  }));
}

function rejectEntry(entry) {
  entry.status = 'rejected';
  repaintEntry(entry);
  logActivity(`Rejected: "${truncate(entry.question.questionText, 60)}"`);
  focusQuestionInPage(entry.uid);
}

/**
 * Reconsider: clean wipe back to pending.
 *
 * If a value was applied to the form (any accepted-* state), REVERT_ANSWER
 * is sent first so the form input goes back to its original value. The
 * card then snaps back to its original Case A/B/C layout with no memory
 * of the previous choice.
 */
function reconsiderEntry(entry) {
  const wasApplied =
    entry.status === 'accepted-form' ||
    entry.status === 'accepted-image' ||
    entry.status === 'accepted-verified';

  if (wasApplied) {
    chrome.runtime.sendMessage(
      { action: 'REVERT_ANSWER', question: entry.question },
      (resp) => {
        if (resp?.ok) {
          entry.status = 'pending';
          repaintEntry(entry);
          logActivity(`Reconsidering: reverted "${truncate(entry.question.questionText, 60)}"`);
        } else {
          showToast(`Revert failed: ${resp?.error || 'unknown'}`);
        }
      }
    );
  } else {
    // Rejected → pending. Nothing was written to the form, so no revert
    // round-trip is needed.
    entry.status = 'pending';
    repaintEntry(entry);
    logActivity(`Reconsidering: "${truncate(entry.question.questionText, 60)}"`);
    focusQuestionInPage(entry.uid);
  }
}

els.btnRejectAll.addEventListener('click', () => {
  const pending = state.entries.filter((e) => e.status === 'pending');
  pending.forEach((e) => { e.status = 'rejected'; repaintEntry(e); });
  showToast(`Rejected ${pending.length} suggestions`);
  logActivity(`Bulk reject: ${pending.length} entries`);
});

// Accept-all: for every pending entry, accept whichever pass is available.
// Preference order is verified (Case B - both passes agree) > formPass
// (Case A/C form side) > imagePass (Case A image side). Entries with no
// pass at all are skipped. Each accept goes through the same APPLY_ANSWER
// round-trip used by the per-card Accept buttons, so the form DOM stays
// in sync.
els.btnAcceptAll.addEventListener('click', () => {
  const pending = state.entries.filter((e) => e.status === 'pending');
  let count = 0;
  pending.forEach((entry) => {
    // Case B: form and image passes both exist and agree - apply once
    // as "verified".
    if (entry.formPass && entry.imagePass) {
      acceptVerified(entry);
      count++;
    } else if (entry.formPass) {
      acceptForm(entry);
      count++;
    } else if (entry.imagePass) {
      acceptImage(entry);
      count++;
    }
  });
  showToast(`Accepting ${count} suggestions`);
  logActivity(`Bulk accept: ${count} entries`);
});

// Refresh button (top bar): re-detect the active page and reset the side
// panel so the user can re-run the flow without reopening the extension.
// Equivalent to closing and re-opening the side panel.
if (els.btnRefresh) {
  els.btnRefresh.addEventListener('click', () => {
    logActivity('Refreshing...');
    location.reload();
  });
}

function focusQuestionInPage(uid) {
  chrome.runtime.sendMessage({ action: 'FOCUS_QUESTION', questionUid: uid }, (resp) => {
    if (!resp?.ok) showToast('Could not locate that question on the page');
  });
}

// ═════════════════════════════════════════════════════════════════════
// 8.10  Feedback submission
// ═════════════════════════════════════════════════════════════════════
//
// After Sync completes, the inspector reviews each AI suggestion and
// either accepts (form / image / verified) or rejects it. The "Send
// Feedback" button at the bottom of the queue card bundles every
// reviewed question into a single payload and POSTs it to FEEDBACK_API
// (the fetch itself lives in background/background.js for mixed-content
// reasons - same as the verify call).
//
// Payload shape (one feedback entry per question shown in the queue):
//
//   {
//     result_id: "<result_id from verify response>",
//     feedback: [
//       {
//         questionId:     "Q123",
//         questionText:   "Year roof was installed?",
//         questionType:   "text",        // inputType from the scrape
//         currentAnswer:  "2015",        // value in the form right now
//         formAnswer:     "2018",        // AI form-pass answer
//         imageAnswer:    "2018",        // AI image-pass answer
//         answerSelected: "2018"         // what the user actually picked
//       },
//       ...
//     ]
//   }
//
// answerSelected resolution (matches the entry.status set by the
// Accept/Reject handlers):
//
//   accepted-form     → formAnswer
//   accepted-image    → imageAnswer
//   accepted-verified → formAnswer (verified means form/image agree)
//   rejected          → currentAnswer (form wasn't changed)
//   matched           → currentAnswer (current already agrees with AI)
//   pending           → currentAnswer (no action taken yet)

/**
 * Convert one feedback-relevant answer to the wire shape:
 *   - checkbox: array of label strings
 *   - everything else: string (or empty string)
 */
function feedbackFormatAnswer(question, raw) {
  if (raw == null) return question && question.inputType === 'checkbox' ? [] : '';
  if (question && question.inputType === 'checkbox') {
    if (Array.isArray(raw)) {
      return raw
        .filter((s) => s != null)
        .map((s) => String(s).trim())
        .filter((s) => s !== '');
    }
    const s = String(raw).trim();
    return s ? [s] : [];
  }
  return String(raw).trim();
}

/**
 * Pull the AI form-pass / image-pass answers off an entry, in the wire
 * shape feedbackFormatAnswer produces. Returns '' / [] when the pass is
 * absent so the payload key is always present.
 */
function getPassAnswerForFeedback(entry, which) {
  const pass = which === 'form' ? entry.formPass : entry.imagePass;
  if (!pass) return entry.question.inputType === 'checkbox' ? [] : '';
  return feedbackFormatAnswer(entry.question, pass.aiAnswer);
}

/**
 * Build the answerSelected value for one entry, based on what the user
 * accepted in the UI. Falls back to currentAnswer for rejected / pending
 * / matched entries.
 */
function resolveAnswerSelected(entry, currentAnswer, formAnswer, imageAnswer) {
  switch (entry.status) {
    case 'accepted-form': return formAnswer;
    case 'accepted-image': return imageAnswer;
    case 'accepted-verified': return formAnswer;       // form == image in caseB
    case 'rejected':
    case 'matched':
    case 'pending':
    default: return currentAnswer;
  }
}

/**
 * Build the full feedback payload from current state. One entry per
 * question that appeared in the queue (i.e. that had an AI suggestion).
 */
function buildFeedbackPayload() {
  const feedback = state.entries.map((entry) => {
    const q = entry.question;
    const currentAnswer = feedbackFormatAnswer(q, q.answer);
    const formAnswer = getPassAnswerForFeedback(entry, 'form');
    const imageAnswer = getPassAnswerForFeedback(entry, 'image');
    const answerSelected = resolveAnswerSelected(
      entry, currentAnswer, formAnswer, imageAnswer
    );
    return {
      questionId: q.questionId || entry.uid,
      questionText: q.questionText || '',
      questionType: q.inputType || '',
      currentAnswer,
      formAnswer,
      imageAnswer,
      answerSelected,
    };
  });

  return {
    result_id: state.resultId || '',
    feedback,
  };
}

/**
 * Update the Send Feedback button label without touching disabled state.
 * Used to flash "Sending…" / "Sent" feedback during the round-trip.
 */
function setFeedbackButtonLabel(text) {
  if (!els.btnSendFeedback) return;
  const span = els.btnSendFeedback.querySelector('span');
  if (span) span.textContent = text;
  else els.btnSendFeedback.textContent = text;
}

/**
 * Click handler for the Send Feedback button. Disables itself during the
 * round-trip, surfaces the backend status via toast + activity log, and
 * re-enables on completion (success or error - user can retry on error).
 */
function sendFeedback() {
  if (state.feedbackSending) return;
  if (!state.entries.length) {
    showToast('Nothing to send - run Sync first');
    return;
  }

  state.feedbackSending = true;
  els.btnSendFeedback.disabled = true;
  setFeedbackButtonLabel('Sending…');

  const payload = buildFeedbackPayload();
  logActivity(`Sending feedback for ${payload.feedback.length} question${payload.feedback.length === 1 ? '' : 's'}…`);

  chrome.runtime.sendMessage(
    { action: 'SEND_FEEDBACK', payload },
    (resp) => {
      state.feedbackSending = false;
      if (chrome.runtime.lastError || !resp) {
        setFeedbackButtonLabel('Send Feedback');
        els.btnSendFeedback.disabled = false;
        const msg = (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'Unknown error';
        showToast(`Feedback failed: ${msg}`);
        logActivity(`Feedback failed: ${msg}`, 'error');
        return;
      }
      if (resp.ok) {
        setFeedbackButtonLabel('Feedback sent ✓');
        // Leave disabled so a single Sync run produces a single feedback
        // POST. Next Sync (or page change) re-enables it.
        els.btnSendFeedback.disabled = true;
        showToast('Feedback sent. Thank you!');
        logActivity(`Feedback sent (${payload.feedback.length} item${payload.feedback.length === 1 ? '' : 's'})`, 'success');
      } else {
        setFeedbackButtonLabel('Send Feedback');
        els.btnSendFeedback.disabled = false;
        const detail = resp.detail || `HTTP ${resp.status || '?'}`;
        showToast(`Feedback failed: ${detail}`);
        logActivity(`Feedback failed: ${detail}`, 'error');
      }
    }
  );
}

if (els.btnSendFeedback) {
  els.btnSendFeedback.addEventListener('click', sendFeedback);
}

// ═════════════════════════════════════════════════════════════════════
// 9. Image-extraction subsystem
// ═════════════════════════════════════════════════════════════════════

function showImgStatusWarning(title, bodyHtml) {
  els.imgStatusTitle.textContent = title;
  els.imgStatusBody.innerHTML = bodyHtml;
  els.imgStatusCard.style.display = 'block';
}

function hidePhotoUi() {
  els.imgMetaCard.style.display = 'none';
  els.imgToolbarCard.style.display = 'none';
  els.imgGalleryCard.style.display = 'none';
  els.imgFooter.style.display = 'none';
}

function showPhotoUi() {
  els.imgMetaCard.style.display = 'block';
  els.imgToolbarCard.style.display = 'block';
  els.imgGalleryCard.style.display = 'block';
  els.imgFooter.style.display = 'block';
  els.imgStatusCard.style.display = 'none';
}

function extractImages() {
  if (state.isImagesProcessing) return;
  showImgProgress('Extracting images…', '', 0, 1, 'Connecting to page…');

  chrome.runtime.sendMessage({ action: 'EXTRACT_IMAGES' }, (resp) => {
    hideImgProgress();
    if (chrome.runtime.lastError) return failExtract('Could not connect to the page. Make sure you\'re on an LC360 survey page.');
    if (!resp) return failExtract('No response from content script. Try refreshing the LC360 page.');
    if (resp.error === 'NOT_ORDER_PHOTOS_PAGE') {
      if (resp.meta) updateImgMeta(resp.meta);
      hidePhotoUi();
      showImgStatusWarning(
        'Not on Order Photos page',
        'Navigate to a LossControl360 survey\'s <strong>Order Photos</strong> view to extract images.'
      );
      return;
    }
    if (resp.error) return failExtract(resp.error);
    if (!resp.images || resp.images.length === 0) return failExtract('No images found on this page.');

    state.images = resp.images;
    state.imgMeta = resp.meta;
    state.currentSort = 'original';

    // Preserve prior AI verification when re-extracting the SAME photo set.
    // extractImages() runs automatically every time the user returns to the
    // Order Photos page (e.g. after the results tab opened), so blindly
    // clearing apiResults here would grey out the AI Sort button and drop
    // the per-image label choices. We only invalidate when the set of
    // photoIds on the page has genuinely changed.
    const newIds = resp.images.map((i) => i.photoId).sort().join('|');
    const aiIds = state.apiResults
      ? Object.keys(state.aiLabelById).sort().join('|')
      : '';
    const sameSet = state.apiResults && newIds !== '' && newIds === aiIds;

    if (!sameSet) {
      // Different (or first) photo set → prior verification no longer applies.
      state.apiResults = null;
      state.labelChoice = {};
      state.aiLabelById = {};
      state.origLabelById = {};
    }

    if (resp.meta) updateImgMeta(resp.meta);
    updateSortButtons(state.currentSort);
    showPhotoUi();
    renderGallery(state.images);
    logActivity(`Extracted ${state.images.length} image${state.images.length === 1 ? '' : 's'}`, 'success');
  });
}

function failExtract(message) {
  hidePhotoUi();
  showImgStatusWarning('Extraction failed', escapeHtml(message));
  logActivity(`Image extract failed: ${message}`, 'error');
}

/**
 * Resolve the current per-image label choices into a { photoId: label }
 * map the content script can apply. Only photos that have an AI result
 * appear here; everything else is left untouched on the page.
 *
 *   choice 'ai'       → AI verifiedLabel
 *   choice 'original' → original label captured at verify time
 */
function buildLabelMap() {
  const map = {};
  Object.keys(state.labelChoice || {}).forEach((photoId) => {
    const choice = state.labelChoice[photoId];
    map[photoId] = (choice === 'ai')
      ? (state.aiLabelById[photoId] || '')
      : (state.origLabelById[photoId] || '');
  });
  return map;
}

function applyApiSort() {
  if (state.isImagesProcessing || !state.apiResults) return;
  showImgProgress('Applying AI sort...', '', 0, 1, 'Reordering on page…');

  chrome.runtime.sendMessage(
    { action: 'APPLY_API_RESULTS', results: state.apiResults, labelMap: buildLabelMap() },
    (resp) => {
      hideImgProgress();
      if (chrome.runtime.lastError || !resp) return showToast('Failed to apply AI sort');
      if (resp.error) return showToast('Error: ' + resp.error);
      if (resp.images) {
        state.images = resp.images;
        state.currentSort = 'api';
        updateSortButtons('api');
        renderGallery(state.images);
        showToast('AI sort applied.');
        logActivity('Applied AI sort to page', 'success');
      }
    }
  );
}

function applyOriginalSort() {
  if (state.isImagesProcessing) return;
  showImgProgress('Restoring original…', '', 0, 1, 'Restoring original order…');

  // Pass the resolved label map so per-image choices survive the order
  // change. When no AI verification has happened, labelMap is empty and the
  // content script falls back to the original-snapshot labels.
  const labelMap = state.apiResults ? buildLabelMap() : null;

  chrome.runtime.sendMessage({ action: 'RESTORE_IMAGES', labelMap }, (resp) => {
    hideImgProgress();
    if (chrome.runtime.lastError || !resp) return showToast('Failed to restore original');
    if (resp.error) return showToast('Error: ' + resp.error);
    if (resp.images) {
      state.images = resp.images;
      state.currentSort = 'original';
      updateSortButtons('original');
      renderGallery(state.images);
      showToast('Original order restored');
      logActivity('Restored original order', 'success');
    }
  });
}

function updateSortButtons(activeSort) {
  els.btnSortOrig.classList.toggle('is-active', activeSort === 'original');
  els.btnSortApi.classList.toggle('is-active', activeSort === 'api');
  if (state.apiResults) {
    els.btnSortApi.disabled = false;
    els.btnSortApi.classList.remove('is-disabled');
  } else {
    els.btnSortApi.disabled = true;
    els.btnSortApi.classList.add('is-disabled');
  }
}

// ── Image-verify backend endpoint ─────────────────────────────────────
// Sent as multipart/form-data with:
//   · "data"  → JSON-stringified ARRAY of { photoId, label, order } (one per
//               image, in current on-page order). NOT wrapped in an object -
//               the backend rejects the wrapped form.
//   · "files" → one part per successfully-fetched image blob, filename =
//               "<photoId>.jpg". Failed fetches are silently skipped (the
//               metadata entry is still sent so the backend sees the gap).
const IMAGES_API = 'https://qagent.dhaninfo.ai/pipeline';
// const IMAGES_API = 'http://164.52.196.182/pipeline';

async function displayDescriptions() {
  if (state.isImagesProcessing || state.images.length === 0) return;

  // Pin the LC360 tab id NOW, before any async work begins. The user is
  // free to switch tabs while the loop runs (some users do this deliberately
  // to check email while ~50 images upload); without a pinned target the
  // service worker would route each fetch to whichever tab is currently
  // focused, which fails.
  const targetTabId = state.detection?.tabId;
  if (typeof targetTabId !== 'number') {
    showToast('Cannot start: no LC360 tab detected. Reopen the side panel on the Order Photos page.');
    logActivity('Display Description aborted: no tab id pinned', 'error');
    return;
  }

  state.isImagesProcessing = true;
  els.btnDescribe.disabled = true;

  const total = state.images.length;
  const imageBlobs = []; // { photoId, label, blob | null, filename }

  try {
    // ── Step 1: fetch each full-res blob through the content script ──
    // (cookies on the LC360 origin are required to authorise the request,
    //  so we route through the page rather than fetching directly here)
    showImgProgress('Fetching images…', `0 / ${total}`, 0, total, 'Downloading full-resolution images…');

    for (let i = 0; i < total; i++) {
      const img = state.images[i];
      updateImgProgress(
        'Fetching images…',
        `${i + 1} / ${total}`,
        i + 1, total,
        `Downloading: ${labelForDisplay(img.label)}`
      );
      try {
        // Pass targetTabId so the service worker forwards the FETCH_IMAGE_BLOB
        // message to the LC360 tab even if the user has tabbed away.
        const blobData = await fetchImageBlob(img.fullResUrl, targetTabId);
        imageBlobs.push({
          photoId: img.photoId,
          label: img.label,
          blob: blobData.blob,
          filename: img.photoId + '.jpg',
        });
      } catch (err) {
        console.error('[SmartFill] Failed to fetch image:', img.label, err);
        // Push a sentinel so the metadata array still includes this entry -
        // it just won't have a corresponding `files` part.
        imageBlobs.push({
          photoId: img.photoId,
          label: img.label,
          blob: null,
          filename: img.photoId + '.jpg',
          error: err.message,
        });
      }
    }

    // ── Step 2: build the multipart body ─────────────────────────────
    updateImgProgress('Preparing upload...', '', total, total, 'Building request payload...');

    const formData = new FormData();

    // The backend expects:
    //   · `data` -> JSON-stringified ARRAY of { photoId, label, order }
    //     (one per image, in current on-page order). NOT wrapped in an object.
    //   · `survey_number` -> separate top-level form field.
    const metadata = imageBlobs.map((item, index) => ({
      photoId: item.photoId,
      label: item.label,
      order: index,
    }));
    formData.append('data', JSON.stringify(metadata));
    formData.append('survey_number', (state.imgMeta && state.imgMeta.surveyNumber) || '');
    formData.append('survey_type', (state.imgMeta && state.imgMeta.surveyType) || '');

    // One `files` part per successfully-fetched blob. Filename uses .jpg
    // even if the backend mime-sniffs internally - the original extension
    // does the same and the backend accepts it.
    imageBlobs.forEach((item) => {
      if (item.blob) {
        formData.append('files', item.blob, item.filename);
      }
    });

    // ── Step 3: POST to the pipeline ─────────────────────────────────
    // Surface the count here so the inspector sees exactly how many images
    // are about to be sent. `validCount` ignores entries whose blob fetch
    // failed (sentinels with blob === null); the metadata array still
    // includes them, but they have no `files` part attached.
    const validCount = imageBlobs.filter((it) => it.blob).length;
    const countLabel = `${validCount} of ${total} image${total === 1 ? '' : 's'}`;
    updateImgProgress(
      'Processing…',
      countLabel,
      total, total,
      `Uploading ${countLabel} and metadata…`
    );

    const response = await fetch(IMAGES_API, {
      method: 'POST',
      body: formData,
      // No Content-Type header - fetch sets the correct multipart boundary
      // automatically when given a FormData body.
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`API returned HTTP ${response.status}${errText ? ': ' + errText.substring(0, 200) : ''}`);
    }

    const apiResult = await response.json();
    state.apiResults = apiResult.results || [];

    // Build the per-image label-choice model now that AI labels exist.
    // Default rule: choose 'ai' only where the AI label differs from the
    // original; otherwise 'original'. Choices persist across sort toggles.
    state.aiLabelById = {};
    state.origLabelById = {};
    state.labelChoice = {};
    const origByIdNow = {};
    state.images.forEach((img) => { origByIdNow[img.photoId] = img.label || ''; });
    state.apiResults.forEach((r) => {
      if (!r || !r.photoId) return;
      const aiLabel = (r.verifiedLabel != null) ? String(r.verifiedLabel) : '';
      const origLabel = origByIdNow[r.photoId] != null ? String(origByIdNow[r.photoId]) : '';
      state.aiLabelById[r.photoId] = aiLabel;
      state.origLabelById[r.photoId] = origLabel;
      const differs = aiLabel.trim() !== origLabel.trim() && aiLabel.trim() !== '';
      state.labelChoice[r.photoId] = differs ? 'ai' : 'original';
    });

    updateSortButtons(state.currentSort);

    // Apply the default per-image label choices to the page WITHOUT changing
    // the current order (photos defaulted to 'ai' get the AI label written;
    // 'original' ones are left as-is). Then re-render the gallery so the
    // AI/Original toggles appear. Order stays put until the user presses a
    // sort button - labels and order are independent now.
    const defaultLabelMap = buildLabelMap();
    chrome.runtime.sendMessage(
      { action: 'SET_IMAGE_LABELS_BULK', labelMap: defaultLabelMap },
      (resp) => {
        if (!chrome.runtime.lastError && resp && resp.images) {
          state.images = resp.images;
        }
        renderGallery(state.images);
      }
    );

    const resultsData = {
      meta: state.imgMeta || {},
      results: state.apiResults,
      thumbnails: {},
    };
    state.images.forEach((img) => {
      resultsData.thumbnails[img.photoId] = img.thumbnailUrl;
      resultsData.thumbnails[img.photoId + '_full'] = img.fullResUrl;
    });

    // ── Step 4: open the results report ──────────────────────────────
    // We do this from the side panel directly (not via the service worker)
    // so the message-port lifecycle can't tear down the worker mid-flight
    // before chrome.tabs.create resolves. The side panel has the same
    // chrome.tabs/storage privileges as the worker.
    await openResultsTab(resultsData);

    hideImgProgress();
    showToast('Results ready. AI Sort is now available.');
    logActivity(
      `Image verification complete: ${state.apiResults.length} result${state.apiResults.length === 1 ? '' : 's'}`,
      'success'
    );
  } catch (err) {
    hideImgProgress();
    showToast('API error: ' + err.message);
    logActivity('Image verification failed: ' + err.message, 'error');
    console.error('[SmartFill] Images pipeline failed:', err);
  } finally {
    state.isImagesProcessing = false;
    els.btnDescribe.disabled = false;
  }
}

/**
 * Open the results report in a new browser tab placed immediately to the
 * right of the user's current LC360 tab. The payload is stashed in
 * chrome.storage.local under a unique key whose name is passed as the URL
 * fragment - results.js picks it up on DOMContentLoaded and deletes the
 * entry so a refresh doesn't redraw stale data.
 *
 * Runs from the side panel context directly so MV3 service-worker tear-down
 * mid-async-flow can't interrupt the open.
 */
async function openResultsTab(resultsData) {
  const key = 'results:' + Date.now() + ':' + Math.random().toString(36).slice(2, 8);

  try {
    await chrome.storage.local.set({ [key]: resultsData });

    // Find the user's current tab so we can place the new one right after.
    // `currentWindow: true` is the side panel's containing window - i.e.
    // the same window the user is looking at.
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

    const createOpts = {
      url: chrome.runtime.getURL('results/results.html') + '#' + encodeURIComponent(key),
      active: true,
    };
    if (activeTab && typeof activeTab.index === 'number') {
      createOpts.index = activeTab.index + 1;
      createOpts.openerTabId = activeTab.id;
    }
    if (activeTab && typeof activeTab.windowId === 'number') {
      createOpts.windowId = activeTab.windowId;
    }

    await chrome.tabs.create(createOpts);
  } catch (err) {
    console.error('[SmartFill] Failed to open results tab:', err);
    showToast('Could not open results tab: ' + err.message);
    // Make sure the stashed payload doesn't leak if the tab open failed
    chrome.storage.local.remove(key).catch(() => { });
    throw err;
  }
}


/**
 * Ask the content script to fetch an image (so the page's session cookies
 * are sent), then reconstruct the Blob on this side. Returns { blob, type,
 * size } - matching the shape the old extension's pipeline expected.
 *
 * `targetTabId` pins the request to the LC360 tab captured when the user
 * started the operation. Without it, the service worker would route to
 * whichever tab the user is *currently* looking at, which fails the moment
 * they switch tabs mid-loop.
 */
function fetchImageBlob(imageUrl, targetTabId) {
  return new Promise((resolve, reject) => {
    const msg = { action: 'FETCH_IMAGE_BLOB', imageUrl };
    if (typeof targetTabId === 'number') msg.targetTabId = targetTabId;
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      if (!response || response.error) {
        return reject(new Error(response ? response.error : 'No response'));
      }

      // dataUrl → Blob (the content script handed us a base64 data URL because
      // raw Blobs can't be serialised across runtime.sendMessage).
      try {
        const commaIdx = response.dataUrl.indexOf(',');
        const byteString = atob(response.dataUrl.substring(commaIdx + 1));
        const mimeType = response.type || 'image/jpeg';
        const ab = new ArrayBuffer(byteString.length);
        const ia = new Uint8Array(ab);
        for (let j = 0; j < byteString.length; j++) ia[j] = byteString.charCodeAt(j);
        const blob = new Blob([ab], { type: mimeType });
        resolve({ blob, type: mimeType, size: response.size });
      } catch (err) {
        reject(new Error('Failed to decode image data: ' + err.message));
      }
    });
  });
}

// ── Image-pipeline progress UI ──────────────────────────────────────

function showImgProgress(label, count, current, total, detail) {
  els.imgProgressCard.style.display = 'block';
  updateImgProgress(label, count, current, total, detail);
}
function updateImgProgress(label, count, current, total, detail) {
  els.imgProgressLabel.textContent = label;
  els.imgProgressCount.textContent = count;
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  els.imgProgressBar.style.width = pct + '%';
  els.imgProgressDetail.textContent = detail;
}
function hideImgProgress() {
  els.imgProgressCard.style.display = 'none';
  els.imgProgressBar.style.width = '0%';
}

// ── Gallery rendering + filter ──────────────────────────────────────

function updateImgMeta(meta) {
  state.imgMeta = meta;
  els.metaSurvey.textContent = meta.surveyNumber || '-';
  els.metaInsured.textContent = meta.insuredName || '-';
  els.metaPolicy.textContent = meta.policyNumber || '-';
  els.imgMetaCard.style.display = 'block';
}

function renderGallery(images) {
  els.imgGallery.innerHTML = '';
  els.imgCount.textContent = images.length;

  images.forEach((img, idx) => {
    // `img.label` is the raw textbox value (possibly ""). We show
    // "(No label)" in the UI when it's empty, but never persist that
    // placeholder anywhere - so a later Restore writes "" back into the
    // input instead of the literal "(No label)" string.
    const displayLabel = labelForDisplay(img.label);

    // Does this photo have an AI result? Only then do we show the toggle
    // and the Original-vs-AI comparison.
    const hasAi = !!(state.apiResults &&
      Object.prototype.hasOwnProperty.call(state.aiLabelById, img.photoId));
    const choice = state.labelChoice[img.photoId] || 'original';

    const card = document.createElement('div');
    card.className = 'image-card';
    card.setAttribute('title', displayLabel);

    const idHtml = `<div class="card-id">${escapeHtml((img.photoId || '').substring(0, 18))}${img.photoId && img.photoId.length > 18 ? '…' : ''}</div>`;

    let infoHtml;
    if (hasAi) {
      // Show BOTH labels so the operator sees exactly what each choice
      // writes. The currently-selected one is highlighted.
      const origText = labelForDisplay(state.origLabelById[img.photoId]);
      const aiText = labelForDisplay(state.aiLabelById[img.photoId]);
      infoHtml = `
        <div class="card-info">
          <div class="label-compare">
            <div class="label-row ${choice === 'original' ? 'is-chosen' : ''}" data-role="row-original">
              <span class="label-tag tag-original">Original</span>
              <span class="label-val">${escapeHtml(origText)}</span>
            </div>
            <div class="label-row ${choice === 'ai' ? 'is-chosen' : ''}" data-role="row-ai">
              <span class="label-tag tag-ai">AI</span>
              <span class="label-val">${escapeHtml(aiText)}</span>
            </div>
          </div>
          ${idHtml}
        </div>
      `;
    } else {
      // No AI result yet → single current label, as before.
      infoHtml = `
        <div class="card-info">
          <div class="card-label">${escapeHtml(displayLabel)}</div>
          ${idHtml}
        </div>
      `;
    }

    const toggleHtml = hasAi ? `
      <div class="label-toggle" data-role="label-toggle" title="Choose which label to write on the page">
        <button class="lt-opt ${choice === 'original' ? 'is-active' : ''}" data-choice="original">Original</button>
        <button class="lt-opt ${choice === 'ai' ? 'is-active' : ''}" data-choice="ai">AI</button>
      </div>
    ` : '';

    card.innerHTML = `
      <span class="card-index">${idx + 1}</span>
      <div class="card-thumb" data-role="thumb" title="Click to open full resolution">
        <img src="${escapeHtml(img.thumbnailUrl)}" alt="${escapeHtml(displayLabel)}" loading="lazy" />
      </div>
      ${infoHtml}
      ${toggleHtml}
    `;

    // Clicking the mini image (thumbnail) opens the on-page modal (zoom/pan)
    // as a gallery of ALL photos in the current on-page order, starting at
    // this one. `images` is the array this render was given (filtered or
    // full), so the gallery matches exactly what's on screen.
    const thumb = card.querySelector('[data-role="thumb"]');
    if (thumb) {
      thumb.addEventListener('click', (e) => {
        e.stopPropagation();
        const gallery = images.map((im) => im.fullResUrl).filter(Boolean);
        // Resolve the start position by URL so it stays correct even if some
        // photo lacked a full-res URL and got filtered out above.
        const start = Math.max(0, gallery.indexOf(img.fullResUrl));
        openImageOnPage(gallery, start);
      });
    }

    // Per-image label toggle: flipping writes the chosen label to the page
    // immediately and updates the displayed label. Stops propagation so it
    // doesn't also trigger the focus-in-page click below.
    const toggle = card.querySelector('[data-role="label-toggle"]');
    if (toggle) {
      toggle.querySelectorAll('.lt-opt').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const newChoice = btn.dataset.choice; // 'ai' | 'original'
          if (state.labelChoice[img.photoId] === newChoice) return;
          setLabelChoice(img.photoId, newChoice, card);
        });
      });
    }

    // Clicking anywhere else on the card scrolls the matching photo block
    // into the center of the page and flashes a highlight on it - the same
    // behavior as clicking a question card in the Core Revised flow.
    card.addEventListener('click', () => {
      focusImageInPage(img.photoId);
    });

    els.imgGallery.appendChild(card);
  });
}

/**
 * Flip a single photo's label choice ('ai' | 'original'), write the chosen
 * label to the page input via the content script, and update the card UI in
 * place (toggle highlight + displayed label). The choice persists in
 * state.labelChoice so it survives sort toggles.
 */
function setLabelChoice(photoId, choice, card) {
  state.labelChoice[photoId] = choice;
  const newLabel = (choice === 'ai')
    ? (state.aiLabelById[photoId] || '')
    : (state.origLabelById[photoId] || '');

  // Update toggle highlight + which comparison row is chosen (optimistic).
  if (card) {
    card.querySelectorAll('.lt-opt').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.choice === choice);
    });
    const rowOrig = card.querySelector('[data-role="row-original"]');
    const rowAi = card.querySelector('[data-role="row-ai"]');
    if (rowOrig) rowOrig.classList.toggle('is-chosen', choice === 'original');
    if (rowAi) rowAi.classList.toggle('is-chosen', choice === 'ai');
    // Fallback for the no-AI single-label layout (shouldn't occur here,
    // but keeps the function safe if called on a plain card).
    const labelEl = card.querySelector('.card-label');
    if (labelEl) labelEl.textContent = labelForDisplay(newLabel);
  }

  // Keep state.images in sync so re-renders (filter/sort) show the choice.
  const imgRef = state.images.find((i) => i.photoId === photoId);
  if (imgRef) imgRef.label = newLabel;

  chrome.runtime.sendMessage(
    { action: 'SET_IMAGE_LABEL', photoId, label: newLabel },
    (resp) => {
      if (chrome.runtime.lastError || !resp?.ok) {
        showToast('Could not update label on the page');
        return;
      }
      logActivity(`Label set to ${choice === 'ai' ? 'AI' : 'original'} for one photo`);
    }
  );
}

/**
 * Ask the content script to scroll the photo block (matching photoId) to
 * the center of the page and flash a highlight on it. Mirrors
 * focusQuestionInPage used by the form-review flow.
 */
function focusImageInPage(photoId) {
  if (!photoId) return;
  chrome.runtime.sendMessage({ action: 'FOCUS_IMAGE', photoId }, (resp) => {
    if (chrome.runtime.lastError) return;
    if (!resp?.ok) showToast('Could not locate that photo on the page');
  });
}

// UI-only display fallback. The underlying data keeps `label` raw (possibly
// empty) so writes back into the page input are correct.
function labelForDisplay(label) {
  const s = (label == null ? '' : String(label)).trim();
  return s === '' ? '(No label)' : s;
}

function filterImages() {
  const query = (els.imgSearch.value || '').toLowerCase().trim();
  if (!query) { renderGallery(state.images); return; }
  const filtered = state.images.filter((img) =>
    (img.label || '').toLowerCase().includes(query)
  );
  if (filtered.length === 0) {
    els.imgGallery.innerHTML = '<div class="no-filter-results">No images match your filter.</div>';
    els.imgCount.textContent = '0';
  } else {
    renderGallery(filtered);
  }
}

function copyToClipboard(text, toastMsg) {
  navigator.clipboard.writeText(text)
    .then(() => showToast(toastMsg || 'Copied'))
    .catch(() => showToast('Copy failed'));
}

// Image subsystem event wiring
els.btnDescribe.addEventListener('click', displayDescriptions);
els.btnSortOrig.addEventListener('click', () => {
  if (state.isImagesProcessing) return;
  applyOriginalSort();
});
els.btnSortApi.addEventListener('click', () => {
  if (state.isImagesProcessing || !state.apiResults) return;
  applyApiSort();
});
els.imgSearch.addEventListener('input', filterImages);

// ═════════════════════════════════════════════════════════════════════
// 10. Activity log rendering
// ═════════════════════════════════════════════════════════════════════

function renderActivity() {
  if (state.activity.length === 0) {
    els.activityList.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="1.6"
               stroke-linecap="round" stroke-linejoin="round">
            <rect x="4" y="3" width="16" height="18" rx="2"/>
            <line x1="8" y1="8" x2="16" y2="8"/>
            <line x1="8" y1="12" x2="16" y2="12"/>
            <line x1="8" y1="16" x2="13" y2="16"/>
          </svg>
        </div>
        <p>No activity yet</p>
        <span>Events will appear here as you sync forms.</span>
      </div>`;
    return;
  }
  els.activityList.innerHTML = state.activity.map((a) => {
    const time = a.ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return `
      <div class="activity-item is-${a.level || 'info'}">
        <span class="activity-time">${time}</span>
        <span class="activity-message">${escapeHtml(a.message)}</span>
      </div>`;
  }).join('');
}

els.btnClearLog.addEventListener('click', () => {
  state.activity = [];
  renderActivity();
});

// ═════════════════════════════════════════════════════════════════════
// 10.1  Config: answer-block colour pickers
// ═════════════════════════════════════════════════════════════════════
//
// Three pickers let the user override the soft tint of the Page/Form,
// AI-suggestion (image), and Current answer blocks. The chosen colours
// are persisted to chrome.storage.local under `answerBlockColors` and
// applied immediately by overwriting the corresponding CSS custom
// properties on :root, so the suggestion queue retints live.

const DEFAULT_BLOCK_COLORS = {
  form: '#eef4ff',
  image: '#ede9fe',
  current: '#f8fafc',
};

const COLOR_VAR = {
  form: '--cfg-form-bg',
  image: '--cfg-image-bg',
  current: '--cfg-current-bg',
};

function applyBlockColor(target, value) {
  if (!value) return;
  document.documentElement.style.setProperty(COLOR_VAR[target], value);

  // Keep the swatch + picker visually in sync
  const swatch = { form: els.swatchForm, image: els.swatchImage, current: els.swatchCurrent }[target];
  if (swatch) swatch.style.background = value;

  const picker = { form: els.cfgColorForm, image: els.cfgColorImage, current: els.cfgColorCurrent }[target];
  if (picker && picker.value.toLowerCase() !== value.toLowerCase()) {
    picker.value = value;
  }
}

function persistBlockColors() {
  const colors = {
    form: els.cfgColorForm.value,
    image: els.cfgColorImage.value,
    current: els.cfgColorCurrent.value,
  };
  try {
    chrome.storage.local.set({ answerBlockColors: colors }).catch(() => { });
  } catch (_) { /* ignore - storage unavailable */ }
}

function initColorPickers() {
  if (!els.cfgColorForm) return;

  // Load persisted colours (fall back to defaults)
  try {
    chrome.storage.local.get('answerBlockColors').then((res) => {
      const saved = (res && res.answerBlockColors) || {};
      ['form', 'image', 'current'].forEach((k) => {
        const v = saved[k] || DEFAULT_BLOCK_COLORS[k];
        applyBlockColor(k, v);
      });
    }).catch(() => {
      ['form', 'image', 'current'].forEach((k) => applyBlockColor(k, DEFAULT_BLOCK_COLORS[k]));
    });
  } catch (_) {
    ['form', 'image', 'current'].forEach((k) => applyBlockColor(k, DEFAULT_BLOCK_COLORS[k]));
  }

  // Live preview on change + persist
  const wire = (picker, target) => {
    if (!picker) return;
    picker.addEventListener('input', () => applyBlockColor(target, picker.value));
    picker.addEventListener('change', () => { applyBlockColor(target, picker.value); persistBlockColors(); });
  };
  wire(els.cfgColorForm, 'form');
  wire(els.cfgColorImage, 'image');
  wire(els.cfgColorCurrent, 'current');

  // Reset buttons: per-row revert to default
  document.querySelectorAll('.color-reset').forEach((btn) => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.target;
      if (!t || !DEFAULT_BLOCK_COLORS[t]) return;
      applyBlockColor(t, DEFAULT_BLOCK_COLORS[t]);
      persistBlockColors();
    });
  });
}

// ═════════════════════════════════════════════════════════════════════
// 11. Bootstrap
// ═════════════════════════════════════════════════════════════════════

setRingProgress(0);
setConnection('idle', 'Idle');
setStatusBadge('IDLE', 'idle');
renderSupportedList();
initColorPickers();
requestDetection();
