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

/* ───────────────────────── UI: helpers ───────────────────────── */
const HUES = [252, 199, 152, 24, 340, 45, 175, 290];
const hueOf = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return HUES[h % HUES.length]; };
const initials = n => (String(n).trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2) || '?').toUpperCase();
const avatar = (id, cls = '') => { const p = person(id); return `<span class="av ${cls}" style="--h:${hueOf(id)}">${esc(initials(p ? p.name : '?'))}</span>`; };
const avStack = ids => `<span class="avs">${ids.slice(0, 4).map(i => avatar(i, 'xs')).join('')}${ids.length > 4 ? `<span class="av xs more">+${ids.length - 4}</span>` : ''}</span>`;
const CATS = [['🧾', 'Other'], ['🍽️', 'Food'], ['🛒', 'Groceries'], ['🚗', 'Transport'], ['🏠', 'Home'], ['🎬', 'Fun'], ['✈️', 'Travel'], ['💡', 'Bills'], ['🎁', 'Gift'], ['🏥', 'Health']];
const symbol = cur => { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).formatToParts(0).find(p => p.type === 'currency').value; } catch { return cur; } };
const isoDay = d => new Date(d).toISOString().slice(0, 10);
const dayLabel = d => {
  if (d === isoDay(Date.now())) return 'Today';
  if (d === isoDay(Date.now() - 864e5)) return 'Yesterday';
  return new Date(d + 'T00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
};

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
  app.innerHTML = S.ui.view === 'book' ? bookView() : homeView();
  paintStatus();
}
const money = (v, cur, signed) => (signed && v > 0 ? '+' : '') + fmt(v, cur).replace(/^-/, '−');

function homeView() {
  const m = me(), books = live('books').sort((a, b) => b.updatedAt - a.updatedAt), tot = {};
  const cards = books.map(b => {
    const net = netBalances(b.id), mine = m ? (net[m.id] || 0) : 0;
    (tot[b.currency] = tot[b.currency] || { owed: 0, owe: 0 })[mine > 0 ? 'owed' : 'owe'] += Math.abs(mine);
    const chip = Math.abs(mine) < 1 ? `<span class="chip-b zero">Settled</span>` : mine > 0 ? `<span class="chip-b pos">+${fmt(mine, b.currency)}</span>` : `<span class="chip-b neg">−${fmt(-mine, b.currency)}</span>`;
    return `<button class="bk" data-act="open-book" data-id="${b.id}"><span class="bk-ico">${esc(b.emoji || '📒')}</span>
      <span class="bk-mid"><b>${esc(b.name)}</b>${avStack(b.memberIds)}</span>${chip}</button>`;
  }).join('');
  const cur = Object.keys(tot);
  const hero = cur.length ? (() => {
    const netOf = c => tot[c].owed - tot[c].owe, c0 = cur[0], n0 = netOf(c0);
    return `<section class="hero"><div class="hero-l">Overall balance</div>
      <div class="hero-n ${n0 < 0 ? 'neg' : ''}">${money(n0, c0, true)}</div>
      <div class="hero-s">${n0 === 0 ? 'You are all settled up' : n0 > 0 ? 'in your favour across all books' : 'you owe across all books'}${cur.slice(1).map(c => ` · ${money(netOf(c), c, true)}`).join('')}</div>
      <div class="hero-row"><div><span class="dot pos"></span>Owed to you<b>${cur.map(c => fmt(tot[c].owed, c)).join(' · ')}</b></div>
      <div><span class="dot neg"></span>You owe<b>${cur.map(c => fmt(tot[c].owe, c)).join(' · ')}</b></div></div></section>`;
  })() : `<section class="hero welcome"><div class="hero-l">Welcome to SplitBook</div><div class="hero-t">Track shared money,<br>without the awkwardness.</div>
      <ol class="steps"><li><i>1</i>Create a book for a trip, home or group</li><li><i>2</i>Add expenses — split in one tap</li><li><i>3</i>See who owes who and settle up</li></ol>
      ${(!m || m.name === 'Me') ? `<input id="wn" class="wn" placeholder="Your name (optional)" maxlength="40" autocomplete="given-name">` : ''}</section>`;
  const backup = (S.meta.wasSignedIn || !clientId()) ? '' : `<button class="banner" data-act="settings"><span>☁️</span><span><b>Back up to Google Drive</b><small>Sync across devices. Works offline.</small></span><i>›</i></button>`;
  const name = (m && m.name !== 'Me' && m.name) || '';
  return `<header class="top"><div>${name ? `<small>Hi,</small><h1>${esc(name)} 👋</h1>` : `<h1>Welcome 👋</h1>`}</div>${statusPill()}
      <button class="iconbtn" data-act="settings" aria-label="Settings">${m ? avatar(m.id) : '⚙️'}</button></header>
    <main>${hero}${backup}${books.length ? `<div class="sec-h">Your books</div><div class="list">${cards}<button class="bk new" data-act="new-book"><span class="bk-ico">＋</span><span class="bk-mid"><b>New book</b></span></button></div>` : ''}</main>
    <button class="fab ${books.length ? '' : 'wide'}" data-act="${books.length ? 'quick-add' : 'new-book'}" aria-label="${books.length ? 'Add expense' : 'New book'}"><i>＋</i><span>${books.length ? 'Add expense' : 'Create your first book'}</span></button>`;
}

function bookView() {
  const b = S.doc.books[S.ui.bookId], tab = S.ui.tab, m = me(), cur = b.currency;
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
    body = es.length ? es.map(e => {
      const day = dayLabel(e.date), head = day !== last ? `<div class="day">${day}</div>` : ''; last = day;
      const mn = m ? (e.paidBy === m.id ? e.amount : 0) - (e.split[m.id] || 0) : 0;
      const isS = e.type === 'settle';
      const sub = isS ? `${esc(pname(e.paidBy))} paid ${esc(pname(Object.keys(e.split)[0]))}` : `${esc(pname(e.paidBy))} paid ${fmt(e.amount, cur)}`;
      const right = mn === 0 ? `<small class="muted">not involved</small>` : `<b class="${mn > 0 ? 'pos' : 'neg'}">${mn > 0 ? '+' : '−'}${fmt(Math.abs(mn), cur)}</b><small>${mn > 0 ? 'you lent' : 'you borrowed'}</small>`;
      return head + `<button class="tx" data-act="edit-entry" data-id="${e.id}"><span class="tx-ico ${isS ? 'pay' : ''}">${isS ? '🤝' : esc(e.cat || '🧾')}</span>
        <span class="tx-mid"><b>${esc(e.desc || (isS ? 'Payment' : 'Expense'))}</b><small>${sub}</small></span><span class="tx-end">${right}</span></button>`;
    }).join('') : `<div class="empty"><div class="ico">🧾</div><b>Nothing here yet</b><p>Record the first shared expense.</p><button class="btn sm" data-act="new-entry">＋ Add expense</button></div>`;
  } else if (tab === 'balances') {
    const ids = b.memberIds.filter(i => person(i) && !person(i).deleted), debts = simplify(net);
    const max = Math.max(1, ...ids.map(i => Math.abs(net[i] || 0)));
    body = `<div class="card pad">` + ids.map(i => { const v = net[i] || 0;
      return `<div class="bal">${avatar(i)}<div class="bal-mid"><div class="bal-top"><b>${esc(pname(i))}</b><span class="${v > 0 ? 'pos' : v < 0 ? 'neg' : 'muted'}">${Math.abs(v) < 1 ? 'settled' : money(v, cur, true)}</span></div>
        <div class="bar"><i class="${v >= 0 ? 'pos' : 'neg'}" style="width:${Math.abs(v) / max * 100}%"></i></div></div></div>`; }).join('') + `</div>
      <div class="sec-h">Settle up <button class="link" data-act="share">Share summary</button></div>` + (debts.length ? debts.map(d => `<div class="settle"><div class="settle-who">${avatar(d.from, 'sm')}<span class="arrow">→</span>${avatar(d.to, 'sm')}</div>
        <div class="settle-t"><b>${esc(pname(d.from))} pays ${esc(pname(d.to))}</b><small>${fmt(d.amt, cur)}</small></div>
        <button class="btn sm" data-act="settle" data-from="${d.from}" data-to="${d.to}" data-amt="${d.amt}">Settle</button></div>`).join('') :
      `<div class="empty small"><div class="ico">🎉</div><b>All settled up</b></div>`);
  } else {
    const ids = b.memberIds.filter(i => person(i) && !person(i).deleted);
    body = `<div class="card pad">${ids.map(i => `<div class="bal">${avatar(i)}<div class="bal-mid"><b>${esc(pname(i))}</b></div></div>`).join('')}</div>
      <div class="addrow"><input id="addm" placeholder="Add someone to this book…" maxlength="40" autocomplete="off"><button class="btn" data-act="add-member">Add</button></div>
      <div class="btns two"><button class="btn" data-act="edit-book">✏️ Edit book</button><button class="btn danger" data-act="del-book">🗑 Delete</button></div>`;
  }
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
function closeSheet() { const o = $('.overlay'); if (o) { o.remove(); document.body.classList.remove('noscroll'); } }
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

/* ---- book form ---- */
const REGION_CUR = { IN: 'INR', US: 'USD', GB: 'GBP', AU: 'AUD', CA: 'CAD', JP: 'JPY', SG: 'SGD', AE: 'AED', CH: 'CHF', CN: 'CNY', BR: 'BRL', ZA: 'ZAR', MX: 'MXN',
  DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR', NL: 'EUR', IE: 'EUR', PT: 'EUR', BE: 'EUR', AT: 'EUR', FI: 'EUR', GR: 'EUR' };
const localeCurrency = () => REGION_CUR[((navigator.language || '').split('-')[1] || '').toUpperCase()] || 'INR';
const EMOJIS = ['📒', '✈️', '🏠', '🍻', '🎉', '🏖️', '🚗', '🛒', '💼', '❤️'];
function bookSheet(id) {
  const ex = id && S.doc.books[id], m = me();
  const B = ex ? { ...ex, memberIds: [...ex.memberIds] } : { name: '', emoji: '📒', currency: localStorage.getItem('sb.cur') || localeCurrency(), memberIds: m ? [m.id] : [] };
  const o = openSheet('<div id="form"></div>'), root = $('#form', o);
  const keep = () => { if ($('#bn', o)) { B.name = $('#bn', o).value; B.currency = $('#bc', o).value; } };
  const draw = () => {
    const people = live('people');
    root.innerHTML = `<div class="sh-head"><h2>${ex ? 'Edit book' : 'New book'}</h2><button class="iconbtn" data-x="close" aria-label="Close">✕</button></div>
      <label class="field"><span>Name</span><input id="bn" value="${esc(B.name)}" placeholder="Goa trip, Flat 4B…" maxlength="60" autocomplete="off"></label>
      <div class="field"><span>Icon</span><div class="emojis">${EMOJIS.map(e => `<button data-x="emoji" data-v="${e}" class="${B.emoji === e ? 'on' : ''}">${e}</button>`).join('')}</div></div>
      <label class="field"><span>Currency</span><select id="bc">${[...new Set([B.currency, ...CURRENCIES])].map(c => `<option ${c === B.currency ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
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
    else if (x === 'mem') { const i = B.memberIds.indexOf(t.dataset.v); i < 0 ? B.memberIds.push(t.dataset.v) : B.memberIds.splice(i, 1); draw(); }
    else if (x === 'addp') { const n = $('#np', o).value.trim(); if (!n) return; const p = { id: uid(), name: n, createdAt: now() }; put('people', p); B.memberIds.push(p.id); draw(); $('#np', o).focus(); }
    else if (x === 'save') {
      if (!B.name.trim()) return toast('Give the book a name');
      if (B.memberIds.length < 1) return toast('Add at least one person');
      localStorage.setItem('sb.cur', B.currency);
      const book = { ...B, name: B.name.trim(), id: ex ? ex.id : uid(), createdAt: ex ? ex.createdAt : now() };
      put('books', book); closeSheet(); if (!ex) go('book/' + book.id); toast(ex ? 'Book updated' : 'Book created');
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
  const setBook = id => { bid = id; b = S.doc.books[id]; cur = b.currency; members = b.memberIds.filter(i => person(i) && !person(i).deleted); };
  setBook(bid);
  const m = me();
  const defPayer = () => (m && members.includes(m.id)) ? m.id : members[0];
  const E = ex ? { type: ex.type, desc: ex.desc, amount: toInput(ex.amount, cur), paidBy: ex.paidBy, date: ex.date, cat: ex.cat || '🧾', note: ex.note || '',
      method: ex.method || 'exact', sel: Object.keys(ex.split), vals: {}, custom: (ex.method || 'exact') !== 'equal' }
    : { type: 'expense', desc: '', amount: '', paidBy: defPayer(), date: isoDay(Date.now()), cat: '🧾', note: '', method: 'equal', sel: [...members], vals: {}, custom: false };
  if (ex) for (const [p, c] of Object.entries(ex.split)) E.vals[p] = (ex.method === 'percent' || ex.method === 'shares') ? ((ex.vals && ex.vals[p]) ?? '') : toInput(c, cur);
  if (ex && ex.type === 'expense' && ex.method === 'equal') E.custom = false;
  if (preset) Object.assign(E, preset);
  const o = openSheet('<div id="form"></div>'), root = $('#form', o);
  const amt = () => parseMoney(E.amount, cur);

  function compute() {
    const total = amt();
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
      else if (E.method === 'equal' && E.sel.length && total) { h.textContent = `${fmt(Math.round(total / E.sel.length), cur)} each · ${E.sel.length} ${E.sel.length === 1 ? 'person' : 'people'}`; h.className = 'hint'; }
      else { h.textContent = ''; h.className = 'hint'; }
    }
    const sb = $('#savebtn', root); if (sb) sb.textContent = (ex ? 'Save' : E.type === 'settle' ? 'Record payment' : 'Add expense') + (total ? ` · ${fmt(total, cur)}` : '');
  }
  const pc = (id, on, x) => `<button class="pc ${on ? 'on' : ''}" data-x="${x}" data-v="${id}">${avatar(id, 'xs')}${esc(pname(id))}</button>`;

  function draw() {
    const isS = E.type === 'settle', unit = E.method === 'percent' ? '%' : E.method === 'shares' ? '×' : cur;
    const books = live('books');
    root.innerHTML = `<div class="sh-head"><div class="seg2"><button data-x="type" data-v="expense" class="${!isS ? 'on' : ''}">Expense</button><button data-x="type" data-v="settle" class="${isS ? 'on' : ''}">Payment</button></div>
        <button class="iconbtn" data-x="close" aria-label="Close">✕</button></div>
      ${!ex && books.length > 1 ? `<div class="pcs scroll">${books.map(k => `<button class="pc ${k.id === bid ? 'on' : ''}" data-x="book" data-v="${k.id}">${esc(k.emoji || '📒')} ${esc(k.name)}</button>`).join('')}</div>` : ''}
      <div class="amt"><span class="cur">${esc(symbol(cur))}</span><input id="ea" inputmode="decimal" autocomplete="off" value="${esc(E.amount)}" placeholder="0"></div>
      ${isS ? '' : `<input id="ed" class="desc" value="${esc(E.desc)}" placeholder="What was it for?" maxlength="80" autocomplete="off">
      <div class="cats">${CATS.map(([c, l]) => `<button data-x="cat" data-v="${c}" data-l="${l}" class="${E.cat === c ? 'on' : ''}"><i>${c}</i>${l}</button>`).join('')}</div>`}
      <div class="lbl">${isS ? 'Who paid?' : 'Paid by'}</div><div class="pcs scroll">${members.map(i => pc(i, i === E.paidBy, 'paid')).join('')}</div>
      ${isS ? `<div class="lbl">Paid to</div><div class="pcs scroll">${members.filter(i => i !== E.paidBy).map(i => pc(i, i === E.sel[0], 'to')).join('')}</div>` :
      `<div class="lbl">Split between <button class="link" data-x="all">${E.sel.length === members.length ? 'Clear' : 'Everyone'}</button></div>
      ${E.custom ? `<div class="seg">${[['equal', 'Equal'], ['exact', 'Exact'], ['percent', '%'], ['shares', 'Shares']].map(([k, l]) => `<button data-x="method" data-v="${k}" class="${E.method === k ? 'on' : ''}">${l}</button>`).join('')}</div>
        <div class="card pad">${members.map(i => `<div class="who"><label>${avatar(i, 'xs')}<input type="checkbox" data-x="sel" data-v="${i}" ${E.sel.includes(i) ? 'checked' : ''}><span>${esc(pname(i))}</span></label>
          ${E.method !== 'equal' && E.sel.includes(i) ? `<input class="val" data-val="${i}" inputmode="decimal" value="${esc(E.vals[i] ?? '')}" placeholder="${unit}">` : ''}<span class="calc" data-calc="${i}"></span></div>`).join('')}</div>` :
        `<div class="pcs">${members.map(i => pc(i, E.sel.includes(i), 'tog')).join('')}</div>`}
      <div class="split-foot"><span id="hint" class="hint"></span><button class="link" data-x="custom">${E.custom ? 'Simple split' : 'Customize split'}</button></div>`}
      <div class="row2"><label class="field"><span>Date</span><input id="edt" type="date" value="${E.date}"></label>
        ${isS ? '' : `<label class="field grow"><span>Note</span><input id="en" value="${esc(E.note)}" placeholder="Optional" maxlength="300"></label>`}</div>
      <div class="btns"><button class="cta" id="savebtn" data-x="save"></button>${ex ? `<button class="btn danger" data-x="del" aria-label="Delete">🗑</button>` : ''}</div>`;
    updateCalc();
  }
  const pull = () => {
    const g = id => root.querySelector(id);
    if (g('#ed')) E.desc = g('#ed').value; if (g('#ea')) E.amount = g('#ea').value; if (g('#edt')) E.date = g('#edt').value || E.date; if (g('#en')) E.note = g('#en').value;
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
    else if (x === 'type') { E.type = v; E.sel = v === 'settle' ? [members.find(i => i !== E.paidBy)].filter(Boolean) : [...members]; draw(); }
    else if (x === 'book') { setBook(v); E.paidBy = defPayer(); E.sel = [...members]; E.vals = {}; draw(); }
    else if (x === 'cat') { E.cat = v; if (!E.desc.trim()) E.desc = t.dataset.l === 'Other' ? '' : t.dataset.l; draw(); $('#ed', root).focus(); }
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
      const isS = E.type === 'settle', catLabel = (CATS.find(([c0]) => c0 === E.cat) || [])[1];
      const entry = { id: ex ? ex.id : uid(), bookId: bid, type: E.type, desc: isS ? 'Payment' : (E.desc.trim() || catLabel || 'Expense'), amount: total, paidBy: E.paidBy,
        split: Object.fromEntries(Object.entries(c.split).filter(([, n]) => n > 0 || isS)), method: isS ? 'exact' : E.method, vals,
        date: E.date, cat: E.cat, note: E.note.trim(), createdAt: ex ? ex.createdAt : now() };
      put('entries', entry); buzz(); closeSheet();
      if (S.ui.bookId !== bid) go('book/' + bid);
      toast(ex ? 'Entry updated' : isS ? 'Payment recorded' : 'Expense added');
    }
  });
  draw();
  if (!ex && !preset) setTimeout(() => { const a = $('#ea', root); a && a.focus(); }, 80);
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
    <div class="lbl">Backup</div><div class="btns two"><button class="btn" data-x="export">Export</button><button class="btn" data-x="import">Import</button></div>
    <p class="note c">SplitBook · works offline · installable</p>`);
  o.addEventListener('click', async e => {
    const x = e.target.closest('[data-x]')?.dataset.x; if (!x) return;
    if (x === 'close') closeSheet();
    else if (x === 'in') { closeSheet(); await signIn(); }
    else if (x === 'out') { closeSheet(); signOut(); }
    else if (x === 'sync') { closeSheet(); await sync(true); toast(S.sync.state === 'err' ? 'Sync failed: ' + S.sync.error : 'Synced ✓'); }
    else if (x === 'savename') { const n = $('#myname', o).value.trim(); if (m && n) { put('people', { ...m, name: n }); toast('Saved'); } }
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
  else if (a === 'open-book') { S.ui.tab = 'entries'; go('book/' + d.id); }
  else if (a === 'tab') { S.ui.tab = d.tab; render(); }
  else if (a === 'new-entry') entrySheet();
  else if (a === 'quick-add') entrySheet(null, null, (live('books').sort((x, y) => y.updatedAt - x.updatedAt)[0] || {}).id);
  else if (a === 'edit-entry') entrySheet(d.id);
  else if (a === 'edit-book') bookSheet(S.ui.bookId);
  else if (a === 'del-book') {
    if (!confirm('Delete this book and all its entries?')) return;
    const id = S.ui.bookId, old = S.doc.books[id], ens = bookEntries(id);
    ens.forEach(en => del('entries', en.id)); del('books', id); go('');
    toast('Book deleted', () => { put('books', old); ens.forEach(en => put('entries', en)); toast('Restored'); });
  }
  else if (a === 'settle') {
    const id = uid(), bk = S.doc.books[S.ui.bookId];
    put('entries', { id, bookId: bk.id, type: 'settle', desc: 'Payment', amount: +d.amt, paidBy: d.from, split: { [d.to]: +d.amt }, method: 'exact', date: isoDay(Date.now()), cat: '🤝', note: '', createdAt: now() });
    buzz(); toast(`${pname(d.from)} paid ${pname(d.to)} ${fmt(+d.amt, bk.currency)}`, () => { del('entries', id); toast('Payment removed'); });
  }
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
document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(false); });
setInterval(() => { if (!document.hidden) sync(false); }, 60000);
window.addEventListener('storage', e => { if (e.key === 'sb.doc') { S.doc = jget('sb.doc', S.doc); render(); } });

/* ───────────────────────── boot ───────────────────────── */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(e => console.warn('sw', e));
ensureMe(); route();
if (S.meta.wasSignedIn) sync(false);
