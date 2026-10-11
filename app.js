'use strict';

/* =========================================================
   State (saved to localStorage as JSON)
   ========================================================= */

const STORAGE_KEY = 'split-data';
const state = { events: [], currentEventId: null };
let nextId = 1;
const newId = () => nextId++;

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, nextId }));
  } catch {
    // Storage unavailable (e.g. private mode) — keep working in memory
  }
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!saved || !Array.isArray(saved.events)) return;
    state.events = saved.events;
    state.currentEventId = saved.currentEventId ?? null;
    nextId = saved.nextId || 1;
  } catch {
    // Missing or corrupt data — start fresh
  }
}

function createEvent(name) {
  const event = { id: newId(), shareId: randomShareId(), name, participants: [], expenses: [] };
  state.events.push(event);
  return event;
}

function getCurrentEvent() {
  return state.events.find((event) => event.id === state.currentEventId) || null;
}

function participantName(event, participantId) {
  const participant = event.participants.find((p) => p.id === participantId);
  return participant ? participant.name : 'Unknown';
}

/* =========================================================
   Money and settlement calculations (pure, no DOM)
   All amounts are integer paise.
   ========================================================= */

const MAX_RUPEE_DIGITS = 9;

/** Parses user input like "900", "1,200.5" or "33.33" into paise. Returns null if invalid or not > 0. */
function parseAmountToPaise(input) {
  const text = String(input).trim().replace(/,/g, '');
  const match = /^(\d*)(?:\.(\d{0,2}))?$/.exec(text);
  if (!match || !/\d/.test(text) || match[1].length > MAX_RUPEE_DIGITS) return null;
  const paise = Number(match[1] || 0) * 100 + Number((match[2] || '').padEnd(2, '0'));
  return paise > 0 ? paise : null;
}

function paiseToInput(paise) {
  const rupees = Math.floor(paise / 100);
  const remainder = paise % 100;
  return remainder ? `${rupees}.${String(remainder).padStart(2, '0')}` : String(rupees);
}

const inrWhole = new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 0,
});
const inrFraction = new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2,
});

function formatINR(paise) {
  return (paise % 100 === 0 ? inrWhole : inrFraction).format(paise / 100);
}

/**
 * Splits an amount among participants so shares sum exactly to the total.
 * Leftover paise go one each to the first participants in the given order.
 */
function splitShares(amountPaise, participantIds) {
  const count = participantIds.length;
  const base = Math.floor(amountPaise / count);
  const remainder = amountPaise - base * count;
  return new Map(participantIds.map((id, index) => [id, base + (index < remainder ? 1 : 0)]));
}

function describeShare(amountPaise, count) {
  const base = Math.floor(amountPaise / count);
  return amountPaise % count === 0
    ? `${formatINR(base)} each`
    : `${formatINR(base + 1)} / ${formatINR(base)} each`;
}

function totalExpenses(event) {
  return event.expenses.reduce((sum, expense) => sum + expense.amountPaise, 0);
}

/** Net balance per participant: positive = gets money back, negative = owes. */
function computeBalances(event) {
  const balances = new Map(event.participants.map((p) => [p.id, 0]));
  for (const expense of event.expenses) {
    balances.set(expense.paidById, balances.get(expense.paidById) + expense.amountPaise);
    for (const [id, share] of splitShares(expense.amountPaise, expense.splitAmongIds)) {
      balances.set(id, balances.get(id) - share);
    }
  }
  return balances;
}

/**
 * Greedy settlement: match the largest debtor with the largest creditor until all are settled.
 * Produces at most (people with non-zero balance − 1) payments.
 */
function computeSettlements(balances) {
  const creditors = [];
  const debtors = [];
  for (const [id, amount] of balances) {
    if (amount > 0) creditors.push({ id, amount });
    else if (amount < 0) debtors.push({ id, amount: -amount });
  }
  const byAmountDesc = (a, b) => b.amount - a.amount;
  creditors.sort(byAmountDesc);
  debtors.sort(byAmountDesc);

  const settlements = [];
  let c = 0;
  let d = 0;
  while (c < creditors.length && d < debtors.length) {
    const amount = Math.min(creditors[c].amount, debtors[d].amount);
    settlements.push({ fromId: debtors[d].id, toId: creditors[c].id, amount });
    creditors[c].amount -= amount;
    debtors[d].amount -= amount;
    if (creditors[c].amount === 0) c++;
    if (debtors[d].amount === 0) d++;
  }
  return settlements;
}

function countExpensesInvolving(event, participantId) {
  return event.expenses.filter(
    (e) => e.paidById === participantId || e.splitAmongIds.includes(participantId),
  ).length;
}

function validateExpense({ description, amountPaise, splitAmongIds }) {
  const errors = {};
  if (!description) errors.description = 'Add a short description.';
  if (amountPaise === null) errors.amount = 'Enter an amount greater than ₹0 (up to 2 decimals).';
  if (splitAmongIds.length === 0) errors.split = 'Select at least one person.';
  return errors;
}

/** Plain-text summary using WhatsApp formatting (*bold*). */
function buildShareText(event) {
  const name = (id) => participantName(event, id);
  const balances = computeBalances(event);
  const settlements = computeSettlements(balances);

  const expenseLines = event.expenses.map((e) => {
    const split = e.splitAmongIds.length === event.participants.length
      ? 'everyone'
      : e.splitAmongIds.map(name).join(', ');
    return `• ${e.description}: ${formatINR(e.amountPaise)} (paid by ${name(e.paidById)}, split among ${split})`;
  });
  const balanceLines = event.participants.map((p) => {
    const amount = balances.get(p.id);
    if (amount > 0) return `• ${p.name} gets back ${formatINR(amount)}`;
    if (amount < 0) return `• ${p.name} owes ${formatINR(-amount)}`;
    return `• ${p.name} is settled up`;
  });
  const paymentLines = settlements.length
    ? settlements.map((s) => `• ${name(s.fromId)} → ${name(s.toId)}: *${formatINR(s.amount)}*`)
    : ['Everyone is settled. No payments needed 🎉'];

  return [
    `*${event.name}*`,
    `Total spent: *${formatINR(totalExpenses(event))}*`,
    '',
    '*Expenses*', ...expenseLines,
    '',
    '*Balances*', ...balanceLines,
    '',
    '*Who pays whom*', ...paymentLines,
  ].join('\n');
}

/* =========================================================
   Share links: one event, compressed into the URL #fragment
   ========================================================= */

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(text) {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function randomShareId() {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(9)));
}

/** Compact form: participants by name, expenses as [description, paise, payerIndex, splitIndexes]. */
function eventToSharePayload(event) {
  const indexOf = new Map(event.participants.map((p, i) => [p.id, i]));
  return {
    v: 1,
    id: event.shareId,
    n: event.name,
    p: event.participants.map((p) => p.name),
    x: event.expenses.map((e) => [
      e.description, e.amountPaise, indexOf.get(e.paidById), e.splitAmongIds.map((id) => indexOf.get(id)),
    ]),
  };
}

/** Validates a decoded payload and rebuilds an event with fresh local ids. Throws if invalid. */
function sharePayloadToEvent(payload) {
  const isText = (value) => typeof value === 'string' && value.trim() !== '';
  if (!payload || payload.v !== 1 || !isText(payload.id) || !isText(payload.n)
    || !Array.isArray(payload.p) || !payload.p.every(isText) || !Array.isArray(payload.x)) {
    throw new Error('Invalid share data');
  }
  const participants = payload.p.map((name) => ({ id: newId(), name }));
  const isIndex = (i) => Number.isInteger(i) && i >= 0 && i < participants.length;
  const expenses = payload.x.map((item) => {
    const [description, amountPaise, payerIndex, splitIndexes] = Array.isArray(item) ? item : [];
    if (!isText(description) || !Number.isInteger(amountPaise) || amountPaise <= 0 || !isIndex(payerIndex)
      || !Array.isArray(splitIndexes) || splitIndexes.length === 0 || !splitIndexes.every(isIndex)) {
      throw new Error('Invalid expense in share data');
    }
    return {
      id: newId(),
      description,
      amountPaise,
      paidById: participants[payerIndex].id,
      splitAmongIds: [...new Set(splitIndexes)].map((i) => participants[i].id),
    };
  });
  return { shareId: payload.id, name: payload.n, participants, expenses };
}

async function pipeBytes(bytes, transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** "z" + deflated base64url when the browser supports compression, otherwise "j" + plain base64url. */
async function encodeShareData(payload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  if (typeof CompressionStream === 'undefined') return `j${bytesToBase64Url(bytes)}`;
  return `z${bytesToBase64Url(await pipeBytes(bytes, new CompressionStream('deflate-raw')))}`;
}

async function decodeShareData(text) {
  let bytes = base64UrlToBytes(text.slice(1));
  if (text[0] === 'z') bytes = await pipeBytes(bytes, new DecompressionStream('deflate-raw'));
  else if (text[0] !== 'j') throw new Error('Unknown share format');
  return JSON.parse(new TextDecoder().decode(bytes));
}

/* =========================================================
   UI rendering and interaction
   ========================================================= */

const ICONS = {
  add: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
  chevron: 'M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z',
  close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  edit: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a.996.996 0 0 0 0-1.41l-2.34-2.34a.996.996 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
  delete: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
  check: 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
};

const $ = (id) => document.getElementById(id);
const icon = (name) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`;
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

function escapeHtml(value) {
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value).replace(/[&<>"']/g, (char) => entities[char]);
}

let editingExpenseId = null;

const labelTimers = new Map();

/** Briefly shows a status message on a button label, then restores it. */
function flashLabel(labelId, message, defaultText) {
  $(labelId).textContent = message;
  clearTimeout(labelTimers.get(labelId));
  labelTimers.set(labelId, setTimeout(() => { $(labelId).textContent = defaultText; }, 2000));
}

/** Imports an event from a "#e=..." link, replacing the local copy if it was shared before. */
async function importFromHash() {
  const match = /^#e=(.+)$/.exec(location.hash);
  if (!match) return;
  history.replaceState(null, '', location.href.split('#')[0]);

  let payload;
  let shared;
  try {
    payload = await decodeShareData(match[1]);
    shared = sharePayloadToEvent(payload);
  } catch {
    alert('This share link is invalid or incomplete. Ask for a fresh link.');
    return;
  }

  const existing = state.events.find((e) => e.shareId === shared.shareId);
  if (!existing) {
    const event = { id: newId(), ...shared };
    state.events.push(event);
    openEvent(event.id);
    return;
  }
  const unchanged = JSON.stringify(eventToSharePayload(existing)) === JSON.stringify(payload);
  if (!unchanged && confirm(`Replace your copy of "${existing.name}" with the version from this link?`)) {
    Object.assign(existing, shared);
  }
  openEvent(existing.id);
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for browsers/contexts without the async Clipboard API
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    return copied;
  }
}

function render() {
  saveState(); // every state change ends in render()
  const event = getCurrentEvent();
  $('events-view').hidden = Boolean(event);
  $('detail-view').hidden = !event;
  if (event) renderDetail(event);
  else renderEvents();
}

function renderEvents() {
  const list = $('event-list');
  if (state.events.length === 0) {
    list.innerHTML = '<p class="empty">No events yet. Create one above to get started.</p>';
    return;
  }
  list.innerHTML = state.events.map((event) => `
    <button class="event-item" type="button" data-event-id="${event.id}">
      <span class="event-item-text">
        <span class="event-item-name">${escapeHtml(event.name)}</span>
        <span class="event-item-meta">${plural(event.participants.length, 'participant')} · ${plural(event.expenses.length, 'expense')}</span>
      </span>
      <span class="event-item-total">${formatINR(totalExpenses(event))}</span>
      ${icon('chevron')}
    </button>`).join('');
}

function renderDetail(event) {
  $('detail-name').textContent = event.name;
  $('detail-meta').textContent =
    `${plural(event.participants.length, 'participant')} · ${formatINR(totalExpenses(event))} total`;
  renderParticipants(event);
  renderExpenses(event);
  renderSettlement(event);
}

function renderParticipants(event) {
  $('participant-list').innerHTML = event.participants.length === 0
    ? '<li class="empty">No participants yet. Add everyone who is sharing costs.</li>'
    : event.participants.map((p) => `
      <li class="chip">
        <span class="chip-label">${escapeHtml(p.name)}</span>
        <button class="chip-remove" type="button" data-remove-id="${p.id}" aria-label="Remove ${escapeHtml(p.name)}">${icon('close')}</button>
      </li>`).join('');
}

function renderExpenses(event) {
  const list = $('expense-list');
  $('add-expense-btn').hidden = event.participants.length === 0;

  if (event.participants.length === 0) {
    list.innerHTML = '<p class="empty">Add participants to start adding expenses.</p>';
    return;
  }
  if (event.expenses.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <p>No expenses yet.</p>
        <button class="btn btn-tonal" type="button" data-action="add">${icon('add')}Add expense</button>
      </div>`;
    return;
  }
  list.innerHTML = event.expenses.map((expense) => {
    const names = expense.splitAmongIds.map((id) => participantName(event, id));
    const label = escapeHtml(expense.description);
    return `
      <article class="expense">
        <div class="expense-main">
          <div class="expense-title-row">
            <h3 class="expense-title">${label}</h3>
            <span class="expense-amount">${formatINR(expense.amountPaise)}</span>
          </div>
          <p class="expense-meta">Paid by <strong>${escapeHtml(participantName(event, expense.paidById))}</strong></p>
          <p class="expense-meta">Split among ${escapeHtml(names.join(', '))} · <span class="nowrap">${describeShare(expense.amountPaise, names.length)}</span></p>
        </div>
        <div class="expense-actions">
          <button class="icon-btn" type="button" data-action="edit" data-id="${expense.id}" aria-label="Edit ${label}">${icon('edit')}</button>
          <button class="icon-btn" type="button" data-action="delete" data-id="${expense.id}" aria-label="Delete ${label}">${icon('delete')}</button>
        </div>
      </article>`;
  }).join('');
}

function renderSettlement(event) {
  const container = $('settlement');
  $('copy-summary-btn').hidden = event.expenses.length === 0;
  if (event.expenses.length === 0) {
    container.innerHTML = '<p class="empty">Add an expense to see who owes whom.</p>';
    return;
  }
  const balances = computeBalances(event);
  const settlements = computeSettlements(balances);

  const balanceRows = event.participants.map((p) => {
    const amount = balances.get(p.id);
    const [className, text] = amount > 0 ? ['positive', `gets back ${formatINR(amount)}`]
      : amount < 0 ? ['negative', `owes ${formatINR(-amount)}`]
        : ['neutral', 'settled up'];
    return `
      <li class="balance-row">
        <span class="balance-name">${escapeHtml(p.name)}</span>
        <span class="balance-amount ${className}">${text}</span>
      </li>`;
  }).join('');

  const payments = settlements.length === 0
    ? `<p class="all-settled">${icon('check')}Everyone is settled — no payments needed.</p>`
    : `<ol class="settle-list">${settlements.map((s) => `
        <li class="settle-row">
          <span class="settle-names"><strong>${escapeHtml(participantName(event, s.fromId))}</strong> pays <strong>${escapeHtml(participantName(event, s.toId))}</strong></span>
          <span class="settle-amount">${formatINR(s.amount)}</span>
        </li>`).join('')}</ol>`;

  container.innerHTML = `
    <div class="total-row"><span>Total spent</span><strong>${formatINR(totalExpenses(event))}</strong></div>
    <h3 class="subheading">Balances</h3>
    <ul class="balance-list">${balanceRows}</ul>
    <h3 class="subheading">Payments</h3>
    ${payments}`;
}

function openEvent(eventId) {
  state.currentEventId = eventId;
  $('participant-error').textContent = '';
  $('participant-name').value = '';
  render();
  window.scrollTo(0, 0);
}

/* ---------- Expense dialog ---------- */

function getCheckedSplitIds() {
  return [...document.querySelectorAll('#split-options input:checked')].map((input) => Number(input.value));
}

function updateSplitSummary() {
  const total = document.querySelectorAll('#split-options input').length;
  const selectedCount = getCheckedSplitIds().length;
  const amountPaise = parseAmountToPaise($('expense-amount').value);
  $('split-count').textContent = `${selectedCount} of ${total} selected`;
  $('share-preview').textContent =
    selectedCount > 0 && amountPaise !== null ? describeShare(amountPaise, selectedCount) : '';
  $('toggle-all').textContent = selectedCount === total ? 'Clear all' : 'Select all';
}

function showExpenseErrors(errors) {
  const fields = [
    ['description', 'expense-description'],
    ['amount', 'expense-amount'],
    ['split', 'split-options'],
  ];
  for (const [key, inputId] of fields) {
    $(`${key}-error`).textContent = errors[key] || '';
    $(inputId).setAttribute('aria-invalid', String(Boolean(errors[key])));
  }
}

function openExpenseDialog(expense) {
  const event = getCurrentEvent();
  editingExpenseId = expense ? expense.id : null;

  $('dialog-title').textContent = expense ? 'Edit expense' : 'Add expense';
  $('expense-description').value = expense ? expense.description : '';
  $('expense-amount').value = expense ? paiseToInput(expense.amountPaise) : '';
  $('expense-payer').innerHTML = event.participants
    .map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
  if (expense) $('expense-payer').value = String(expense.paidById);
  $('split-options').innerHTML = event.participants.map((p) => {
    const checked = !expense || expense.splitAmongIds.includes(p.id);
    return `
      <label class="check-row">
        <input type="checkbox" value="${p.id}"${checked ? ' checked' : ''}>
        <span>${escapeHtml(p.name)}</span>
      </label>`;
  }).join('');

  showExpenseErrors({});
  updateSplitSummary();
  $('expense-dialog').showModal();
  $('expense-description').focus();
}

function handleExpenseSubmit(domEvent) {
  domEvent.preventDefault();
  const event = getCurrentEvent();
  const data = {
    description: $('expense-description').value.trim(),
    amountPaise: parseAmountToPaise($('expense-amount').value),
    paidById: Number($('expense-payer').value),
    splitAmongIds: getCheckedSplitIds(),
  };
  const errors = validateExpense(data);
  showExpenseErrors(errors);
  if (Object.keys(errors).length > 0) return;

  if (editingExpenseId !== null) {
    Object.assign(event.expenses.find((e) => e.id === editingExpenseId), data);
  } else {
    event.expenses.push({ id: newId(), ...data });
  }
  $('expense-dialog').close();
  render();
}

/* ---------- Wiring ---------- */

function init() {
  $('event-form').addEventListener('submit', (domEvent) => {
    domEvent.preventDefault();
    const name = $('event-name').value.trim();
    if (!name) {
      $('event-error').textContent = 'Give the event a name.';
      return;
    }
    $('event-name').value = '';
    $('event-error').textContent = '';
    openEvent(createEvent(name).id);
    $('participant-name').focus();
  });
  $('event-name').addEventListener('input', () => { $('event-error').textContent = ''; });

  $('event-list').addEventListener('click', (domEvent) => {
    const item = domEvent.target.closest('[data-event-id]');
    if (item) openEvent(Number(item.dataset.eventId));
  });

  $('back-btn').addEventListener('click', () => {
    state.currentEventId = null;
    render();
    window.scrollTo(0, 0);
  });

  $('participant-form').addEventListener('submit', (domEvent) => {
    domEvent.preventDefault();
    const event = getCurrentEvent();
    const input = $('participant-name');
    const name = input.value.trim().replace(/\s+/g, ' ');
    const error = $('participant-error');
    if (!name) {
      error.textContent = 'Enter a name.';
    } else if (event.participants.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      error.textContent = `${name} is already in this event.`;
    } else {
      event.participants.push({ id: newId(), name });
      input.value = '';
      error.textContent = '';
      render();
    }
    input.focus();
  });
  $('participant-name').addEventListener('input', () => { $('participant-error').textContent = ''; });

  $('participant-list').addEventListener('click', (domEvent) => {
    const button = domEvent.target.closest('[data-remove-id]');
    if (!button) return;
    const event = getCurrentEvent();
    const id = Number(button.dataset.removeId);
    const count = countExpensesInvolving(event, id);
    if (count > 0) {
      $('participant-error').textContent =
        `${participantName(event, id)} is part of ${plural(count, 'expense')}. Edit or delete ${count === 1 ? 'it' : 'them'} first.`;
      return;
    }
    event.participants = event.participants.filter((p) => p.id !== id);
    $('participant-error').textContent = '';
    render();
  });

  $('add-expense-btn').addEventListener('click', () => openExpenseDialog(null));

  $('copy-summary-btn').addEventListener('click', async () => {
    const copied = await copyToClipboard(buildShareText(getCurrentEvent()));
    flashLabel('copy-summary-label', copied ? 'Copied!' : 'Copy failed', 'Copy summary');
  });

  $('share-btn').addEventListener('click', async () => {
    const event = getCurrentEvent();
    if (!event.shareId) {
      event.shareId = randomShareId(); // events saved before sharing existed
      saveState();
    }
    const url = `${location.href.split('#')[0]}#e=${await encodeShareData(eventToSharePayload(event))}`;
    // Share sheet only on touch devices over http(s); desktop Chrome can crash the tab on navigator.share
    const useShareSheet = navigator.share && /^https?:$/.test(location.protocol)
      && matchMedia('(pointer: coarse)').matches;
    if (useShareSheet) {
      try {
        await navigator.share({ title: `${event.name} · Split`, url });
        return;
      } catch (err) {
        if (err.name === 'AbortError') return; // user closed the share sheet
      }
    }
    const copied = await copyToClipboard(url);
    flashLabel('share-label', copied ? 'Link copied!' : 'Copy failed', 'Share');
  });

  window.addEventListener('hashchange', importFromHash);

  $('expense-list').addEventListener('click', (domEvent) => {
    const button = domEvent.target.closest('[data-action]');
    if (!button) return;
    const event = getCurrentEvent();
    const expense = event.expenses.find((e) => e.id === Number(button.dataset.id));
    if (button.dataset.action === 'add') {
      openExpenseDialog(null);
    } else if (button.dataset.action === 'edit') {
      openExpenseDialog(expense);
    } else if (button.dataset.action === 'delete' && confirm(`Delete "${expense.description}"?`)) {
      event.expenses = event.expenses.filter((e) => e !== expense);
      render();
    }
  });

  const dialog = $('expense-dialog');
  $('expense-form').addEventListener('submit', handleExpenseSubmit);
  $('expense-amount').addEventListener('input', updateSplitSummary);
  $('split-options').addEventListener('change', updateSplitSummary);
  $('toggle-all').addEventListener('click', () => {
    const inputs = document.querySelectorAll('#split-options input');
    const selectAll = getCheckedSplitIds().length !== inputs.length;
    inputs.forEach((input) => { input.checked = selectAll; });
    updateSplitSummary();
  });
  $('dialog-close').addEventListener('click', () => dialog.close());
  $('dialog-cancel').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (domEvent) => {
    if (domEvent.target === dialog) dialog.close(); // backdrop click
  });

  loadState();
  render();
  importFromHash();
}

if (typeof document !== 'undefined') {
  init();
}

if (typeof module !== 'undefined') {
  module.exports = {
    parseAmountToPaise, paiseToInput, formatINR, splitShares, describeShare,
    computeBalances, computeSettlements, totalExpenses, countExpensesInvolving, validateExpense,
    buildShareText, eventToSharePayload, sharePayloadToEvent, encodeShareData, decodeShareData,
  };
}
