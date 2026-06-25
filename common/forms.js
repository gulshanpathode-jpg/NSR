/**
 * common/forms.js - Page capability registry.
 *
 * Single source of truth for which LossControl360 pages this extension can act
 * on. Two independent capabilities are tracked:
 *
 *   · "form" - an NSR form on natsr.losscontrol360.com whose header matches one
 *     of SUPPORTED_FORMS. Drives the Sync tab (AI form review).
 *   · "images" - a LossControl360 "Order Photos" page (any host on
 *     losscontrol360.com under /pages/cases/*) whose .mainSectionHeaderLabel
 *     contains "Order Photos" and which renders a #sortable image grid.
 *     Drives the Sync tab's Order Photos sub-mode (label sort / API
 *     verification).
 *
 * Detection itself happens in content/content.js - this file only holds the
 * registry and a couple of host-level helpers so both the side panel and the
 * service worker can ask "could this URL possibly host capability X?" without
 * touching the DOM.
 *
 * Loaded in both the content script (attaches to window.NSR_FORMS) and the
 * service worker (attaches to self.NSR_FORMS).
 */

(function () {
  'use strict';

  // ── Supported NSR forms ─────────────────────────────────────────────
  // Order matters: titleHints are matched as substrings, so list the more
  // specific patterns first to avoid an accidental partial match.
  //
  // Each entry carries:
  //   · titleHint  - substring matched (case-insensitively) against the
  //                  page's .mainSectionHeaderLabel text.
  //   · flow       - which backend pipeline this page uses:
  //                    "verify"         → POST /verify-direct with the rich
  //                                       items[] payload, returns AI answers,
  //                                       drives the Accept/Reject queue.
  //                                       Used by WKFC: Core Revised.
  //                    "knowledge_base" → POST to the knowledge-base endpoint
  //                                       with { survey_no, page_type, data:{} }.
  //                                       No queue - just a status message
  //                                       from the response. Used by WKFC
  //                                       Cover and General Information.
  //                    "kb_then_verify" → TWO sequential calls from one button:
  //                                       (1) the knowledge_base POST (cover
  //                                           sections, page_type 'cover'), then
  //                                       (2) the verify POST (full items[]),
  //                                       which drives the Accept/Reject queue.
  //                                       The cover call MUST succeed first - if
  //                                       it fails the verify call is skipped and
  //                                       the whole flow aborts. Used by the
  //                                       Dual: Habitational Property Form.
  //                                       Carries BOTH a `coverFields` whitelist
  //                                       (for the cover scrape, like Cover's
  //                                       `fields`) and `pageType: 'cover'`.
  //   · pageType   - value sent as `page_type` for the knowledge_base flow.
  //                  Lowercase per the backend contract: must be 'cover' or
  //                  'general' (anything else → HTTP 400). Unused by the
  //                  verify flow.
  //   · kind       - how content/extractor.js builds the `data` payload:
  //                    "form"            → use extract() and items[] (verify flow)
  //                    "form_text_dict"  → use extract() but project items[]
  //                                        down to a flat {questionLabel: value}
  //                                        dict (Cover, knowledge_base flow)
  //                    "generic_fields"  → use extractGenericFields() to pull
  //                                        the whitelisted display rows
  //                                        (General Information, knowledge_base
  //                                        flow).
  // ── Case types ───────────────────────────────────────────────────
  // These strings must match Utilant.CaseTypeName verbatim (after whitespace
  // collapse). Detection filters the form registry by the active case type
  // before header matching, so a Brownstone page can never match a WKFC-only
  // form and vice-versa.
  const CASE_TYPES = {
    WKFC: 'WKFC Property Standard',
    WKFC_RENEWAL: 'WKFC Property Renewal',
    WKFC_RENEWAL_MULTI: 'WKFC Property Renewal - Multi Building',
    BROWNSTONE: 'Brownstone Interior Report',
    CONDOS: 'Condos - Property',
    ABBREVIATED_HAB: 'Abbreviated: Hab',
    ABBREVIATED_NON_HAB: 'Abbreviated: Non-Hab',
    HAB_PACKAGE_EXTERIOR: 'Hab Package - Exterior',
    EXTERIOR_ONLY: 'Exterior only',
  };

  // Each entry may carry an optional `caseTypes` array. An entry with no
  // `caseTypes` is *universal* - valid for every case type (e.g. General
  // Information, whose header and page_type are identical across case types).
  const SUPPORTED_FORMS = [
    // ── WKFC Property Standard set (behaviour unchanged) ──────────────
    {
      formId: '976feb9d-eafc-4b28-88ea-6c6cb97ee649',
      name: 'WKFC: Core Revised',
      shortName: 'WKFC Core Revised',
      titleHint: 'WKFC: Core Revised',
      flow: 'verify',
      kind: 'form',
      caseTypes: [CASE_TYPES.WKFC],
    },
    {
      formId: 'bc280e16-762c-4a02-b3b8-b0cd1bcd4019',
      name: 'WKFC Cover',
      shortName: 'WKFC Cover',
      titleHint: 'WKFC Cover',
      flow: 'knowledge_base',
      pageType: 'cover',
      kind: 'form_text_dict',
      caseTypes: [CASE_TYPES.WKFC],
      // Only these 5 questions are sent to the knowledge base. Each entry is
      // a *prefix* matched (case-insensitively, after trailing-colon strip
      // and whitespace collapse) against the page's question label. The
      // emitted dict key is the FULL original label (colon-stripped), not
      // the short prefix - the Underwriter row in particular has a very
      // long instructional label that the backend wants verbatim.
      fields: [
        'Construction',
        'Common / Special Hazards',
        'Protection',
        'Review Of Operations / Occupancy',
        'Underwriter concerns / Inspection comments',
      ],
    },

    // ── Brownstone Interior Report set ────────────────────────────────
    {
      formId: 'brownstone-cover',
      name: 'Brownstone Cover',
      shortName: 'Brownstone Cover',
      titleHint: 'Brownstone Cover',
      flow: 'knowledge_base',
      pageType: 'cover',
      kind: 'form_text_dict',
      caseTypes: [CASE_TYPES.BROWNSTONE],
      // Single field. The on-page label carries instructional helper text
      // ("Please include how the survey went…"), so it is matched by prefix
      // (see PREFIX_MATCH_KEYS in extractor.js). Emits:
      //   { "Inspection Comments": "<textarea text>" }
      fields: ['Inspection Comments'],
    },
    {
      formId: 'brownstone-form-6-22-17',
      name: 'Brownstone Form 6.22.17',
      shortName: 'Brownstone Form 6.22.17',
      titleHint: 'Brownstone Form 6.22.17',
      flow: 'verify',
      kind: 'form',
      caseTypes: [CASE_TYPES.BROWNSTONE],
    },
    {
      // Brownstone General Information: same flow / page_type / endpoint as
      // WKFC GI, but the payload is restricted to Address only. The
      // `genericFields` whitelist (page labels) is passed to
      // extractGenericFields(); "Address to be Inspected" is emitted as the
      // backend key "Address".
      formId: 'brownstone-general-information',
      name: 'General Information',
      shortName: 'Brownstone General Information',
      titleHint: 'General Information',
      flow: 'knowledge_base',
      pageType: 'general',
      kind: 'generic_fields',
      caseTypes: [CASE_TYPES.BROWNSTONE],
      genericFields: ['Address to be Inspected'],
    },

    // ── Condos - Property set ─────────────────────────────────────────
    {
      // Condos - Property General Information: identical flow / page_type /
      // endpoint to Brownstone GI - the payload is restricted to Address
      // only. The on-page label "Address to be Inspected" is emitted as the
      // backend key "Address" by extractGenericFields().
      formId: 'condos-general-information',
      name: 'General Information',
      shortName: 'Condos General Information',
      titleHint: 'General Information',
      flow: 'knowledge_base',
      pageType: 'general',
      kind: 'generic_fields',
      caseTypes: [CASE_TYPES.CONDOS],
      genericFields: ['Address to be Inspected'],
    },
    {
      // Condos - Property "Dual: Habitational Property Form". One button
      // fires two sequential backend calls (see flow: 'kb_then_verify'):
      //   (1) knowledge_base POST, page_type 'cover', with the cover-section
      //       narratives scraped from this page (coverFields whitelist).
      //   (2) verify POST with the full items[] payload (standard Core-Revised
      //       extract()), which drives the Accept/Reject queue.
      // The cover call must succeed before the verify call runs; if it fails
      // the whole flow aborts.
      //
      // NOTE: `coverFields` lists the on-page section labels to capture for
      // the cover call. They are matched the same way Cover's `fields` are
      // (exact/prefix, colon-stripped, whitespace-collapsed). The exact label
      // strings are pending the cover-page HTML and may need adjustment.
      formId: 'condos-dual-habitational-property',
      name: 'Dual: Habitational Property Form',
      shortName: 'Dual Habitational Property',
      titleHint: 'Dual: Habitational Property Form',
      flow: 'kb_then_verify',
      pageType: 'cover',
      kind: 'form',            // verify-leg payload uses the standard extract()
      caseTypes: [CASE_TYPES.CONDOS],
      coverFields: [
        'Operations & Occupancy',
        'Building Information Narrative',
        'Common Hazards',
        'Other Hazards',
        'Protection/Security Information Narrative',
        'Neighborhood & Area Information Narrative',
      ],
    },

    // ── Abbreviated: Hab set ──────────────────────────────────────────
    // Three separate forms, mirroring the WKFC pattern (independent Cover +
    // Core pages rather than the Condos chained kb_then_verify):
    //   · General Information (address-only, like Brownstone/Condos GI)
    //   · CrossCover cover page  → knowledge_base / page_type 'cover'
    //   · CrossCover: Core page  → verify (Accept/Reject queue)
    {
      formId: 'abbrev-hab-general-information',
      name: 'General Information',
      shortName: 'Abbreviated Hab General Information',
      titleHint: 'General Information',
      flow: 'knowledge_base',
      pageType: 'general',
      kind: 'generic_fields',
      caseTypes: [CASE_TYPES.ABBREVIATED_HAB],
      genericFields: ['Address to be Inspected'],
    },
    {
      // KB-cover page. Single narrative field. The on-page label
      // "Review of occupancy and construction" is a clean exact label
      // (no instructional suffix), so it resolves via extractCoverFields'
      // exact match - no PREFIX_MATCH_KEYS entry required.
      formId: 'abbrev-hab-crosscover-cover',
      name: 'CrossCover Cover for Abreviated',
      shortName: 'CrossCover Cover (Hab)',
      titleHint: 'CrossCover Cover for Abreviated',
      flow: 'knowledge_base',
      pageType: 'cover',
      kind: 'form_text_dict',
      caseTypes: [CASE_TYPES.ABBREVIATED_HAB],
      fields: ['Review of occupancy and construction'],
    },
    {
      // Send-and-verify page. Standard Core-Revised verify flow.
      formId: 'abbrev-hab-crosscover-core',
      name: 'CrossCover: Core',
      shortName: 'CrossCover Core (Hab)',
      titleHint: 'CrossCover: Core',
      flow: 'verify',
      kind: 'form',
      caseTypes: [CASE_TYPES.ABBREVIATED_HAB],
    },

    // ── Abbreviated: Non-Hab set ──────────────────────────────────────
    // Same three-form shape as Hab: address-only GI, the shared
    // CrossCover cover page (knowledge_base/cover, identical to Hab), and a
    // separate verify page - here the verify header is the longer
    // "NSR: CrossCover Pre Inspection Underwriting Property Information"
    // (Hab's verify header is "CrossCover: Core").
    {
      formId: 'abbrev-nonhab-general-information',
      name: 'General Information',
      shortName: 'Abbreviated Non-Hab General Information',
      titleHint: 'General Information',
      flow: 'knowledge_base',
      pageType: 'general',
      kind: 'generic_fields',
      caseTypes: [CASE_TYPES.ABBREVIATED_NON_HAB],
      genericFields: ['Address to be Inspected'],
    },
    {
      // KB-cover page - identical to Hab's cover (single clean exact label).
      formId: 'abbrev-nonhab-crosscover-cover',
      name: 'CrossCover Cover for Abreviated',
      shortName: 'CrossCover Cover (Non-Hab)',
      titleHint: 'CrossCover Cover for Abreviated',
      flow: 'knowledge_base',
      pageType: 'cover',
      kind: 'form_text_dict',
      caseTypes: [CASE_TYPES.ABBREVIATED_NON_HAB],
      fields: ['Review of occupancy and construction'],
    },
    {
      // Send-and-verify page. Standard verify flow.
      formId: 'abbrev-nonhab-crosscover-verify',
      name: 'NSR: CrossCover Pre Inspection Underwriting Property Information',
      shortName: 'CrossCover Pre-Inspection UW (Non-Hab)',
      titleHint: 'NSR: CrossCover Pre Inspection Underwriting Property Information',
      flow: 'verify',
      kind: 'form',
      caseTypes: [CASE_TYPES.ABBREVIATED_NON_HAB],
    },

    // ── Hab Package - Exterior set ────────────────────────────────────
    // Two forms, mirroring the WKFC / Abbreviated pattern (independent Cover +
    // verify pages rather than the Condos chained kb_then_verify). No General
    // Information page is supported for this case type.
    //   · Breckenridge Exterior Cover → knowledge_base / page_type 'cover'
    //   · Breckenridge: Exterior 2024 → verify (Accept/Reject queue)
    // Order Photos is universal, so it works on this case type automatically;
    // survey_type flows through from Utilant.CaseTypeName unchanged.
    {
      // KB-cover page. Single narrative field. The on-page label is a long
      // instructional paragraph ("Provide a brief overview of the location
      // plus add any additional information…"), so it can't be matched
      // verbatim and can't double as the emitted key. We use the object
      // form of a cover field: `match` is the stable leading text (prefix-
      // matched), `key` is the dict key the backend receives. The captured
      // narrative is therefore emitted as { "additional information": "…" }.
      formId: 'hab-pkg-ext-cover',
      name: 'Breckenridge Exterior Cover',
      shortName: 'Breckenridge Exterior Cover',
      titleHint: 'Breckenridge Exterior Cover',
      flow: 'knowledge_base',
      pageType: 'cover',
      kind: 'form_text_dict',
      caseTypes: [CASE_TYPES.HAB_PACKAGE_EXTERIOR],
      fields: [
        {
          match: 'Provide a brief overview of the location',
          key: 'additional information',
          prefix: true,
        },
      ],
    },
    {
      // Send-and-verify page. Standard Core-Revised verify flow.
      formId: 'hab-pkg-ext-verify',
      name: 'Breckenridge: Exterior 2024',
      shortName: 'Breckenridge Exterior 2024',
      titleHint: 'Breckenridge: Exterior 2024',
      flow: 'verify',
      kind: 'form',
      caseTypes: [CASE_TYPES.HAB_PACKAGE_EXTERIOR],
    },

    // ── Exterior only set ─────────────────────────────────────────────
    // Two verify-only forms. No Cover or General Information page is
    // supported for this case type - both pages route straight to the
    // standard Core-Revised verify flow (Accept/Reject queue). Order Photos
    // is universal, so it works on this case type automatically;
    // survey_type flows through from Utilant.CaseTypeName unchanged.
    {
      // Send-and-verify page. Standard Core-Revised verify flow.
      formId: 'exterior-only-brownstone-exterior-11-2018',
      name: 'Brownstone: Exterior 11/2018',
      shortName: 'Brownstone Exterior 11/2018',
      titleHint: 'Brownstone: Exterior 11/2018',
      flow: 'verify',
      kind: 'form',
      caseTypes: [CASE_TYPES.EXTERIOR_ONLY],
    },
    {
      // Send-and-verify page. Standard Core-Revised verify flow.
      formId: 'exterior-only-brownstone-aerial-roof-assessment',
      name: 'Brownstone Aerial Roof Assessment',
      shortName: 'Brownstone Aerial Roof Assessment',
      titleHint: 'Brownstone Aerial Roof Assessment',
      flow: 'verify',
      kind: 'form',
      caseTypes: [CASE_TYPES.EXTERIOR_ONLY],
    },

    // ── WKFC Property Renewal set ─────────────────────────────────────
    // Single verify-only form, shared by both the single-building
    // ('WKFC Property Renewal') and multi-building
    // ('WKFC Property Renewal - Multi Building') case types - same header,
    // same flow. No Cover or General Information page is supported for these
    // case types - the page routes straight to the standard Core-Revised
    // verify flow (Accept/Reject queue). Order Photos is universal, so it
    // works on both case types automatically; survey_type flows through from
    // Utilant.CaseTypeName unchanged.
    {
      // Send-and-verify page. Standard Core-Revised verify flow.
      formId: 'wkfc-renewal-form',
      name: 'WKFC Renewal Form',
      shortName: 'WKFC Renewal Form',
      titleHint: 'WKFC Renewal Form',
      flow: 'verify',
      kind: 'form',
      caseTypes: [CASE_TYPES.WKFC_RENEWAL, CASE_TYPES.WKFC_RENEWAL_MULTI],
    },

    // ── WKFC General Information ──────────────────────────────────────
    // Full generic-fields payload (construction, stories, address, etc.).
    // Scoped to WKFC so it can't capture a Brownstone GI page.
    {
      formId: 'general-information',
      name: 'General Information',
      shortName: 'General Information',
      titleHint: 'General Information',
      flow: 'knowledge_base',
      pageType: 'general',
      kind: 'generic_fields',
      caseTypes: [CASE_TYPES.WKFC],
    },
  ];

  /**
   * Return the subset of SUPPORTED_FORMS valid for a given CaseTypeName.
   * Entries with no `caseTypes` array are universal and always included.
   * An empty/unknown caseType returns the FULL registry, so detection still
   * degrades gracefully to header-only matching if CaseTypeName can't be
   * scraped (no regression vs the prior behaviour).
   */
  function formsForCaseType(caseTypeName) {
    const ct = (caseTypeName || '').replace(/\s+/g, ' ').trim();
    if (!ct) return SUPPORTED_FORMS.slice();
    return SUPPORTED_FORMS.filter(
      (f) => !Array.isArray(f.caseTypes) || f.caseTypes.includes(ct)
    );
  }

  // ── Host-level capability hints ─────────────────────────────────────
  // These never look at the DOM - they're cheap pre-checks used by the
  // service worker before bothering to message the content script.

  /** True if `hostname` is the NSR form host. */
  function isNsrFormHost(hostname) {
    return hostname === 'natsr.losscontrol360.com';
  }

  /** True if `hostname` is any LC360 host (NSR or otherwise). */
  function isLc360Host(hostname) {
    return typeof hostname === 'string' && hostname.endsWith('losscontrol360.com');
  }

  /** True if the URL path looks like an LC360 case/photos page. */
  function isCasesPath(pathname) {
    return typeof pathname === 'string' && pathname.startsWith('/pages/cases/');
  }

  /**
   * Given a tab URL, return which capabilities the URL is eligible for. The
   * caller still has to confirm with a DETECT_FORM message before showing
   * "supported" UI - these flags just mean "it's worth asking".
   */
  function capabilitiesForUrl(url) {
    let hostname = '';
    let pathname = '';
    try {
      const u = new URL(url || '');
      hostname = u.hostname;
      pathname = u.pathname;
    } catch (_) {
      // Invalid URL → no capabilities
    }
    return {
      hostname,
      pathname,
      form: isNsrFormHost(hostname),
      images: isLc360Host(hostname) && isCasesPath(pathname),
    };
  }

  const api = {
    SUPPORTED_FORMS,
    CASE_TYPES,
    formsForCaseType,
    isNsrFormHost,
    isLc360Host,
    isCasesPath,
    capabilitiesForUrl,
  };

  // Content-script context - attach to window
  if (typeof window !== 'undefined') {
    window.NSR_FORMS = api;
  }
  // Service-worker context - attach to self
  if (typeof self !== 'undefined') {
    self.NSR_FORMS = api;
  }
})();
