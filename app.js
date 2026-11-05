/* SplitBook – local-first expense journal with Google Drive sync (appDataFolder). No build step. */
'use strict';

/* ───────────────────────── helpers ───────────────────────── */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
const now = () => Date.now();
const jget = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const jset = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn('storage', e); } };
const COLL = ['people', 'books', 'entries'];
const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AUD', 'CAD', 'JPY', 'SGD', 'AED', 'CHF', 'CNY', 'BRL', 'ZAR', 'MXN'];
const SCOPE = 'openid email profile https://www.googleapis.com/auth/drive.appdata';
const FILE_NAME = 'splitbook-data.json';

/* money: stored as integer minor units, decimals depend on currency */
const digits = cur => { try { return new Intl.NumberFormat('en', { style: 'currency', currency: cur }).resolvedOptions().maximumFractionDigits; } catch { return 2; } };
const factor = cur => 10 ** digits(cur);
const fmt = (c, cur) => { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).format(c / factor(cur)); } catch { return (c / 100).toFixed(2) + ' ' + cur; } };
const parseMoney = (str, cur) => { const n = parseFloat(String(str).replace(/,/g, '.').replace(/[^\d.\-]/g, '')); return isFinite(n) ? Math.round(n * factor(cur)) : 0; };
const toInput = (c, cur) => (c / factor(cur)).toFixed(digits(cur));

/* ───────────────────────── state & persistence ───────────────────────── */
const emptyDoc = () => ({ v: 1, people: {}, books: {}, entries: {} });
const S = {
  doc: jget('sb.doc', null) || emptyDoc(),
  meta: Object.assign({ fileId: null, lastSync: 0, dirty: false, user: null, clientId: '', token: null, tokenExp: 0, wasSignedIn: false }, jget('sb.meta', {})),
  ui: { view: 'home', bookId: null, tab: 'entries', limit: 40 },
  sync: { state: 'idle', error: '' }, // idle | busy | err
};
const persist = () => { jset('sb.doc', S.doc); jset('sb.meta', S.meta); };
const live = coll => Object.values(S.doc[coll]).filter(x => !x.deleted);
const me = () => live('people').find(p => p.isMe);
const person = id => S.doc.people[id];
const pname = id => { const p = person(id); return p ? (p.isMe ? 'You' : p.name) : '?'; };
const bookEntries = bid => live('entries').filter(e => e.bookId === bid).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);

function put(coll, obj) {
  obj.updatedAt = now();
  S.doc[coll][obj.id] = obj;
  touched();
}
function del(coll, id) {
  const o = S.doc[coll][id]; if (!o) return null;
  S.doc[coll][id] = { id, deleted: true, updatedAt: now(), bookId: o.bookId }; // tombstone
  touched(); return o;
}
function touched() { S.meta.dirty = true; persist(); render(); scheduleSync(); }

/* Merge two docs: per-record last-writer-wins (tombstones included). */
function mergeDocs(local, remote) {
  const out = emptyDoc(); let remoteStale = false, localChanged = false;
  for (const c of COLL) {
    const a = local[c] || {}, b = (remote && remote[c]) || {};
    for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const x = a[id], y = b[id];
      if (x && (!y || x.updatedAt > y.updatedAt)) { out[c][id] = x; remoteStale = true; }
      else { out[c][id] = y; if (!x || y.updatedAt > x.updatedAt) localChanged = true; }
    }
  }
  return { doc: out, remoteStale, localChanged };
}

/* ───────────────────────── split & balance maths ───────────────────────── */
/* Largest-remainder allocation of `total` minor units by weights. */
function byWeights(total, weights) {
  const ids = Object.keys(weights), sum = ids.reduce((s, i) => s + weights[i], 0);
  if (!ids.length || sum <= 0) return {};
  const raw = ids.map(i => ({ i, v: total * weights[i] / sum }));
  const res = {}; let used = 0;
  raw.forEach(r => { res[r.i] = Math.floor(r.v); used += res[r.i]; });
  raw.sort((a, b) => (b.v - Math.floor(b.v)) - (a.v - Math.floor(a.v)));
  for (let k = 0; k < total - used; k++) res[raw[k % raw.length].i]++;
  return res;
}
function netBalances(bookId) {
  const net = {};
  for (const e of bookEntries(bookId)) {
    if (e.type === 'income') continue;          // income is personal money in, not a debt between people
    net[e.paidBy] = (net[e.paidBy] || 0) + e.amount;
    for (const [p, c] of Object.entries(e.split)) net[p] = (net[p] || 0) - c;
  }
  return net;
}
/* Greedy debt simplification → minimal-ish list of {from,to,amt}. */
function simplify(net) {
  const cr = [], db = [];
  for (const [p, v] of Object.entries(net)) { if (v > 0) cr.push([p, v]); else if (v < 0) db.push([p, -v]); }
  cr.sort((a, b) => b[1] - a[1]); db.sort((a, b) => b[1] - a[1]);
  const out = []; let i = 0, j = 0;
  while (i < cr.length && j < db.length) {
    const m = Math.min(cr[i][1], db[j][1]);
    out.push({ from: db[j][0], to: cr[i][0], amt: m });
    cr[i][1] -= m; db[j][1] -= m;
    if (!cr[i][1]) i++; if (!db[j][1]) j++;
  }
  return out;
}

/* ───────────────────────── Google auth + Drive ───────────────────────── */
const clientId = () => S.meta.clientId || (window.SPLITBOOK_CONFIG && window.SPLITBOOK_CONFIG.GOOGLE_CLIENT_ID) || '';
let gsiPromise = null, tokenClient = null, tokenResolver = null;
const loadGsi = () => gsiPromise || (gsiPromise = new Promise((res, rej) => {
  if (window.google && google.accounts && google.accounts.oauth2) return res();
  const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
  s.onload = res; s.onerror = () => { gsiPromise = null; rej(new Error('Could not load Google sign-in (offline?)')); };
  document.head.appendChild(s);
}));
function haveToken() { return S.meta.token && S.meta.tokenExp - 60000 > now(); }

async function requestToken(interactive) {
  const cid = clientId();
  if (!cid) throw new Error('Google sign-in is not enabled for this app.');
  await loadGsi();
  if (!tokenClient) {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: cid, scope: SCOPE, callback: r => tokenResolver && tokenResolver.ok(r),
      error_callback: e => tokenResolver && tokenResolver.fail(new Error(e.type || 'auth error')),
    });
  }
  return new Promise((ok, fail) => {
    tokenResolver = {
      ok: r => {
        if (r.error) return fail(new Error(r.error_description || r.error));
        S.meta.token = r.access_token; S.meta.tokenExp = now() + (r.expires_in || 3600) * 1000;
        S.meta.wasSignedIn = true; persist(); ok(r.access_token);
      }, fail,
    };
    tokenClient.requestAccessToken({ prompt: interactive ? (S.meta.wasSignedIn ? '' : 'consent') : '' });
  });
}
async function ensureToken(interactive) { return haveToken() ? S.meta.token : requestToken(interactive); }

async function signIn() {
  try {
    await requestToken(true);
    const u = await gfetch('https://www.googleapis.com/oauth2/v3/userinfo');
    S.meta.user = await u.json(); persist();
    const mp = me(); if (mp && mp.name === 'Me' && S.meta.user.given_name) put('people', { ...mp, name: S.meta.user.given_name });
    toast('Signed in as ' + (S.meta.user.email || 'Google user'));
    await sync(true);
  } catch (e) { toast(e.message); }
  render();
}
function signOut() {
  try { if (S.meta.token && window.google) google.accounts.oauth2.revoke(S.meta.token, () => {}); } catch {}
  Object.assign(S.meta, { token: null, tokenExp: 0, user: null, fileId: null, wasSignedIn: false, lastSync: 0 });
  persist(); render(); toast('Signed out. Data stays on this device.');
}

async function gfetch(url, opts = {}, retry = true) {
  const tok = await ensureToken(false);
  const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + tok } });
  if (res.status === 401 && retry) { S.meta.tokenExp = 0; return gfetch(url, opts, false); }
  if (!res.ok) throw new Error('Drive error ' + res.status);
  return res;
}
async function driveFind() {
  const q = encodeURIComponent(`name='${FILE_NAME}' and trashed=false`);
  const r = await gfetch(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,modifiedTime)&orderBy=modifiedTime desc`);
  const f = (await r.json()).files || [];
  return f[0] || null;
}
async function driveRead(id) { return (await (await gfetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`)).json()); }
async function driveWrite(id, doc) {
  const body = JSON.stringify(doc);
  if (id) {
    await gfetch(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body });
    return id;
  }
  const b = 'sbound' + uid();
  const multipart = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: FILE_NAME, parents: ['appDataFolder'], mimeType: 'application/json' })}\r\n--${b}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${b}--`;
  const r = await gfetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + b }, body: multipart });
  return (await r.json()).id;
}

/* ───────────────────────── sync engine ───────────────────────── */
let syncTimer = null, syncing = false;
function scheduleSync() { clearTimeout(syncTimer); syncTimer = setTimeout(() => sync(false), 400); }
async function sync(interactive) {
  if (syncing || !S.meta.wasSignedIn || !navigator.onLine) return;
  if (!interactive && !haveToken() && !S.meta.token) return;
  syncing = true; S.sync = { state: 'busy', error: '' }; paintStatus();
  try {
    let f = S.meta.fileId ? { id: S.meta.fileId } : await driveFind();
    let remote = null;
    if (f) {
      try { remote = await driveRead(f.id); }
      catch (e) { if (/404/.test(e.message)) { S.meta.fileId = null; f = await driveFind(); remote = f ? await driveRead(f.id) : null; } else throw e; }
    }
    // Brand-new device: adopt remote wholesale instead of merging a pristine local doc.
    const pristine = !live('books').filter(b => !b.personal).length && !live('entries').length;
    if (remote && pristine) { for (const p of live('people')) if (p.isMe && !(remote.people && remote.people[p.id])) delete S.doc.people[p.id]; }
    const m = mergeDocs(S.doc, remote);
    S.doc = m.doc;
    ensureMe(); ensurePersonal();
    let id = f && f.id;
    if (!remote || m.remoteStale || S.meta.dirty) id = await driveWrite(id, S.doc);
    S.meta.fileId = id; S.meta.dirty = false; S.meta.lastSync = now();
    S.sync = { state: 'idle', error: '' };
    persist(); render(); materializeRecurring();
  } catch (e) {
    S.sync = { state: 'err', error: e.message }; console.warn('sync', e); paintStatus();
  } finally { syncing = false; }
}
function ensureMe() {
  if (me()) return;
  const name = (S.meta.user && S.meta.user.given_name) || (S.meta.user && S.meta.user.name) || 'Me';
  const p = { id: uid(), name, isMe: true, createdAt: now() };
  S.doc.people[p.id] = { ...p, updatedAt: now() }; S.meta.dirty = true; persist();
}
/* "My money": a built-in single-person book for income & expenses. Fixed id → every device converges on the same one. */
const PERSONAL_ID = 'my-money';
const personalBook = () => { const b = S.doc.books[PERSONAL_ID]; return b && !b.deleted ? b : null; };
function ensurePersonal() {
  const m = me(); if (!m) return;
  const b = S.doc.books[PERSONAL_ID];
  if (!b) { S.doc.books[PERSONAL_ID] = { id: PERSONAL_ID, name: 'My money', emoji: '👛', currency: localeCurrency(), memberIds: [m.id], personal: true, createdAt: 1, updatedAt: 1 }; persist(); }
  else if (!b.deleted && b.memberIds[0] !== m.id) b.memberIds = [m.id];     // follow this device's "me"
}
function monthStats(bookId, ym) {
  let inc = 0, exp = 0;
  for (const e of bookEntries(bookId)) { if (!e.date.startsWith(ym)) continue; if (e.type === 'income') inc += e.amount; else if (e.type === 'expense') exp += e.amount; }
  return { inc, exp, net: inc - exp };
}
function statusInfo() {
  if (!S.meta.wasSignedIn) return { cls: '', text: 'Local only' };
  if (!navigator.onLine) return { cls: 'pending', text: S.meta.dirty ? 'Offline · changes queued' : 'Offline' };
  if (S.sync.state === 'busy') return { cls: 'busy', text: 'Syncing…' };
  if (S.sync.state === 'err') return { cls: 'err', text: 'Sync failed' };
  if (S.meta.dirty) return { cls: 'pending', text: 'Pending' };
  return { cls: 'ok', text: 'Synced' };
}
function paintStatus() { const el = $('#status'); if (!el) return; const s = statusInfo(); el.title = s.text; el.innerHTML = `<span class="sync-dot ${s.cls}"></span><span class="st-t">${s.text}</span>`; }


/* ───────────────────────── recurring entries ───────────────────────── */
/* A template is an ordinary entry with `repeat`. Occurrences get deterministic ids (`<template>~<date>`) so every
   device that generates them produces the same record and merging never duplicates. */
function nthOccurrence(t, i) {
  const [y, m, d] = t.date.split('-').map(Number);
  if (t.repeat === 'weekly') return ymd(new Date(y, m - 1, d + 7 * i));
  let Y = y, M = m - 1;
  if (t.repeat === 'yearly') Y = y + i; else { M = m - 1 + i; Y = y + Math.floor(M / 12); M = ((M % 12) + 12) % 12; }
  return ymd(new Date(Y, M, Math.min(d, new Date(Y, M + 1, 0).getDate())));   // 31 Jan → 28/29 Feb → 31 Mar
}
function occurrences(t, until) {
  const out = []; for (let i = 1; i <= 800; i++) { const d = nthOccurrence(t, i); if (d > until) break; out.push(d); } return out;
}
function nextDue(t, from = isoDay(Date.now())) {
  for (let i = 1; i <= 800; i++) { const d = nthOccurrence(t, i); if (d > from) return d; } return null;
}
const PERIOD = { weekly: 'week', monthly: 'month', yearly: 'year' };
const perMonth = t => t.amount * (t.repeat === 'weekly' ? 52 / 12 : t.repeat === 'yearly' ? 1 / 12 : 1);
function materializeRecurring() {
  const today = isoDay(Date.now()); let n = 0;
  for (const t of live('entries').filter(e => e.repeat && PERIOD[e.repeat])) {
    for (const date of occurrences(t, today)) {
      const id = t.id + '~' + date;
      if (S.doc.entries[id]) continue;                       // exists, or was deleted (tombstone) → never resurrect
      const ms = new Date(date + 'T00:00').getTime(), c = { ...t, id, date, fromRule: t.id, createdAt: ms, updatedAt: ms };
      delete c.repeat; S.doc.entries[id] = c; n++;           // old updatedAt: any real edit elsewhere wins the merge
    }
  }
  if (n) { S.meta.dirty = true; persist(); render(); scheduleSync(); }
  return n;
}

/* ───────────────────────── loans: principal, repayments, simple interest ───────────────────────── */
const isLoan = e => e.type === 'expense' && e.cat === '💸' && !e.interestFor && Object.keys(e.split).length === 1 && Object.keys(e.split)[0] !== e.paidBy;
/* Repayments (payments borrower→lender) clear charged interest first, then principal, oldest loan first.
   Interest is simple, per year, on the outstanding principal; it only changes balances once you "add it". */
function loanReport(bookId, asOf = isoDay(Date.now())) {
  const es = bookEntries(bookId), loans = es.filter(isLoan), pairs = {}, out = [];
  loans.forEach(l => (pairs[l.paidBy + '>' + Object.keys(l.split)[0]] = pairs[l.paidBy + '>' + Object.keys(l.split)[0]] || []).push(l));
  for (const [k, ls] of Object.entries(pairs)) {
    const [lender, borrower] = k.split('>'), ev = [];
    ls.forEach(l => ev.push({ t: 'loan', date: l.date, o: 0, e: l }));
    es.filter(e => e.interestFor && ls.some(l => l.id === e.interestFor)).forEach(e => ev.push({ t: 'charge', date: e.date, o: 1, e }));
    es.filter(e => e.type === 'settle' && e.paidBy === borrower && Object.keys(e.split).length === 1 && e.split[lender] !== undefined).forEach(e => ev.push({ t: 'repay', date: e.date, o: 2, e }));
    ev.sort((a, b) => a.date.localeCompare(b.date) || a.o - b.o || a.e.createdAt - b.e.createdAt);
    const st = {}, order = [];
    const accrue = date => { for (const id of order) { const s = st[id]; if (date > s.last) { s.acc += s.out * (s.rate / 100) * daysBetween(s.last, date) / 365; s.last = date; } } };
    for (const x of ev) {
      accrue(x.date);
      if (x.t === 'loan') { st[x.e.id] = { l: x.e, out: x.e.amount, intDebt: 0, charged: 0, repaid: 0, acc: 0, last: x.date, rate: (x.e.loan && +x.e.loan.rate) || 0 }; order.push(x.e.id); }
      else if (x.t === 'charge') { const s = st[x.e.interestFor]; if (s) { s.charged += x.e.amount; s.intDebt += x.e.amount; } }
      else { let amt = x.e.amount; for (const id of order) { const s = st[id]; if (!amt) break;
        const pi = Math.min(s.intDebt, amt); s.intDebt -= pi; amt -= pi; const pp = Math.min(s.out, amt); s.out -= pp; amt -= pp; s.repaid += pi + pp; } }
    }
    accrue(asOf);
    for (const id of order) {
      const s = st[id], due = (s.l.loan && s.l.loan.due) || '', accrued = Math.round(s.acc), pending = Math.max(0, accrued - s.charged);
      const daysLeft = due ? daysBetween(asOf, due) : null, settled = s.out === 0 && s.intDebt === 0 && pending === 0;
      out.push({ id, entry: s.l, lender, borrower, principal: s.l.amount, repaid: s.repaid, out: s.out, rate: s.rate, accrued, charged: s.charged, pending, intDebt: s.intDebt,
        due, daysLeft, overdue: !!due && daysLeft < 0 && !settled, settled });
    }
  }
  return out.sort((a, b) => (a.settled - b.settled) || (b.entry.date.localeCompare(a.entry.date)));
}
function chargeInterest(loanId) {
  const l = S.doc.entries[loanId], r = loanReport(l.bookId).find(x => x.id === loanId);
  if (!r || r.pending <= 0) return null;
  const id = uid(); put('entries', { id, bookId: l.bookId, type: 'expense', desc: 'Interest · ' + l.desc, amount: r.pending, paidBy: l.paidBy, split: { [r.borrower]: r.pending },
    method: 'exact', date: isoDay(Date.now()), cat: '💸', note: `${r.rate}% p.a.`, interestFor: loanId, createdAt: now() });
  return id;
}

/* ───────────────────────── UI: helpers ───────────────────────── */
const HUES = [252, 199, 152, 24, 340, 45, 175, 290];
const hueOf = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return HUES[h % HUES.length]; };
const initials = n => (String(n).trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2) || '?').toUpperCase();
const avatar = (id, cls = '') => { const p = person(id); return `<span class="av ${cls}" style="--h:${hueOf(id)}">${esc(initials(p ? p.name : '?'))}</span>`; };
const avStack = ids => `<span class="avs">${ids.slice(0, 4).map(i => avatar(i, 'xs')).join('')}${ids.length > 4 ? `<span class="av xs more">+${ids.length - 4}</span>` : ''}</span>`;
const CATS = [['🧾', 'Other'], ['🍽️', 'Food'], ['🛒', 'Groceries'], ['🚗', 'Transport'], ['🏠', 'Home'], ['🎬', 'Fun'], ['✈️', 'Travel'], ['💡', 'Bills'], ['🎁', 'Gift'], ['🏥', 'Health'], ['🔁', 'Subscription'], ['💸', 'Loan']];
const INCOME_CATS = [['💼', 'Salary'], ['💻', 'Freelance'], ['📈', 'Investing'], ['🎁', 'Gift'], ['↩️', 'Refund'], ['➕', 'Other']];
const catName = c => (CATS.concat(INCOME_CATS).find(([k]) => k === c) || [])[1] || '';
const symbol = cur => { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).formatToParts(0).find(p => p.type === 'currency').value; } catch { return cur; } };
const ymd = dt => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
const isoDay = d => ymd(new Date(d));
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00') - new Date(a + 'T00:00')) / 864e5);
const shortDate = d => new Date(d + 'T00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const dayLabel = d => {
  if (d === isoDay(Date.now())) return 'Today';
  if (d === isoDay(Date.now() - 864e5)) return 'Yesterday';
  return new Date(d + 'T00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
};


/* ───────────────────────── in-app dialogs (no native confirm/alert/prompt/select) ───────────────────────── */
function openLayer(html, cls = '') {
  let res; const done = new Promise(r => { res = r; });
  const el = document.createElement('div'); el.className = 'layer ' + cls; el.innerHTML = html;
  const close = v => { if (el.isConnected) { el.remove(); res(v); } };
  el._close = close; el.addEventListener('pointerdown', e => { if (e.target === el) close(null); });
  document.body.appendChild(el); return { el, done, close };
}
function askConfirm({ title, message = '', ok = 'OK', cancel = 'Cancel', danger = false }) {
  const L = openLayer(`<div class="dlg" role="alertdialog" aria-modal="true" aria-label="${esc(title)}"><h3>${esc(title)}</h3>${message ? `<p>${esc(message)}</p>` : ''}
    <div class="btns two"><button class="btn" data-x="no">${esc(cancel)}</button><button class="btn ${danger ? 'danger-fill' : 'primary'}" data-x="ok">${esc(ok)}</button></div></div>`, 'center');
  L.el.addEventListener('click', e => { const x = e.target.closest('[data-x]'); if (x) L.close(x.dataset.x === 'ok'); });
  setTimeout(() => { const n = L.el.querySelector('[data-x=no]'); n && n.focus(); }, 30);   // safe default
  return L.done.then(v => !!v);
}
const CUR_POPULAR = ['INR', 'USD', 'EUR', 'GBP', 'AUD', 'CAD', 'SGD', 'AED', 'JPY', 'CHF', 'CNY', 'NZD'];
let _curs = null;
function allCurrencies() {
  if (_curs) return _curs;
  let codes = []; try { codes = Intl.supportedValuesOf('currency'); } catch {}
  if (codes.length < 20) codes = [...CURRENCIES];
  let dn = null; try { dn = new Intl.DisplayNames([navigator.language || 'en', 'en'], { type: 'currency' }); } catch {}
  return (_curs = codes.map(c => { let name = c; try { name = (dn && dn.of(c)) || c; } catch {} return { code: c, name, sym: symbol(c) }; }));
}
const curName = c => (allCurrencies().find(x => x.code === c) || { name: c }).name;
function pickCurrency(current) {
  const L = openLayer(`<div class="sheet picker" role="dialog" aria-modal="true" aria-label="Choose currency"><div class="grab"></div>
    <div class="sh-head"><h2>Currency</h2><button class="iconbtn" data-x="x" aria-label="Close">✕</button></div>
    <input id="cq" class="desc" placeholder="Search — rupee, EUR, dollar…" autocomplete="off" autocapitalize="off"><div id="cl" class="clist"></div></div>`, 'bottom');
  const list = $('#cl', L.el), row = c => `<button class="cur-row ${c.code === current ? 'on' : ''}" data-v="${c.code}"><span class="cur-sym">${esc(c.sym)}</span><span class="grow"><b>${c.code}</b><small>${esc(c.name)}</small></span>${c.code === current ? '<i>✓</i>' : ''}</button>`;
  const draw = q => {
    const all = allCurrencies(); q = q.trim().toLowerCase();
    if (q) { const score = c => { const code = c.code.toLowerCase(), name = c.name.toLowerCase();
        return code === q ? 0 : code.startsWith(q) ? 1 : name.split(/[\s()-]+/).some(w => w.startsWith(q)) ? 2 : c.sym.toLowerCase() === q ? 2 : (code.includes(q) || name.includes(q)) ? 3 : 9; };
      const r = all.map(c => [score(c), c]).filter(x => x[0] < 9).sort((x, y) => x[0] - y[0] || x[1].code.localeCompare(y[1].code)).map(x => x[1]); list.innerHTML = r.length ? r.map(row).join('') : `<div class="empty small"><b>No match</b><p>Try the 3-letter code, e.g. “CHF”.</p></div>`; return; }
    const pop = [...new Set([current, ...CUR_POPULAR])].map(c => all.find(x => x.code === c)).filter(Boolean);
    list.innerHTML = `<div class="lbl">Popular</div>${pop.map(row).join('')}<div class="lbl">All currencies</div>${all.map(row).join('')}`;
  };
  draw('');
  L.el.addEventListener('input', e => { if (e.target.id === 'cq') draw(e.target.value); });
  L.el.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'cq') { const f = list.querySelector('.cur-row'); f && L.close(f.dataset.v); } });
  L.el.addEventListener('click', e => { const t = e.target.closest('[data-v],[data-x]'); if (!t) return; L.close(t.dataset.v || null); });
  setTimeout(() => { const q = $('#cq', L.el); q && q.focus(); }, 60);
  return L.done;
}
/* Changing a book's currency keeps the face value of every amount (₹100.00 → ¥100): no exchange-rate conversion. */
function changeCurrency(bookId, cur) {
  const b = S.doc.books[bookId]; if (!b || b.currency === cur) return;
  const k = digits(cur) - digits(b.currency), m = 10 ** Math.abs(k), conv = v => k >= 0 ? v * m : Math.round(v / m);
  for (const e of bookEntries(bookId)) {
    const amount = conv(e.amount), keys = Object.keys(e.split), w = {}; keys.forEach(i => w[i] = e.split[i]);
    put('entries', { ...e, amount, split: keys.length ? (k >= 0 ? Object.fromEntries(keys.map(i => [i, e.split[i] * m])) : byWeights(amount, w)) : {} });
  }
  put('books', { ...b, currency: cur });
}

/* ───────────────────────── UI: toast & routing ───────────────────────── */
let toastT;
function toast(msg, undo) {
  const t = $('#toast'); t.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button>Undo</button>' : ''}`;
  t.classList.toggle('act', !!undo); t.classList.add('show');
  if (undo) t.querySelector('button').onclick = () => { undo(); t.classList.remove('show'); };
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), undo ? 5500 : 2800);
}
function route() {
  const m = location.hash.slice(1).match(/^book\/(.+)$/);
  if (m && S.doc.books[m[1]] && !S.doc.books[m[1]].deleted) { S.ui.view = 'book'; S.ui.bookId = m[1]; }
  else { S.ui.view = 'home'; S.ui.bookId = null; }
  window.scrollTo(0, 0); render();
}
const go = h => { location.hash = h; };

/* ───────────────────────── UI: views ───────────────────────── */
const statusPill = () => `<button class="pill" id="status" data-act="sync-now" aria-label="Sync status"></button>`;
function render() {
  const app = $('#app'); if (!app) return;
  if (!me()) ensureMe();
  if (S.ui.view === 'book') {                       // book deleted here or on another device → go home
    const bk = S.doc.books[S.ui.bookId];
    if (!bk || bk.deleted) { S.ui.view = 'home'; S.ui.bookId = null; if (location.hash) history.replaceState(null, '', location.pathname + location.search); }
  }
  try { const pb = S.ui.view === 'book' && S.doc.books[S.ui.bookId]; app.innerHTML = pb ? (pb.personal ? personalView(pb) : bookView()) : homeView(); }
  catch (e) { console.error('render', e); app.innerHTML = `<div class="empty"><div class="ico">⚠️</div><b>Something went wrong</b><p>Your data is safe on this device.</p><button class="btn sm" onclick="location.hash='';location.reload()">Reload</button></div>`; }
  paintStatus();
}
const money = (v, cur, signed) => (signed && v > 0 ? '+' : '') + fmt(v, cur).replace(/^-/, '−');


const cap = x => x.charAt(0).toUpperCase() + x.slice(1);
const whoName = id => (me() && id === me().id) ? 'you' : pname(id);
function recurringBlock(b) {
  const ts = live('entries').filter(e => e.bookId === b.id && e.repeat && PERIOD[e.repeat]);
  if (!ts.length) return '';
  const sum = f => Math.round(ts.filter(f).reduce((s, t) => s + perMonth(t), 0)), inc = sum(t => t.type === 'income'), exp = sum(t => t.type !== 'income');
  const parts = []; if (inc) parts.push('+' + fmt(inc, b.currency)); if (exp || !inc) parts.push((inc ? '−' : '') + fmt(exp, b.currency));
  return `<div class="sec-h">Recurring · ${parts.join(' · ')}/mo</div>` + ts.map(t => `<button class="tx rec" data-act="edit-entry" data-id="${t.id}"><span class="tx-ico">${t.type === 'income' ? esc(t.cat || '💼') : '🔁'}</span>
    <span class="tx-mid"><b>${esc(t.desc)}</b><small>Every ${PERIOD[t.repeat]} · next ${shortDate(nextDue(t))}</small></span><span class="tx-end">${t.type === 'income' ? `<b class="pos">+${fmt(t.amount, b.currency)}</b><small>income</small>` : `<b>${fmt(t.amount, b.currency)}</b><small>${b.personal ? 'expense' : esc(pname(t.paidBy)) + ' pays'}</small>`}</span></button>`).join('') + `<div class="sec-h">Activity</div>`;
}
function loansBlock(b) {
  const rs = loanReport(b.id), cur = b.currency; if (!rs.length) return '';
  const open = rs.filter(r => !r.settled), done = rs.filter(r => r.settled);
  const chip = r => !r.due ? '' : r.overdue ? `<span class="chip-b neg">Overdue ${-r.daysLeft}d</span>` : r.daysLeft <= 7 ? `<span class="chip-b warn">${r.daysLeft === 0 ? 'Due today' : 'Due in ' + r.daysLeft + 'd'}</span>` : `<span class="chip-b zero">Due ${shortDate(r.due)}</span>`;
  const card = r => `<div class="loan"><div class="loan-h"><span class="tx-ico">💸</span><div class="grow"><b>${esc(r.entry.desc)}</b>
      <small>${esc(cap(whoName(r.lender)))} lent ${esc(whoName(r.borrower))} ${fmt(r.principal, cur)}${r.rate ? ` · ${r.rate}% a year` : ''}</small></div>${chip(r)}</div>
    <div class="loan-n"><div><small>Repaid</small><b>${fmt(r.repaid, cur)}</b></div><div><small>Outstanding</small><b class="${r.out ? 'neg' : 'pos'}">${fmt(r.out + r.intDebt, cur)}</b></div>${r.rate ? `<div><small>Interest so far</small><b>${fmt(r.accrued, cur)}</b></div>` : ''}</div>
    <div class="btns"><button class="btn sm" data-act="repay-loan" data-id="${r.id}">Record repayment</button>${r.pending > 0 ? `<button class="btn sm ghost" data-act="charge-interest" data-id="${r.id}">+ ${fmt(r.pending, cur)} interest</button>` : ''}</div></div>`;
  return `<div class="sec-h">Loans</div>` + open.map(card).join('') + done.map(r => `<div class="loan done">✓ ${esc(r.entry.desc)} <small>· fully repaid</small></div>`).join('');
}
function dueBanner() {
  const m = me(); if (!m) return ''; let best = null;
  for (const b of live('books')) for (const r of loanReport(b.id)) {
    if (r.settled || !r.due || (r.lender !== m.id && r.borrower !== m.id)) continue;
    if (r.daysLeft <= 7 && (!best || r.daysLeft < best.r.daysLeft)) best = { r, b };
  }
  if (!best) return '';
  const { r, b } = best, when = r.overdue ? `overdue by ${-r.daysLeft} day${r.daysLeft === -1 ? '' : 's'}` : r.daysLeft === 0 ? 'due today' : `due in ${r.daysLeft} day${r.daysLeft === 1 ? '' : 's'}`;
  return `<button class="banner due" data-act="open-loans" data-id="${b.id}"><span>⏰</span><span><b>${r.lender === m.id ? esc(pname(r.borrower)) + '’s loan' : 'Your loan'} ${when}</b><small>${fmt(r.out + r.intDebt, b.currency)} · ${esc(b.name)}</small></span><i>›</i></button>`;
}

function myMoneyCard(pb) {
  if (!pb) return '';
  const cur = pb.currency, ym = isoDay(Date.now()).slice(0, 7), st = monthStats(pb.id, ym);
  return `<section class="card mm"><button class="mm-top" data-act="open-personal"><span class="mm-t">👛 My money <small>${new Date().toLocaleDateString(undefined, { month: 'long' })}</small></span><i>›</i></button>
    <div class="mm-n ${st.net < 0 ? 'neg' : ''}">${money(st.net, cur, true)}</div><div class="mm-s">left this month</div>
    <div class="mm-row"><div><span class="dot pos"></span>Income<b>${fmt(st.inc, cur)}</b></div><div><span class="dot neg"></span>Spent<b>${fmt(st.exp, cur)}</b></div></div>
    <div class="btns two"><button class="btn" data-act="add-income">＋ Income</button><button class="btn" data-act="add-expense">− Expense</button></div></section>`;
}
function homeView() {
  const m = me(), books = live('books').filter(b => !b.personal).sort((a, b) => b.updatedAt - a.updatedAt), tot = {}, pb = personalBook();
  const cards = books.map(b => {
    const net = netBalances(b.id), mine = m ? (net[m.id] || 0) : 0;
    (tot[b.currency] = tot[b.currency] || { owed: 0, owe: 0 })[mine > 0 ? 'owed' : 'owe'] += Math.abs(mine);
    const chip = Math.abs(mine) < 1 ? `<span class="chip-b zero">Settled</span>` : mine > 0 ? `<span class="chip-b pos">+${fmt(mine, b.currency)}</span>` : `<span class="chip-b neg">−${fmt(-mine, b.currency)}</span>`;
    return `<button class="bk" data-act="open-book" data-id="${b.id}"><span class="bk-ico">${esc(b.emoji || '📒')}</span>
      <span class="bk-mid"><b>${esc(b.name)}</b>${avStack(b.memberIds)}</span>${chip}</button>`;
  }).join('');
  const cnt = {}; books.forEach(b => cnt[b.currency] = (cnt[b.currency] || 0) + 1);
  const cur = Object.keys(tot).sort((x, y) => cnt[y] - cnt[x]);   // most-used currency leads
  const hero = cur.length ? (() => {
    const netOf = c => tot[c].owed - tot[c].owe, c0 = cur[0], n0 = netOf(c0);
    return `<section class="hero"><div class="hero-l">Overall balance</div>
      <div class="hero-n ${n0 < 0 ? 'neg' : ''}">${money(n0, c0, true)}</div>
      <div class="hero-s">${n0 === 0 ? 'You are all settled up' : n0 > 0 ? 'in your favour across all books' : 'you owe across all books'}${cur.slice(1).map(c => ` · ${money(netOf(c), c, true)}`).join('')}</div>
      <div class="hero-row"><div><span class="dot pos"></span>Owed to you${cur.filter(c => tot[c].owed).map(c => `<b>${fmt(tot[c].owed, c)}</b>`).join('') || '<b>—</b>'}</div>
      <div><span class="dot neg"></span>You owe${cur.filter(c => tot[c].owe).map(c => `<b>${fmt(tot[c].owe, c)}</b>`).join('') || '<b>—</b>'}</div></div></section>`;
  })() : (pb && bookEntries(PERSONAL_ID).length) ? '' : `<section class="hero welcome"><div class="hero-l">Welcome to SplitBook</div><div class="hero-t">Your money,<br>on your own terms.</div>
      <ol class="steps"><li><i>1</i>Add income &amp; expenses to <b>My money</b></li><li><i>2</i>Make a book to split costs with others</li><li><i>3</i>See who owes who and settle up</li></ol>
      ${(!m || m.name === 'Me') ? `<input id="wn" class="wn" placeholder="Your name (optional)" maxlength="40" autocomplete="given-name">` : ''}</section>`;
  const backup = (S.meta.wasSignedIn || !clientId()) ? '' : `<button class="banner" data-act="settings"><span>☁️</span><span><b>Back up to Google Drive</b><small>Sync across devices. Works offline.</small></span><i>›</i></button>`;
  const name = (m && m.name !== 'Me' && m.name) || '';
  return `<header class="top"><div>${name ? `<small>Hi,</small><h1>${esc(name)} 👋</h1>` : `<h1>Welcome 👋</h1>`}</div>${statusPill()}
      <button class="iconbtn" data-act="settings" aria-label="Settings">${m ? avatar(m.id) : '⚙️'}</button></header>
    <main>${hero}${myMoneyCard(pb)}${dueBanner()}${backup}<div class="sec-h">Shared books</div><div class="list">${cards}<button class="bk new" data-act="new-book"><span class="bk-ico">＋</span><span class="bk-mid"><b>${books.length ? 'New book' : 'New shared book'}</b>${books.length ? '' : '<small class="muted">Split costs with friends, a trip, your flat…</small>'}</span></button></div></main>
    <button class="fab" data-act="quick-add" aria-label="Add"><i>＋</i><span>Add</span></button>`;
}

function personalView(b) {
  const cur = b.currency, tab = S.ui.tab === 'summary' ? 'summary' : 'entries', es = bookEntries(b.id);
  const ym = isoDay(Date.now()).slice(0, 7), st = monthStats(b.id, ym);
  const balance = es.reduce((s, e) => s + (e.type === 'income' ? e.amount : e.type === 'expense' ? -e.amount : 0), 0);
  const hero = `<section class="hero compact"><div class="hero-l">${new Date().toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</div>
    <div class="hero-n ${st.net < 0 ? 'neg' : ''}">${money(st.net, cur, true)}</div><div class="hero-s">income minus spending this month</div>
    <div class="hero-row"><div><span class="dot pos"></span>Income<b>${fmt(st.inc, cur)}</b></div><div><span class="dot neg"></span>Spent<b>${fmt(st.exp, cur)}</b></div><div>All-time<b>${money(balance, cur)}</b></div></div></section>`;
  const tabs = [['entries', 'Activity'], ['summary', 'Summary']].map(([k, l]) => `<button class="${tab === k ? 'on' : ''}" data-act="tab" data-tab="${k}">${l}</button>`).join('');
  let body = '';
  if (tab === 'entries') {
    let last = '';
    body = es.length ? es.slice(0, S.ui.limit).map(e => {
      const day = dayLabel(e.date), head = day !== last ? `<div class="day">${day}</div>` : ''; last = day;
      const inc = e.type === 'income';
      return head + `<button class="tx" data-act="edit-entry" data-id="${e.id}"><span class="tx-ico ${inc ? 'pay' : ''}">${esc(e.cat || (inc ? '💼' : '🧾'))}</span>
        <span class="tx-mid"><b>${esc(e.desc || (inc ? 'Income' : 'Expense'))}</b><small>${esc(catName(e.cat) || (inc ? 'Income' : 'Expense'))}${e.fromRule || e.repeat ? ' · 🔁' : ''}</small></span>
        <span class="tx-end"><b class="${inc ? 'pos' : 'neg'}">${inc ? '+' : '−'}${fmt(e.amount, cur)}</b></span></button>`;
    }).join('') + (es.length > S.ui.limit ? `<button class="btn more" data-act="more">Show older · ${es.length - S.ui.limit} more</button>` : '')
      : `<div class="empty"><div class="ico">👛</div><b>Nothing here yet</b><p>Record your first income or expense.</p><div class="btns two"><button class="btn sm" data-act="add-income">＋ Income</button><button class="btn sm" data-act="add-expense">− Expense</button></div></div>`;
    body = recurringBlock(b) + body;
  } else {
    const months = [];
    for (let i = 5; i >= 0; i--) { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i); const k = ymd(d).slice(0, 7); months.push({ k, label: d.toLocaleDateString(undefined, { month: 'short' }), ...monthStats(b.id, k) }); }
    const max = Math.max(1, ...months.flatMap(m => [m.inc, m.exp]));
    const cats = {}; es.filter(e => e.type === 'expense' && e.date.startsWith(ym)).forEach(e => { const k = catName(e.cat) || 'Other'; (cats[k] = cats[k] || { v: 0, ico: e.cat || '🧾' }).v += e.amount; });
    const top = Object.entries(cats).sort((a, c) => c[1].v - a[1].v), tot = top.reduce((s, [, c]) => s + c.v, 0) || 1;
    body = `<div class="sec-h">Last 6 months</div><div class="card pad">${months.map(m => `<div class="mrow"><b>${m.label}</b><div class="bars"><i class="pos" style="width:${m.inc / max * 100}%"></i><i class="neg" style="width:${m.exp / max * 100}%"></i></div><span class="${m.net < 0 ? 'neg' : m.net > 0 ? 'pos' : 'muted'}">${m.net ? money(m.net, cur, true) : '—'}</span></div>`).join('')}</div>
      <div class="sec-h">Where it went this month</div>` + (top.length ? `<div class="card pad">${top.map(([name, c]) => `<div class="mrow cat"><span class="ci">${esc(c.ico)}</span><div class="grow"><div class="bal-top"><b>${esc(name)}</b><span>${fmt(c.v, cur)}</span></div><div class="bar"><i class="neg" style="width:${c.v / tot * 100}%"></i></div></div><small class="muted">${Math.round(c.v / tot * 100)}%</small></div>`).join('')}</div>`
      : `<div class="empty small"><b>No spending yet this month</b></div>`);
  }
  return `<header class="top"><button class="iconbtn" data-act="back" aria-label="Back">‹</button><div class="grow"><h1>👛 My money</h1></div>${statusPill()}
    <button class="iconbtn" data-act="settings" aria-label="Settings">⚙️</button></header>
    <main>${hero}<div class="tabs" role="tablist">${tabs}</div>${body}</main>
    <button class="fab" data-act="new-entry" aria-label="Add"><i>＋</i><span>Add</span></button>`;
}

function bookView() {
  const b = S.doc.books[S.ui.bookId], m = me(), cur = b.currency, tab = ['entries', 'balances', 'members'].includes(S.ui.tab) ? S.ui.tab : 'entries';
  const net = netBalances(b.id), mine = m ? (net[m.id] || 0) : 0, es = bookEntries(b.id);
  const spent = es.filter(e => e.type !== 'settle').reduce((s, e) => s + e.amount, 0);
  const myShare = m ? es.filter(e => e.type !== 'settle').reduce((s, e) => s + (e.split[m.id] || 0), 0) : 0;
  const hero = `<section class="hero compact"><div class="hero-l">Your balance</div>
    <div class="hero-n ${mine < 0 ? 'neg' : ''}">${Math.abs(mine) < 1 ? 'Settled up ✓' : money(mine, cur, true)}</div>
    <div class="hero-s">${Math.abs(mine) < 1 ? 'Nobody owes anything' : mine > 0 ? 'you are owed' : 'you owe'}</div>
    <div class="hero-row"><div>Group spending<b>${fmt(spent, cur)}</b></div><div>Your share<b>${fmt(myShare, cur)}</b></div></div></section>`;
  const tabs = [['entries', 'Activity'], ['balances', 'Balances'], ['members', 'People']].map(([k, l]) => `<button class="${tab === k ? 'on' : ''}" data-act="tab" data-tab="${k}">${l}</button>`).join('');
  let body = '';
  if (tab === 'entries') {
    let last = '';
    body = es.length ? es.slice(0, S.ui.limit).map(e => {
      const day = dayLabel(e.date), head = day !== last ? `<div class="day">${day}</div>` : ''; last = day;
      const mn = m ? (e.paidBy === m.id ? e.amount : 0) - (e.split[m.id] || 0) : 0;
      const isS = e.type === 'settle';
      const sub = isS ? `${esc(pname(e.paidBy))} paid ${esc(pname(Object.keys(e.split)[0]))}` : `${esc(pname(e.paidBy))} paid ${fmt(e.amount, cur)}`;
      const right = mn === 0 ? `<small class="muted">not involved</small>` : `<b class="${mn > 0 ? 'pos' : 'neg'}">${mn > 0 ? '+' : '−'}${fmt(Math.abs(mn), cur)}</b><small>${mn > 0 ? 'you lent' : 'you borrowed'}</small>`;
      return head + `<button class="tx" data-act="edit-entry" data-id="${e.id}"><span class="tx-ico ${isS ? 'pay' : ''}">${isS ? '🤝' : esc(e.cat || '🧾')}</span>
        <span class="tx-mid"><b>${esc(e.desc || (isS ? 'Payment' : 'Expense'))}</b><small>${sub}</small></span><span class="tx-end">${right}</span></button>`;
    }).join('') + (es.length > S.ui.limit ? `<button class="btn more" data-act="more">Show older · ${es.length - S.ui.limit} more</button>` : '') : `<div class="empty"><div class="ico">🧾</div><b>Nothing here yet</b><p>Record the first shared expense.</p><button class="btn sm" data-act="new-entry">＋ Add expense</button></div>`;
  } else if (tab === 'balances') {
    const ids = b.memberIds.filter(i => person(i) && !person(i).deleted), debts = simplify(net);
    const max = Math.max(1, ...ids.map(i => Math.abs(net[i] || 0)));
    body = `<div class="card pad">` + ids.map(i => { const v = net[i] || 0;
      return `<div class="bal">${avatar(i)}<div class="bal-mid"><div class="bal-top"><b>${esc(pname(i))}</b><span class="${v > 0 ? 'pos' : v < 0 ? 'neg' : 'muted'}">${Math.abs(v) < 1 ? 'settled' : money(v, cur, true)}</span></div>
        <div class="bar"><i class="${v >= 0 ? 'pos' : 'neg'}" style="width:${Math.abs(v) / max * 100}%"></i></div></div></div>`; }).join('') + `</div>
      ${loansBlock(b)}<div class="sec-h">Settle up <button class="link" data-act="share">Share summary</button></div>` + (debts.length ? debts.map(d => `<div class="settle"><div class="settle-who">${avatar(d.from, 'sm')}<span class="arrow">→</span>${avatar(d.to, 'sm')}</div>
        <div class="settle-t"><b>${esc(pname(d.from))} pays ${esc(pname(d.to))}</b><small>${fmt(d.amt, cur)}</small></div>
        <button class="btn sm" data-act="settle" data-from="${d.from}" data-to="${d.to}" data-amt="${d.amt}">Settle</button></div>`).join('') :
      `<div class="empty small"><div class="ico">🎉</div><b>All settled up</b></div>`);
  } else {
    const ids = b.memberIds.filter(i => person(i) && !person(i).deleted);
    body = `<div class="card pad">${ids.map(i => `<div class="bal">${avatar(i)}<div class="bal-mid"><b>${esc(pname(i))}</b></div></div>`).join('')}</div>
      <div class="addrow"><input id="addm" placeholder="Add someone to this book…" maxlength="40" autocomplete="off"><button class="btn" data-act="add-member">Add</button></div>
      <div class="btns two"><button class="btn" data-act="edit-book">✏️ Edit book</button><button class="btn danger" data-act="del-book">🗑 Delete</button></div>`;
  }
  if (tab === 'entries') body = recurringBlock(b) + body;
  return `<header class="top"><button class="iconbtn" data-act="back" aria-label="Back">‹</button><div class="grow"><h1>${esc(b.emoji || '📒')} ${esc(b.name)}</h1></div>${statusPill()}
    <button class="iconbtn" data-act="settings" aria-label="Settings">⚙️</button></header>
    <main>${hero}<div class="tabs" role="tablist">${tabs}</div>${body}</main>
    ${tab === 'entries' || tab === 'balances' ? `<button class="fab" data-act="new-entry" aria-label="Add expense"><i>＋</i><span>Add expense</span></button>` : ''}`;
}

/* ───────────────────────── UI: sheets ───────────────────────── */
function openSheet(html) {
  closeSheet();
  const o = document.createElement('div'); o.className = 'overlay';
  o.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div>`;
  o.addEventListener('pointerdown', e => { if (e.target === o) closeSheet(); });
  document.body.appendChild(o); document.body.classList.add('noscroll'); return o;
}
function closeSheet() { const o = $('.overlay'); if (o) { o.remove(); document.body.classList.remove('noscroll'); if (pendingReload) location.reload(); } }
document.addEventListener('keydown', e => { if (e.key !== 'Escape') return; const top = [...document.querySelectorAll('.layer')].pop(); if (top) top._close(null); else closeSheet(); });

/* ---- book form ---- */
const REGION_CUR = { IN: 'INR', US: 'USD', GB: 'GBP', AU: 'AUD', CA: 'CAD', JP: 'JPY', SG: 'SGD', AE: 'AED', CH: 'CHF', CN: 'CNY', BR: 'BRL', ZA: 'ZAR', MX: 'MXN',
  DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR', NL: 'EUR', IE: 'EUR', PT: 'EUR', BE: 'EUR', AT: 'EUR', FI: 'EUR', GR: 'EUR', PK: 'PKR', BD: 'BDT', LK: 'LKR', NP: 'NPR',
  ID: 'IDR', MY: 'MYR', TH: 'THB', PH: 'PHP', VN: 'VND', KR: 'KRW', SA: 'SAR', QA: 'QAR', KW: 'KWD', OM: 'OMR', BH: 'BHD', NZ: 'NZD', SE: 'SEK', NO: 'NOK', DK: 'DKK',
  PL: 'PLN', TR: 'TRY', NG: 'NGN', KE: 'KES', EG: 'EGP', IL: 'ILS', RU: 'RUB', UA: 'UAH', CZ: 'CZK', HU: 'HUF', AR: 'ARS', CL: 'CLP', CO: 'COP', HK: 'HKD', TW: 'TWD' };
const localeCurrency = () => REGION_CUR[((navigator.language || '').split('-')[1] || '').toUpperCase()] || 'INR';
const EMOJIS = ['📒', '✈️', '🏠', '🍻', '🎉', '🏖️', '🚗', '🛒', '💼', '❤️'];
function bookSheet(id) {
  const ex = id && S.doc.books[id], m = me();
  const B = ex ? { ...ex, memberIds: [...ex.memberIds] } : { name: '', emoji: '📒', currency: localStorage.getItem('sb.cur') || localeCurrency(), memberIds: m ? [m.id] : [] };
  const o = openSheet('<div id="form"></div>'), root = $('#form', o);
  const keep = () => { if ($('#bn', o)) B.name = $('#bn', o).value; };
  const draw = () => {
    const people = live('people');
    root.innerHTML = `<div class="sh-head"><h2>${ex ? 'Edit book' : 'New book'}</h2><button class="iconbtn" data-x="close" aria-label="Close">✕</button></div>
      <label class="field"><span>Name</span><input id="bn" value="${esc(B.name)}" placeholder="Goa trip, Flat 4B…" maxlength="60" autocomplete="off"></label>
      <div class="field"><span>Icon</span><div class="emojis">${EMOJIS.map(e => `<button data-x="emoji" data-v="${e}" class="${B.emoji === e ? 'on' : ''}">${e}</button>`).join('')}</div></div>
      <div class="field"><span>Currency</span><button class="curbtn" data-x="cur"><b>${esc(symbol(B.currency))} ${B.currency}</b><small>${esc(curName(B.currency))}</small><i>›</i></button>${ex ? '<p class="note">Changing it keeps the same numbers — no exchange-rate conversion.</p>' : ''}</div>
      <div class="field"><span>Who's in this book?</span><div class="pcs">${people.map(p => `<button class="pc ${B.memberIds.includes(p.id) ? 'on' : ''}" data-x="mem" data-v="${p.id}">${avatar(p.id, 'xs')}${esc(p.isMe ? 'You' : p.name)}</button>`).join('')}</div>
      <div class="addrow"><input id="np" placeholder="Add someone new…" autocomplete="off"><button class="btn" data-x="addp">Add</button></div></div>
      <button class="cta" data-x="save">${ex ? 'Save changes' : 'Create book'}</button>`;
  };
  draw();
  root.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'np') { e.preventDefault(); root.querySelector('[data-x=addp]').click(); } });
  root.addEventListener('click', e => {
    const t = e.target.closest('[data-x]'); if (!t) return; const x = t.dataset.x; keep();
    if (x === 'close') closeSheet();
    else if (x === 'emoji') { B.emoji = t.dataset.v; draw(); }
    else if (x === 'cur') { pickCurrency(B.currency).then(c => { if (c) { B.currency = c; draw(); } }); }
    else if (x === 'mem') { const i = B.memberIds.indexOf(t.dataset.v); i < 0 ? B.memberIds.push(t.dataset.v) : B.memberIds.splice(i, 1); draw(); }
    else if (x === 'addp') { const n = $('#np', o).value.trim(); if (!n) return; const p = { id: uid(), name: n, createdAt: now() }; put('people', p); B.memberIds.push(p.id); draw(); $('#np', o).focus(); }
    else if (x === 'save') {
      if (!B.name.trim()) return toast('Give the book a name');
      if (B.memberIds.length < 1) return toast('Add at least one person');
      localStorage.setItem('sb.cur', B.currency);
      const book = { ...B, name: B.name.trim(), id: ex ? ex.id : uid(), createdAt: ex ? ex.createdAt : now() };
      if (ex && ex.currency !== book.currency) { changeCurrency(ex.id, book.currency); book.updatedAt = now(); }
      put('books', { ...book, ...(ex ? { currency: S.doc.books[ex.id].currency } : {}) }); closeSheet(); if (!ex) go('book/' + book.id); toast(ex ? 'Book updated' : 'Book created');
    }
  });
  if (!ex) setTimeout(() => $('#bn', o) && $('#bn', o).focus(), 60);
}

/* ---- add / edit entry (quick-add) ---- */
function entrySheet(entryId, preset, bookId) {
  const ex = entryId && S.doc.entries[entryId];
  let bid = ex ? ex.bookId : (bookId || S.ui.bookId || (live('books')[0] || {}).id);
  if (!bid) return toast('Create a book first');
  let b, cur, members;
  const setBook = id => { bid = id; b = S.doc.books[id]; cur = b.currency; members = b.personal ? [me().id] : b.memberIds.filter(i => person(i) && !person(i).deleted); };
  setBook(bid);
  const m = me();
  const defPayer = () => (m && members.includes(m.id)) ? m.id : members[0];
  const E = ex ? { type: ex.type, desc: ex.desc, amount: toInput(ex.amount, cur), paidBy: ex.paidBy, date: ex.date, cat: ex.cat || '🧾', note: ex.note || '',
      method: ex.method || 'exact', sel: Object.keys(ex.split), vals: {}, custom: (ex.method || 'exact') !== 'equal' }
    : { type: 'expense', desc: '', amount: '', paidBy: defPayer(), date: isoDay(Date.now()), cat: '🧾', note: '', method: 'equal', sel: [...members], vals: {}, custom: false };
  if (ex) for (const [p, c] of Object.entries(ex.split)) E.vals[p] = (ex.method === 'percent' || ex.method === 'shares') ? ((ex.vals && ex.vals[p]) ?? '') : toInput(c, cur);
  if (ex && ex.type === 'expense' && ex.method === 'equal') E.custom = false;
  E.repeat = ex ? (ex.repeat || '') : ''; E.rate = ex && ex.loan && ex.loan.rate ? String(ex.loan.rate) : ''; E.due = ex && ex.loan ? (ex.loan.due || '') : '';
  if (preset) Object.assign(E, preset);
  const o = openSheet('<div id="form"></div>'), root = $('#form', o);
  const amt = () => parseMoney(E.amount, cur);

  function compute() {
    const total = amt();
    if (b.personal) return { split: E.type === 'income' ? {} : { [members[0]]: total }, ok: total > 0 };
    if (E.type === 'settle') return { split: { [E.sel[0]]: total }, ok: !!E.sel[0] && E.sel[0] !== E.paidBy && total > 0 };
    if (!E.sel.length) return { split: {}, ok: false, msg: 'Pick at least one person' };
    if (E.method === 'equal') { const w = {}; E.sel.forEach(i => w[i] = 1); return { split: byWeights(total, w), ok: total > 0 }; }
    if (E.method === 'shares' || E.method === 'percent') {
      const w = {}; E.sel.forEach(i => w[i] = parseFloat(E.vals[i]) || 0);
      const s = Object.values(w).reduce((a, c) => a + c, 0);
      if (s <= 0) return { split: {}, ok: false, msg: 'Enter a value for each person' };
      if (E.method === 'percent' && Math.abs(s - 100) > 0.001) return { split: byWeights(total, w), ok: false, msg: `Percentages add up to ${+s.toFixed(2)}% — need 100%` };
      return { split: byWeights(total, w), ok: total > 0 };
    }
    const split = {}; let s = 0; E.sel.forEach(i => { split[i] = parseMoney(E.vals[i] || 0, cur); s += split[i]; });
    const diff = total - s;
    return { split, ok: total > 0 && diff === 0, msg: diff === 0 ? '' : `${fmt(Math.abs(diff), cur)} ${diff > 0 ? 'left to assign' : 'over the total'}` };
  }
  function updateCalc() {
    const c = compute(), total = amt();
    root.querySelectorAll('[data-calc]').forEach(el => { const i = el.dataset.calc; el.textContent = E.sel.includes(i) && total ? fmt(c.split[i] || 0, cur) : ''; });
    const h = $('#hint', root);
    if (h) {
      if (c.msg) { h.textContent = c.msg; h.className = 'hint bad'; }
      else if (isLoanForm() && total) { h.textContent = `Lent ${fmt(total, cur)} to ${pname(E.sel[0])}`; h.className = 'hint'; }
      else if (E.method === 'equal' && E.sel.length && total) { h.textContent = `${fmt(Math.round(total / E.sel.length), cur)} each · ${E.sel.length} ${E.sel.length === 1 ? 'person' : 'people'}`; h.className = 'hint'; }
      else { h.textContent = ''; h.className = 'hint'; }
    }
    const sb = $('#savebtn', root); if (sb) sb.textContent = (ex ? 'Save' : E.type === 'settle' ? 'Record payment' : E.type === 'income' ? 'Add income' : isLoanForm() ? 'Add loan' : 'Add expense') + (total ? ` · ${fmt(total, cur)}` : '');
  }
  const pc = (id, on, x) => `<button class="pc ${on ? 'on' : ''}" data-x="${x}" data-v="${id}">${avatar(id, 'xs')}${esc(pname(id))}</button>`;

  const isLoanForm = () => !b.personal && E.type === 'expense' && E.cat === '💸' && E.sel.length === 1 && E.sel[0] !== E.paidBy && !(ex && ex.interestFor);
  function draw() {
    const isS = E.type === 'settle', isP = !!b.personal, isI = E.type === 'income', unit = E.method === 'percent' ? '%' : E.method === 'shares' ? '×' : cur;
    const books = live('books').sort((x, y) => (y.personal ? 1 : 0) - (x.personal ? 1 : 0));
    root.innerHTML = `<div class="sh-head"><div class="seg2"><button data-x="type" data-v="expense" class="${E.type === 'expense' ? 'on' : ''}">Expense</button><button data-x="type" data-v="${isP ? 'income' : 'settle'}" class="${E.type === (isP ? 'income' : 'settle') ? 'on' : ''}">${isP ? 'Income' : 'Payment'}</button></div>
        <button class="iconbtn" data-x="close" aria-label="Close">✕</button></div>
      ${!ex && books.length > 1 ? `<div class="pcs scroll">${books.map(k => `<button class="pc ${k.id === bid ? 'on' : ''}" data-x="book" data-v="${k.id}">${esc(k.emoji || '📒')} ${esc(k.name)}</button>`).join('')}</div>` : ''}
      <div class="amt"><span class="cur">${esc(symbol(cur))}</span><input id="ea" inputmode="decimal" autocomplete="off" value="${esc(E.amount)}" placeholder="0"></div>
      ${isS ? '' : `<input id="ed" class="desc" value="${esc(E.desc)}" placeholder="${isI ? 'Where from?' : 'What was it for?'}" maxlength="80" autocomplete="off">
      <div class="cats">${(isI ? INCOME_CATS : CATS).map(([c, l]) => `<button data-x="cat" data-v="${c}" data-l="${l}" class="${E.cat === c ? 'on' : ''}"><i>${c}</i>${l}</button>`).join('')}</div>`}
      ${isP ? '' : `      <div class="lbl">${isS ? 'Who paid?' : 'Paid by'}</div><div class="pcs scroll">${members.map(i => pc(i, i === E.paidBy, 'paid')).join('')}</div>
      ${isS ? `<div class="lbl">Paid to</div><div class="pcs scroll">${members.filter(i => i !== E.paidBy).map(i => pc(i, i === E.sel[0], 'to')).join('')}</div>` :
      `<div class="lbl">${E.cat === '💸' ? 'Lent to' : 'Split between'} <button class="link" data-x="all">${E.sel.length === members.length ? 'Clear' : 'Everyone'}</button></div>
      ${E.custom ? `<div class="seg">${[['equal', 'Equal'], ['exact', 'Exact'], ['percent', '%'], ['shares', 'Shares']].map(([k, l]) => `<button data-x="method" data-v="${k}" class="${E.method === k ? 'on' : ''}">${l}</button>`).join('')}</div>
        <div class="card pad">${members.map(i => `<div class="who"><label>${avatar(i, 'xs')}<input type="checkbox" data-x="sel" data-v="${i}" ${E.sel.includes(i) ? 'checked' : ''}><span>${esc(pname(i))}</span></label>
          ${E.method !== 'equal' && E.sel.includes(i) ? `<input class="val" data-val="${i}" inputmode="decimal" value="${esc(E.vals[i] ?? '')}" placeholder="${unit}">` : ''}<span class="calc" data-calc="${i}"></span></div>`).join('')}</div>` :
        `<div class="pcs">${members.map(i => pc(i, E.sel.includes(i), 'tog')).join('')}</div>`}
      <div class="split-foot"><span id="hint" class="hint"></span><button class="link" data-x="custom">${E.custom ? 'Simple split' : 'Customize split'}</button></div>`}`}
      <div class="row2"><label class="field"><span>Date</span><input id="edt" type="date" value="${E.date}"></label>
        ${isS ? '' : `<label class="field grow"><span>Note</span><input id="en" value="${esc(E.note)}" placeholder="Optional" maxlength="300"></label>`}</div>
      ${isS ? '' : `${isLoanForm() ? `<div class="loanbox"><div class="lbl">Loan terms <small>optional</small></div><div class="row2"><label class="field"><span>Interest % / year</span><input id="elr" inputmode="decimal" value="${esc(E.rate)}" placeholder="0"></label>
        <label class="field"><span>Due date</span><input id="eld" type="date" value="${E.due}"></label></div></div>` : ''}
        ${ex && ex.fromRule ? `<p class="note">🔁 Part of a recurring series. Edit the original to change future ones.</p>` : `<div class="field"><span>Repeat</span><div class="pcs scroll">${[['', 'Never'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['yearly', 'Yearly']].map(([k, l]) => `<button class="pc ${E.repeat === k ? 'on' : ''}" data-x="rep" data-v="${k}">${l}</button>`).join('')}</div></div>`}`}
      <div class="btns"><button class="cta" id="savebtn" data-x="save"></button>${ex ? `<button class="btn danger" data-x="del" aria-label="Delete">🗑</button>` : ''}</div>`;
    updateCalc();
  }
  const pull = () => {
    const g = id => root.querySelector(id);
    if (g('#ed')) E.desc = g('#ed').value; if (g('#ea')) E.amount = g('#ea').value; if (g('#edt')) E.date = g('#edt').value || E.date; if (g('#en')) E.note = g('#en').value;
    if (g('#elr')) E.rate = g('#elr').value; if (g('#eld')) E.due = g('#eld').value;
  };
  root.addEventListener('input', e => {
    if (e.target.dataset.val) { E.vals[e.target.dataset.val] = e.target.value; updateCalc(); }
    else if (e.target.id === 'ea') { E.amount = e.target.value; updateCalc(); }
  });
  root.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'ea') { e.preventDefault(); const d = $('#ed', root); d ? d.focus() : $('#savebtn', root).click(); }
    else if (e.key === 'Enter' && e.target.id === 'ed') { e.preventDefault(); $('#savebtn', root).click(); } });
  root.addEventListener('change', e => {
    if (e.target.dataset.x === 'sel') { pull(); const v = e.target.dataset.v, i = E.sel.indexOf(v); i < 0 ? E.sel.push(v) : E.sel.splice(i, 1); draw(); }
  });
  root.addEventListener('click', e => {
    const t = e.target.closest('[data-x]'); if (!t || t.tagName === 'INPUT') return;
    const x = t.dataset.x, v = t.dataset.v; pull();
    if (x === 'close') closeSheet();
    else if (x === 'type') { E.type = v; E.sel = v === 'settle' ? [members.find(i => i !== E.paidBy)].filter(Boolean) : [...members]; if (v === 'income') E.cat = '💼'; else if (INCOME_CATS.some(([k]) => k === E.cat) && E.cat !== '🎁') E.cat = '🧾'; draw(); }
    else if (x === 'book') { setBook(v); E.paidBy = defPayer(); E.sel = [...members]; E.vals = {}; if (b.personal && E.type === 'settle') E.type = 'expense'; if (!b.personal && E.type === 'income') { E.type = 'expense'; E.cat = '🧾'; } draw(); }
    else if (x === 'rep') { E.repeat = v; draw(); }
    else if (x === 'cat') { E.cat = v; if (!E.desc.trim()) E.desc = t.dataset.l === 'Other' ? '' : t.dataset.l; if (v === '💸' && !ex && E.sel.length !== 1) E.sel = [members.find(i => i !== E.paidBy)].filter(Boolean); draw(); $('#ed', root).focus(); }
    else if (x === 'paid') { E.paidBy = v; if (E.type === 'settle' && E.sel[0] === v) E.sel = [members.find(i => i !== v)]; draw(); }
    else if (x === 'to') { E.sel = [v]; draw(); }
    else if (x === 'tog') { const i = E.sel.indexOf(v); i < 0 ? E.sel.push(v) : E.sel.splice(i, 1); draw(); }
    else if (x === 'all') { E.sel = E.sel.length === members.length ? [] : [...members]; draw(); }
    else if (x === 'custom') { E.custom = !E.custom; if (!E.custom) { E.method = 'equal'; E.vals = {}; } draw(); }
    else if (x === 'method') { E.method = v; if (v === 'shares') E.sel.forEach(i => E.vals[i] = E.vals[i] || 1); else E.vals = {}; draw(); }
    else if (x === 'del') { const old = del('entries', ex.id); closeSheet(); toast('Entry deleted', () => { put('entries', old); toast('Restored'); }); }
    else if (x === 'save') {
      const c = compute(), total = amt();
      if (total <= 0) { toast('Enter an amount'); return $('#ea', root).focus(); }
      if (E.type === 'settle' && !c.ok) return toast('Choose who paid whom');
      if (!c.ok) return toast(c.msg || 'Check the split');
      const vals = (E.method === 'percent' || E.method === 'shares') ? Object.fromEntries(E.sel.map(i => [i, E.vals[i]])) : undefined;
      const isS = E.type === 'settle', catLabel = catName(E.cat);
      const entry = { id: ex ? ex.id : uid(), bookId: bid, type: E.type, desc: isS ? 'Payment' : (E.desc.trim() || catLabel || (E.type === 'income' ? 'Income' : 'Expense')), amount: total, paidBy: E.paidBy,
        split: Object.fromEntries(Object.entries(c.split).filter(([, n]) => n > 0 || isS)), method: isS ? 'exact' : E.method, vals,
        date: E.date, cat: E.cat, note: E.note.trim(), createdAt: ex ? ex.createdAt : now() };
      if (!isS) {
        if (E.repeat) entry.repeat = E.repeat;
        const only = Object.keys(entry.split);
        if (E.cat === '💸' && only.length === 1 && only[0] !== E.paidBy && !(ex && ex.interestFor)) entry.loan = { rate: Math.max(0, parseFloat(String(E.rate).replace(',', '.')) || 0), due: E.due || '' };
      }
      if (ex && ex.fromRule) entry.fromRule = ex.fromRule;
      if (ex && ex.interestFor) entry.interestFor = ex.interestFor;
      put('entries', entry); materializeRecurring(); buzz(); closeSheet();
      try { localStorage.setItem('sb.last', bid); } catch {}
      if (S.ui.view === 'book' && S.ui.bookId !== bid) go('book/' + bid);
      toast(ex ? 'Entry updated' : isS ? 'Payment recorded' : E.type === 'income' ? 'Income added' : 'Expense added');
    }
  });
  draw();
  if (!ex && !(preset && preset.type === 'settle')) setTimeout(() => { const a = $('#ea', root); a && a.focus(); }, 80);
}

/* ---- settings ---- */
function settingsSheet() {
  const u = S.meta.user, st = statusInfo(), m = me();
  const o = openSheet(`<div class="sh-head"><h2>Settings</h2><button class="iconbtn" data-x="close" aria-label="Close">✕</button></div>
    <div class="card pad acct">${S.meta.wasSignedIn ? `<div class="acct-row">${u && u.picture ? `<img class="av" src="${esc(u.picture)}" alt="" referrerpolicy="no-referrer">` : '<span class="av">☁️</span>'}
      <div><b>${esc((u && (u.name || u.email)) || 'Signed in')}</b><small>${esc((u && u.email) || '')}</small></div></div>
      <div class="note"><span class="sync-dot ${st.cls}"></span>${st.text}${S.meta.lastSync ? ' · last sync ' + new Date(S.meta.lastSync).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}${S.sync.error ? '<br>' + esc(S.sync.error) : ''}</div>
      <div class="btns two"><button class="btn primary" data-x="sync">Sync now</button><button class="btn" data-x="out">Sign out</button></div>` :
    `<b>☁️ Back up with Google Drive</b><p class="note">Your data stays on this device and is also saved to a private, hidden folder in <i>your own</i> Google Drive. Works offline and syncs when you reconnect.</p>
      ${clientId() ? `<button class="cta" data-x="in">Continue with Google</button>` : `<p class="note">Google backup isn't enabled for this app yet. Everything still works and is saved on this device.</p>`}`}</div>
    <div class="lbl">Your name</div>
    <div class="addrow"><input id="myname" value="${esc((m || {}).name || '')}"><button class="btn" data-x="savename">Save</button></div>
    ${personalBook() ? `<div class="lbl">My money currency</div><button class="curbtn" data-x="pcur"><b>${esc(symbol(personalBook().currency))} ${personalBook().currency}</b><small>${esc(curName(personalBook().currency))}</small><i>›</i></button><p class="note">Keeps the same numbers — no exchange-rate conversion.</p>` : ''}
    <div class="lbl">Demo</div>
    <div class="card pad"><p class="note">Fill the app with realistic example books — daily spends, a trip, rent &amp; bills, subscriptions, loans and a EUR weekend — to see how everything works.</p>
      <div class="btns two" style="margin:8px 0"><button class="btn" data-x="${hasSample() ? 'sample-clear' : 'sample-load'}">${hasSample() ? 'Remove sample data' : 'Load sample data'}</button></div></div>
    <div class="lbl">Backup</div><div class="btns two"><button class="btn" data-x="export">Export</button><button class="btn" data-x="import">Import</button></div>
    <p class="note c">SplitBook · works offline · installable</p>`);
  o.addEventListener('click', async e => {
    const x = e.target.closest('[data-x]')?.dataset.x; if (!x) return;
    if (x === 'close') closeSheet();
    else if (x === 'pcur') { const c = await pickCurrency(personalBook().currency); if (c && c !== personalBook().currency) { changeCurrency(PERSONAL_ID, c); toast('Currency updated'); settingsSheet(); } }
    else if (x === 'in') { closeSheet(); await signIn(); }
    else if (x === 'out') { closeSheet(); signOut(); }
    else if (x === 'sync') { closeSheet(); await sync(true); toast(S.sync.state === 'err' ? 'Sync failed: ' + S.sync.error : 'Synced ✓'); }
    else if (x === 'savename') { const n = $('#myname', o).value.trim(); if (m && n) { put('people', { ...m, name: n }); toast('Saved'); } }
    else if (x === 'sample-load') { closeSheet(); loadSampleData(); go(''); toast('Sample data loaded'); }
    else if (x === 'sample-clear') { closeSheet(); clearSampleData(); go(''); toast('Sample data removed'); }
    else if (x === 'export') {
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(S.doc, null, 2)], { type: 'application/json' }));
      a.download = 'splitbook-backup-' + isoDay(Date.now()) + '.json'; a.click();
    } else if (x === 'import') {
      const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/json';
      inp.onchange = async () => { try { const d = JSON.parse(await inp.files[0].text()); if (!d.books || !d.entries || !d.people) throw 0;
        S.doc = mergeDocs(S.doc, d).doc; touched(); closeSheet(); toast('Imported & merged'); } catch { toast('Not a valid SplitBook backup'); } };
      inp.click();
    }
  });
}

/* ---- sample data (demo / testing) ---- */
const isSample = id => String(id).startsWith('smp-');
const hasSample = () => Object.values(S.doc.books).some(b => !b.deleted && isSample(b.id)) || Object.values(S.doc.entries).some(e => !e.deleted && isSample(e.id));
function loadSampleData(seed = 7) {
  let a = seed >>> 0;
  const rnd = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const between = (lo, hi) => lo + rnd() * (hi - lo);
  const t0 = now(); let seq = 0, nb = 0;
  ensureMe(); const M = me().id;
  const P = { me: M };
  for (const [k, name] of [['ravi', 'Ravi'], ['meera', 'Meera'], ['dev', 'Dev'], ['priya', 'Priya']]) {
    P[k] = 'smp-p-' + k; S.doc.people[P[k]] = { id: P[k], name, createdAt: t0, updatedAt: t0 };
  }
  const day = d => isoDay(Date.now() - d * 864e5);
  const mkBook = (k, name, emoji, currency, members) => {
    const id = 'smp-b-' + k; S.doc.books[id] = { id, name, emoji, currency, memberIds: members, createdAt: t0, updatedAt: t0 + (nb++) }; return id;
  };
  // spec: array => equal | {id: weight} for shares/percent | {id: major units} for exact
  const exp = (bk, d, desc, cat, amount, paidBy, spec, method = 'equal') => {
    const cur = S.doc.books[bk].currency, f = factor(cur), total = Math.round(amount * f);
    let split, vals;
    if (method === 'equal') { const w = {}; spec.forEach(i => w[i] = 1); split = byWeights(total, w); }
    else if (method === 'exact') { split = Object.fromEntries(Object.entries(spec).map(([i, v]) => [i, Math.round(v * f)])); }
    else { split = byWeights(total, spec); vals = Object.fromEntries(Object.entries(spec).map(([i, v]) => [i, String(v)])); }
    const id = 'smp-e-' + (seq++);
    S.doc.entries[id] = { id, bookId: bk, type: 'expense', desc, amount: total, paidBy, split, method, vals, date: day(d), cat, note: '', createdAt: t0 + seq, updatedAt: t0 };
  };
  const pay = (bk, d, from, to, amount) => {
    const total = Math.round(amount * factor(S.doc.books[bk].currency)), id = 'smp-e-' + (seq++);
    S.doc.entries[id] = { id, bookId: bk, type: 'settle', desc: 'Payment', amount: total, paidBy: from, split: { [to]: total }, method: 'exact', date: day(d), cat: '🤝', note: '', createdAt: t0 + seq, updatedAt: t0 };
  };
  const loan = (bk, d, lender, borrower, amount, desc, terms) => { exp(bk, d, desc, '💸', amount, lender, { [borrower]: amount }, 'exact'); S.doc.entries['smp-e-' + (seq - 1)].loan = terms || { rate: 0, due: '' }; };
  const rec = (bk, d, desc, cat, amount, paidBy, spec, period) => { exp(bk, d, desc, cat, amount, paidBy, spec); S.doc.entries['smp-e-' + (seq - 1)].repeat = period; };
  const both = [P.me, P.ravi];

  const things = [['Chai & snacks', '🍽️', 40, 120], ['Auto / cab', '🚗', 60, 350], ['Lunch', '🍽️', 120, 450], ['Groceries', '🛒', 200, 1500],
    ['Dinner out', '🍽️', 300, 1200], ['Coffee', '🍽️', 90, 260], ['Pharmacy', '🏥', 80, 600], ['Movie', '🎬', 250, 800]];
  // 0) My money — salary, freelance, rent, bills and everyday spending (no book, no people)
  ensurePersonal();
  const PB = PERSONAL_ID, pinc = (d, desc, cat, amount, period) => {
    const id = 'smp-e-' + (seq++), total = Math.round(amount * factor(S.doc.books[PB].currency));
    S.doc.entries[id] = { id, bookId: PB, type: 'income', desc, amount: total, paidBy: P.me, split: {}, method: 'equal', date: day(d), cat, note: '', createdAt: t0 + seq, updatedAt: t0 };
    if (period) S.doc.entries[id].repeat = period;
  };
  const pexp = (d, desc, cat, amount, period) => { exp(PB, d, desc, cat, amount, P.me, [P.me]); if (period) S.doc.entries['smp-e-' + (seq - 1)].repeat = period; };
  pinc(80, 'Salary', '💼', 85000, 'monthly'); pinc(52, 'Freelance project', '💻', 12000); pinc(21, 'Interest', '📈', 640); pinc(12, 'Amazon refund', '↩️', 1299);
  pexp(78, 'House rent', '🏠', 22000, 'monthly'); pexp(77, 'Phone & internet', '💡', 599, 'monthly'); pexp(75, 'Gym', '🎬', 1500, 'monthly'); pexp(74, 'Electricity', '💡', 1850, 'monthly');
  for (let d = 70; d >= 0; d -= 2) { const [desc, cat, lo, hi] = things[Math.floor(rnd() * things.length)]; pexp(d, desc, cat, Math.round(between(lo, hi)), null); }
  pexp(33, 'New headphones', '🎁', 6499, null); pexp(9, 'Flight tickets', '✈️', 8800, null);

  // 1) Daily life — small everyday spends, shared / personal / paid-for-the-other
  const daily = mkBook('daily', 'Daily life', '🍵', 'INR', both);
  for (let d = 29; d >= 0; d--) for (let k = 0, n = 1 + Math.floor(rnd() * 3); k < n; k++) {
    const [desc, cat, lo, hi] = things[Math.floor(rnd() * things.length)];
    const amt = Math.round(between(lo, hi)) + (rnd() < .3 ? .5 : 0), payer = rnd() < .55 ? P.me : P.ravi, other = payer === P.me ? P.ravi : P.me, r = rnd();
    exp(daily, d, desc, cat, amt, payer, r < .55 ? both : r < .85 ? [payer] : [other]);   // shared | personal | paid for them
  }
  pay(daily, 12, P.ravi, P.me, 500);

  // 2) Event — Goa trip: every split method, subset of people, odd cents, part-settled
  const goa = mkBook('goa', 'Goa trip', '🏖️', 'INR', [P.me, P.ravi, P.meera, P.dev]);
  exp(goa, 44, 'Flights (each own fare)', '✈️', 33400, P.meera, { [P.me]: 8200, [P.ravi]: 8200, [P.meera]: 7900, [P.dev]: 9100 }, 'exact');
  exp(goa, 43, 'Hotel · 3 nights', '🏠', 24000, P.me, [P.me, P.ravi, P.meera, P.dev]);
  exp(goa, 42, 'Scooter rental', '🚗', 1800, P.ravi, { [P.me]: 2, [P.ravi]: 1, [P.meera]: 1 }, 'shares');
  exp(goa, 42, 'Seafood dinner', '🍽️', 3499.99, P.dev, [P.me, P.ravi, P.meera, P.dev]);
  exp(goa, 41, 'Water sports (Dev skipped)', '🎬', 4500, P.meera, [P.me, P.ravi, P.meera]);
  exp(goa, 41, 'Beach shack', '🍽️', 2750, P.ravi, { [P.me]: 40, [P.ravi]: 30, [P.meera]: 20, [P.dev]: 10 }, 'percent');
  exp(goa, 40, 'Airport taxi', '🚗', 1600, P.me, [P.me, P.ravi, P.meera, P.dev]);
  pay(goa, 38, P.dev, P.me, 3000); pay(goa, 37, P.ravi, P.meera, 2000);

  // 3) Rent & bills — 3 months, different payers, shares for maid
  const flat = mkBook('flat', 'Flat 4B', '🏠', 'INR', [P.me, P.ravi, P.priya]), three = [P.me, P.ravi, P.priya];
  rec(flat, 85, 'Rent', '🏠', 36000, P.me, three, 'monthly');
  for (const [mi, d] of [[0, 85], [1, 55], [2, 25]]) {
    exp(flat, d - 2, 'Electricity', '💡', Math.round(1800 + rnd() * 1200), P.ravi, three);
    exp(flat, d - 3, 'WiFi', '💡', 1179, P.priya, three);
    exp(flat, d - 3, 'Water', '💡', 300, P.ravi, three);
    exp(flat, d - 4, 'Maid (Priya works from home)', '🏠', 3000, P.priya, { [P.me]: 1, [P.ravi]: 1, [P.priya]: 2 }, 'shares');
    if (mi === 1) exp(flat, d - 5, 'Gas cylinder', '💡', 1150, P.priya, three);
    if (mi < 2) { pay(flat, d - 8, P.ravi, P.me, 12000); pay(flat, d - 9, P.priya, P.me, 11500); }
  }

  // 4) Subscriptions — monthly shared / family plans + a personal one
  const subs = mkBook('subs', 'Subscriptions', '🔁', 'INR', [P.me, P.ravi, P.meera, P.dev, P.priya]);
  rec(subs, 70, 'Netflix', '🔁', 649, P.me, [P.me, P.ravi, P.meera, P.dev], 'monthly');
  rec(subs, 69, 'Spotify Family', '🔁', 179, P.ravi, [P.me, P.ravi, P.priya], 'monthly');
  rec(subs, 69, 'iCloud 50GB (mine)', '🔁', 75, P.me, [P.me], 'monthly');
  rec(subs, 68, 'YouTube Premium Family', '🔁', 189, P.meera, [P.me, P.meera, P.dev], 'monthly');
  rec(subs, 60, 'Cloud storage (yearly)', '🔁', 2400, P.dev, [P.me, P.dev], 'yearly');
  pay(subs, 35, P.dev, P.me, 400); pay(subs, 33, P.priya, P.ravi, 60);

  // 5) Loans & IOUs — lend, borrow, instalments, fully repaid
  const loans = mkBook('loans', 'Loans & IOUs', '💸', 'INR', [P.me, P.ravi, P.meera, P.dev, P.priya]);
  loan(loans, 120, P.me, P.ravi, 20000, 'Loan to Ravi', { rate: 12, due: day(30) });        pay(loans, 90, P.ravi, P.me, 5000); pay(loans, 60, P.ravi, P.me, 5000);
  loan(loans, 100, P.dev, P.me, 3000, 'Borrowed from Dev', { rate: 0, due: day(-20) });     pay(loans, 80, P.me, P.dev, 1000);
  exp(loans, 50, 'Meera paid my clinic bill', '🏥', 1500, P.meera, { [P.me]: 1500 }, 'exact'); pay(loans, 45, P.me, P.meera, 1500);
  loan(loans, 30, P.me, P.priya, 800, 'Lunch money for Priya', { rate: 0, due: day(10) }); pay(loans, 5, P.priya, P.me, 800);

  // 6) Foreign currency — EUR weekend, awkward cents
  const eu = mkBook('berlin', 'Berlin weekend', '✈️', 'EUR', [P.me, P.ravi, P.priya]);
  exp(eu, 16, 'Airbnb', '🏠', 285.5, P.priya, [P.me, P.ravi, P.priya]);
  exp(eu, 16, 'Train tickets', '🚗', 100.01, P.ravi, [P.me, P.ravi, P.priya]);
  exp(eu, 15, 'Museum pass', '🎬', 45, P.me, { [P.me]: 15, [P.ravi]: 15, [P.priya]: 15 }, 'exact');
  exp(eu, 15, 'Dinner', '🍽️', 128.9, P.priya, { [P.me]: 1, [P.ravi]: 1, [P.priya]: 2 }, 'shares');
  exp(eu, 14, 'Beers', '🍽️', 33.3, P.me, [P.me, P.ravi, P.priya]);
  materializeRecurring(); touched();
}
function clearSampleData() {
  for (const c of COLL) for (const id of Object.keys(S.doc[c])) if (isSample(id) && !S.doc[c][id].deleted)
    S.doc[c][id] = { id, deleted: true, updatedAt: now(), bookId: S.doc[c][id].bookId };
  touched();
}

/* ---- share balances ---- */
const buzz = () => { try { navigator.vibrate && navigator.vibrate(12); } catch {} };
async function shareSummary() {
  const b = S.doc.books[S.ui.bookId], debts = simplify(netBalances(b.id));
  const text = `${b.emoji || '📒'} ${b.name} — who owes who\n` + (debts.length ? debts.map(d => `• ${pname(d.from) === 'You' ? 'I' : pname(d.from)} ${pname(d.from) === 'You' ? 'owe' : 'owes'} ${pname(d.to) === 'You' ? 'me' : pname(d.to)} ${fmt(d.amt, b.currency)}`).join('\n') : 'All settled up 🎉');
  try { if (navigator.share) { await navigator.share({ text }); return; } await navigator.clipboard.writeText(text); toast('Summary copied'); } catch { /* cancelled */ }
}

/* ───────────────────────── events ───────────────────────── */
document.addEventListener('click', e => {
  const t = e.target.closest('[data-act]'); if (!t || t.closest('.overlay')) return;
  const a = t.dataset.act, d = t.dataset;
  if (a === 'back') go('');
  else if (a === 'settings') settingsSheet();
  else if (a === 'sync-now') { if (!S.meta.wasSignedIn) { if (clientId()) settingsSheet(); else toast('Saved on this device · Google backup not enabled'); } else if (!navigator.onLine) toast('Offline — changes will sync later'); else sync(true).then(() => toast(S.sync.state === 'err' ? 'Sync failed: ' + S.sync.error : 'Synced ✓')); }
  else if (a === 'new-book') { const w = $('#wn'), p = me(); if (w && p && w.value.trim()) put('people', { ...p, name: w.value.trim() }); bookSheet(); }
  else if (a === 'open-book') { S.ui.tab = 'entries'; S.ui.limit = 40; go('book/' + d.id); }
  else if (a === 'more') { S.ui.limit += 40; render(); }
  else if (a === 'tab') { S.ui.tab = d.tab; render(); }
  else if (a === 'new-entry') entrySheet();
  else if (a === 'quick-add') { let last = null; try { last = localStorage.getItem('sb.last'); } catch {} const lb = last && S.doc.books[last]; entrySheet(null, null, lb && !lb.deleted ? last : PERSONAL_ID); }
  else if (a === 'open-personal') { S.ui.tab = 'entries'; S.ui.limit = 40; go('book/' + PERSONAL_ID); }
  else if (a === 'add-income') entrySheet(null, { type: 'income', cat: '💼' }, PERSONAL_ID);
  else if (a === 'add-expense') entrySheet(null, null, PERSONAL_ID);
  else if (a === 'edit-entry') entrySheet(d.id);
  else if (a === 'edit-book') bookSheet(S.ui.bookId);
  else if (a === 'del-book') {
    const bk0 = S.doc.books[S.ui.bookId], n0 = bookEntries(S.ui.bookId).length;
    askConfirm({ title: `Delete “${bk0.name}”?`, message: `This removes the book and its ${n0} entr${n0 === 1 ? 'y' : 'ies'} on all your devices. You can undo right after.`, ok: 'Delete', danger: true }).then(yes => { if (!yes) return;
    const id = S.ui.bookId, old = S.doc.books[id], ens = bookEntries(id), t = now();
    ens.forEach(en => { S.doc.entries[en.id] = { id: en.id, deleted: true, updatedAt: t, bookId: id }; });
    S.doc.books[id] = { id, deleted: true, updatedAt: t };
    S.ui.view = 'home'; S.ui.bookId = null; history.replaceState(null, '', location.pathname + location.search); touched();
    toast('Book deleted', () => { put('books', old); ens.forEach(en => put('entries', en)); toast('Restored'); }); });
  }
  else if (a === 'settle') {
    const id = uid(), bk = S.doc.books[S.ui.bookId];
    put('entries', { id, bookId: bk.id, type: 'settle', desc: 'Payment', amount: +d.amt, paidBy: d.from, split: { [d.to]: +d.amt }, method: 'exact', date: isoDay(Date.now()), cat: '🤝', note: '', createdAt: now() });
    buzz(); toast(`${pname(d.from)} paid ${pname(d.to)} ${fmt(+d.amt, bk.currency)}`, () => { del('entries', id); toast('Payment removed'); });
  }
  else if (a === 'repay-loan') {
    const r = loanReport(S.ui.bookId).find(x => x.id === d.id), bk = S.doc.books[S.ui.bookId];
    entrySheet(null, { type: 'settle', paidBy: r.borrower, sel: [r.lender], amount: toInput(r.out + r.intDebt, bk.currency) });
  }
  else if (a === 'charge-interest') { const id = chargeInterest(d.id); if (id) { buzz(); toast('Interest added to balance', () => { del('entries', id); toast('Interest removed'); }); } }
  else if (a === 'open-loans') { S.ui.tab = 'balances'; go('book/' + d.id); }
  else if (a === 'share') shareSummary();
  else if (a === 'add-member') {
    const inp = $('#addm'), n = inp && inp.value.trim(), bk = S.doc.books[S.ui.bookId]; if (!n) return;
    const p = { id: uid(), name: n, createdAt: now() }; put('people', p); put('books', { ...bk, memberIds: [...bk.memberIds, p.id] }); toast(n + ' added');
    setTimeout(() => { const i = $('#addm'); i && i.focus(); }, 30);
  }
});
document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'addm') { e.preventDefault(); $('[data-act=add-member]').click(); } });
window.addEventListener('hashchange', route);
window.addEventListener('online', () => { render(); sync(false); });
window.addEventListener('offline', () => { render(); toast('Offline — everything is saved on this device'); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { materializeRecurring(); sync(false); } });
setInterval(() => { if (!document.hidden) { materializeRecurring(); sync(false); } }, 15000);
window.addEventListener('focus', () => sync(false));
window.addEventListener('storage', e => { if (e.key === 'sb.doc') { S.doc = jget('sb.doc', S.doc); render(); } });

/* ───────────────────────── boot ───────────────────────── */
let pendingReload = false;
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller; let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;               // first install: nothing to refresh
    if ($('.overlay')) { pendingReload = true; return; }   // don't interrupt an open form
    reloading = true; location.reload();
  });
  navigator.serviceWorker.register('sw.js').then(reg => {
    reg.update().catch(() => {});
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
  }).catch(e => console.warn('sw', e));
}
ensureMe(); ensurePersonal(); route(); materializeRecurring();
if (S.meta.wasSignedIn) sync(false);
