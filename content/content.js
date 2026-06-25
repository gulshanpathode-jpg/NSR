/**
 * content/content.js - Message router running on LossControl360 pages.
 *
 * Handles two families of actions from the service worker:
 *
 *   Form (NSR) family - only meaningful on natsr.losscontrol360.com:
 *     · DETECT_FORM      - form detection from .mainSectionHeaderLabel
 *     · SCRAPE           - extract questions + survey number (NSR_EXTRACTOR)
 *     · APPLY_ANSWER     - write one AI answer to the DOM (NSR_WRITER)
 *     · REVERT_ANSWER    - undo a previously applied answer
 *     · FOCUS_QUESTION   - scroll + flash highlight on a question
 *
 *   Image (LC360) family - any *.losscontrol360.com case page:
 *     · DETECT_IMAGES    - is this an Order Photos page with images?
 *     · EXTRACT_IMAGES   - return image metadata + URLs
 *     · APPLY_API_RESULTS- rename + reorder photos to match API output
 *     · RESTORE_IMAGES   - undo back to original labels + order
 *     · FETCH_IMAGE_BLOB - fetch a full-res photo as a data URL
 *
 * DETECT_PAGE returns both capabilities at once so the side panel can render
 * its tab badges without two round-trips.
 *
 * Why network calls don't happen here (for NSR):
 *   NSR is HTTPS but the form-verify backend is plain HTTP. Mixed-content
 *   blocking forces that fetch to live in the service worker. Image fetches
 *   are same-origin (LC360 → LC360), so we keep them here to inherit the
 *   user's session cookies.
 */

(() => {
  if (window.__NSR_CONTENT_LOADED__) {
    console.log('[SmartFill] Content already loaded - skipping');
    return;
  }
  window.__NSR_CONTENT_LOADED__ = true;

  // ── Form detection (NSR) ───────────────────────────────────────────

  /**
   * Look at every `.mainSectionHeaderLabel` on the page and try to match its
   * text against a known form name. Case-insensitive, whitespace-tolerant.
   */
  function detectFormFromDom() {
    const hostname = window.location.hostname;
    if (hostname !== 'natsr.losscontrol360.com') {
      return { supported: false, reason: 'Not on NSR LossControl360', hostname };
    }

    const labels = document.querySelectorAll('.mainSectionHeaderLabel');
    if (labels.length === 0) {
      return { supported: false, reason: 'Form header not found on page' };
    }

    // Reuse the Order-Photos survey-type scraper. images.js is loaded on the
    // NSR form host too (see manifest content_scripts), so this is available
    // here without any new scraping code.
    const caseTypeName =
      (window.NSR_IMAGES && typeof window.NSR_IMAGES.extractCaseTypeName === 'function')
        ? window.NSR_IMAGES.extractCaseTypeName()
        : '';

    // Filter the registry by the active case type before header matching, so
    // a Brownstone page can't match a WKFC-only form (and vice-versa). When
    // the case type can't be scraped, formsForCaseType returns the full
    // registry → header-only matching, same as the prior behaviour.
    const FORMS = window.NSR_FORMS;
    const registry =
      FORMS && typeof FORMS.formsForCaseType === 'function'
        ? FORMS.formsForCaseType(caseTypeName)
        : ((FORMS && FORMS.SUPPORTED_FORMS) || []);

    for (const labelEl of labels) {
      const text = (labelEl.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;

      for (const form of registry) {
        const hint = (form.titleHint || form.name || '').toLowerCase();
        if (hint && text.toLowerCase().includes(hint)) {
          return { supported: true, form, matchedText: text, caseTypeName };
        }
      }
    }

    const firstLabelText = (labels[0].textContent || '').replace(/\s+/g, ' ').trim();
    return {
      supported: false,
      reason: 'Unsupported form',
      detectedHeader: firstLabelText,
      caseTypeName,
    };
  }

  /**
   * Combined page detection - returns both form and image capabilities so the
   * side panel can render its tab badges in one round-trip.
   */
  function detectPage() {
    const form = detectFormFromDom();
    const images = window.NSR_IMAGES
      ? window.NSR_IMAGES.detectImagesPage()
      : { supported: false, reason: 'Image module not loaded' };

    return {
      url: window.location.href,
      title: document.title,
      hostname: window.location.hostname,
      caseTypeName: (form && form.caseTypeName)
        || (images && images.meta && images.meta.surveyType)
        || '',
      form,
      images,
      hasFormQuestions: document.querySelectorAll('.formQues').length > 0,
    };
  }

  // ── Message router ─────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    try {
      switch (msg.action) {

        // ── Combined ────────────────────────────────────────────────
        case 'DETECT_PAGE': {
          sendResponse(detectPage());
          return false;
        }

        // ── Form (NSR) family ───────────────────────────────────────
        case 'DETECT_FORM': {
          const detection = detectFormFromDom();
          sendResponse({
            ...detection,
            hasFormQuestions: document.querySelectorAll('.formQues').length > 0,
            url: window.location.href,
          });
          return false;
        }

        case 'SCRAPE': {
          try {
            if (!window.NSR_EXTRACTOR) throw new Error('Extractor not loaded on this page');

            // Detect the page first so we know which backend flow + payload
            // shape to use. The detected form record carries `flow`, `kind`
            // and `pageType` from common/forms.js → SUPPORTED_FORMS.
            const detection = detectFormFromDom();
            if (!detection.supported) {
              sendResponse({ success: false, error: detection.reason || 'Unsupported page' });
              return false;
            }

            const surveyNumber = window.NSR_EXTRACTOR.extractSurveyNumber();
            const form = detection.form || {};
            const kind = form.kind || 'form';
            const flow = form.flow || 'verify';
            // Survey type (Utilant.CaseTypeName) from detection. Added to the
            // verify-flow request body; also returned for the UI's
            // "Detected Survey Type" display on every form page.
            const surveyType = detection.caseTypeName || '';

            // ── kind: "generic_fields" ─────────────────────────────
            //   Flat dict from the General Information "Generic Fields"
            //   display table. Knowledge-base flow.
            if (kind === 'generic_fields') {
              if (typeof window.NSR_EXTRACTOR.extractGenericFields !== 'function') {
                throw new Error('Generic-fields extractor not available');
              }
              const generic = window.NSR_EXTRACTOR.extractGenericFields(form.genericFields);
              sendResponse({
                success: true,
                surveyNumber,
                surveyType,
                form,
                flow,
                kind,
                pageType: form.pageType || '',
                kbData: generic.data,           // dict for knowledge_base payload
                stats: generic.stats,
                extractedAt: generic.extractedAt,
                sourceUrl: generic.sourceUrl,
              });
              return false;
            }

            // ── kind: "form_text_dict" ─────────────────────────────
            //   Cover page knowledge-base scrape. Delegates to the
            //   dedicated extractor.extractCoverFields(whitelist), which
            //   walks every <tr>, matches the first <td>'s label end-to-
            //   end against the whitelist, and pulls the value from the
            //   second <td>.
            //
            //   Crucially this reads the textarea's INITIAL textContent
            //   when .value is empty - the prior implementation went
            //   through extract() which only consulted .value, producing
            //   empty strings on freshly-loaded pages where the page's own
            //   JS hadn't hydrated the .value property yet.
            //
            //   `form.fields` declares the 5 labels to capture. The
            //   Underwriter row is matched on its short prefix (its full
            //   on-page label is a paragraph of instructional text).
            if (kind === 'form_text_dict') {
              if (typeof window.NSR_EXTRACTOR.extractCoverFields !== 'function') {
                throw new Error('Cover-fields extractor not available');
              }
              const cover = window.NSR_EXTRACTOR.extractCoverFields(form.fields || []);
              sendResponse({
                success: true,
                surveyNumber,
                surveyType,
                form,
                flow,
                kind,
                pageType: form.pageType || '',
                kbData: cover.data,
                stats: cover.stats,
                extractedAt: cover.extractedAt,
                sourceUrl: cover.sourceUrl,
              });
              return false;
            }

            // ── flow: "kb_then_verify" ─────────────────────────────
            //   Dual: Habitational Property Form. One scrape returns BOTH
            //   payloads the chained pipeline needs:
            //     · kbData       - the cover-section narratives, scraped the
            //                      same way as the Cover page
            //                      (extractCoverFields(coverFields)). Sent in
            //                      the FIRST (knowledge_base) call.
            //     · items/...    - the full standard extract() (spread below),
            //                      identical to the Core-Revised verify
            //                      payload. Sent in the SECOND (verify) call.
            //   The service worker runs the cover call first and only proceeds
            //   to verify if it succeeds.
            if (flow === 'kb_then_verify') {
              if (typeof window.NSR_EXTRACTOR.extractCoverFields !== 'function') {
                throw new Error('Cover-fields extractor not available');
              }
              const cover = window.NSR_EXTRACTOR.extractCoverFields(form.coverFields || []);
              const extractedDual = window.NSR_EXTRACTOR.extract();
              sendResponse({
                success: true,
                surveyNumber,
                surveyType,
                form,
                flow,
                kind,
                pageType: form.pageType || '',
                // Cover leg
                kbData: cover.data,
                coverStats: cover.stats,
                // Verify leg (items[], sections, stats, …)
                ...extractedDual,
              });
              return false;
            }

            // ── kind: "form" (default) ─────────────────────────────
            //   Original Core Revised path - unchanged. Verify flow.
            const extracted = window.NSR_EXTRACTOR.extract();
            sendResponse({
              success: true,
              surveyNumber,
              surveyType,
              form,
              flow,
              kind,
              ...extracted,
            });
          } catch (err) {
            console.error('[SmartFill] Scrape failed:', err);
            sendResponse({ success: false, error: err.message });
          }
          return false;
        }

        case 'APPLY_ANSWER': {
          (async () => {
            if (!window.NSR_WRITER) {
              sendResponse({ ok: false, error: 'Writer not loaded on this page' });
              return;
            }
            const r = await window.NSR_WRITER.applyAnswer(msg.question, msg.aiItem);
            if (r.ok && window.NSR_HIGHLIGHTER) {
              window.NSR_HIGHLIGHTER.focusQuestion(msg.question?.questionUid);
            }
            sendResponse(r);
          })();
          return true; // async response
        }

        case 'REVERT_ANSWER': {
          (async () => {
            if (!window.NSR_WRITER) {
              sendResponse({ ok: false, error: 'Writer not loaded on this page' });
              return;
            }
            const r = await window.NSR_WRITER.revertAnswer(msg.question);
            if (r.ok && window.NSR_HIGHLIGHTER) {
              window.NSR_HIGHLIGHTER.focusQuestion(msg.question?.questionUid);
            }
            sendResponse(r);
          })();
          return true;
        }

        case 'FOCUS_QUESTION': {
          const ok = window.NSR_HIGHLIGHTER
            ? window.NSR_HIGHLIGHTER.focusQuestion(msg.questionUid)
            : false;
          sendResponse({ ok });
          return false;
        }

        // ── Shared: on-page full-resolution image modal ─────────────
        //   Used by BOTH flows: the verify "source photos" links and the
        //   Order Photos thumbnails. The image loads with the page's own
        //   session cookies (same-origin photoHandler), so we just hand the
        //   URL to the modal module running on this page.
        case 'SHOW_IMAGE_MODAL': {
          if (!window.NSR_IMAGE_MODAL) {
            sendResponse({ ok: false, error: 'Image modal not loaded on this page' });
            return false;
          }
          // `images` is the gallery (array of URLs); `imageUrl` is the legacy
          // single-image form, still accepted. `index` is the start position.
          const gallery = Array.isArray(msg.images)
            ? msg.images
            : (msg.imageUrl ? [msg.imageUrl] : []);
          const ok = window.NSR_IMAGE_MODAL.show(gallery, msg.index || 0);
          sendResponse({ ok: !!ok, error: ok ? undefined : 'No image URL' });
          return false;
        }

        // ── Image (LC360) family ────────────────────────────────────
        case 'DETECT_IMAGES': {
          if (!window.NSR_IMAGES) {
            sendResponse({ supported: false, reason: 'Image module not loaded' });
          } else {
            sendResponse(window.NSR_IMAGES.detectImagesPage());
          }
          return false;
        }

        case 'EXTRACT_IMAGES': {
          if (!window.NSR_IMAGES) {
            sendResponse({ error: 'Image module not loaded' });
            return false;
          }
          sendResponse(window.NSR_IMAGES.extract());
          return false;
        }

        case 'APPLY_API_RESULTS': {
          if (!window.NSR_IMAGES) {
            sendResponse({ ok: false, error: 'Image module not loaded' });
            return false;
          }
          sendResponse(window.NSR_IMAGES.applyApiResults(msg.results || [], msg.labelMap || null));
          return false;
        }

        case 'RESTORE_IMAGES': {
          if (!window.NSR_IMAGES) {
            sendResponse({ ok: false, error: 'Image module not loaded' });
            return false;
          }
          sendResponse(window.NSR_IMAGES.restoreOriginal(msg.labelMap || null));
          return false;
        }

        case 'SET_IMAGE_LABEL': {
          if (!window.NSR_IMAGES) {
            sendResponse({ ok: false, error: 'Image module not loaded' });
            return false;
          }
          sendResponse(window.NSR_IMAGES.setImageLabel(msg.photoId, msg.label));
          return false;
        }

        case 'SET_IMAGE_LABELS_BULK': {
          if (!window.NSR_IMAGES) {
            sendResponse({ ok: false, error: 'Image module not loaded' });
            return false;
          }
          sendResponse(window.NSR_IMAGES.applyLabelMap(msg.labelMap || {}));
          return false;
        }

        case 'FOCUS_IMAGE': {
          const ok = window.NSR_IMAGES
            ? window.NSR_IMAGES.focusImage(msg.photoId)
            : false;
          sendResponse({ ok });
          return false;
        }

        case 'FETCH_IMAGE_BLOB': {
          if (!window.NSR_IMAGES) {
            sendResponse({ error: 'Image module not loaded' });
            return false;
          }
          window.NSR_IMAGES.fetchImageBlob(msg.imageUrl)
            .then((res) => sendResponse(res))
            .catch((err) => sendResponse({ error: 'Fetch failed: ' + err.message }));
          return true; // async response
        }

        default:
          return false;
      }
    } catch (err) {
      console.error('[SmartFill] Content handler error:', err);
      sendResponse({ success: false, error: err.message });
      return false;
    }
  });

  console.log('[SmartFill] Content script ready');
})();
