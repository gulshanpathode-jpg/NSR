# Smart Fill - NSR LossControl360

**Version 4.0.0**

A Manifest V3 Chrome extension with an AI-assisted side panel for
LossControl360. The **Sync** tab hosts two related workflows in one place,
chosen automatically based on what the active page exposes:

1. **Form review** - for NSR LossControl360 inspection forms. Scrapes the
   open form, sends it to a backend for AI verification, and lets the
   inspector review each suggested change with **Accept / Reject /
   Reconsider** controls. Filters: **All / Different / Matched**. Clicking
   any card scrolls the page to that question and flashes it yellow.

2. **Order Photos** - for the LC360 *Order Photos* page (detected by the
   `.mainSectionHeaderLabel` containing "Order Photos"). Pulls every survey
   photo, fetches the full-resolution blobs (using the page's session
   cookies), sends them to an image-description backend, then renames +
   reorders the photos on-page to match the API result. A
   "Original / AI Sort" segmented control toggles between the two states
   in place. The result report opens immediately to the right of the active
   tab.

When a page exposes both capabilities, a mode strip appears at the top of
the Sync tab letting the user pick. Both flows share the Activity log,
detection card, toasts, and design system.

## Supported pages

Form detection is **case-type aware**. The page's `Utilant.CaseTypeName`
(scraped from an inline script) filters the form registry *before* header
matching, so a form scoped to one case type can never match a page of
another. Forms with no case-type scope are universal (e.g. General
Information, which behaves identically across case types apart from its
payload whitelist).

| Capability   | Host                                 | Case type (`Utilant.CaseTypeName`) | Header (`.mainSectionHeaderLabel`)        | Backend flow      |
|--------------|--------------------------------------|------------------------------------|-------------------------------------------|-------------------|
| Form review  | `natsr.losscontrol360.com`           | WKFC Property Standard             | `WKFC: Core Revised`                       | verify            |
| Form review  | `natsr.losscontrol360.com`           | WKFC Property Standard             | `WKFC Cover`                               | knowledge_base    |
| Form review  | `natsr.losscontrol360.com`           | WKFC Property Standard             | `General Information`                      | knowledge_base    |
| Form review  | `natsr.losscontrol360.com`           | Brownstone Interior Report         | `Brownstone Cover`                         | knowledge_base    |
| Form review  | `natsr.losscontrol360.com`           | Brownstone Interior Report         | `Brownstone Form 6.22.17`                  | verify            |
| Form review  | `natsr.losscontrol360.com`           | Brownstone Interior Report         | `General Information` (address only)       | knowledge_base    |
| Form review  | `natsr.losscontrol360.com`           | Condos - Property                  | `General Information` (address only)       | knowledge_base    |
| Form review  | `natsr.losscontrol360.com`           | Condos - Property                  | `Dual: Habitational Property Form`         | kb_then_verify    |
| Form review  | `natsr.losscontrol360.com`           | Abbreviated: Hab                   | `General Information` (address only)        | knowledge_base    |
| Form review  | `natsr.losscontrol360.com`           | Abbreviated: Hab                   | `CrossCover Cover for Abreviated`           | knowledge_base    |
| Form review  | `natsr.losscontrol360.com`           | Abbreviated: Hab                   | `CrossCover: Core`                          | verify            |
| Form review  | `natsr.losscontrol360.com`           | Abbreviated: Non-Hab               | `General Information` (address only)        | knowledge_base    |
| Form review  | `natsr.losscontrol360.com`           | Abbreviated: Non-Hab               | `CrossCover Cover for Abreviated`           | knowledge_base    |
| Form review  | `natsr.losscontrol360.com`           | Abbreviated: Non-Hab               | `NSR: CrossCover Pre Inspection Underwriting Property Information` | verify |
| Form review  | `natsr.losscontrol360.com`           | Hab Package - Exterior             | `Breckenridge Exterior Cover`               | knowledge_base    |
| Form review  | `natsr.losscontrol360.com`           | Hab Package - Exterior             | `Breckenridge: Exterior 2024`               | verify            |
| Form review  | `natsr.losscontrol360.com`           | Exterior only                      | `Brownstone: Exterior 11/2018`              | verify            |
| Form review  | `natsr.losscontrol360.com`           | Exterior only                      | `Brownstone Aerial Roof Assessment`         | verify            |
| Form review  | `natsr.losscontrol360.com`           | WKFC Property Renewal              | `WKFC Renewal Form`                         | verify            |
| Form review  | `natsr.losscontrol360.com`           | WKFC Property Renewal - Multi Building | `WKFC Renewal Form`                     | verify            |
| Order Photos | `*.losscontrol360.com/pages/cases/*` | (any)                              | `Order Photos` **and** an `#sortable` grid | image pipeline    |

Backend flows:

- **verify** - POST the full `items[]` to `/verify-direct`; drives the
  Accept / Reject / Reconsider queue.
- **knowledge_base** - POST `{ survey_no, page_type, data }` to `/knowledge`;
  one-shot save, no queue. `page_type` is `cover` or `general`.
- **kb_then_verify** - one button fires **two** sequential calls: first the
  cover `knowledge_base` save (`page_type: cover`), then - only if that
  succeeds - the standard `verify` call. If the cover save fails the whole
  flow aborts and the verify call never runs. Used by the Condos
  *Dual: Habitational Property Form*.

The side panel's "Unsupported page" card lists every registered form grouped
by case type, tags which group applies to the current page, flags the form
that matched the page header, and shows the case type the page reported (so
a page that is unsupported only because of a case-type mismatch is easy to
diagnose).

If nothing matches, the Sync tab shows an "Unsupported page" warning.

## Project structure

```
smart-fill-extension/
├── manifest.json
├── common/
│   └── forms.js              ← Form registry + URL → capability helpers
├── background/
│   └── background.js         ← MV3 service worker (API proxies, message router)
├── content/
│   ├── extractor.js          ← Scrape NSR DOM → structured JSON
│   ├── writer.js             ← Apply AI answers to form inputs
│   ├── highlighter.js        ← Smooth scroll + yellow flash
│   ├── images.js             ← Order Photos extraction + label sort
│   ├── imageModal.js         ← On-page full-res image modal (zoom + pan)
│   └── content.js            ← Page-side message router (both flows)
├── sidepanel/
│   ├── sidepanel.html        ← Single Sync tab with two sub-modes
│   ├── sidepanel.css         ← Light SaaS design system
│   └── sidepanel.js          ← Unified controller (form + images + shared)
├── results/
│   ├── results.html          ← Full-page light-theme results report
│   └── results.js            ← Renderer (reads payload from chrome.storage)
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## Installation (developer mode)

1. Unzip / copy this folder somewhere stable.
2. Open Chrome → `chrome://extensions/`
3. Toggle **Developer mode** in the top-right corner.
4. Click **Load unpacked** and select `smart-fill-extension/`.
5. Pin the extension icon to your toolbar.
6. Navigate to a supported LossControl360 page.
7. Click the extension icon → side panel opens on the right.
8. **Drag the panel's left edge** to roughly **40% of the viewport**. Chrome
   remembers the per-extension width after the first drag, so this is
   one-time setup.

## Side panel width

Chrome's side-panel API doesn't accept a fixed width - users resize the
panel by hand. The layout targets ~640px (≈40% of a 1600px display) and
holds up cleanly from 380px to 900+px:

- `body { min-width: 380px }` keeps the rail + main grid readable on narrow
  panels.
- All cards and the image gallery scale fluidly - no hard upper bound.

## Form-review workflow

1. **Open the side panel** on a supported NSR form. The detection card
   confirms which form was recognised.
2. **Click "Sync & Verify with AI"**. The panel shows a progress ring while
   the page is scraped, the data is POSTed to the backend, and the response
   is parsed.
3. **Review suggestions**. Each AI-proposed change renders as a card with
   the current form answer next to the AI's recommendation.
4. **Per-card actions**:
   - **Accept** - writes the AI answer into the form input on the page.
   - **Reject** - keeps the current form answer, marks the card as rejected.
   - **Reconsider** - re-opens the choice. If you had previously accepted,
     the form input is reverted first.
5. **Bulk actions**: *Accept all* / *Reject all* operate only on pending
   cards.
6. **Click any card body** (not a button) to scroll the page to that
   question and flash it yellow.
7. **Click a reference image** ("Image 1", "Image 2"…) on a card to open the
   full-resolution image viewer (see *Image viewer* below). Each question's
   reference photos open as their own gallery.

## Order Photos workflow

1. Navigate to a LossControl360 survey's **Order Photos** page (the one
   whose section header reads "Order Photos").
2. Open the side panel. The Sync tab auto-switches to the Order Photos
   sub-mode and triggers an extract. The detection card confirms the page
   and shows the photo count; survey metadata loads from the case-info
   header.
3. The gallery shows every photo with its current label.
   - **Search** filters by label.
   - **Refresh** re-extracts after manual changes.
   - **Copy labels** puts a numbered list on your clipboard.
   - **Click a thumbnail** to open the full-resolution image viewer (see
     *Image viewer* below) - it opens all photos as a gallery, starting at
     the one you clicked.
4. Click **Display Image Description**. The side panel:
   - fetches each photo's full-resolution blob through the content script
     (uses the page's session cookies),
   - hands the blobs to the service worker, which POSTs them to the
     image-verify backend,
   - immediately opens a results report in a **new tab placed directly to
     the right of the current tab**.
5. Back in the side panel, **AI Sort** becomes active. Click it to rename
   + reorder the photos on the LC360 page in place. **Original** restores
   the pre-sort state at any time.

## Image viewer

Both flows share an in-page, full-resolution image viewer. It renders **on
the LossControl360 page** (not in the side panel) because the image is served
from `photoHandler.ashx`, which needs the page's own session cookies - the
page is same-origin with that endpoint, so the image loads with no extra
authentication and no proxying.

- **Opening it**: click a reference image on a verify card, or a thumbnail on
  the Order Photos gallery. The viewer must open on the LC360 tab; if the
  active tab isn't an LC360 page, the panel shows a short "switch to the
  inspection tab" note instead.
- **Gallery scope**: verify opens just that question's reference photos;
  Order Photos opens every photo in the current on-page order. It always
  opens at the image you clicked.
- **Controls**: navigate with the **‹ ›** arrows or **← / →** keys; **zoom**
  with the scroll wheel or the **+ / −** buttons; **drag** to pan when zoomed
  in; **fit to screen** with the ⤢ button or the `0` key; **close** with the
  **✕** button, the **Esc** key, or by clicking the dim backdrop.

## Architecture notes

- **Manifest V3** service worker. The worker proxies the form-verify API
  call (mixed-content blocking forbids the page from talking to a plain-
  HTTP backend) and the multipart image-verify POST.
- **Side Panel API** (`chrome.sidePanel`) with
  `openPanelOnActionClick: true` - clicking the toolbar icon opens the panel
  on any page.
- **Single combined detection broadcast**: `PAGE_DETECTED` carries
  `{ form, images }` sub-detections in one round-trip. The side panel uses
  it to render the detection card AND to pick which Sync sub-mode to show.
- **Content scripts** are split into single-purpose modules. Each registers
  itself on `window.NSR_*` (e.g. `NSR_EXTRACTOR`, `NSR_IMAGES`) and is
  re-injected on demand by the service worker if the message bus fails.
- **Results tab handoff** uses `chrome.storage.local` keyed by a fragment
  in the new tab's URL - the renderer reads + deletes the entry on load.
  This eliminates the race where `results.html` mounts before its
  `runtime.onMessage` listener is wired up.
- **Tab placement**: when opening the results tab, the service worker uses
  `chrome.tabs.create({ index: sender.tab.index + 1, active: true })` so the
  new tab appears immediately to the right of the LC360 tab the user
  started from.

### Message contract

Side panel ↔ background ↔ content script:

| Action              | Flow                                            | Purpose                                            |
|---------------------|-------------------------------------------------|----------------------------------------------------|
| `REQUEST_DETECTION` | sidepanel → background                          | Ask for current-tab capability snapshot            |
| `PAGE_DETECTED`     | background → sidepanel                          | Broadcast `{ form, images }` capability snapshot   |
| `DETECT_PAGE`       | background → page                               | Pull combined capabilities (read DOM)              |
| `SCRAPE_AND_VERIFY` | sidepanel → background → page                   | Form: full pipeline (scrape + API + reply)         |
| `PIPELINE_PROGRESS` | background → sidepanel                          | Progress updates for the Sync ring                 |
| `APPLY_ANSWER`      | sidepanel → background → page                   | Form: apply one AI answer                          |
| `REVERT_ANSWER`     | sidepanel → background → page                   | Form: revert one answer (used by Reconsider)       |
| `FOCUS_QUESTION`    | sidepanel → background → page                   | Form: scroll + flash a specific question           |
| `EXTRACT_IMAGES`    | sidepanel → background → page                   | Photos: pull image metadata + URLs                 |
| `FETCH_IMAGE_BLOB`  | sidepanel → background → page                   | Photos: download one image as a data URL           |
| `APPLY_API_RESULTS` | sidepanel → background → page                   | Photos: rename + reorder photos on the page        |
| `RESTORE_IMAGES`    | sidepanel → background → page                   | Photos: undo back to original labels + order       |
| `SHOW_IMAGE_MODAL`  | sidepanel → background → page                   | Both: open a full-res image in the on-page modal   |

### Configuring the backends

Two backend URLs live in the codebase:

```js
// background/background.js - form-review pipeline (proxied via service worker
// because NSR is HTTPS and the backend is plain HTTP)
const VERIFY_API = 'http://164.52.205.183/verify-direct';

// sidepanel/sidepanel.js - image-verify pipeline (posted directly from the
// side panel as multipart FormData)
const IMAGES_API = 'http://164.52.205.183/pipeline';
```

Edit those constants and update `host_permissions` in `manifest.json` if
the host or scheme changes.

The image backend is expected to accept a `multipart/form-data` POST with:

- a `data` part - a JSON-stringified **array** (not an object) of
  `{ photoId, label, order }`, one entry per image in current on-page order
- a `files` part per successfully-fetched image - the JPEG blob with
  filename `<photoId>.jpg`

Example (conceptual):

```
POST /pipeline
Content-Type: multipart/form-data; boundary=…

--…
Content-Disposition: form-data; name="data"

[{"photoId":"abc","label":"Front of building","order":0}, …]
--…
Content-Disposition: form-data; name="files"; filename="abc.jpg"
Content-Type: image/jpeg

<JPEG bytes>
--…
```

It responds with:

```json
{
  "results": [
    {
      "photoId": "<id>",
      "originalLabel": "...",
      "verifiedLabel": "...",
      "isCorrect": true,
      "modelDescription": "..."
    }
  ]
}
```

## Troubleshooting

- **"Unsupported page" on a valid form / photo page.** Reload the page
  after installing the extension - content scripts only inject on pages
  loaded after install.
- **Sync or Display button does nothing.** Open DevTools on the *side
  panel* (right-click inside the panel → Inspect) and check the console.
- **"Content script unreachable".** The background worker tries to
  re-inject on demand, but pages that block `chrome.scripting` will fail.
  Reload the page.
- **Results tab opens blank.** Likely a `chrome.storage.local` permission
  issue. Make sure the `storage` permission is still in `manifest.json`
  (it is by default).
- **Image fetch fails with "HTTP 403".** The image backend requires
  session cookies. Stay logged into LC360 in the same browser session.
- **Highlight scrolls to the wrong question.** Happens if NSR re-renders
  the form and changes anchor names. Re-run Sync to rebuild the mapping.
- **Image viewer doesn't open / shows the "switch tab" note.** The viewer
  renders on the LC360 page, so the LC360 tab must be the active tab. Switch
  to it and click again. If it still fails, reload the page.

## Version history

### 4.0.0
- **On-page full-resolution image viewer (gallery).** Reference images
  (verify) and photo thumbnails (Order Photos) now open in an in-page viewer
  with zoom, pan, and prev/next navigation, instead of a new browser tab.
  Verify opens a per-question gallery; Order Photos opens all photos.
- **New supported case types:** Abbreviated: Hab, Abbreviated: Non-Hab,
  Hab Package - Exterior (Breckenridge Exterior Cover + Breckenridge:
  Exterior 2024; no General Information page for this case type), and
  Exterior only (Brownstone: Exterior 11/2018 + Brownstone Aerial Roof
  Assessment; both verify-only, no Cover or General Information page), and
  WKFC Property Renewal and WKFC Property Renewal - Multi Building (both use
  the WKFC Renewal Form; verify-only, no Cover or General Information page).
- **Bug fix:** reference/source images no longer disappear from the side
  panel after card repaints or tab switches.
- **Bug fix:** text-area answers are now captured correctly in the verify
  scrape (previously the hidden QA-note box was read instead, yielding an
  empty answer).
- **Bug fix:** a backend result or error no longer carries over to an
  unrelated page - the form output is tied to the page it ran on.
- Supported-forms list and the Order Photos Original/AI toggle restyled to
  match the extension's design system.

### 3.2.0
- Condos - Property support (General Information + the Dual: Habitational
  Property Form chained `kb_then_verify` flow); case-type-aware
  supported-forms list.
