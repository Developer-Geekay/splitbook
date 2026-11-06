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
async function newDevice(browser, appUrl, drive, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: opts.width || 390, height: opts.height || 844 }, serviceWorkers: 'block', locale: opts.locale || 'en-IN', deviceScaleFactor: 1, ...(opts.ctx || {}) });
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
module.exports = { makeDrive, newDevice, signIn };
