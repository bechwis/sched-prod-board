import { fetchIncidents, ack } from './api.js';

const REFRESH_MS = 2000; // R4

const list = document.querySelector('[data-testid="incident-list"]');
const loader = document.querySelector('[data-testid="loader"]');
const empty = document.querySelector('[data-testid="empty"]');
const errorBox = document.querySelector('.error');
const panel = document.querySelector('[data-testid="incident-panel"]');

/** Per-incident ack state, kept across refreshes: 'pending' | 'acked'. */
const ackState = new Map();
let incidents = [];
/** The incident open in the panel (by id, so it stays the same incident when rows move). */
let openId = null;

// R5: the viewer's own zone and order (en-GB, de-DE, en-NZ ... give dd/mm; en-US gives mm/dd).
const timeFormat = new Intl.DateTimeFormat(undefined, {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  timeZoneName: 'short',
});

// API data is untrusted: escape every field, allowlist the severity class.
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
const sevClass = (s) => (/^sev[0-9]$/.test(s) ? s : 'sev-unknown');

function localTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : timeFormat.format(d);
}

function rowInner(i, acked) {
  return `<span class="id">${esc(i.id)}</span>
        <span class="sev">${esc(i.severity)}</span>
        <span class="what">${esc(i.service)} · ${esc(i.region)} · ${esc(i.summary)}</span>
        <time datetime="${esc(i.openedAt)}" title="${esc(i.openedAt)}">${esc(localTime(i.openedAt))}</time>
        <span class="state">${acked ? '<span data-testid="acked" class="acked">✓ acked</span>' : ''}</span>`;
}

/** Row elements by incident id. A row stays the same element for its whole life on the board. */
const rowEls = new Map();

function renderList() {
  // R1: newest first, live at the top. Rows are updated in place and new ones inserted; an existing
  // row is never rebuilt or taken out while its incident is still on the board, so it does not jump,
  // flicker or lose focus on the 2-second refresh.
  const sorted = [...incidents].sort((a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt));
  const live = new Set(sorted.map((i) => i.id));
  for (const [id, el] of rowEls) {
    if (!live.has(id)) {
      el.remove();
      rowEls.delete(id);
    }
  }
  let prev = null;
  for (const i of sorted) {
    const acked = ackState.get(i.id) === 'acked';
    const open = i.id === openId;
    let el = rowEls.get(i.id);
    if (!el) {
      el = document.createElement('li');
      el.setAttribute('data-testid', 'incident-row');
      el.dataset.id = i.id;
      el.setAttribute('role', 'button');
      el.tabIndex = 0;
      el.setAttribute('aria-label', `Open ${i.id}`);
      rowEls.set(i.id, el);
    }
    el.className = `row ${sevClass(i.severity)}${acked ? ' is-acked' : ''}${open ? ' is-open' : ''}`;
    el.setAttribute('aria-pressed', String(open));
    const html = rowInner(i, acked);
    if (el.dataset.html !== html) {
      el.innerHTML = html;
      el.dataset.html = html;
    }
    // Place it right after the previous row; only touch the DOM when it is not there already.
    const want = prev ? prev.nextElementSibling : list.firstElementChild;
    if (want !== el) list.insertBefore(el, want);
    prev = el;
  }
  list.hidden = sorted.length === 0;
  empty.hidden = sorted.length !== 0;
}

// R2 (product's decision after step 1): Ack lives in the incident panel, not in the row. The panel
// is keyed by incident id and is only redrawn when its own incident or ack state changes, so a
// refresh never moves what is under the pointer there.
let panelKey = '';
function renderPanel() {
  const i = incidents.find((x) => x.id === openId);
  const state = openId ? ackState.get(openId) ?? 'open' : '';
  const key = i ? `${i.id}|${state}|${i.summary}` : openId ? `${openId}|gone` : '';
  if (key === panelKey) return;
  panelKey = key;
  if (!openId) {
    panel.hidden = true;
    panel.removeAttribute('data-id');
    panel.innerHTML = '';
    return;
  }
  panel.hidden = false;
  panel.dataset.id = openId;
  if (!i) {
    panel.innerHTML = `<h2>${esc(openId)}</h2><p class="muted">This incident is no longer on the board.</p>
      <button type="button" class="close" data-action="close">Close</button>`;
    return;
  }
  const ackHtml =
    state === 'acked'
      ? `<p class="acked">✓ ${esc(i.id)} acked</p>`
      : `<button type="button" data-testid="panel-ack" class="ack" data-id="${esc(i.id)}"${state === 'pending' ? ' disabled' : ''}>${state === 'pending' ? 'Acking…' : `Ack ${esc(i.id)}`}</button>`;
  panel.innerHTML = `<h2 class="panel-id">${esc(i.id)}</h2>
    <dl>
      <dt>Severity</dt><dd class="sev ${sevClass(i.severity)}">${esc(i.severity)}</dd>
      <dt>Service</dt><dd>${esc(i.service)}</dd>
      <dt>Region</dt><dd>${esc(i.region)}</dd>
      <dt>Summary</dt><dd>${esc(i.summary)}</dd>
      <dt>Opened</dt><dd><time datetime="${esc(i.openedAt)}" title="${esc(i.openedAt)}">${esc(localTime(i.openedAt))}</time></dd>
    </dl>
    <div class="panel-actions">${ackHtml}<button type="button" class="close" data-action="close">Close</button></div>`;
}

function render() {
  renderList();
  renderPanel();
}

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.hidden = false;
}

function openIncident(id) {
  openId = id;
  render();
  panel.focus();
}

list.addEventListener('click', (ev) => {
  const row = ev.target.closest('[data-testid="incident-row"]');
  if (row) openIncident(row.dataset.id);
});
list.addEventListener('keydown', (ev) => {
  const row = ev.target.closest('[data-testid="incident-row"]');
  if (row && (ev.key === 'Enter' || ev.key === ' ')) {
    ev.preventDefault();
    openIncident(row.dataset.id);
  }
});

panel.addEventListener('click', async (ev) => {
  if (ev.target.closest('[data-action="close"]')) {
    openId = null;
    render();
    return;
  }
  const btn = ev.target.closest('[data-testid="panel-ack"]');
  if (!btn || btn.disabled) return;
  const id = btn.dataset.id; // the panel's own incident, never a list position
  ackState.set(id, 'pending');
  render();
  try {
    await ack(id);
    ackState.set(id, 'acked');
    errorBox.hidden = true;
  } catch (err) {
    ackState.delete(id);
    showError(`Ack failed for ${id}: ${err.message}`);
  }
  render();
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && openId) {
    openId = null;
    render();
  }
});

async function refresh() {
  try {
    const page = await fetchIncidents();
    incidents = page.incidents ?? [];
    render();
    loader.hidden = true; // R3: gone once incidents load
    errorBox.hidden = true;
  } catch (err) {
    showError(`Could not load incidents: ${err.message}`);
  } finally {
    setTimeout(refresh, REFRESH_MS); // R4: no overlapping requests
  }
}

refresh();
