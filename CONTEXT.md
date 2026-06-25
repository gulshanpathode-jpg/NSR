# SmartFill NSR QA - Engineering Context / Handoff

**Extension version: 4.0.0** (see `manifest.json` and the README version
history; bump both when shipping a release).

This file is a self-contained brief for anyone (human or AI) picking up this
Chrome extension cold. It explains the architecture, the form registry, every
backend flow, and the most recent changes, so the folder can be handed to a
fresh conversation without re-deriving how things fit together.

Read this alongside `README.md` (user-facing workflows) and the inline
comments in each source file (the deepest detail lives there).

---

## 1. What the extension does

A Manifest V3 Chrome extension with an AI-assisted **side panel** for
LossControl360. One **Sync** tab hosts two workflows, auto-selected from what
the active page exposes:

1. **Form review** - on `natsr.losscontrol360.com` inspection forms. Scrapes
   the open form and routes it to one of three backend flows (see §4). The
   `verify` flow returns AI suggestions reviewed via Accept / Reject /
   Reconsider; the `knowledge_base` flow is a one-shot save; the
   `kb_then_verify` flow chains a save then a review.
2. **Order Photos** - on any `*.losscontrol360.com/pages/cases/*` page whose
   header reads "Order Photos" and which renders a `#sortable` grid. Pulls
   photos, sends them to an image backend, renames + reorders on-page.

The two workflows share the Activity log, detection card, toasts, and design
system.

---

## 2. File map

```
SmartFill NSR QA/
├── manifest.json              MV3 manifest. content_scripts + host_permissions.
├── common/
│   └── forms.js               ★ Registry: case types + SUPPORTED_FORMS + URL helpers.
│                                Loaded in content script (window.NSR_FORMS),
│                                service worker (self.NSR_FORMS), AND now the
│                                side panel (for the supported-forms list).
├── background/
│   └── background.js          MV3 service worker. API proxies + message router +
│                                the SCRAPE_AND_VERIFY pipeline (incl. chaining).
├── content/
│   ├── extractor.js           ★ Scrape NSR DOM. extract(), extractGenericFields(),
│   │                            extractCoverFields(), extractSurveyNumber().
│   ├── writer.js              Apply / revert AI answers to form inputs (verify flow).
│   ├── highlighter.js         Smooth scroll + yellow flash on a question.
│   ├── images.js              Order Photos extract + label sort + case-type scrape.
│   ├── imageModal.js          On-page full-res image modal (zoom + pan). Shared
│   │                            by verify refs + Order Photos thumbs.
│   └── content.js             ★ Page-side message router + form detection.
├── sidepanel/
│   ├── sidepanel.html         Single Sync tab; loads forms.js THEN sidepanel.js.
│   ├── sidepanel.css          Design system (incl. supported-forms list styles).
│   └── sidepanel.js           ★ Controller: detection render, pipeline, queue,
│                                supported-forms list, feedback.
├── results/                   Full-page image-results report (Order Photos).
├── icons/
├── README.md                  User-facing workflows + supported-pages table.
└── CONTEXT.md                 (this file)
```

★ = the files most relevant to form support / the recent changes.

---

## 3. The form registry (`common/forms.js`)

Single source of truth for which pages are supported. Two capabilities are
tracked independently: **form** (NSR forms) and **images** (Order Photos).

### Case types

`CASE_TYPES` maps short keys to the exact `Utilant.CaseTypeName` strings the
page reports (whitespace-collapsed):

```
WKFC                 = 'WKFC Property Standard'
WKFC_RENEWAL         = 'WKFC Property Renewal'
WKFC_RENEWAL_MULTI   = 'WKFC Property Renewal - Multi Building'
BROWNSTONE           = 'Brownstone Interior Report'
CONDOS               = 'Condos - Property'
ABBREVIATED_HAB      = 'Abbreviated: Hab'
ABBREVIATED_NON_HAB  = 'Abbreviated: Non-Hab'
HAB_PACKAGE_EXTERIOR = 'Hab Package - Exterior'
EXTERIOR_ONLY        = 'Exterior only'
```

### `SUPPORTED_FORMS` entry shape

| Field          | Meaning                                                                 |
|----------------|-------------------------------------------------------------------------|
| `formId`       | Stable id (free-form string).                                           |
| `name`         | Display name.                                                           |
| `titleHint`    | Substring matched (case-insensitively) against `.mainSectionHeaderLabel`.|
| `flow`         | `verify` \| `knowledge_base` \| `kb_then_verify` (see §4).              |
| `pageType`     | `cover` \| `general` for the KB call. Backend rejects anything else.    |
| `kind`         | How the scrape builds `data`: `form` \| `form_text_dict` \| `generic_fields`. |
| `caseTypes`    | Optional array. Omit = universal (valid for every case type).          |
| `fields`       | (Cover, `form_text_dict`) whitelist of cover labels to capture.        |
| `coverFields`  | (`kb_then_verify`) whitelist of cover-section labels for the KB leg.   |
| `genericFields`| (`generic_fields`) whitelist of display-row labels to capture.         |

### Case-type filtering

`formsForCaseType(caseTypeName)` returns the subset valid for a case type.
Entries with no `caseTypes` are always included. An empty/unknown case type
returns the **full** registry so detection degrades to header-only matching
(no regression when the case type can't be scraped).

**This is the most common reason a known form shows "Unsupported":** the page
reports a case type that doesn't include that form. The side panel surfaces
the reported case type in the warning to make this obvious.

### Current registry contents

- **WKFC Property Standard**: `WKFC: Core Revised` (verify), `WKFC Cover`
  (knowledge_base/cover), `General Information` (knowledge_base/general, full
  generic-fields whitelist).
- **Brownstone Interior Report**: `Brownstone Cover` (knowledge_base/cover,
  single Inspection-Comments field), `Brownstone Form 6.22.17` (verify),
  `General Information` (knowledge_base/general, **address only**).
- **Condos - Property**: `General Information` (knowledge_base/general,
  **address only**), `Dual: Habitational Property Form`
  (**kb_then_verify**, cover-section narratives then full verify).
- **Abbreviated: Hab**: `General Information` (knowledge_base/general,
  **address only**), `CrossCover Cover for Abreviated`
  (knowledge_base/cover, single field `Review of occupancy and
  construction`), `CrossCover: Core` (verify). Modelled on WKFC's separate
  Cover + Core pages, not the Condos chained flow.
- **Abbreviated: Non-Hab**: same three-form shape as Hab -
  `General Information` (knowledge_base/general, **address only**),
  `CrossCover Cover for Abreviated` (knowledge_base/cover, single field
  `Review of occupancy and construction`, identical to Hab), and the verify
  page `NSR: CrossCover Pre Inspection Underwriting Property Information`
  (verify). Only the verify header differs from Hab.
- **Hab Package - Exterior**: `Breckenridge Exterior Cover`
  (knowledge_base/cover, single object-form field whose key is
  `additional information`), `Breckenridge: Exterior 2024` (verify). Separate
  Cover + verify pages (WKFC/Abbreviated pattern). **No General Information
  page** for this case type.
- **Exterior only**: `Brownstone: Exterior 11/2018` (verify) and
  `Brownstone Aerial Roof Assessment` (verify). **Both verify-only** - no
  Cover or General Information page is supported for this case type. Every
  entry reuses the standard Core-Revised `verify`/`form` flow, so no
  extractor/background/sidepanel changes were needed.
- **WKFC Property Renewal** / **WKFC Property Renewal - Multi Building**:
  `WKFC Renewal Form` (verify). **Verify-only** - no Cover or General
  Information page is supported for these case types. A single registry entry
  carries both case types in its `caseTypes` array (same header, same flow).
  Reuses the standard Core-Revised `verify`/`form` flow, so no
  extractor/background/sidepanel changes were needed.

---

## 4. Backend flows

Backends live in `background/background.js` (currently pointed at
`https://qagent.dhaninfo.ai`; old HTTP IPs are commented out):

```
VERIFY_API   = …/verify-direct   POST { survey_no, survey_type, data:<items[]> } → { result_id, answers[] }
KB_API       = …/knowledge       POST { survey_no, page_type, data:{} }          → { status:"saved", … } | 400/404 { detail }
FEEDBACK_API = …/feedback        POST { result_id, feedback[] }                  → 200
```
(The Order Photos image pipeline is posted directly from the side panel as
multipart FormData - see `IMAGES_API` in `sidepanel.js`.)

### `verify`
Standard Core-Revised path. `extract()` builds `items[]`; POST to VERIFY_API;
the response drives the Accept / Reject queue. Unchanged baseline behaviour.

### `knowledge_base`
Cover and General Information. The scrape builds a flat `data` dict
(`form_text_dict` via `extractCoverFields`, or `generic_fields` via
`extractGenericFields`); POST `{ survey_no, page_type, data }` to KB_API. No
queue - the side panel renders a saved/invalid/not-found/network banner from
the structured result.

### `kb_then_verify`  (NEW - Condos Dual form)
**One button, two sequential calls.** Implemented in the SCRAPE_AND_VERIFY
handler in `background.js`:

1. The page scrape (`content.js`, `flow === 'kb_then_verify'`) returns BOTH:
   - `kbData` - the cover-section narratives, scraped with
     `extractCoverFields(form.coverFields)` (same machinery as Cover).
   - the full standard `extract()` (`items`, `sections`, `stats`) for the
     verify leg.
2. Background runs **leg 1**: `callKnowledgeBaseApi(survey, 'cover', kbData)`.
   - If it **fails** → respond with `{ coverFailed: true, kbResult }` and
     **stop**. The verify call never runs. The side panel shows the KB
     failure banner ("Cover rejected - verify skipped", etc.).
   - If it **succeeds** → run **leg 2**: `callVerifyApi(survey, items,
     survey_type)`, then respond with the verify queue payload (plus the
     `kbResult` so the panel can log "Cover saved").
3. The side panel button keeps the label **"Sync & Verify with AI"** for this
   flow, so the single click triggers both actions.

---

## 5. How scraping works (`content/extractor.js`)

- **`extract()`** - the full form scrape. Walks every `<tr>`, classifies rows
  as header / subheader / question, reads radio/checkbox/text/textarea/select
  inputs, assigns a stable `questionUid` (the NSR `<a name>` anchor). Produces
  `items[]` + grouped `sections[]`. Used by the `verify` leg.

- **`extractGenericFields(whitelist)`** - General Information "Generic Fields"
  display table. Pulls whitelisted `td.leftCol` → `td.rightCol` key/value
  pairs. The label `Address to be Inspected` is emitted under the backend key
  `Address`, with `<br>` converted to a newline. Brownstone & Condos GI pass
  `['Address to be Inspected']` to get an address-only payload.

- **`extractCoverFields(whitelist)`** - Cover / Dual cover-section scrape.
  Walks every `<tr>`, matches the first `<td>`'s `.ucLabel` against the
  whitelist, reads the value from the second `<td>` (prefers `<textarea>.value`,
  falls back to its initial `textContent` for freshly-loaded read-only pages),
  and strips the `QANoteContainer` boilerplate.
  - Matching is **exact** by default, or **prefix** for entries in the
    `PREFIX_MATCH_KEYS` set (labels with long instructional suffixes). Prefix
    matches require a boundary char (`''`, `:`, or whitespace) after the
    prefix so `Common Hazards` can't catch `Common Hazards Extra`.
  - A whitelist entry may be a plain string (the string is both the matched
    label and the emitted dict key) **or** an object
    `{ match, key, prefix }` when the emitted key must differ from the on-page
    label (e.g. Hab Package - Exterior's cover field, whose label is a long
    instructional paragraph but whose key is `additional information`).
    `prefix` defaults to `true` for object entries.
  - `PREFIX_MATCH_KEYS` currently holds: the WKFC Underwriter row, Brownstone
    `Inspection Comments`, and the six Condos Dual cover sections
    (`Operations & Occupancy`, `Building Information Narrative`,
    `Common Hazards`, `Other Hazards`,
    `Protection/Security Information Narrative`,
    `Neighborhood & Area Information Narrative`).

---

## 6. Detection + message flow

```
sidepanel → background: REQUEST_DETECTION
background → page:       DETECT_PAGE
page → background:       { form:{supported,form,caseTypeName,detectedHeader,…}, images:{…} }
background → sidepanel:  PAGE_DETECTED { detection, tabId, url, title }

(user clicks Sync & Verify with AI)
sidepanel → background:  SCRAPE_AND_VERIFY
background → page:       DETECT_FORM, then SCRAPE
background:              routes by flow (verify | knowledge_base | kb_then_verify)
background → sidepanel:  PIPELINE_PROGRESS (×N), then the final response
```

`detectFormFromDom()` in `content.js`:
1. scrape `Utilant.CaseTypeName` (via `NSR_IMAGES.extractCaseTypeName()`),
2. `formsForCaseType(caseType)` to filter the registry,
3. first form whose `titleHint` is a substring of a `.mainSectionHeaderLabel`
   wins. On a miss it returns `{ supported:false, reason:'Unsupported form',
   detectedHeader, caseTypeName }`.

---

## 7. Side panel "Supported page" UI (NEW)

`renderSupportedList(detection)` in `sidepanel.js` is now **registry-driven**
and **case-type-aware** (previously a hardcoded 4-item list):

- Reads `window.NSR_FORMS.SUPPORTED_FORMS` (forms.js is loaded before
  sidepanel.js in the HTML), so adding a form to the registry updates the
  panel automatically - no second edit.
- Groups forms by case type. The current page's case type is shown first and
  tagged **"this page"**; other case types are tagged **"other case type"**.
- Flags the form whose `titleHint` matched the page header with
  **"· detected here"**.
- Shows each form's flow in plain language (`FLOW_LABELS`).
- Adds a footer note stating the reported case type (or that it couldn't be
  read), which is the key diagnostic when a known form is gated out by case
  type.

The warning body also now appends the detected case type, e.g.
`Detected form header: "Dual: Habitational Property Form" (case type: "…") -
this is not in the supported list for this case type.`

CSS for this lives under `.warning-list` in `sidepanel.css`
(`.supported-group`, `.supported-form`, `.supported-group-tag`,
`.supported-note`).

---

## 8. Recent change log (most recent first)

-5. **WKFC Property Renewal - Multi Building support.** Added the
   `WKFC Property Renewal - Multi Building` case type and attached it to the
   existing `WKFC Renewal Form` registry entry (its `caseTypes` array now holds
   both `WKFC Property Renewal` and the multi-building variant). Same header,
   same verify flow - no new entry and no extractor/background/sidepanel
   changes. Order Photos is universal; `survey_type` flows through unchanged.
   (File: `forms.js`.)

-4. **WKFC Property Renewal support.** Added the `WKFC Property Renewal` case
   type (`Utilant.CaseTypeName === 'WKFC Property Renewal'`) and one registry
   entry in `common/forms.js` only - no extractor/background/sidepanel changes
   needed because the entry reuses the standard `verify`/`form` flow:
   - `WKFC Renewal Form` (verify). **Verify-only** - no Cover or General
     Information page is supported for this case type.
   Order Photos is universal, so it picks up this case type automatically;
   `survey_type` (`WKFC Property Renewal`) flows through unchanged in the
   verify payload.
   (File: `forms.js`.)

-3. **Exterior only support.** Added the `Exterior only` case type
   (`Utilant.CaseTypeName === 'Exterior only'`) and two registry entries in
   `common/forms.js` only - no extractor/background/sidepanel changes needed
   because both entries reuse the standard `verify`/`form` flow:
   - `Brownstone: Exterior 11/2018` (verify) and `Brownstone Aerial Roof
     Assessment` (verify). **Both verify-only** - no Cover or General
     Information page is supported for this case type.
   Order Photos is universal, so it picks up this case type automatically;
   `survey_type` (`Exterior only`) flows through unchanged.
   (File: `forms.js`.)

-2. **On-page image modal/gallery (verify + Order Photos).** Clicking a verify
   "source photo" link or an Order Photos thumbnail now opens the full-res
   image in a modal **on the LC360 page** (zoom via wheel/±, drag to pan,
   prev/next with ‹ › or ← →, counter, Esc/✕/backdrop to close) instead of a
   new browser tab. It's a **gallery**: Order Photos opens all photos in
   on-page order; a verify question opens just that question's reference
   photos - each starting at the clicked image. The modal lives on the page
   because photoHandler needs the page's session cookies (same-origin → no
   403, no blob fetch). New `content/imageModal.js`
   (`window.NSR_IMAGE_MODAL.show(images, startIndex)`); new `SHOW_IMAGE_MODAL`
   pass-through message (`{ images:[], index }`); side panel dispatches it to
   the active tab via `openImageOnPage(images, index)` and shows a "wrong
   page" toast if that tab isn't the LC360 page (no tab switching, no new-tab
   fallback). Verify refs became `<button>`s; a delegated click on
   `els.suggestionList` gathers each question's buttons into the gallery.
   (Files: `imageModal.js`, `content.js`, `background.js`, `manifest.json`,
   `sidepanel.js`, `sidepanel.css`.)

-1. **Hab Package - Exterior support.** Added the `Hab Package - Exterior`
   case type and two registry entries in `common/forms.js`, plus one small
   extractor enhancement:
   - `Breckenridge Exterior Cover` (knowledge_base/cover) and
     `Breckenridge: Exterior 2024` (verify). Separate Cover + verify pages
     (WKFC/Abbreviated pattern), not the Condos chained flow. **No General
     Information page** is supported for this case type.
   - The cover page has a **single** narrative field whose on-page label is a
     long instructional paragraph ("Provide a brief overview of the location
     …"). The backend wants the dict key to be `additional information`, which
     differs from the label - so `extractCoverFields` now accepts an **object
     entry** `{ match, key, prefix }` in a form's `fields`/`coverFields`
     (alongside the existing plain-string entries). `match` is the on-page
     label (prefix-matched here), `key` is the emitted dict key. The cover
     field is declared as
     `{ match: 'Provide a brief overview of the location', key: 'additional information', prefix: true }`.
   Order Photos is universal, so it picks up this case type automatically;
   `survey_type` (`Hab Package - Exterior`) flows through unchanged.
   (Files: `forms.js`, `extractor.js`.)

0. **Abbreviated: Hab / Non-Hab support.** Added two case types
   (`Abbreviated: Hab`, `Abbreviated: Non-Hab`) and five registry entries in
   `common/forms.js` only - no extractor/background/sidepanel changes were
   needed because every entry reuses an existing flow/kind:
   - Hab: GI (address-only `generic_fields`), `CrossCover Cover for Abreviated`
     (knowledge_base/cover, `form_text_dict`, single field
     `Review of occupancy and construction` - clean exact label, no
     `PREFIX_MATCH_KEYS` entry), `CrossCover: Core` (verify). Separate Cover +
     Core pages (WKFC pattern), not the Condos chained flow.
   - Non-Hab: GI (address-only), `CrossCover Cover for Abreviated`
     (knowledge_base/cover, same single field as Hab), and verify page
     `NSR: CrossCover Pre Inspection Underwriting Property Information`
     (verify). Same three-form shape as Hab; only the verify header differs.
   Order Photos is universal, so it picks up both case types automatically;
   `survey_type`/`page_type` flow through unchanged from the registry.
   (File: `forms.js`.)

1. **Case-type-aware supported-forms list.** `forms.js` now loads into the
   side panel; `renderSupportedList()` rewritten to be registry-driven and
   grouped by case type with applicability tags + a diagnostic note. Warning
   body surfaces the reported case type. New CSS. (Files: `sidepanel.html`,
   `sidepanel.js`, `sidepanel.css`.)

2. **Condos - Property support.** Added `CONDOS` case type and two registry
   entries: Condos General Information (address-only `generic_fields`) and the
   Condos `Dual: Habitational Property Form` (`kb_then_verify`). Added the six
   Dual cover-section labels to `PREFIX_MATCH_KEYS` in `extractor.js` (this was
   the one missing piece - without it the cover scrape returned empty values).
   Chained pipeline (cover save → abort-on-fail → verify) wired through
   `content.js`, `background.js`, `sidepanel.js`. (Files: `forms.js`,
   `extractor.js`, `content.js`, `background.js`, `sidepanel.js`.)

---

## 9. Gotchas / things to verify on a live page

- **Case type must match exactly.** `Utilant.CaseTypeName` must equal the
  registry string after whitespace collapse. If a Condos page reports a
  slightly different string, the Dual form is filtered out and shows
  "Unsupported". The warning note now reveals the actual reported value -
  check it first.
- **Reload after install.** Content scripts only inject on pages loaded after
  the extension is (re)loaded. A stale page → stale supported list. The
  screenshot showing only 3 supported forms is this: an older build/page.
- **Cover-section labels are matched by their leading section name.** If a
  live label's leading words differ from the whitelist (punctuation around
  `Protection/Security`, etc.), adjust that one string in `forms.js`
  `coverFields` and/or `PREFIX_MATCH_KEYS` in `extractor.js`.
- **kb_then_verify aborts on cover failure by design.** If the verify queue
  never appears for the Dual form, the cover save likely failed - check the
  banner / Activity log for the KB error.
- **Backends are HTTPS now** (`qagent.dhaninfo.ai`). If you revert to the
  plain-HTTP IPs, update both the constants in `background.js`/`sidepanel.js`
  AND `host_permissions` in `manifest.json`.

---

## 10. Quick test recipes

The scrapers are pure DOM functions and can be unit-tested with `jsdom`:

```js
// extractCoverFields against the Dual cover HTML → expect the 6 keys filled,
// QANote boilerplate stripped, empty sections as "".
// extractGenericFields(['Address to be Inspected']) → expect { Address }.
// formsForCaseType('Condos - Property') → expect Condos GI + Dual only.
// renderSupportedList({caseTypeName:'Condos - Property', form:{detectedHeader:'Dual…'}})
//   → Condos group first, Dual flagged "detected here".
```

(These were run during development and all passed; no test files are shipped
in the package.)
