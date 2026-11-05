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
const CATS = ['🧾', '🍽️', '🛒', '🚗', '🏠', '🎬', '✈️', '💡', '🎁', '🏥'];
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
  ui: { view: 'home', bookId: null, tab: 'entries' },
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
  const o = S.doc[coll][id]; if (!o) return;
  S.doc[coll][id] = { id, deleted: true, updatedAt: now(), bookId: o.bookId }; // tombstone
  touched();
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
  if (!cid) throw new Error('Set your Google Client ID in Settings first.');
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
function scheduleSync() { clearTimeout(syncTimer); syncTimer = setTimeout(() => sync(false), 1500); }
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
    const pristine = !live('books').length && !live('entries').length;
    if (remote && pristine) { for (const p of live('people')) if (p.isMe && !(remote.people && remote.people[p.id])) delete S.doc.people[p.id]; }
    const m = mergeDocs(S.doc, remote);
    S.doc = m.doc;
    ensureMe();
    let id = f && f.id;
    if (!remote || m.remoteStale || S.meta.dirty) id = await driveWrite(id, S.doc);
    S.meta.fileId = id; S.meta.dirty = false; S.meta.lastSync = now();
    S.sync = { state: 'idle', error: '' };
    persist(); render();
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
function statusInfo() {
  if (!S.meta.wasSignedIn) return { cls: '', text: 'Local only' };
  if (!navigator.onLine) return { cls: 'pending', text: S.meta.dirty ? 'Offline · changes queued' : 'Offline' };
  if (S.sync.state === 'busy') return { cls: 'busy', text: 'Syncing…' };
  if (S.sync.state === 'err') return { cls: 'err', text: 'Sync failed' };
  if (S.meta.dirty) return { cls: 'pending', text: 'Pending' };
  return { cls: 'ok', text: 'Synced' };
}
function paintStatus() { const el = $('#status'); if (!el) return; const s = statusInfo(); el.innerHTML = `<span class="sync-dot ${s.cls}"></span>${s.text}`; }

/* ───────────────────────── UI: toast & routing ───────────────────────── */
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3200); }
function route() {
  const h = location.hash.slice(1);
  const m = h.match(/^book\/(.+)$/);
  if (m && S.doc.books[m[1]] && !S.doc.books[m[1]].deleted) { S.ui.view = 'book'; S.ui.bookId = m[1]; }
  else { S.ui.view = 'home'; S.ui.bookId = null; }
  render();
}
const go = h => { location.hash = h; };

/* ───────────────────────── UI: views ───────────────────────── */
function balanceText(v, cur) {
  if (Math.abs(v) < 1) return `<span class="muted">settled up</span>`;
  return v > 0 ? `<span class="pos">you are owed ${fmt(v, cur)}</span>` : `<span class="neg">you owe ${fmt(-v, cur)}</span>`;
}
function render() {
  const app = $('#app'); if (!app) return;
  if (!me()) { ensureMe(); }
  const sheetOpen = $('.overlay');
  app.innerHTML = S.ui.view === 'book' ? bookView() : homeView();
  paintStatus();
  void sheetOpen;
}
function header(title, back) {
  return `<header class="bar">${back ? `<button class="iconbtn" data-act="back" aria-label="Back">←</button>` : ''}
    <h1>${esc(title)}</h1><button class="pill" id="status" data-act="sync-now"></button>
    <button class="iconbtn" data-act="settings" aria-label="Settings">⚙️</button></header>`;
}
function homeView() {
  const books = live('books').sort((a, b) => b.updatedAt - a.updatedAt);
  const m = me(); const totals = {};
  const rows = books.map(b => {
    const net = netBalances(b.id), mine = m ? (net[m.id] || 0) : 0;
    totals[b.currency] = totals[b.currency] || { owed: 0, owe: 0 };
    if (mine > 0) totals[b.currency].owed += mine; else totals[b.currency].owe += -mine;
    const n = bookEntries(b.id).length;
    return `<button class="row" data-act="open-book" data-id="${b.id}"><div class="ico">${esc(b.emoji || '📒')}</div>
      <div class="mid"><b>${esc(b.name)}</b><small class="muted">${b.memberIds.length} people · ${n} entr${n === 1 ? 'y' : 'ies'}</small></div>
      <div class="end"><small>${balanceText(mine, b.currency)}</small></div></button>`;
  }).join('');
  const cur = Object.keys(totals);
  const summary = cur.length ? `<div class="card summary"><div><div class="label">You are owed</div>${cur.map(c => `<div class="big pos">${fmt(totals[c].owed, c)}</div>`).join('')}</div>
    <div><div class="label">You owe</div>${cur.map(c => `<div class="big neg">${fmt(totals[c].owe, c)}</div>`).join('')}</div></div>` : '';
  return header('📒 SplitBook') + `<main>${summary}${rows ? `<div class="list">${rows}</div>` :
    `<div class="empty"><div class="ico">📒</div><p><b>Start your first journal book</b><br>Create a book for a trip, flat, or friend group, then add shared expenses.</p></div>`}</main>
    <button class="fab" data-act="new-book">＋ New book</button>`;
}
function bookView() {
  const b = S.doc.books[S.ui.bookId], tab = S.ui.tab;
  const tabs = ['entries', 'balances', 'members'].map(t => `<button class="${tab === t ? 'on' : ''}" data-act="tab" data-tab="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('');
  let body = '';
  if (tab === 'entries') {
    const es = bookEntries(b.id); let last = '';
    body = es.length ? '<div class="list">' + es.map(e => {
      const mo = new Date(e.date + 'T00:00').toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
      const head = mo !== last ? `<div class="month">${mo}</div>` : ''; last = mo;
      const m = me(), mine = m ? (e.paidBy === m.id ? e.amount : 0) - (e.split[m.id] || 0) : 0;
      const sub = e.type === 'settle' ? `${esc(pname(e.paidBy))} paid ${esc(pname(Object.keys(e.split)[0]))}` : `${esc(pname(e.paidBy))} paid ${fmt(e.amount, b.currency)}`;
      return head + `<button class="row" data-act="edit-entry" data-id="${e.id}"><div class="ico">${e.type === 'settle' ? '🤝' : esc(e.cat || '🧾')}</div>
        <div class="mid"><b>${esc(e.desc || (e.type === 'settle' ? 'Settlement' : 'Expense'))}</b><small class="muted">${sub} · ${e.date.slice(5)}</small></div>
        <div class="end"><b>${fmt(e.amount, b.currency)}</b><small>${mine === 0 ? 'not involved' : mine > 0 ? `<span class="pos">you lent ${fmt(mine, b.currency)}</span>` : `<span class="neg">you borrowed ${fmt(-mine, b.currency)}</span>`}</small></div></button>`;
    }).join('') + '</div>' : `<div class="empty"><div class="ico">🧾</div><p>No entries yet.<br>Tap “Add expense” to record one.</p></div>`;
  } else if (tab === 'balances') {
    const net = netBalances(b.id), debts = simplify(net), ids = b.memberIds.filter(i => person(i) && !person(i).deleted);
    body = `<div class="sect">Balances</div><div class="list">` + ids.map(i => { const v = net[i] || 0;
      return `<div class="row"><div class="ico">👤</div><div class="mid"><b>${esc(pname(i))}</b></div><div class="end"><b class="${v > 0 ? 'pos' : v < 0 ? 'neg' : 'muted'}">${v > 0 ? '+' : ''}${fmt(v, b.currency)}</b></div></div>`; }).join('') + `</div>
      <div class="sect">Suggested settle-up</div>` + (debts.length ? `<div class="list">` + debts.map(d => `<div class="settle"><div class="t"><b>${esc(pname(d.from))}</b> → <b>${esc(pname(d.to))}</b><br><span class="muted">${fmt(d.amt, b.currency)}</span></div>
        <button class="btn sm primary" data-act="settle" data-from="${d.from}" data-to="${d.to}" data-amt="${d.amt}">Record payment</button></div>`).join('') + '</div>' : `<p class="muted">Everyone is settled up 🎉</p>`);
  } else {
    body = `<div class="sect">Members</div><div class="list">` + b.memberIds.filter(i => person(i) && !person(i).deleted).map(i => `<div class="row"><div class="ico">👤</div><div class="mid"><b>${esc(pname(i))}</b></div></div>`).join('') + `</div>
      <div class="btns" style="margin-top:14px"><button class="btn" data-act="edit-book">Edit book</button><button class="btn danger" data-act="del-book">Delete book</button></div>`;
  }
  return header(`${b.emoji || '📒'} ${b.name}`, true) + `<main><div class="tabs">${tabs}</div>${body}</main>` +
    (tab === 'entries' ? `<button class="fab" data-act="new-entry">＋ Add expense</button>` : '');
}

/* ───────────────────────── sheets ───────────────────────── */
function openSheet(html) {
  closeSheet();
  const o = document.createElement('div'); o.className = 'overlay';
  o.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  o.addEventListener('mousedown', e => { if (e.target === o) closeSheet(); });
  document.body.appendChild(o); return o;
}
function closeSheet() { const o = $('.overlay'); if (o) o.remove(); }

/* ---- book form ---- */
function bookSheet(id) {
  const ex = id && S.doc.books[id];
  const m = me();
  const B = ex ? { ...ex, memberIds: [...ex.memberIds] } : { name: '', emoji: '📒', currency: localStorage.getItem('sb.cur') || 'INR', memberIds: m ? [m.id] : [] };
  const o = openSheet('');
  const draw = () => {
    const people = live('people');
    $('.sheet', o).innerHTML = `<h2>${ex ? 'Edit book' : 'New book'}<button class="iconbtn" data-x="close">✕</button></h2>
      <label class="field"><span>Name</span><input id="bn" value="${esc(B.name)}" placeholder="Goa trip, Flat 4B…" maxlength="60"></label>
      <div style="display:flex;gap:10px"><label class="field" style="width:90px"><span>Icon</span><input id="be" value="${esc(B.emoji)}" maxlength="4" style="text-align:center"></label>
      <label class="field" style="flex:1"><span>Currency</span><select id="bc">${[...new Set([B.currency, ...CURRENCIES])].map(c => `<option ${c === B.currency ? 'selected' : ''}>${c}</option>`).join('')}</select></label></div>
      <div class="field"><span>Members</span><div class="chips">${people.map(p => `<button class="chip ${B.memberIds.includes(p.id) ? 'on' : ''}" data-p="${p.id}">${esc(p.isMe ? 'You' : p.name)}</button>`).join('')}</div>
      <div style="display:flex;gap:8px"><input id="np" placeholder="Add a new person" style="flex:1;padding:11px 12px;border-radius:12px;border:1px solid var(--line);background:var(--card)"><button class="btn" data-x="addp">Add</button></div></div>
      <div class="btns"><button class="btn primary" data-x="save" style="flex:1">Save</button></div>`;
  };
  const keep = () => { B.name = $('#bn', o).value; B.emoji = $('#be', o).value || '📒'; B.currency = $('#bc', o).value; };
  draw();
  o.addEventListener('click', e => {
    const t = e.target.closest('[data-x],[data-p]'); if (!t) return;
    if (t.dataset.p) { keep(); const i = B.memberIds.indexOf(t.dataset.p); i < 0 ? B.memberIds.push(t.dataset.p) : B.memberIds.splice(i, 1); draw(); }
    else if (t.dataset.x === 'close') closeSheet();
    else if (t.dataset.x === 'addp') { keep(); const n = $('#np', o).value.trim(); if (!n) return; const p = { id: uid(), name: n, createdAt: now() }; put('people', p); B.memberIds.push(p.id); draw(); }
    else if (t.dataset.x === 'save') {
      keep(); if (!B.name.trim()) return toast('Give the book a name');
      if (B.memberIds.length < 1) return toast('Add at least one member');
      localStorage.setItem('sb.cur', B.currency);
      const book = { ...B, name: B.name.trim(), id: ex ? ex.id : uid(), createdAt: ex ? ex.createdAt : now() };
      put('books', book); closeSheet(); if (!ex) go('book/' + book.id);
    }
  });
}

/* ---- entry form ---- */
function entrySheet(entryId, preset) {
  const b = S.doc.books[S.ui.bookId], cur = b.currency, ex = entryId && S.doc.entries[entryId];
  const members = b.memberIds.filter(i => person(i) && !person(i).deleted);
  const m = me();
  const E = ex ? { type: ex.type, desc: ex.desc, amount: toInput(ex.amount, cur), paidBy: ex.paidBy, date: ex.date, cat: ex.cat || '🧾', note: ex.note || '',
      method: ex.method || 'exact', sel: Object.keys(ex.split), vals: {} }
    : { type: 'expense', desc: '', amount: '', paidBy: (m && members.includes(m.id)) ? m.id : members[0], date: new Date().toISOString().slice(0, 10), cat: '🧾', note: '', method: 'equal', sel: [...members], vals: {} };
  if (ex) for (const [p, c] of Object.entries(ex.split)) E.vals[p] = ex.method === 'percent' || ex.method === 'shares' ? (ex.vals && ex.vals[p]) ?? '' : toInput(c, cur);
  if (preset) Object.assign(E, preset);
  const o = openSheet('<div id="form"></div>');
  const root = $('#form', o);

  const amt = () => parseMoney(E.amount, cur);
  function compute() {
    const total = amt();
    if (E.type === 'settle') return { split: { [E.sel[0]]: total }, ok: !!E.sel[0] && E.sel[0] !== E.paidBy && total > 0 };
    if (!E.sel.length) return { split: {}, ok: false, msg: 'Select at least one person' };
    if (E.method === 'equal') { const w = {}; E.sel.forEach(i => w[i] = 1); return { split: byWeights(total, w), ok: total > 0 }; }
    if (E.method === 'shares' || E.method === 'percent') {
      const w = {}; E.sel.forEach(i => w[i] = parseFloat(E.vals[i]) || 0);
      const s = Object.values(w).reduce((a, b) => a + b, 0);
      if (s <= 0) return { split: {}, ok: false, msg: 'Enter values' };
      if (E.method === 'percent' && Math.abs(s - 100) > 0.001) return { split: byWeights(total, w), ok: false, msg: `Percentages total ${+s.toFixed(2)}% (need 100%)` };
      return { split: byWeights(total, w), ok: total > 0 };
    }
    const split = {}; let s = 0; E.sel.forEach(i => { split[i] = parseMoney(E.vals[i] || 0, cur); s += split[i]; });
    const diff = total - s;
    return { split, ok: total > 0 && diff === 0, msg: diff === 0 ? '' : `${fmt(Math.abs(diff), cur)} ${diff > 0 ? 'left to assign' : 'over the total'}` };
  }
  function updateCalc() {
    const c = compute();
    root.querySelectorAll('[data-calc]').forEach(el => { const i = el.dataset.calc; el.textContent = E.sel.includes(i) ? fmt(c.split[i] || 0, cur) : ''; });
    const h = $('#hint', root); if (h) { h.textContent = c.msg || ''; h.className = 'hint ' + (c.msg ? 'bad' : ''); }
  }
  function draw() {
    const isS = E.type === 'settle';
    const opts = sel => members.map(i => `<option value="${i}" ${i === sel ? 'selected' : ''}>${esc(pname(i))}</option>`).join('');
    const unit = E.method === 'percent' ? '%' : E.method === 'shares' ? '×' : cur;
    root.innerHTML = `<h2>${ex ? 'Edit entry' : 'Add entry'}<button class="iconbtn" data-x="close">✕</button></h2>
      <div class="seg"><button data-x="type" data-v="expense" class="${!isS ? 'on' : ''}">Expense</button><button data-x="type" data-v="settle" class="${isS ? 'on' : ''}">Settlement</button></div>
      ${isS ? '' : `<label class="field"><span>Description</span><input id="ed" value="${esc(E.desc)}" placeholder="Dinner, groceries, cab…" maxlength="80"></label>
      <div class="cats">${CATS.map(c => `<button data-x="cat" data-v="${c}" class="${E.cat === c ? 'on' : ''}">${c}</button>`).join('')}</div>`}
      <label class="field"><span>Amount (${cur})</span><input id="ea" class="amount" inputmode="decimal" value="${esc(E.amount)}" placeholder="0.00"></label>
      <div style="display:flex;gap:10px"><label class="field" style="flex:1"><span>${isS ? 'Paid by' : 'Paid by'}</span><select id="ep">${opts(E.paidBy)}</select></label>
      <label class="field" style="flex:1"><span>Date</span><input id="edt" type="date" value="${E.date}"></label></div>
      ${isS ? `<label class="field"><span>Paid to</span><select id="eto">${members.filter(i => i !== E.paidBy).map(i => `<option value="${i}" ${i === E.sel[0] ? 'selected' : ''}>${esc(pname(i))}</option>`).join('')}</select></label>` :
      `<div class="field"><span>Split</span></div>
      <div class="seg">${[['equal', 'Equally'], ['exact', 'Exact'], ['percent', '%'], ['shares', 'Shares']].map(([k, l]) => `<button data-x="method" data-v="${k}" class="${E.method === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="card" style="padding:4px 12px;margin-bottom:6px">${members.map(i => `<div class="who"><label><input type="checkbox" data-x="sel" data-v="${i}" ${E.sel.includes(i) ? 'checked' : ''}>${esc(pname(i))}</label>
        ${E.method !== 'equal' && E.sel.includes(i) ? `<input class="val" data-val="${i}" inputmode="decimal" value="${esc(E.vals[i] ?? '')}" placeholder="${unit}">` : ''}<span class="calc" data-calc="${i}"></span></div>`).join('')}</div>
      <div id="hint" class="hint"></div>
      <label class="field"><span>Note</span><textarea id="en" rows="2" maxlength="300" placeholder="Optional">${esc(E.note)}</textarea></label>`}
      <div class="btns"><button class="btn primary" data-x="save" style="flex:1">Save</button>${ex ? `<button class="btn danger" data-x="del">Delete</button>` : ''}</div>`;
    updateCalc();
  }
  const sync_ = () => { // pull plain inputs into E
    const g = id => root.querySelector(id);
    if (g('#ed')) E.desc = g('#ed').value; if (g('#ea')) E.amount = g('#ea').value; if (g('#edt')) E.date = g('#edt').value || E.date;
    if (g('#ep')) E.paidBy = g('#ep').value; if (g('#eto')) E.sel = [g('#eto').value]; if (g('#en')) E.note = g('#en').value;
  };
  root.addEventListener('input', e => {
    if (e.target.dataset.val) { E.vals[e.target.dataset.val] = e.target.value; updateCalc(); }
    else if (e.target.id === 'ea') { E.amount = e.target.value; updateCalc(); }
  });
  root.addEventListener('change', e => {
    if (e.target.id === 'ep') { sync_(); if (E.type === 'settle' && E.sel[0] === E.paidBy) E.sel = [members.find(i => i !== E.paidBy)]; draw(); }
    else if (e.target.id === 'eto') sync_();
    else if (e.target.dataset.x === 'sel') { sync_(); const v = e.target.dataset.v, i = E.sel.indexOf(v); i < 0 ? E.sel.push(v) : E.sel.splice(i, 1); draw(); }
  });
  root.addEventListener('click', e => {
    const t = e.target.closest('[data-x]'); if (!t || t.tagName === 'INPUT') return;
    const x = t.dataset.x; sync_();
    if (x === 'close') closeSheet();
    else if (x === 'type') { E.type = t.dataset.v; if (E.type === 'settle') { E.sel = [members.find(i => i !== E.paidBy)].filter(Boolean); } else E.sel = [...members]; draw(); }
    else if (x === 'cat') { E.cat = t.dataset.v; draw(); }
    else if (x === 'method') { E.method = t.dataset.v; if (E.method === 'shares') E.sel.forEach(i => E.vals[i] = E.vals[i] || 1); else if (E.method !== 'equal') E.vals = {}; draw(); }
    else if (x === 'del') { if (confirm('Delete this entry?')) { del('entries', ex.id); closeSheet(); } }
    else if (x === 'save') {
      const c = compute(); const total = amt();
      if (E.type === 'settle' && !c.ok) return toast('Choose who paid whom and an amount');
      if (total <= 0) return toast('Enter an amount');
      if (!c.ok) return toast(c.msg || 'Check the split');
      if (E.type === 'expense' && !E.desc.trim()) return toast('Add a description');
      const vals = (E.method === 'percent' || E.method === 'shares') ? Object.fromEntries(E.sel.map(i => [i, E.vals[i]])) : undefined;
      const entry = { id: ex ? ex.id : uid(), bookId: b.id, type: E.type, desc: E.type === 'settle' ? 'Settlement' : E.desc.trim(), amount: total, paidBy: E.paidBy,
        split: Object.fromEntries(Object.entries(c.split).filter(([, v]) => v > 0 || E.type === 'settle')), method: E.type === 'settle' ? 'exact' : E.method, vals,
        date: E.date, cat: E.cat, note: E.note.trim(), createdAt: ex ? ex.createdAt : now() };
      put('entries', entry); closeSheet(); toast(ex ? 'Entry updated' : 'Entry added');
    }
  });
  draw();
}

/* ---- settings ---- */
function settingsSheet() {
  const u = S.meta.user, st = statusInfo();
  const o = openSheet(`<h2>Settings<button class="iconbtn" data-x="close">✕</button></h2>
    <div class="sect">Google Drive sync</div>
    ${S.meta.wasSignedIn ? `<div class="card" style="padding:14px;margin-bottom:10px"><b>${esc((u && (u.email || u.name)) || 'Signed in')}</b>
      <div class="note"><span class="sync-dot ${st.cls}"></span>${st.text}${S.meta.lastSync ? ' · last sync ' + new Date(S.meta.lastSync).toLocaleString() : ''}${S.sync.error ? '<br>' + esc(S.sync.error) : ''}</div></div>
      <div class="btns"><button class="btn primary" data-x="sync">Sync now</button><button class="btn" data-x="out">Sign out</button></div>` :
    `<p class="note">Your data lives on this device and (when signed in) in a private hidden app folder of <i>your own</i> Google Drive. Nobody else can see it. It keeps working offline and syncs when you reconnect.</p>
     <button class="btn primary" data-x="in">Sign in with Google</button>`}
    <label class="field" style="margin-top:14px"><span>Google OAuth Client ID</span><input id="cid" value="${esc(clientId())}" placeholder="xxxx.apps.googleusercontent.com"></label>
    <button class="btn sm" data-x="savecid">Save Client ID</button>
    <div class="sect">Backup</div>
    <div class="btns"><button class="btn" data-x="export">Export JSON</button><button class="btn" data-x="import">Import JSON</button></div>
    <div class="sect">Your name</div>
    <div style="display:flex;gap:8px"><input id="myname" value="${esc((me() || {}).name || '')}" style="flex:1;padding:11px 12px;border-radius:12px;border:1px solid var(--line);background:var(--card)"><button class="btn" data-x="savename">Save</button></div>
    <p class="note" style="margin-top:16px">Tip: install this app from your browser menu (“Add to Home screen”).</p>`);
  o.addEventListener('click', async e => {
    const x = e.target.closest('[data-x]')?.dataset.x; if (!x) return;
    if (x === 'close') closeSheet();
    else if (x === 'in') { closeSheet(); await signIn(); }
    else if (x === 'out') { closeSheet(); signOut(); }
    else if (x === 'sync') { closeSheet(); await sync(true); toast(S.sync.state === 'err' ? 'Sync failed: ' + S.sync.error : 'Synced'); }
    else if (x === 'savecid') { S.meta.clientId = $('#cid', o).value.trim(); tokenClient = null; persist(); toast('Client ID saved'); }
    else if (x === 'savename') { const p = me(); const n = $('#myname', o).value.trim(); if (p && n) { put('people', { ...p, name: n }); toast('Saved'); } }
    else if (x === 'export') {
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(S.doc, null, 2)], { type: 'application/json' }));
      a.download = 'splitbook-backup-' + new Date().toISOString().slice(0, 10) + '.json'; a.click();
    } else if (x === 'import') {
      const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/json';
      inp.onchange = async () => { try { const d = JSON.parse(await inp.files[0].text()); if (!d.books || !d.entries || !d.people) throw 0;
        S.doc = mergeDocs(S.doc, d).doc; touched(); closeSheet(); toast('Imported & merged'); } catch { toast('Not a valid SplitBook backup'); } };
      inp.click();
    }
  });
}

/* ───────────────────────── events ───────────────────────── */
document.addEventListener('click', e => {
  const t = e.target.closest('[data-act]'); if (!t || t.closest('.overlay')) return;
  const a = t.dataset.act, d = t.dataset;
  if (a === 'back') go('');
  else if (a === 'settings') settingsSheet();
  else if (a === 'sync-now') { if (!S.meta.wasSignedIn) settingsSheet(); else if (!navigator.onLine) toast('You are offline — changes will sync later'); else sync(true).then(() => toast(S.sync.state === 'err' ? 'Sync failed: ' + S.sync.error : 'Synced')); }
  else if (a === 'new-book') bookSheet();
  else if (a === 'open-book') { S.ui.tab = 'entries'; go('book/' + d.id); }
  else if (a === 'tab') { S.ui.tab = d.tab; render(); }
  else if (a === 'new-entry') entrySheet();
  else if (a === 'edit-entry') entrySheet(d.id);
  else if (a === 'edit-book') bookSheet(S.ui.bookId);
  else if (a === 'del-book') { if (confirm('Delete this book and all its entries?')) { const id = S.ui.bookId; bookEntries(id).forEach(en => del('entries', en.id)); del('books', id); go(''); } }
  else if (a === 'settle') entrySheet(null, { type: 'settle', paidBy: d.from, sel: [d.to], amount: toInput(+d.amt, S.doc.books[S.ui.bookId].currency) });
});
window.addEventListener('hashchange', route);
window.addEventListener('online', () => { render(); sync(false); });
window.addEventListener('offline', () => { render(); toast('You are offline — changes are saved on this device'); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(false); });
setInterval(() => { if (!document.hidden) sync(false); }, 60000);
window.addEventListener('storage', e => { if (e.key === 'sb.doc') { S.doc = jget('sb.doc', S.doc); render(); } });

/* ───────────────────────── boot ───────────────────────── */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(e => console.warn('sw', e));
ensureMe(); route();
if (S.meta.wasSignedIn) sync(false);
