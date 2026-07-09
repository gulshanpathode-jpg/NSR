/**
 * content/extractor.js - Scrape NSR LossControl360 form into structured JSON.
 *
 * The page lays out questions as <tr> rows containing:
 *   - <td><div class="headerRow"> for section headers
 *   - <td><div class="headerText levelN"> for subsection headers
 *   - <td class="leftCol formQues">  (question label)
 *     <td class="rightCol formQues"> (input control)
 *
 * We return a flat array of items with type "header" | "subheader" | "question",
 * plus a derived "sections" array for the UI to render grouped.
 *
 * Each question is given a stable questionUid for matching against AI response
 * and for highlighting/scrolling back to.
 *
 * Public API: window.NSR_EXTRACTOR.extract()
 */

(() => {
  if (window.__NSR_EXTRACTOR_LOADED__) return;
  window.__NSR_EXTRACTOR_LOADED__ = true;

  // ── Visibility helpers ───────────────────────────────────────────

  function isHidden(el) {
    while (el && el !== document.body) {
      if (el.style && (el.style.display === 'none' || el.style.visibility === 'hidden')) {
        return true;
      }
      el = el.parentElement;
    }
    return false;
  }

  function isRowHidden(row) {
    if (isHidden(row)) return true;
    const tds = row.querySelectorAll(':scope > td');
    for (const td of tds) {
      if (td.style && (td.style.display === 'none' || td.style.visibility === 'hidden')) {
        return true;
      }
    }
    return false;
  }

  // ── Per-row extraction ───────────────────────────────────────────

  function extractQuestionFromRow(row) {
    const leftCol = row.querySelector('td.leftCol.formQues');
    const rightCol = row.querySelector('td.rightCol.formQues');
    if (!leftCol || !rightCol) return null;

    const labelSpan = leftCol.querySelector('span.ucLabel');
    const questionText = labelSpan ? labelSpan.textContent.trim() : '';

    // Anchor `<a name="...">` is NSR's stable identifier for jumping/scrolling
    const anchor = leftCol.querySelector('a[name]');
    const questionId = anchor ? anchor.getAttribute('name') : '';

    let inputType = 'unknown';
    let answer = null;
    let options;
    let inputElementId = '';

    // Every question row also contains a hidden "QA note" widget
    // (.QANoteContainer → a comment <input type="text"> + Save/Cancel
    // buttons). Those controls are NOT the question's answer - they're
    // reviewer-note boilerplate. We must skip them, otherwise the empty
    // QA-note text box gets picked up as the answer for textarea questions
    // (its <input type="text"> is matched before we ever reach the real
    // <textarea>). `pick()` returns only the real answer controls.
    const isNoteControl = (el) =>
      !!(el && el.closest('.QANoteContainer, .QANotediv, .InspectorNote'));
    const pick = (selector) =>
      Array.from(rightCol.querySelectorAll(selector)).filter((el) => !isNoteControl(el));

    // ── RADIO ──────────────────────────────────────────────────────
    const radios = pick('input[type="radio"]');
    if (radios.length > 0) {
      inputType = 'radio';
      options = [];
      let selectedValue = null;
      radios.forEach((radio) => {
        const label = rightCol.querySelector(`label[for="${radio.id}"]`);
        const labelText = label ? label.textContent.trim() : radio.value;
        const isChecked = radio.checked;
        options.push({
          id: radio.id,
          value: radio.value,
          label: labelText,
          selected: isChecked,
        });
        if (isChecked) selectedValue = labelText; // NSR backend keys on label
      });
      answer = selectedValue;
    }

    // ── CHECKBOX ───────────────────────────────────────────────────
    if (inputType === 'unknown') {
      const checkboxes = pick('input[type="checkbox"]');
      if (checkboxes.length > 0) {
        inputType = 'checkbox';
        options = [];
        const selectedLabels = [];
        checkboxes.forEach((cb) => {
          const label = rightCol.querySelector(`label[for="${cb.id}"]`);
          const labelText = label ? label.textContent.trim() : cb.value;
          options.push({
            id: cb.id,
            value: cb.value,
            label: labelText,
            selected: cb.checked,
          });
          if (cb.checked) selectedLabels.push(labelText);
        });
        answer = selectedLabels;
      }
    }

    // ── TEXT INPUT ─────────────────────────────────────────────────
    if (inputType === 'unknown') {
      const textInputs = pick('input[type="text"]');
      const textInput = textInputs.find((el) => el.classList.contains('text'))
                       || textInputs[0];
      if (textInput) {
        inputType = 'text';
        answer = textInput.value || '';
        inputElementId = textInput.id;
      }
    }

    // ── TEXTAREA ───────────────────────────────────────────────────
    if (inputType === 'unknown') {
      const textarea = pick('textarea')[0];
      if (textarea) {
        inputType = 'textarea';
        answer = textarea.value || textarea.textContent.trim() || '';
        inputElementId = textarea.id;
      }
    }

    // ── SELECT ─────────────────────────────────────────────────────
    if (inputType === 'unknown') {
      const select = pick('select')[0];
      if (select) {
        inputType = 'select';
        const selectedOption = select.options[select.selectedIndex];
        answer = selectedOption ? selectedOption.value : '';
        inputElementId = select.id;
        options = Array.from(select.options).map((opt) => ({
          id: select.id,
          value: opt.value,
          label: opt.textContent.trim(),
          selected: opt.selected,
        }));
      }
    }

    // No real input → not a question we can act on
    if (inputType === 'unknown') return null;

    return {
      type: 'question',
      questionId,
      questionText,
      inputType,
      answer,
      ...(options ? { options } : {}),
      ...(inputElementId ? { inputElementId } : {}),
    };
  }

  // ── Top-level orchestrator ───────────────────────────────────────

  function extract() {
    const items = [];
    const allRows = document.querySelectorAll('tr');

    for (const row of allRows) {
      if (isRowHidden(row)) continue;

      // HEADER
      const headerDiv = row.querySelector('td > div.headerRow');
      if (headerDiv) {
        items.push({ type: 'header', text: headerDiv.textContent.trim() });
        continue;
      }

      // SUBHEADER
      const subHeaderDiv = row.querySelector('td > div.headerText');
      if (subHeaderDiv) {
        const parentTd = subHeaderDiv.closest('td');
        const levelMatch = subHeaderDiv.className.match(/level(\d+)/);
        items.push({
          type: 'subheader',
          text: subHeaderDiv.textContent.trim(),
          id: parentTd ? parentTd.id : '',
          level: levelMatch ? parseInt(levelMatch[1], 10) : 0,
        });
        continue;
      }

      const q = extractQuestionFromRow(row);
      if (q) items.push(q);
    }

    // Build sections (UI-friendly grouped view) and assign stable questionUids.
    const sections = [];
    let currentHeader = null;
    let currentSubheader = '';
    let qCounter = 0;

    for (const item of items) {
      if (item.type === 'header') {
        currentHeader = { id: `sec_${sections.length}`, text: item.text, questions: [] };
        sections.push(currentHeader);
        currentSubheader = '';
        continue;
      }
      if (item.type === 'subheader') {
        currentSubheader = item.text;
        continue;
      }
      if (item.type === 'question') {
        // Ensure there's always a section (some pages have stray questions)
        if (!currentHeader) {
          currentHeader = { id: `sec_${sections.length}`, text: '(General)', questions: [] };
          sections.push(currentHeader);
        }
        // questionUid: prefer the NSR anchor name; fall back to a stable index key.
        const uid = item.questionId || `q_${qCounter++}`;
        const enriched = {
          ...item,
          questionUid: uid,
          subheader: currentSubheader,
          sectionId: currentHeader.id,
          sectionText: currentHeader.text,
        };
        currentHeader.questions.push(enriched);
      }
    }

    const totalQuestions = sections.reduce((n, s) => n + s.questions.length, 0);

    return {
      items,
      sections,
      stats: {
        sections: sections.length,
        questions: totalQuestions,
      },
      extractedAt: new Date().toISOString(),
      sourceUrl: window.location.href,
    };
  }

  // ── Survey number - used as identifier for the backend ──────────

  function extractSurveyNumber() {
    // 1. Page title (e.g. "Case #12345")
    const title = document.title || '';
    const titleMatch = title.match(/#(\d+)/);
    if (titleMatch) return titleMatch[1];

    // 2. Case detail section
    const detailItems = document.querySelectorAll('.caseinfo-detail-item');
    for (const item of detailItems) {
      const labelEl = item.querySelector('span');
      if (!labelEl) continue;
      const labelText = labelEl.textContent.trim().toLowerCase();
      if (!labelText.includes('survey')) continue;

      let value = '';
      item.childNodes.forEach((node) => {
        if (node !== labelEl && node.nodeType === Node.TEXT_NODE) {
          value += node.textContent;
        }
      });
      value = value.replace(/\u00a0/g, '').trim();
      if (value) return value;
    }

    // 3. URL params
    const params = new URLSearchParams(window.location.search);
    return (
      params.get('SurveyID') ||
      params.get('surveyid') ||
      params.get('survey') ||
      params.get('SurveyNumber') ||
      params.get('caseID') ||
      'UNKNOWN'
    );
  }

  // ── Generic Fields scrape (General Information page) ────────────
  //
  // The General Information view shows a "Generic Fields" header row followed
  // by 2-column key/value rows that look like:
  //
  //   <tr>
  //     <td class="leftCol"  style="font-weight: bold">ConstructionType:</td>
  //     <td class="rightCol">Frame</td>
  //     <td class="leftCol"  style="font-weight: bold">Control Number:</td>
  //     <td class="rightCol">2307661</td>
  //   </tr>
  //
  // Unlike the form view, leftCol/rightCol here do NOT carry the .formQues
  // class - they're plain display rows, not editable inputs. We pull only the
  // whitelisted fields the backend wants, returning a flat
  //   { ConstructionType: "Frame", ... }
  // object suitable as the `data` payload for page_type "General Information".
  //
  // Trailing ":" on the label is stripped before matching.

  const GENERIC_FIELDS_WHITELIST = [
    'ConstructionType',
    'NumberStories',
    'NumberOfBuildings',
    'RoofType',
    'Roofing',
    'Sprinklers',
    'YearBuilt',
    'Plumbing',
    'Wiring',
    'Heating',
    'Occupancy',
    'Address to be Inspected',
  ];

  function normalizeFieldKey(raw) {
    // Strip trailing colon and whitespace; collapse internal spaces.
    // The page label is "ConstructionType:" → "ConstructionType".
    return (raw || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/:$/, '')
      .trim();
  }

  function extractGenericFields(whitelist) {
    // Caller may pass a subset of page labels to capture (e.g. Brownstone GI
    // wants only "Address to be Inspected"). When omitted, the full default
    // GENERIC_FIELDS_WHITELIST is used (WKFC GI behaviour, unchanged).
    const activeWhitelist = (Array.isArray(whitelist) && whitelist.length)
      ? whitelist.filter(Boolean)
      : GENERIC_FIELDS_WHITELIST;

    // Seed the result with every whitelisted key so the payload shape is
    // stable even when the page is missing a field.
    const data = {};
    activeWhitelist.forEach((k) => {
      // The page label "Address to be Inspected" is emitted under the
      // shorter backend key "Address".
      const outKey = (k === 'Address to be Inspected') ? 'Address' : k;
      data[outKey] = '';
    });

    // Walk every td.leftCol on the page; pair with its immediate sibling
    // td.rightCol. The page can have multiple leftCol/rightCol pairs per
    // <tr>, so iterating cells is more robust than iterating rows.
    const leftCols = document.querySelectorAll('td.leftCol');
    leftCols.forEach((td) => {
      // Skip the form-question version of leftCol; we only want the plain
      // display rows from the Generic Fields table.
      if (td.classList.contains('formQues')) return;

      const key = normalizeFieldKey(td.textContent);
      if (!key || !activeWhitelist.includes(key)) return;

      // Find the next td.rightCol that is the value cell.
      let sib = td.nextElementSibling;
      while (sib && !(sib.tagName === 'TD' && sib.classList.contains('rightCol'))) {
        sib = sib.nextElementSibling;
      }
      if (!sib) return;

      if (key === 'Address to be Inspected') {
        // The address cell uses <br> to split street / city-state / etc. into
        // multiple lines. Flatten it to a SINGLE line: every <br> becomes a
        // space so a two- or three-line address reads "line1 line2 line3".
        // This single-line form is what the side panel shows AND what the
        // knowledge-base payload sends under `Address`.
        const value = (sib.innerHTML || '')
          .replace(/<br\s*\/?>/gi, ' ')    // <br>, <br/>, <BR> → space
          .replace(/<[^>]+>/g, '')         // strip any other stray tags
          .replace(/\u00a0/g, ' ')         // &nbsp; → space
          .replace(/\s+/g, ' ')            // collapse all whitespace to a space
          .trim();
        data['Address'] = value;
      } else {
        const value = (sib.textContent || '')
          .replace(/\u00a0/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        data[key] = value;
      }
    });

    const present = Object.keys(data).filter((k) => data[k] !== '').length;

    return {
      data,
      stats: {
        fields: activeWhitelist.length,
        present,
      },
      extractedAt: new Date().toISOString(),
      sourceUrl: window.location.href,
    };
  }

  // ── Cover-page row scrape (whitelist of <tr> labels) ────────────────
  //
  // The Cover page lays each question out as a single <tr> with two <td>s:
  //
  //   <tr>
  //     <td class="leftCol formQues">
  //       <span class="ucLabel">Construction:</span>
  //     </td>
  //     <td class="rightCol formQues">
  //       <textarea>Two story, ISO-1 wood frame building…</textarea>
  //       <!-- plus a hidden QANoteContainer we want to ignore -->
  //     </td>
  //   </tr>
  //
  // We walk every <tr>, take the first <td>'s label, strip the trailing
  // ":" and collapse whitespace, and end-to-end compare against the
  // caller-supplied whitelist. If it matches, we read the value from the
  // second <td> - and that's where the empty-value bug was hiding:
  //
  //   The page server-renders the saved text *between* <textarea> tags as
  //   the element's initial child text. The .value DOM property is only
  //   populated by the page's own JS, and on this form it's sometimes
  //   still empty when our scrape runs. So we read .value FIRST (catches
  //   the case where the user has been editing) and FALL BACK to the
  //   textarea's textContent (catches the freshly-loaded read-only case).
  //
  // Matching:
  //   · Special-cased for the Underwriter row, which on the page has a
  //     ~250-char instructional label that's flaky to compare verbatim
  //     (line breaks, double-spaces, etc.). For that one row we match on
  //     a stable prefix; everything else is exact end-to-end.
  //   · The QANoteContainer div inside the value cell is removed from a
  //     clone before reading textContent, so its "QANote / Save / Cancel"
  //     boilerplate never leaks into the captured value.
  //
  // Returns { data: { label: value, ... }, stats, extractedAt, sourceUrl }.
  // Every whitelisted label is present in `data`; missing rows come back
  // as empty strings so the payload shape is stable.

  function normalizeLabel(raw) {
    return (raw || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/:$/, '')
      .trim();
  }

  function readCellValue(td) {
    if (!td) return '';

    // Prefer a textarea - that's where Cover answers live.
    const textarea = td.querySelector('textarea');
    if (textarea) {
      // .value reflects live edits when the page JS has hydrated; the
      // initial child text is what the server rendered. Take whichever is
      // non-empty.
      const live = typeof textarea.value === 'string' ? textarea.value : '';
      if (live.trim() !== '') return live.trim();
      const initial = (textarea.textContent || '').trim();
      return initial;
    }

    // Plain text inputs (not used by the 5 Cover fields today, but covered
    // for completeness).
    const input = td.querySelector('input[type="text"]');
    if (input && typeof input.value === 'string') return input.value.trim();

    // Last resort: the cell's visible text minus the QA-note boilerplate.
    const clone = td.cloneNode(true);
    clone.querySelectorAll('.QANoteContainer, .QANotediv, .InspectorNote').forEach((n) => n.remove());
    return (clone.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function extractCoverFields(whitelist) {
    const raw = Array.isArray(whitelist) ? whitelist.filter(Boolean) : [];

    // The Underwriter row's full on-page label is much longer than the
    // whitelist entry (it includes instructional text). We accept a prefix
    // match for that one entry so the long label still resolves cleanly.
    const PREFIX_MATCH_KEYS = new Set([
      'Underwriter concerns / Inspection comments',
      // Brownstone Cover's single field. The on-page label includes helper
      // text ("Please include how the survey went…"), so prefix-match it.
      'Inspection Comments',
      // Condos "Dual: Habitational Property Form" cover sections. Each on-page
      // label carries a long instructional suffix after the section name
      // (e.g. "Operations & Occupancy Information Narrative: Please break out
      // how the units occupy each floor…"), so they are matched by the stable
      // leading section name with a boundary check. "Neighborhood & Area
      // Information Narrative" has no suffix and matches exactly via the same
      // prefix logic (labelLc === norm short-circuit).
      'Operations & Occupancy',
      'Building Information Narrative',
      'Common Hazards',
      'Other Hazards',
      'Protection/Security Information Narrative',
      'Neighborhood & Area Information Narrative',
    ]);

    // Normalize each whitelist entry to { match, key, prefix }:
    //   · String entry (legacy): the string is BOTH the on-page label to
    //     match AND the emitted dict key; prefix-matching is governed by the
    //     PREFIX_MATCH_KEYS set above.
    //   · Object entry { match, key, prefix }: lets the emitted key differ
    //     from the on-page label - needed when the label is a long
    //     instructional paragraph that you don't want as the dict key (e.g.
    //     Hab Package - Exterior's cover field, emitted as "additional
    //     information"). `key` defaults to `match`; `prefix` defaults to true
    //     for object entries (these labels are typically the long kind).
    const entries = raw.map((e) => {
      if (typeof e === 'string') {
        return { match: e, key: e, prefix: PREFIX_MATCH_KEYS.has(e) };
      }
      const match = e.match || e.key || '';
      return { match, key: e.key || match, prefix: e.prefix !== false };
    }).filter((e) => e.match);

    // Seed the result so every whitelisted field is always present in the
    // payload, even if the page didn't render that row.
    const data = {};
    entries.forEach((e) => { data[e.key] = ''; });

    // Build a lookup keyed by normalized lowercased label → emitted key.
    const exactByNorm = new Map();
    const prefixEntries = [];
    entries.forEach((e) => {
      const norm = normalizeLabel(e.match).toLowerCase();
      if (!norm) return;
      if (e.prefix) {
        prefixEntries.push({ emitKey: e.key, norm });
      } else {
        exactByNorm.set(norm, e.key);
      }
    });

    const rows = document.querySelectorAll('tr');
    rows.forEach((tr) => {
      // Find the first two <td> children directly under this tr. Nested
      // tables (rare on this page) could yield extra cells, so we use
      // children rather than querySelectorAll.
      const tds = Array.from(tr.children).filter((el) => el.tagName === 'TD');
      if (tds.length < 2) return;

      const labelTd = tds[0];
      const valueTd = tds[1];

      // The label cell wraps the text in <span class="ucLabel">; fall back
      // to the cell's textContent if that span isn't present.
      const labelSpan = labelTd.querySelector('.ucLabel');
      const rawLabelText = labelSpan ? labelSpan.textContent : labelTd.textContent;
      const label = normalizeLabel(rawLabelText);
      if (!label) return;
      const labelLc = label.toLowerCase();

      // Exact match wins; prefix match (for the long Underwriter row)
      // applies only if no exact entry hit. Exact match emits using the
      // user-supplied whitelist string (preserves their preferred casing).
      let emitKey = exactByNorm.get(labelLc);
      if (!emitKey) {
        const hit = prefixEntries.find((p) => {
          if (labelLc === p.norm) return true;
          if (labelLc.startsWith(p.norm)) {
            // Require a boundary character so "Construction" can't catch
            // a row labelled "ConstructionType".
            const next = labelLc.charAt(p.norm.length);
            return next === '' || next === ':' || /\s/.test(next);
          }
          return false;
        });
        if (hit) emitKey = hit.emitKey;
      }
      if (!emitKey) return;

      data[emitKey] = readCellValue(valueTd);
    });

    const present = Object.keys(data).filter((k) => data[k] !== '').length;

    return {
      data,
      stats: {
        fields: entries.length,
        present,
      },
      extractedAt: new Date().toISOString(),
      sourceUrl: window.location.href,
    };
  }

  // ── Standalone address scrape ──────────────────────────────────────
  // Returns just the inspection address ("Address to be Inspected", emitted
  // under the backend key "Address") from the General Information "Generic
  // Fields" display table, or '' if the page has no such row. Reuses
  // extractGenericFields so the <br>→space flattening (multi-line address →
  // single "line1 line2 line3" line) and matching stay in one place.
  //
  // This powers the side panel's universal address block (Copy / Google /
  // Google Maps), which appears on EVERY General Information page regardless of
  // case type - including case types whose GI page is NOT a supported Sync
  // target. It has no bearing on Sync gating, which still keys off the form
  // registry match.
  function extractAddress() {
    try {
      const out = extractGenericFields(['Address to be Inspected']);
      return (out && out.data && out.data.Address) || '';
    } catch (_) {
      return '';
    }
  }

  window.NSR_EXTRACTOR = { extract, extractSurveyNumber, extractGenericFields, extractCoverFields, extractAddress };
  console.log('[NSR] Extractor loaded');
})();
