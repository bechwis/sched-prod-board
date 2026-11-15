import { fetchIncidents, ack } from './api.js';

const REFRESH_MS = 2000; // R4

const list = document.querySelector('[data-testid="incident-list"]');
const loader = document.querySelector('[data-testid="loader"]');
const empty = document.querySelector('[data-testid="empty"]');
const errorBox = document.querySelector('.error');

/** Per-incident ack state, kept across refreshes: 'pending' | 'acked'. */
const ackState = new Map();
let incidents = [];

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

function ackCell(id) {
  const state = ackState.get(id);
  if (state === 'acked') return `<span data-testid="acked" class="acked">✓ acked</span>`;
  const busy = state === 'pending';
  return `<button type="button" data-testid="ack" class="ack" data-id="${esc(id)}"${busy ? ' disabled' : ''}>${busy ? 'Acking…' : 'Ack'}</button>`;
}

function rowHtml(i) {
  const acked = ackState.get(i.id) === 'acked' ? ' is-acked' : '';
  return `<li data-testid="incident-row" data-id="${esc(i.id)}" class="row ${sevClass(i.severity)}${acked}">
        <span class="id">${esc(i.id)}</span>
        <span class="sev">${esc(i.severity)}</span>
        <span class="what">${esc(i.service)} · ${esc(i.region)} · ${esc(i.summary)}</span>
        <time datetime="${esc(i.openedAt)}" title="${esc(i.openedAt)}">${esc(localTime(i.openedAt))}</time>
        ${ackCell(i.id)}
      </li>`;
}

function render() {
  // R1: newest first, whatever order the page came in.
  const sorted = [...incidents].sort((a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt));
  list.innerHTML = sorted.map(rowHtml).join('');
  list.hidden = sorted.length === 0;
  empty.hidden = sorted.length !== 0;
}

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.hidden = false;
}

list.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-testid="ack"]');
  if (!btn || btn.disabled) return;
  const id = btn.dataset.id;
  ackState.set(id, 'pending');
  render();
  try {
    await ack(id); // R2
    ackState.set(id, 'acked');
    errorBox.hidden = true;
  } catch (err) {
    ackState.delete(id);
    showError(`Ack failed for ${id}: ${err.message}`);
  }
  render();
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
