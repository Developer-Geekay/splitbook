// First-run setup page: name, currency, language.
const { chromium } = require('playwright');
const assert = require('assert');
const { start } = require('./serve');
const { makeDrive, newDevice, addIndicFonts, layoutDetect } = require('./harness');
let pass = 0; const ok = (c, m) => { assert(c, m); pass++; console.log('  ✓', m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} → ${JSON.stringify(a)}${JSON.stringify(a) === JSON.stringify(b) ? '' : ' (expected ' + JSON.stringify(b) + ')'}`);

(async () => {
  const srv = await start(), URL = 'http://localhost:' + srv.address().port + '/index.html', b = await chromium.launch();
  console.log('Shown once, to brand-new users');
  let { p } = await newDevice(b, URL, makeDrive(), { firstRun: true });
  await p.waitForSelector('.setup');
  ok(!(await p.$('.slides')), 'a brand-new visitor sees the setup page, not the dashboard');
  ok((await p.$$('.setup .lg')).length === 6, 'six language tiles');
  ok(await p.isVisible('#sn') && await p.isVisible('[data-act=setup-cur]') && await p.isVisible('[data-act=setup-done]'), 'name, currency and Get started are there');
  ok(await p.isVisible('.setup-art svg'), 'with a vector illustration');
  await p.fill('#sn', 'Priya'); await p.click('.setup .lg[data-v=hi]'); await p.waitForFunction(() => LANG === 'hi');
  eq(await p.inputValue('#sn'), 'Priya', 'the typed name survives a language switch');
  ok(/[ऀ-ॿ]/.test(await p.innerText('.setup')), 'the page itself switches to Hindi');
  await p.click('[data-act=setup-cur]'); await p.fill('#cq', 'USD'); await p.click('.layer .cur-row[data-v=USD]');
  await p.waitForFunction(() => S.ui.setupDraft.cur === 'USD'); ok(/USD/.test(await p.innerText('.curbtn')), 'currency picker updates the page');
  await p.click('[data-act=setup-done]'); await p.waitForSelector('.slides');
  eq(await p.evaluate(() => [me().name, personalBook().currency, S.meta.lang, S.meta.setup]), ['Priya', 'USD', 'hi', true], 'name, currency, language and flag saved');
  await p.reload(); await p.waitForSelector('.slides'); ok(!(await p.$('.setup')), 'does not come back after reload');
  eq(await p.evaluate(() => [me().name, LANG]), ['Priya', 'hi'], 'values persist');

  console.log('Enter key, empty name');
  ({ p } = await newDevice(b, URL, makeDrive(), { firstRun: true })); await p.waitForSelector('.setup');
  await p.fill('#sn', 'Ravi'); await p.press('#sn', 'Enter'); await p.waitForSelector('.slides'); eq(await p.evaluate(() => me().name), 'Ravi', 'Enter in the name field finishes setup');
  ({ p } = await newDevice(b, URL, makeDrive(), { firstRun: true })); await p.waitForSelector('.setup');
  await p.click('[data-act=setup-done]'); await p.waitForSelector('.slides'); eq(await p.evaluate(() => me().name), 'Me', 'name is optional');

  console.log('Existing users skip it');
  for (const [label, init] of [
    ['a user who signed in before', () => localStorage.setItem('sb.meta', JSON.stringify({ wasSignedIn: true }))],
  ]) {
    const d = await newDevice(b, URL, makeDrive(), { firstRun: true, init }); await d.p.waitForSelector('.slides, .setup');
    ok(!(await d.p.$('.setup')), label + ' goes straight to the app');
  }
  { const d = await newDevice(b, URL, makeDrive(), { firstRun: true }); await d.p.waitForSelector('.setup');
    await d.p.evaluate(() => { put('entries', { id: 'e1', bookId: 'my-money', type: 'expense', desc: 'Tea', amount: 2000, paidBy: me().id, split: {}, method: 'equal', date: isoDay(Date.now()), cat: '🍽️', note: '', createdAt: now() }); });
    await d.p.reload(); await d.p.waitForSelector('.slides, .setup'); ok(!(await d.p.$('.setup')), 'a user who already has entries skips setup'); }

  console.log('Layout in every language, 320px');
  for (const l of ['en', 'hi', 'bn', 'mr', 'te', 'ta']) {
    const d = await newDevice(b, URL, makeDrive(), { firstRun: true, width: 320, height: 640 }); await addIndicFonts(d.p);
    await d.p.waitForSelector('.setup'); await d.p.evaluate(x => setLang(x), l);
    await d.p.fill('#sn', 'Aishwarya Venkataraman');
    eq(await d.p.evaluate(layoutDetect), [], `${l}: no overflow or overlap`);
    if (l !== 'en') ok(!/Get started|Your name|Welcome to/.test(await d.p.innerText('.setup')), `${l}: no English leaks`);
    ok(await d.p.isVisible('[data-act=setup-done]'), `${l}: Get started reachable`);
    eq(d.p.errors, [], `${l}: no page errors`);
  }
  await b.close(); srv.close(); console.log(`\nPASS (${pass})`);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
