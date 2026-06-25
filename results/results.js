/**
 * results/results.js - Renderer for the standalone image-description tab.
 *
 * Data handoff:
 *   The side panel stashes the payload in chrome.storage.local under a
 *   per-call key, then opens this tab with that key in the URL fragment:
 *     results.html#<encoded-key>
 *   On load we read + delete that entry so a refresh doesn't double-render
 *   stale data.
 *
 * If the storage read fails or returns nothing, we leave the loading state
 * visible but swap the message to something diagnostic - this is the most
 * common "results page didn't open right" symptom and the user shouldn't
 * have to dig through DevTools to see why.
 */

'use strict';

document.addEventListener('DOMContentLoaded', loadFromStorage);

function loadFromStorage() {
  const rawHash = (location.hash || '').replace(/^#/, '');
  const key = rawHash ? decodeURIComponent(rawHash) : '';

  if (!key) {
    setLoadingMessage('No results key in URL - this page must be opened from the Smart Fill side panel.');
    return;
  }

  chrome.storage.local.get(key, (entry) => {
    if (chrome.runtime.lastError) {
      setLoadingMessage('Could not read results: ' + chrome.runtime.lastError.message);
      return;
    }
    if (!entry || !entry[key]) {
      setLoadingMessage('Results data not found. Try running the verification again.');
      return;
    }
    renderResults(entry[key]);
    chrome.storage.local.remove(key).catch(() => {});
  });
}

function setLoadingMessage(message) {
  const loading = document.getElementById('loadingState');
  const p = loading?.querySelector('p');
  if (p) p.textContent = message;
}

function renderResults(data) {
  document.getElementById('loadingState').style.display    = 'none';
  document.getElementById('resultsContainer').style.display = 'flex';

  // ── Survey metadata ─────────────────────────────────────────────
  const meta = data.meta || {};
  document.getElementById('rSurvey').textContent  = meta.surveyNumber || '-';
  document.getElementById('rInsured').textContent = meta.insuredName  || '-';
  document.getElementById('rPolicy').textContent  = meta.policyNumber || '-';

  // ── Stats ───────────────────────────────────────────────────────
  const results    = Array.isArray(data.results) ? data.results : [];
  const thumbnails = data.thumbnails || {};
  const total      = results.length;
  const correct    = results.filter((r) => r.isCorrect).length;
  const incorrect  = total - correct;

  document.getElementById('statTotalText').textContent     = `${total} Total`;
  document.getElementById('statCorrectText').textContent   = `${correct} Correct`;
  document.getElementById('statIncorrectText').textContent = `${incorrect} Changed`;

  // Heading subtitle ("65 images")
  document.getElementById('rResultsCount').textContent =
    `${total} image${total === 1 ? '' : 's'} verified`;

  // Overall badge: green if everything matched, otherwise warn-ish
  const overallBadge = document.getElementById('rOverallBadge');
  if (incorrect === 0) {
    overallBadge.className   = 'badge badge-success';
    overallBadge.textContent = 'ALL VERIFIED';
  } else {
    overallBadge.className   = 'badge badge-danger';
    overallBadge.textContent = `${incorrect} CHANGED`;
  }

  // ── Result grid ─────────────────────────────────────────────────
  const grid = document.getElementById('resultsGrid');
  grid.innerHTML = '';

  if (results.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = `
      <div class="empty-icon">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="1.6"
             stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
          <circle cx="8.5" cy="8.5" r="1.5"/>
          <polyline points="21 15 16 10 5 21"/>
        </svg>
      </div>
      <p>No results to display</p>
      <span>The image-verify API returned an empty result set.</span>
    `;
    grid.appendChild(empty);
    return;
  }

  results.forEach((result, index) => {
    const thumbUrl = thumbnails[result.photoId] || '';
    const fullUrl  = thumbnails[result.photoId + '_full'] || thumbUrl;

    const card = document.createElement('div');
    card.className = 'result-card';

    const badgeClass = result.isCorrect ? 'badge-success' : 'badge-danger';
    const badgeText  = result.isCorrect ? '\u2713 Correct' : '\u2717 Changed';

    card.innerHTML = `
      <div class="card-image" title="Click to open full resolution">
        <div class="order-badge">#${index + 1}</div>
        <img src="${escapeHtml(thumbUrl)}" alt="${escapeHtml(result.originalLabel || '')}" loading="lazy" />
      </div>
      <div class="card-body">
        <div class="label-row">
          <span class="label-tag">Original</span>
          <span class="label-value">${escapeHtml(result.originalLabel || '')}</span>
        </div>
        <div class="label-row">
          <span class="label-tag">Verified</span>
          <span class="label-value">${escapeHtml(result.verifiedLabel || '')}</span>
        </div>
        <div class="label-changed-row">
          <span class="label-tag">Label</span>
          <span class="badge ${badgeClass}">${badgeText}</span>
        </div>
        <div class="description-box">
          <div class="desc-label">Description</div>
          <div class="desc-text">${escapeHtml(result.modelDescription || 'No description available.')}</div>
        </div>
        <div class="photo-id-text">${escapeHtml(result.photoId || '')}</div>
      </div>
    `;

    const imgArea = card.querySelector('.card-image');
    imgArea.addEventListener('click', () => {
      if (fullUrl) window.open(fullUrl, '_blank');
    });

    grid.appendChild(card);
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}
