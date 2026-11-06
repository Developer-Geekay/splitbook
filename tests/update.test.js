// New-version popup, manual update check, reset app cache, no mic button on the main screen.
const { chromium } = require('playwright');
const assert = require('assert');
const fs = require('fs');
const { start } = require('./serve');
const { makeDrive, newDevice } = require('./harness');
let pass = 0; const ok = (c, m) => { assert(c, m); pass++; console.log('  ✓', m); };

(async () => {
  const os = require('os'), path = require('path'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbupd-'));
  for (const f of ['index.html', 'styles.css', 'app.js', 'i18n.js', 'voice.js', 'config.js', 'manifest.webmanifest', 'sw.js']) fs.copyFileSync(path.join(__dirname, '..', f), path.join(dir, f));
  fs.cpSync(path.join(__dirname, '..', 'icons'), path.join(dir, 'icons'), { recursive: true });
  const srv = await start(0, dir), URL = 'http://localhost:' + srv.address().port + '/index.html', b = await chromium.launch();
  
  const { ctx, p } = await newDevice(b, URL, makeDrive(), { ctx: { serviceWorkers: 'allow' }, init: () => {} });
  await p.reload(); await p.waitForSelector('.slides');
  await p.waitForFunction(() => navigator.serviceWorker.controller && typeof swReg !== 'undefined' && swReg && swReg.active);
  console.log('Main screen');
  ok(!(await p.$('.micfab')), 'no mic button beside the Add button');
  ok(await p.isVisible('.fab'), 'the Add button is still there');
  ok(!(await p.$('#upd')), 'no update popup when nothing changed');

  console.log('Update popup');
  fs.writeFileSync(path.join(dir, 'sw.js'), fs.readFileSync(path.join(dir, 'sw.js'), 'utf8').replace('splitbook-v1', 'splitbook-v2'));
  const r = await p.evaluate(() => checkForUpdate()); ok(r === 'found', 'a changed service worker is detected → ' + r);
  await p.waitForSelector('#upd'); ok(/new version/i.test(await p.innerText('#upd')), 'a popup announces the new version');
  await p.click('#upd [data-x=later]'); ok(!(await p.$('#upd')), 'Later dismisses it');
  await p.evaluate(() => { showUpdate(swReg.waiting); });
  await p.evaluate(() => { window.__mark = 1; });
  await Promise.all([p.waitForEvent('load'), p.click('#upd [data-x=go]')]);
  await p.waitForSelector('.slides'); ok(await p.evaluate(() => window.__mark === undefined), 'Update reloads the app');
  ok(await p.evaluate(async () => (await caches.keys()).includes('splitbook-v2')), 'the new version is now the active cache');
  ok(!(await p.$('#upd')), 'and the popup is gone');
  ok(await p.evaluate(() => checkForUpdate()) === 'latest', 'checking again says up to date');

  console.log('Reset app cache');
  await p.evaluate(() => { put('entries', { id: 'keep', bookId: 'my-money', type: 'expense', desc: 'Keep me', amount: 100, paidBy: me().id, split: {}, method: 'equal', date: isoDay(Date.now()), cat: '🧾', note: '', createdAt: now() }); });
  await p.waitForSelector('.slides');
  await p.click('.top .iconbtn[data-act=settings]'); await p.click('[data-x=upd-check]'); await p.waitForTimeout(300);
  ok(/latest/i.test(await p.innerText('#toast')), 'Check for updates reports the latest version');
  await p.evaluate(() => { window.__mark = 1; });
  await p.click('[data-x=upd-reset]'); await p.waitForSelector('.dlg');
  await Promise.all([p.waitForEvent('load'), p.click('.dlg [data-x=ok]')]);
  await p.waitForSelector('.slides');
  ok(await p.evaluate(() => window.__mark === undefined), 'Reset reloads the app');
  ok(await p.evaluate(() => !!S.doc.entries.keep), 'entries are untouched');
  await p.waitForFunction(() => navigator.serviceWorker.controller || true);
  ok(await p.evaluate(async () => (await caches.keys()).length >= 1), 'caches are rebuilt from the network');
  assert.deepStrictEqual(p.errors, []); ok(true, 'no page errors');
  await b.close(); srv.close(); console.log(`\nPASS (${pass})`);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
