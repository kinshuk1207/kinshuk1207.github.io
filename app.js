const state = { terms: [], results: [], jobId: null, polling: null };
const API_BASE_URL = String(window.YT_EXPLORER_CONFIG?.apiBaseUrl || '').replace(/\/$/, '');

const $ = (selector) => document.querySelector(selector);
const elements = {
  keywordGrid: $('#keyword-grid'), modifierGrid: $('#modifier-grid'),
  termsSource: $('#terms-source'), selectionCount: $('#selection-count'),
  searchButton: $('#search-button'), cancelButton: $('#cancel-button'), progressWrap: $('#progress-wrap'),
  progressBar: $('#progress-bar'), progressText: $('#progress-text'), message: $('#message'),
  resultCount: $('#result-count'), resultsBody: $('#results-body'), tableWrap: $('#table-wrap'),
  emptyState: $('#empty-state'), exportCsv: $('#export-csv'), exportJson: $('#export-json'),
  backendStatus: $('#backend-status'),
};

function applyTheme(theme) {
  const dark = theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('#theme-toggle').textContent = dark ? 'Light mode' : 'Dark mode';
  $('#theme-toggle').setAttribute('aria-pressed', String(dark));
}

applyTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');

$('#theme-toggle').addEventListener('click', () => {
  const nextTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(nextTheme);
  try { localStorage.setItem('yt-explorer-theme', nextTheme); } catch (error) {}
});

async function request(url, options = {}) {
  const response = await fetch(`${API_BASE_URL}${url}`, options);
  let data;
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function loadTerms() {
  try {
    const data = await request('/api/terms');
    state.terms = data.terms;
    renderTerms(true, data.file);
    elements.backendStatus.textContent = 'Backend online';
    elements.backendStatus.classList.add('online');
  } catch (error) {
    elements.backendStatus.textContent = 'Backend offline';
    elements.backendStatus.classList.remove('online');
    showMessage(error.message, 'error');
  }
}

function selectedLabels(grid) {
  return new Set([...grid.querySelectorAll('input:checked')].map((input) => input.dataset.label));
}

function renderTerms(useDefaults = false, file = 'terms.txt', addedTerm = null) {
  const previousKeywords = selectedLabels(elements.keywordGrid);
  const previousModifiers = selectedLabels(elements.modifierGrid);
  elements.keywordGrid.replaceChildren();
  elements.modifierGrid.replaceChildren();
  const keywords = state.terms.filter((term) => term.kind === 'keyword');
  const modifiers = state.terms.filter((term) => term.kind === 'modifier');
  elements.termsSource.textContent = `${keywords.length} keywords and ${modifiers.length} modifiers loaded from ${file}.`;
  const template = $('#term-template');

  function fillGrid(terms, grid, previous, defaultCount) {
    terms.forEach((term, index) => {
      const chip = template.content.firstElementChild.cloneNode(true);
      const input = chip.querySelector('input');
      input.value = term.id;
      input.dataset.label = term.label;
      input.checked = (useDefaults && index < defaultCount)
        || previous.has(term.label)
        || (addedTerm && addedTerm.kind === term.kind && addedTerm.value === term.label);
      input.addEventListener('change', updateSelectionCount);
      chip.querySelector('span').textContent = term.label;
      grid.appendChild(chip);
    });
  }

  fillGrid(keywords, elements.keywordGrid, previousKeywords, 8);
  fillGrid(modifiers, elements.modifierGrid, previousModifiers, 3);
  updateSelectionCount();
}

function selectedIds(grid) {
  return [...grid.querySelectorAll('input:checked')].map((input) => Number(input.value));
}

function searchMode() {
  return $('input[name="search-mode"]:checked').value;
}

function updateSelectionCount() {
  const keywordCount = selectedIds(elements.keywordGrid).length;
  const modifierCount = selectedIds(elements.modifierGrid).length;
  if (searchMode() === 'combined') {
    const searches = keywordCount * modifierCount;
    elements.selectionCount.textContent = `${keywordCount} keywords × ${modifierCount} modifiers = ${searches} searches`;
  } else {
    elements.selectionCount.textContent = `${keywordCount} keyword${keywordCount === 1 ? '' : 's'} = ${keywordCount} searches`;
  }
}

function requestAdminPassword() {
  return new Promise((resolve) => {
    const dialog = $('#admin-dialog');
    const input = $('#admin-password');
    input.value = '';
    dialog.addEventListener('close', () => {
      resolve(dialog.returnValue === 'confirm' ? input.value : '');
    }, { once: true });
    dialog.showModal();
    input.focus();
  });
}

async function addTerm(kind) {
  const input = kind === 'keyword' ? $('#new-keyword') : $('#new-modifier');
  const value = input.value.trim();
  if (!value) {
    showMessage(`Enter a ${kind}.`, 'error');
    input.focus();
    return;
  }
  async function submit(adminToken = '') {
    const headers = { 'Content-Type': 'application/json' };
    if (adminToken) headers['X-Admin-Token'] = adminToken;
    return request('/api/terms', {
      method: 'POST',
      headers,
      body: JSON.stringify({ kind, value }),
    });
  }

  try {
    let adminToken = '';
    try { adminToken = sessionStorage.getItem('yt-explorer-admin-token') || ''; } catch (error) {}
    let data;
    try {
      data = await submit(adminToken);
    } catch (error) {
      if (API_BASE_URL && [401, 403].includes(error.status)) {
        adminToken = await requestAdminPassword();
        if (!adminToken) throw error;
        data = await submit(adminToken);
        try { sessionStorage.setItem('yt-explorer-admin-token', adminToken); } catch (storageError) {}
      } else {
        throw error;
      }
    }
    state.terms = data.terms;
    renderTerms(false, data.file, { kind, value: value.replace(/\s+/g, ' ') });
    input.value = '';
    showMessage(`Added ${kind} “${value}” to ${data.file}.`, 'success');
  } catch (error) {
    showMessage(error.message, 'error');
  }
}

function numberValue(selector) {
  return Number($(selector).value) || 0;
}

function showMessage(text, type = '') {
  elements.message.textContent = text;
  elements.message.className = `message ${type}`;
  elements.message.classList.toggle('hidden', !text);
}

function setRunning(running) {
  elements.searchButton.disabled = running;
  elements.cancelButton.classList.toggle('hidden', !running);
  elements.progressWrap.classList.toggle('hidden', !running);
}

async function startSearch() {
  showMessage('');
  const mode = searchMode();
  const keywordIds = selectedIds(elements.keywordGrid);
  const modifierIds = selectedIds(elements.modifierGrid);
  if (!keywordIds.length) {
    showMessage('Select at least one keyword.', 'error');
    return;
  }
  if (mode === 'combined' && !modifierIds.length) {
    showMessage('Select at least one modifier for combined search.', 'error');
    return;
  }
  const payload = {
    mode,
    keyword_ids: keywordIds,
    modifier_ids: modifierIds,
    extra_query: $('#extra-query').value,
    sort: $('#search-sort').value,
    per_query: numberValue('#per-query'),
    max_total: numberValue('#max-total'),
    date_after: $('#date-after').value,
    min_views: numberValue('#min-views'),
    max_duration_minutes: numberValue('#max-duration'),
  };
  try {
    setRunning(true);
    elements.progressBar.style.width = '0%';
    elements.progressText.textContent = 'Starting search…';
    const job = await request('/api/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    state.jobId = job.id;
    pollJob();
  } catch (error) {
    setRunning(false);
    showMessage(error.message, 'error');
  }
}

async function pollJob() {
  if (!state.jobId) return;
  try {
    const job = await request(`/api/jobs/${state.jobId}`);
    const percent = job.total_queries ? Math.round((job.completed_queries / job.total_queries) * 100) : 0;
    elements.progressBar.style.width = `${percent}%`;
    elements.progressText.textContent = job.current_query
      ? `${job.completed_queries} of ${job.total_queries} searches complete · Searching “${job.current_query}”`
      : `${job.completed_queries} of ${job.total_queries} searches complete`;
    if (['completed', 'cancelled', 'failed'].includes(job.status)) {
      finishJob(job);
    } else {
      state.polling = window.setTimeout(pollJob, 600);
    }
  } catch (error) {
    setRunning(false);
    showMessage(error.message, 'error');
  }
}

function finishJob(job) {
  setRunning(false);
  state.jobId = null;
  state.results = job.results || [];
  renderResults();
  if (job.status === 'failed') showMessage(job.error || 'Search failed.', 'error');
  else if (job.status === 'cancelled') showMessage(`Search cancelled. Kept ${state.results.length} results collected so far.`, 'warning');
  else if (job.warnings?.length) showMessage(`Search finished with ${job.warnings.length} warning(s). Some terms may have returned no results.`, 'warning');
  else showMessage(`Search complete — ${state.results.length} unique videos found.`, 'success');
}

async function cancelSearch() {
  if (!state.jobId) return;
  elements.cancelButton.disabled = true;
  try {
    await request(`/api/jobs/${state.jobId}/cancel`, { method: 'POST' });
    elements.progressText.textContent = 'Cancelling after the current term…';
  } catch (error) {
    showMessage(error.message, 'error');
  } finally {
    elements.cancelButton.disabled = false;
  }
}

function formatDate(date) {
  if (!date || date.length < 8) return '—';
  const parsed = new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T00:00:00`);
  return Number.isNaN(parsed.valueOf()) ? '—' : parsed.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDuration(seconds) {
  if (seconds == null) return '—';
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}` : `${minutes}:${String(secs).padStart(2, '0')}`;
}

function formatViews(views) {
  return views == null ? '—' : new Intl.NumberFormat().format(views);
}

function visibleResults() {
  const needle = $('#result-filter').value.trim().toLocaleLowerCase();
  const results = state.results.filter((item) => !needle || `${item.title} ${item.channel} ${item.matched_terms.join(' ')}`.toLocaleLowerCase().includes(needle));
  const sort = $('#result-sort').value;
  if (sort === 'newest') results.sort((a, b) => (b.upload_date || '').localeCompare(a.upload_date || ''));
  if (sort === 'views') results.sort((a, b) => (b.view_count ?? -1) - (a.view_count ?? -1));
  if (sort === 'duration') results.sort((a, b) => (a.duration ?? Infinity) - (b.duration ?? Infinity));
  if (sort === 'title') results.sort((a, b) => a.title.localeCompare(b.title));
  return results;
}

function makeCell(row, className = '') {
  const cell = document.createElement('td');
  if (className) cell.className = className;
  row.appendChild(cell);
  return cell;
}

function renderResults() {
  const results = visibleResults();
  elements.resultsBody.replaceChildren();
  elements.resultCount.textContent = results.length;
  elements.tableWrap.classList.toggle('hidden', !results.length);
  elements.emptyState.classList.toggle('hidden', Boolean(results.length));
  elements.exportCsv.disabled = !state.results.length;
  elements.exportJson.disabled = !state.results.length;

  results.forEach((video) => {
    const row = document.createElement('tr');
    const videoCell = makeCell(row, 'video-cell');
    if (video.thumbnail) {
      const image = document.createElement('img');
      image.src = video.thumbnail;
      image.alt = '';
      image.loading = 'lazy';
      image.referrerPolicy = 'no-referrer';
      videoCell.appendChild(image);
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'thumb-placeholder';
      placeholder.textContent = '▶';
      videoCell.appendChild(placeholder);
    }
    const title = document.createElement('a');
    title.href = video.url;
    title.target = '_blank';
    title.rel = 'noopener noreferrer';
    title.textContent = video.title;
    videoCell.appendChild(title);

    const channelCell = makeCell(row);
    if (video.channel_url) {
      const channelLink = document.createElement('a');
      channelLink.href = video.channel_url;
      channelLink.target = '_blank';
      channelLink.rel = 'noopener noreferrer';
      channelLink.textContent = video.channel;
      channelCell.appendChild(channelLink);
    } else channelCell.textContent = video.channel;
    makeCell(row).textContent = formatDate(video.upload_date);
    makeCell(row).textContent = formatDuration(video.duration);
    makeCell(row).textContent = formatViews(video.view_count);
    const termsCell = makeCell(row, 'matches');
    termsCell.textContent = video.matched_terms.join(', ');
    const actionCell = makeCell(row, 'row-actions');
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'copy-button';
    copy.textContent = 'Copy URL';
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(video.url);
      copy.textContent = 'Copied';
      window.setTimeout(() => { copy.textContent = 'Copy URL'; }, 1200);
    });
    actionCell.appendChild(copy);
    elements.resultsBody.appendChild(row);
  });
}

function downloadFile(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  URL.revokeObjectURL(url);
}

function csvValue(value) {
  const text = String(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}

function exportCsv() {
  const headers = ['title', 'url', 'channel', 'upload_date', 'duration_seconds', 'view_count', 'matched_terms'];
  const rows = state.results.map((video) => [video.title, video.url, video.channel, video.upload_date, video.duration, video.view_count, video.matched_terms.join(' | ')]);
  const csv = [headers, ...rows].map((row) => row.map(csvValue).join(',')).join('\r\n');
  downloadFile(`youtube-discovery-${new Date().toISOString().slice(0, 10)}.csv`, `\ufeff${csv}`, 'text/csv;charset=utf-8');
}

function exportJson() {
  downloadFile(`youtube-discovery-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(state.results, null, 2), 'application/json');
}

function setGridSelection(grid, checked) {
  grid.querySelectorAll('input').forEach((input) => { input.checked = checked; });
  updateSelectionCount();
}

$('#keyword-select-all').addEventListener('click', () => setGridSelection(elements.keywordGrid, true));
$('#keyword-select-none').addEventListener('click', () => setGridSelection(elements.keywordGrid, false));
$('#modifier-select-all').addEventListener('click', () => setGridSelection(elements.modifierGrid, true));
$('#modifier-select-none').addEventListener('click', () => setGridSelection(elements.modifierGrid, false));
document.querySelectorAll('input[name="search-mode"]').forEach((input) => input.addEventListener('change', updateSelectionCount));
$('#keyword-form').addEventListener('submit', (event) => { event.preventDefault(); addTerm('keyword'); });
$('#modifier-form').addEventListener('submit', (event) => { event.preventDefault(); addTerm('modifier'); });
elements.searchButton.addEventListener('click', startSearch);
elements.cancelButton.addEventListener('click', cancelSearch);
$('#result-filter').addEventListener('input', renderResults);
$('#result-sort').addEventListener('change', renderResults);
elements.exportCsv.addEventListener('click', exportCsv);
elements.exportJson.addEventListener('click', exportJson);
loadTerms();
