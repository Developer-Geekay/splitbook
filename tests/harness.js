// Shared test harness: a fake Google (sign-in + Drive appDataFolder incl. binary multipart uploads) and device factory.
const DOC = 'splitbook-data.json';
function makeDrive() {
  const files = new Map(); let n = 1;
  return { files, nextId: () => 'F' + n++, byName: name => [...files.values()].find(f => f.name === name), count: prefix => [...files.values()].filter(f => f.name.startsWith(prefix)).length,
    doc() { const f = this.byName(DOC); return f ? JSON.parse(f.body.toString('utf8')) : null; } };
}
function parseMultipart(req) {
  const ct = req.headers()['content-type'] || '', m = ct.match(/boundary=(.+)$/); if (!m) return null;
  const buf = req.postDataBuffer(), s = buf.toString('latin1'), parts = s.split('--' + m[1]).slice(1, -1).map(p => p.replace(/^\r\n/, '').replace(/\r\n$/, ''));
  const [metaPart, dataPart] = parts, meta = JSON.parse(metaPart.slice(metaPart.indexOf('\r\n\r\n') + 4));
  const mime = (dataPart.match(/^Content-Type:\s*([^\r\n]+)/i) || [])[1] || 'application/octet-stream';
  return { meta, mime, body: Buffer.from(dataPart.slice(dataPart.indexOf('\r\n\r\n') + 4), 'latin1') };
}
/* Brand-new browsers see the first-run setup page; most tests want to go straight to the app. */
async function skipSetup(ctx) { await ctx.addInitScript(() => { try { if (!localStorage.getItem('sb.meta')) localStorage.setItem('sb.meta', JSON.stringify({ setup: true })); } catch {} }); }
async function newDevice(browser, appUrl, drive, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: opts.width || 390, height: opts.height || 844 }, serviceWorkers: 'block', locale: opts.locale || 'en-IN', deviceScaleFactor: 1, ...(opts.ctx || {}) });
  if (!opts.firstRun) await skipSetup(ctx);
  if (opts.voiceUi) await ctx.addInitScript(() => { window.SB_VOICE_BUTTON = true; });
  await ctx.addInitScript(o => {
    window.google = { accounts: { oauth2: { initTokenClient: c => ({ requestAccessToken: () => setTimeout(() => c.callback({ access_token: 't', expires_in: 3600 }), 5) }), revoke() {} } } };
    if (o.standalone) { const mm = window.matchMedia.bind(window); window.matchMedia = q => /display-mode:\s*standalone/.test(q) ? { matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} } : mm(q); }
  }, { standalone: !!opts.standalone });
  await ctx.route('https://accounts.google.com/**', r => r.fulfill({ body: '', contentType: 'text/javascript' }));
  await ctx.route('**/config.js', r => r.fulfill({ body: 'window.SPLITBOOK_CONFIG={GOOGLE_CLIENT_ID:"x"}', contentType: 'text/javascript' }));
  await ctx.route('https://www.googleapis.com/**', async r => {
    const req = r.request(), u = new URL(req.url()), m = req.method();
    if (u.pathname.endsWith('/userinfo')) return r.fulfill({ json: { email: 'a@b.c', name: 'Asha K', given_name: 'Asha' } });
    if (m === 'GET' && u.pathname === '/drive/v3/files') { const q = decodeURIComponent(u.searchParams.get('q') || ''), name = (q.match(/name='([^']+)'/) || [])[1]; return r.fulfill({ json: { files: [...drive.files.values()].filter(f => f.name === name).map(f => ({ id: f.id })) } }); }
    if (m === 'GET' && /^\/drive\/v3\/files\/[^/]+$/.test(u.pathname) && u.searchParams.get('alt') === 'media') { const f = drive.files.get(u.pathname.split('/').pop()); return f ? r.fulfill({ status: 200, contentType: f.mime, body: f.body }) : r.fulfill({ status: 404, body: '' }); }
    if (m === 'POST' && u.pathname === '/upload/drive/v3/files') { const p = parseMultipart(req), id = drive.nextId(); drive.files.set(id, { id, name: p.meta.name, mime: p.mime, body: p.body }); return r.fulfill({ json: { id } }); }
    if (m === 'PATCH' && u.pathname.startsWith('/upload/drive/v3/files/')) { const f = drive.files.get(u.pathname.split('/').pop()); if (f) f.body = req.postDataBuffer(); return r.fulfill({ json: { id: f && f.id } }); }
    return r.fulfill({ status: 404, body: '' });
  });
  const p = await ctx.newPage(); p.errors = []; p.dialogs = [];
  p.on('pageerror', e => p.errors.push(e.message)); p.on('dialog', d => { p.dialogs.push(d.message()); d.dismiss(); });
  if (opts.init) await ctx.addInitScript(opts.init);
  await p.goto(appUrl); return { ctx, p };
}
async function signIn(p) { await p.evaluate(() => { S.meta.wasSignedIn = true; S.meta.user = { given_name: 'Asha' }; persist(); }); await p.evaluate(() => sync(true)); }
/* Noto Indic fonts (devDependencies) so Hindi/Bengali/Telugu/Tamil text is measured with real glyph widths, even on a bare CI runner. */
const fs = require('fs'), path = require('path');
const FONTS = [['Noto Sans Devanagari', 'devanagari'], ['Noto Sans Bengali', 'bengali'], ['Noto Sans Telugu', 'telugu'], ['Noto Sans Tamil', 'tamil']];
function indicFontCss() {
  return FONTS.map(([fam, k]) => [400, 700].map(w => { const f = path.join(__dirname, '..', 'node_modules', '@fontsource', 'noto-sans-' + k, 'files', `noto-sans-${k}-${k}-${w}-normal.woff2`);
    return `@font-face{font-family:"${fam}";font-weight:${w};src:url(data:font/woff2;base64,${fs.readFileSync(f).toString('base64')}) format("woff2")}`; }).join('')).join('');
}
async function addIndicFonts(page) { await page.addStyleTag({ content: indicFontCss() }); }
/* Run in the page: reports overlaps / sideways overflow inside the open sheet, picker or dialog. */
const layoutDetect = () => {
  const root = document.querySelector('.layer .sheet, .layer .dlg, .overlay .sheet, .setup'); if (!root) return ['no sheet'];
  const out = [], sr = root.getBoundingClientRect(), scroller = e => { for (let n = e.parentElement; n && n !== root; n = n.parentElement) { const o = getComputedStyle(n).overflowX; if (o === 'auto' || o === 'scroll') return true; } return false; };
  const els = [...root.querySelectorAll('input:not([type=checkbox]):not([type=file]),button,select,textarea,label.rc,.cur-row,.pc,.who label')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; });
  const nm = e => (e.id || e.dataset.x || e.className || e.tagName).toString().slice(0, 24);
  for (const e of els) { if (scroller(e)) continue; const r = e.getBoundingClientRect(); if (r.right > sr.right + 1 || r.left < sr.left - 1) out.push('OVERFLOW ' + nm(e) + ' ' + Math.round(r.left) + '..' + Math.round(r.right)); }
  for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) { const a = els[i], c = els[j]; if (a.contains(c) || c.contains(a) || a.classList.contains('rc-x') || c.classList.contains('rc-x')) continue; const x = a.getBoundingClientRect(), y = c.getBoundingClientRect();
    if (Math.min(x.right, y.right) - Math.max(x.left, y.left) > 2 && Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top) > 2) out.push('OVERLAP ' + nm(a) + ' × ' + nm(c)); }
  if (document.documentElement.scrollWidth > innerWidth + 1) out.push('PAGE scrolls sideways');
  const a = document.querySelector('#ea'); if (a && a.scrollWidth > a.clientWidth + 1) out.push('AMOUNT clipped');
  return out;
};
module.exports = { makeDrive, newDevice, signIn, addIndicFonts, layoutDetect, skipSetup };
