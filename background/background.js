/**
 * background/background.js - Manifest V3 service worker.
 *
 * Responsibilities:
 *   1. Open the side panel when the action icon is clicked (any page).
 *   2. Track the active tab and broadcast page-detection updates so the side
 *      panel knows which capabilities (form / images) are available.
 *   3. Proxy the verify API call for the Sync pipeline. NSR is HTTPS but the
 *      AI backend is plain HTTP - mixed-content blocking forces this fetch
 *      to live in the service worker rather than the content script.
 *   4. Forward all per-tab action messages to the active content script,
 *      re-injecting it if necessary.
 *
 * Service workers can be restarted at any time - every handler must work
 * from a cold start. Don't rely on in-memory state surviving across messages.
 */

importScripts('/common/forms.js');

// ── Endpoints ────────────────────────────────────────────────────────
// VERIFY_API: AI form-review backend, used ONLY by the Core Revised flow.
//   Payload:  { survey_no, data: <items[]> }
//   Returns:  { result_id: "<id>", answers: [...] }
//             (legacy shapes - bare array, { answers }, { data } - still
//              accepted as a fallback for backward compatibility.)
// FEEDBACK_API: User feedback POSTed after the inspector reviews the AI
//             suggestions. Tied to a verify run via the result_id.
//   Payload:  { result_id, feedback: [ { questionId, questionText,
//             questionType, currentAnswer, formAnswer, imageAnswer,
//             answerSelected }, ... ] }
//   Returns:  200 → arbitrary acknowledgement body (we only inspect status).
// KB_API:    Knowledge-base ingest, used by the Cover and General Information
//           flows.
//   Payload:  { survey_no, page_type: "cover" | "general", data: {...} }
//   Returns:  200 → { status: "saved", survey_no, page_type }
//             400 → { detail: "page_type must be 'general' or 'cover'" }
//             404 → { detail: "No survey found for survey_no: ..." }
//
// The image-verify endpoint is owned by the side panel (see sidepanel.js
// IMAGES_API constant) - the multipart POST happens there because FormData
// can't cross the runtime.sendMessage boundary cleanly.
const VERIFY_API = 'https://qagent.dhaninfo.ai/verify-direct';
const FEEDBACK_API = 'https://qagent.dhaninfo.ai/feedback';
const KB_API = 'https://qagent.dhaninfo.ai/knowledge';
// const VERIFY_API   = 'http://164.52.196.182/verify-direct';
// const FEEDBACK_API = 'http://164.52.196.182/feedback';
// const KB_API       = 'http://164.52.196.182/knowledge';

// ── Side panel ────────────────────────────────────────────────────────

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error('[SmartFill] sidePanel setup failed:', err));

// ── Tab helpers ──────────────────────────────────────────────────────

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/**
 * Re-inject content scripts manually. Used as a recovery path when
 * sendMessage fails (typically right after install before the page is
 * reloaded, or after a tab navigation that didn't re-trigger the manifest
 * match).
 *
 * The file list is decided by the URL - NSR forms need the form-extraction
 * stack, image pages only need the image module. We attempt both lists in
 * order so the more thorough one runs on the right hosts.
 */
const FILES_FORM = [
  'common/forms.js',
  'content/extractor.js',
  'content/writer.js',
  'content/highlighter.js',
  'content/images.js',
  'content/imageModal.js',
  'content/content.js',
];
const FILES_IMAGES_ONLY = [
  'common/forms.js',
  'content/images.js',
  'content/imageModal.js',
  'content/content.js',
];

function pickInjectionFiles(url) {
  const caps = self.NSR_FORMS.capabilitiesForUrl(url);
  if (caps.form) return FILES_FORM;
  if (caps.images) return FILES_IMAGES_ONLY;
  return null;
}

async function injectContentScripts(tabId, url) {
  const files = pickInjectionFiles(url);
  if (!files) throw new Error('Page is not a LossControl360 page');
  await chrome.scripting.executeScript({ target: { tabId }, files });
  // Give the IIFEs a tick to register their window globals
  await new Promise((r) => setTimeout(r, 150));
}

/**
 * Send a message to a tab's content script, injecting first if needed.
 * Only attempts injection on LossControl360 URLs.
 */
async function sendToTab(tabId, url, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    try {
      await injectContentScripts(tabId, url);
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (err2) {
      throw new Error(err2.message || err.message || 'Content script unreachable');
    }
  }
}

// ── Page-detection broadcast ─────────────────────────────────────────

/**
 * Ask the active tab for its capability snapshot (form + images) and push
 * a PAGE_DETECTED message to any listening side panel. Called on tab change,
 * URL change, and on explicit side-panel request.
 *
 * If the tab isn't on LC360 at all, we short-circuit with host-level info
 * so the side panel can render its "Unsupported page" warning without
 * waiting on a content-script round-trip.
 */
async function broadcastPageDetection() {
  const tab = await getActiveTab();
  if (!tab) return;

  const caps = self.NSR_FORMS.capabilitiesForUrl(tab.url);
  let detection;

  if (!caps.form && !caps.images) {
    detection = {
      url: tab.url,
      title: tab.title,
      hostname: caps.hostname,
      form: { supported: false, reason: 'Not a LossControl360 page', hostname: caps.hostname },
      images: { supported: false, reason: 'Not a LossControl360 page', hostname: caps.hostname },
    };
  } else {
    try {
      detection = await sendToTab(tab.id, tab.url, { action: 'DETECT_PAGE' });
    } catch (err) {
      detection = {
        url: tab.url,
        title: tab.title,
        hostname: caps.hostname,
        form: { supported: false, reason: 'Content script unreachable' },
        images: { supported: false, reason: 'Content script unreachable' },
      };
    }
  }

  const payload = {
    action: 'PAGE_DETECTED',
    detection,
    tabId: tab.id,
    url: tab.url,
    title: tab.title,
  };
  chrome.runtime.sendMessage(payload).catch(() => {
    // No side panel listening - fine
  });
}

chrome.tabs.onActivated.addListener(broadcastPageDetection);
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  // Only on real navigation completion - avoid spamming the content script
  // for every minor "title changed" tick the SPA emits.
  if (changeInfo.status === 'complete') {
    broadcastPageDetection();
  }
});

// ── Verify API (Core Revised) ────────────────────────────────────────
//
// Backend now returns:   { result_id: "<id>", answers: [...] }
// We still accept legacy shapes (bare array, { answers }, { data }) so an
// older backend doesn't break the extension - result_id will just be empty.

async function callVerifyApi(surveyNumber, formItems, surveyType) {
  const payload = { survey_no: surveyNumber, survey_type: surveyType || '', data: formItems };

  const res = await fetch(VERIFY_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`API returned ${res.status}: ${text.substring(0, 300)}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    throw new Error('API response was not valid JSON');
  }

  // New shape: { result_id, answers: [...] }
  // Legacy shapes are tolerated so an older backend keeps working.
  const answers = Array.isArray(data) ? data : (data.answers || data.data || []);
  if (!Array.isArray(answers)) {
    throw new Error('API response missing answers array');
  }

  const resultId =
    (data && typeof data === 'object' && !Array.isArray(data))
      ? (data.result_id || data.resultId || '')
      : '';

  return { resultId, answers, raw: data };
}

// ── Feedback API ─────────────────────────────────────────────────────
//
// POSTs the inspector's review decisions back to the AI backend. The
// payload is gathered in the side panel and forwarded here so the fetch
// happens from the service-worker context (mixed-content reasons - same
// as VERIFY_API).
async function callFeedbackApi(payload) {
  let res;
  try {
    res = await fetch(FEEDBACK_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return { ok: false, status: 0, detail: err.message || 'Network request failed' };
  }

  const text = await res.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch (_) { body = { detail: text }; }
  }

  if (res.ok) {
    return { ok: true, status: res.status, raw: body };
  }
  return {
    ok: false,
    status: res.status,
    detail: (body && body.detail) || `HTTP ${res.status}`,
    raw: body,
  };
}

// ── Knowledge-base API (Cover, General Information) ─────────────────
//
// One-shot POST with the scraped data dict. The backend either saves the
// record (200) or rejects with a structured `detail` message (400 / 404).
// We don't throw on those - we return them so the side panel can surface
// the exact backend message in the UI instead of a generic "error".
async function callKnowledgeBaseApi(surveyNumber, pageType, data) {
  const payload = {
    survey_no: surveyNumber,
    page_type: pageType || '',
    data: data || {},
  };

  let res;
  try {
    res = await fetch(KB_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    // Network failure / CORS / DNS - no HTTP status to surface.
    return {
      ok: false,
      status: 0,
      kind: 'network',
      detail: err.message || 'Network request failed',
    };
  }

  const text = await res.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch (_) { body = { detail: text }; }
  }

  if (res.ok) {
    // Expected shape: { status: "saved", survey_no, page_type }
    return {
      ok: true,
      status: res.status,
      kind: 'saved',
      saved: (body && body.status) || 'saved',
      survey_no: (body && body.survey_no) || surveyNumber,
      page_type: (body && body.page_type) || pageType,
      raw: body,
    };
  }

  // 400 (validation, e.g. wrong page_type) or 404 (survey not in DB) etc.
  return {
    ok: false,
    status: res.status,
    kind: res.status === 404 ? 'not_found' : (res.status === 400 ? 'invalid' : 'error'),
    detail: (body && body.detail) || `HTTP ${res.status}`,
    raw: body,
  };
}

// ── Message router ──────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

  // ── Page-detection request from the side panel ───────────────────
  if (msg.action === 'REQUEST_DETECTION') {
    broadcastPageDetection();
    sendResponse({ ok: true });
    return false;
  }

  // ── Full Sync pipeline (NSR form) ────────────────────────────────
  if (msg.action === 'SCRAPE_AND_VERIFY') {
    (async () => {
      try {
        const tab = await getActiveTab();
        if (!tab?.id) throw new Error('No active tab');

        const detection = await sendToTab(tab.id, tab.url, { action: 'DETECT_FORM' });
        if (!detection?.supported) {
          throw new Error(`Unsupported page: ${detection?.reason || 'unknown'}`);
        }

        chrome.runtime.sendMessage({
          action: 'PIPELINE_PROGRESS',
          stage: 'scraping',
          progress: 15,
          message: 'Reading form…',
        }).catch(() => { });

        const scraped = await sendToTab(tab.id, tab.url, { action: 'SCRAPE' });
        if (!scraped?.success) throw new Error(scraped?.error || 'Scrape failed');

        const flow = scraped.flow
          || (detection.form && detection.form.flow)
          || 'verify';

        // ── Knowledge-base flow (Cover, General Information) ───────
        //   Send the {survey_no, page_type, data} payload to KB_API and
        //   surface the backend's status message verbatim. No Accept/Reject
        //   queue - the side panel will render a one-shot toast/banner.
        if (flow === 'knowledge_base') {
          const pageType = scraped.pageType
            || (detection.form && detection.form.pageType)
            || '';

          chrome.runtime.sendMessage({
            action: 'PIPELINE_PROGRESS',
            stage: 'uploading',
            progress: 55,
            message: 'Processing...',
            stats: scraped.stats,
          }).catch(() => { });

          const kbResult = await callKnowledgeBaseApi(
            scraped.surveyNumber,
            pageType,
            scraped.kbData || {}
          );

          sendResponse({
            success: true,
            form: detection.form,
            flow,
            kind: scraped.kind,
            pageType,
            surveyNumber: scraped.surveyNumber,
            stats: scraped.stats,
            // Pass the structured KB result through; the side panel decides
            // how to render saved / invalid / not_found / network / error.
            kbResult,
          });
          return;
        }

        // ── Chained flow: knowledge_base THEN verify (Dual form) ──────
        //   One button, two sequential calls:
        //     (1) the cover knowledge_base POST, then - only if it succeeds -
        //     (2) the standard verify POST that drives the Accept/Reject queue.
        //   If the cover call fails we abort: verify is never called and the
        //   side panel renders the same KB failure banners as the plain
        //   knowledge_base flow (carrying flow === 'kb_then_verify' so it
        //   knows the queue never arrived).
        if (flow === 'kb_then_verify') {
          const pageType = scraped.pageType
            || (detection.form && detection.form.pageType)
            || 'cover';

          // ── Leg 1: cover → knowledge base ──────────────────────
          chrome.runtime.sendMessage({
            action: 'PIPELINE_PROGRESS',
            stage: 'uploading',
            progress: 40,
            message: 'Saving cover to SmartFill…',
            stats: scraped.coverStats,
          }).catch(() => { });

          const kbResult = await callKnowledgeBaseApi(
            scraped.surveyNumber,
            pageType,
            scraped.kbData || {}
          );

          if (!kbResult.ok) {
            // Cover failed → abort. Do NOT run verify. Surface the KB error
            // exactly like the plain knowledge_base flow does.
            sendResponse({
              success: true,
              form: detection.form,
              flow,
              kind: scraped.kind,
              pageType,
              surveyNumber: scraped.surveyNumber,
              stats: scraped.coverStats,
              coverFailed: true,
              kbResult,
            });
            return;
          }

          // ── Leg 2: verify (only reached when cover saved OK) ────
          chrome.runtime.sendMessage({
            action: 'PIPELINE_PROGRESS',
            stage: 'uploading',
            progress: 70,
            message: 'Cover saved · verifying form…',
            stats: scraped.stats,
          }).catch(() => { });

          const verifyResultDual = await callVerifyApi(
            scraped.surveyNumber,
            scraped.items,
            scraped.surveyType
          );

          chrome.runtime.sendMessage({
            action: 'PIPELINE_PROGRESS',
            stage: 'analyzing',
            progress: 90,
            message: 'Matching AI answers to questions…',
          }).catch(() => { });

          sendResponse({
            success: true,
            form: detection.form,
            flow,
            kind: scraped.kind,
            surveyNumber: scraped.surveyNumber,
            surveyType: scraped.surveyType,
            pageType,
            // Cover leg result, so the panel can confirm the save happened.
            kbResult,
            // Verify leg - same shape as the plain verify flow so the queue
            // rendering path is reused unchanged.
            extracted: { sections: scraped.sections, stats: scraped.stats },
            aiAnswers: verifyResultDual.answers,
            resultId: verifyResultDual.resultId,
          });
          return;
        }

        // ── Verify flow (Core Revised) - unchanged from the original ──
        chrome.runtime.sendMessage({
          action: 'PIPELINE_PROGRESS',
          stage: 'uploading',
          progress: 55,
          message: 'Processing...',
          stats: scraped.stats,
        }).catch(() => { });

        const verifyResult = await callVerifyApi(
          scraped.surveyNumber,
          scraped.items,
          scraped.surveyType
        );

        chrome.runtime.sendMessage({
          action: 'PIPELINE_PROGRESS',
          stage: 'analyzing',
          progress: 90,
          message: 'Matching AI answers to questions…',
        }).catch(() => { });

        sendResponse({
          success: true,
          form: detection.form,
          flow,
          kind: scraped.kind,
          surveyNumber: scraped.surveyNumber,
          surveyType: scraped.surveyType,
          extracted: { sections: scraped.sections, stats: scraped.stats },
          aiAnswers: verifyResult.answers,
          resultId: verifyResult.resultId,
        });
      } catch (err) {
        console.error('[SmartFill] Sync pipeline failed:', err);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // async
  }

  // ── Send feedback to the AI backend ──────────────────────────────
  if (msg.action === 'SEND_FEEDBACK') {
    (async () => {
      try {
        const payload = msg.payload || {};
        const result = await callFeedbackApi(payload);
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, status: 0, detail: err.message || 'Unknown error' });
      }
    })();
    return true; // async
  }

  // ── Per-tab pass-through actions ─────────────────────────────────
  const PASS_THROUGH = [
    // Form actions
    'APPLY_ANSWER',
    'REVERT_ANSWER',
    'FOCUS_QUESTION',
    // Image actions
    'EXTRACT_IMAGES',
    'APPLY_API_RESULTS',
    'RESTORE_IMAGES',
    'FETCH_IMAGE_BLOB',
    'FOCUS_IMAGE',
    'SET_IMAGE_LABEL',
    'SET_IMAGE_LABELS_BULK',
    'DETECT_IMAGES',
    'DETECT_FORM',
    'DETECT_PAGE',
    // Shared on-page image modal (verify refs + Order Photos thumbs)
    'SHOW_IMAGE_MODAL',
    // Warm the on-page image cache so the modal opens instantly
    'PREFETCH_IMAGES',
  ];
  if (PASS_THROUGH.includes(msg.action)) {
    (async () => {
      try {
        // If the caller pinned a target tab (image fetch loops do this so
        // they don't break when the user switches tabs mid-run), use it.
        // Otherwise fall back to whichever tab is active right now.
        let tab;
        if (typeof msg.targetTabId === 'number') {
          tab = await chrome.tabs.get(msg.targetTabId).catch(() => null);
          if (!tab) throw new Error(`Pinned tab ${msg.targetTabId} no longer exists`);
        } else {
          tab = await getActiveTab();
          if (!tab?.id) throw new Error('No active tab');
        }
        const result = await sendToTab(tab.id, tab.url, msg);
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  return false;
});

console.log('[SmartFill] Service worker loaded');
