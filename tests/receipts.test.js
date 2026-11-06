// Receipts: attach photos/PDFs to entries; compression, offline storage, Drive upload, second-device download.
const { chromium } = require('playwright');
const assert = require('assert');
const { start } = require('./serve');
const { makeDrive, newDevice, signIn } = require('./harness');
let pass = 0; const ok = (c, m) => { assert(c, m); pass++; console.log('  ✓', m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} → ${JSON.stringify(a)}${JSON.stringify(a) === JSON.stringify(b) ? '' : ' (expected ' + JSON.stringify(b) + ')'}`);

(async () => {
  const srv = await start(), URL = 'http://localhost:' + srv.address().port + '/index.html';
  const b = await chromium.launch(), drive = makeDrive();
  const A = await newDevice(b, URL, drive), p = A.p;

  // build a real 3000×2000 photo (noisy, so it is large) and tiny PDFs
  const photo = Buffer.from(await p.evaluate(() => { const c = document.createElement('canvas'); c.width = 3000; c.height = 2000; const x = c.getContext('2d'); let a = 12345;
    const rnd = () => (a = (a * 1664525 + 1013904223) >>> 0) / 4294967296;
    const g = x.createLinearGradient(0, 0, 3000, 2000); g.addColorStop(0, '#f4efe6'); g.addColorStop(1, '#b9c4d0'); x.fillStyle = g; x.fillRect(0, 0, 3000, 2000);   // a "paper" with grain and text-like marks
    for (let yy = 0; yy < 2000; yy += 3) for (let xx = 0; xx < 3000; xx += 3) { x.fillStyle = `rgba(${rnd() * 70 | 0},${rnd() * 70 | 0},${rnd() * 70 | 0},${0.05 + rnd() * 0.1})`; x.fillRect(xx, yy, 3, 3); }
    for (let k = 0; k < 400; k++) { x.fillStyle = '#222'; x.fillRect(200 + rnd() * 2400, 150 + rnd() * 1700, 20 + rnd() * 220, 8 + rnd() * 6); }
    return c.toDataURL('image/jpeg', 0.95).split(',')[1]; }), 'base64');
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
  const bigPdf = Buffer.concat([pdf, Buffer.alloc(4.5e6, 32)]);
  const settle = async pg => { for (let i = 0; i < 80; i++) { if (await pg.evaluate(async () => (await rcDB.pending()).length === 0)) return true; await pg.waitForTimeout(100); } return false; };
  const idbRecs = pg => pg.evaluate(async () => { const st = await rcDB.st('readonly'); const all = await rq(st.getAll()); return all.map(r => ({ id: r.id, type: r.type, size: r.size, up: r.up, name: r.name })); });

  console.log('Attach a photo');
  await p.click('.fab'); await p.fill('#ea', '1850'); await p.fill('#ed', 'Dinner at Taj');
  ok(await p.isVisible('#rfile', { timeout: 100 }).catch(() => true) || (await p.$('#rfile')) !== null, 'form offers Camera and Upload');
  ok(/Receipts/i.test(await p.innerText('.sheet')) && /Camera/.test(await p.innerText('.sheet')) && /Upload/.test(await p.innerText('.sheet')), 'Receipts row with Camera and Upload buttons');
  await p.setInputFiles('#rfile', { name: 'IMG_2041.jpg', mimeType: 'image/jpeg', buffer: photo });
  await p.waitForSelector('.rc-th.img');
  ok(true, `thumbnail appears (original ${(photo.length / 1024).toFixed(0)} KB)`);
  const recs = await idbRecs(p); eq(recs.length, 1, 'stored on the device (IndexedDB) straight away');
  ok(recs[0].type === 'image/jpeg' && recs[0].size < photo.length / 3 && recs[0].up === 0, `compressed to JPEG ${(recs[0].size / 1024).toFixed(0)} KB (${Math.round(100 - recs[0].size / photo.length * 100)}% smaller), waiting to upload`);
  const dim = await p.evaluate(async id => { const r = await rcDB.get(id); const bm = await createImageBitmap(r.blob); return [bm.width, bm.height]; }, recs[0].id);
  eq(dim, [1600, 1067], 'longest side limited to 1600px, proportions kept');
  await p.click('[data-x=save]');
  const e1 = await p.evaluate(() => live('entries').find(e => e.desc === 'Dinner at Taj'));
  ok(e1.receipts.length === 1 && e1.receipts[0].id === recs[0].id && !('blob' in e1.receipts[0]), 'entry stores only small metadata (the photo is not inside the data file)');

  console.log('PDFs and limits');
  await p.click('.fab'); await p.fill('#ea', '10'); await p.fill('#ed', 'Test limits');
  await p.setInputFiles('#rfile', { name: 'invoice.pdf', mimeType: 'application/pdf', buffer: pdf });
  await p.waitForSelector('.rc-th:has-text("PDF")'); ok(true, 'PDF accepted and shown as a PDF tile');
  await p.setInputFiles('#rfile', { name: 'huge.pdf', mimeType: 'application/pdf', buffer: bigPdf });
  await p.waitForSelector('#toast.show'); ok(/over 4 MB/.test(await p.innerText('#toast')), 'a PDF over 4 MB is refused with a clear message');
  await p.setInputFiles('#rfile', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await p.waitForFunction(() => /Only photos and PDFs/.test(document.querySelector('#toast').innerText)); ok(true, 'other file types are refused');
  eq((await p.$$('.rc-th')).length, 1, 'only the valid PDF was added');
  for (let i = 0; i < 6; i++) { if (await p.$('#rfile')) await p.setInputFiles('#rfile', { name: `r${i}.pdf`, mimeType: 'application/pdf', buffer: pdf }); }
  eq((await p.$$('.rc-th')).length, 6, 'at most 6 receipts per entry');
  ok(!(await p.$('#rfile')) && !(await p.$('#rcam')), 'Add buttons disappear at the limit');
  const before = (await idbRecs(p)).length;
  await p.click('.rc:nth-child(2) .rc-x');
  eq((await idbRecs(p)).length, before - 1, 'removing a receipt you just added also deletes the stored file');
  await p.click('[data-x=close]');
  await p.waitForTimeout(100);
  eq((await idbRecs(p)).length, 1, 'closing the form without saving discards the unsaved receipts (only the saved photo remains)');

  console.log('Viewer');
  await p.evaluate(() => { location.hash = 'book/my-money'; }); await p.waitForSelector('.hero.compact');
  ok(/📎1/.test(await p.innerText('#app')), 'the entry row shows a 📎1 marker');
  await p.click('.tx:has-text("Dinner at Taj")'); await p.waitForSelector('.rc-th.img');
  await p.click('.rc-th.img'); await p.waitForSelector('.layer.rv img');
  ok(await p.isVisible('.layer.rv img') && /IMG_2041/.test(await p.innerText('.rv-top')), 'tapping a receipt opens a full-screen viewer');
  await p.keyboard.press('Escape'); ok(!(await p.$('.layer.rv')) && await p.isVisible('.sheet'), 'Esc closes the viewer, the entry form stays open');
  await p.click('[data-x=close]');

  console.log('Sync to Drive (and offline queue)');
  await signIn(p);
  ok(await settle(p), 'queue drains after sign-in');
  const photoRec = (await idbRecs(p))[0];
  const f = drive.byName('receipt-' + photoRec.id);
  ok(!!f && f.body.length === photoRec.size && f.mime === 'image/jpeg', `receipt uploaded to Drive as its own file (${f && f.body.length} bytes, ${f && f.mime})`);
  ok(JSON.stringify(drive.doc()).length < 200000 && !JSON.stringify(drive.doc()).includes('base64'), 'main data file stays small — no image data inside');
  eq((await idbRecs(p)).map(r => r.up), [1], 'local copy marked as uploaded');
  await A.ctx.setOffline(true);
  await p.click('.fab'); await p.fill('#ea', '75'); await p.fill('#ed', 'Offline receipt');
  await p.setInputFiles('#rcam', { name: 'cam.jpg', mimeType: 'image/jpeg', buffer: photo }); await p.waitForSelector('.rc-th.img'); await p.click('[data-x=save]');
  const offRec = (await idbRecs(p)).find(r => r.up === 0); ok(!!offRec, 'offline: receipt saved locally and queued');
  eq(drive.count('receipt-'), 1, 'nothing uploaded while offline');
  await A.ctx.setOffline(false); await p.evaluate(() => sync(true));
  ok(await settle(p), 'queue drains once online');
  eq(drive.count('receipt-'), 2, 'back online: the queued receipt uploads');
  await p.evaluate(async () => { await syncReceipts(); await syncReceipts(); }); eq(drive.count('receipt-'), 2, 'syncing again never uploads duplicates');

  console.log('Second device downloads on demand');
  const B = await newDevice(b, URL, drive); await signIn(B.p);
  eq((await idbRecs(B.p)).length, 0, 'device B starts with no receipt files');
  await B.p.evaluate(() => { location.hash = 'book/my-money'; }); await B.p.waitForSelector('.hero.compact');
  ok(/📎1/.test(await B.p.innerText('#app')), 'B sees the 📎 marker on the entry');
  await B.p.click('.tx:has-text("Dinner at Taj")'); await B.p.waitForSelector('.rc-th.img', { timeout: 8000 });
  ok(true, 'opening the entry on B downloads the thumbnail from Drive');
  const brec = (await idbRecs(B.p)).find(r => r.id === photoRec.id);
  ok(!!brec && brec.size === photoRec.size && brec.up === 1, 'B keeps its own copy for offline use (same bytes, not re-uploaded)');
  await B.p.click('[data-x=close]');

  console.log('Insights uses receipts');
  const nr = pg => pg.evaluate(() => insightsData().noReceipt.filter(r => r.e.desc === 'Dinner at Taj').length);
  eq(await nr(p), 0, 'the audit no longer flags the ₹1,850 spend that has a receipt');
  await p.evaluate(() => { const e = live('entries').find(x => x.desc === 'Dinner at Taj'); put('entries', { ...e, receipts: undefined }); });
  eq(await nr(p), 1, 'and flags it again once the receipt is removed');

  console.log('Layout with receipts at 320px');
  const N = await newDevice(b, URL, makeDrive(), { width: 320 });
  await N.p.click('.fab'); await N.p.fill('#ea', '99999999.99');
  for (let i = 0; i < 4; i++) { await N.p.setInputFiles('#rfile', { name: `r${i}.pdf`, mimeType: 'application/pdf', buffer: pdf }); await N.p.waitForFunction(n => document.querySelectorAll('.rc-th').length === n, i + 1); }
  const lay = await N.p.evaluate(() => { const sh = document.querySelector('.sheet'), out = []; if (sh.scrollWidth > sh.clientWidth + 1) out.push('sheet scrolls sideways'); if (document.documentElement.scrollWidth > innerWidth) out.push('page scrolls sideways');
    const a = document.querySelector('#ea'); if (a.scrollWidth > a.clientWidth + 1) out.push('amount clipped'); const rs = [...document.querySelectorAll('.rc')].map(e => e.getBoundingClientRect());
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) if (Math.min(rs[i].right, rs[j].right) - Math.max(rs[i].left, rs[j].left) > 2 && Math.min(rs[i].bottom, rs[j].bottom) - Math.max(rs[i].top, rs[j].top) > 2) out.push('tiles overlap'); return out; });
  eq(lay, [], 'receipt tiles wrap cleanly; nothing clipped or overlapping');

  ok([A, B, N].every(d => d.p.errors.length === 0), 'no JS errors');
  ok([A, B, N].every(d => d.p.dialogs.length === 0), 'no native dialogs');
  console.log(`\nRECEIPTS PASS (${pass} checks)`);
  await b.close(); srv.close();
})().catch(e => { console.error('FAIL', e.message || e); process.exit(1); });
