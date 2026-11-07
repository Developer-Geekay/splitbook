// Dashboard: empty placeholders, quick tiles, recent activity.
const { chromium } = require('playwright');
const assert = require('assert');
const { start } = require('./serve');
const { makeDrive, newDevice } = require('./harness');
let pass = 0; const ok = (c, m) => { assert(c, m); pass++; console.log('  ✓', m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} → ${JSON.stringify(a)}${JSON.stringify(a) === JSON.stringify(b) ? '' : ' (expected ' + JSON.stringify(b) + ')'}`);

(async () => {
  const srv = await start(), URL = 'http://localhost:' + srv.address().port + '/index.html', b = await chromium.launch();
  const { p } = await newDevice(b, URL, makeDrive());
  await p.waitForSelector('.slides');

  console.log('Empty state');
  eq(await p.$$eval('.qt.ph', e => e.length), 4, 'four placeholder tiles');
  eq(await p.$$eval('.qt b', e => e.map(x => x.textContent)), ['—', '—', '—', '—'], 'each shows a dash');
  ok(await p.isVisible('.empty-art svg'), 'recent activity shows an illustration');
  ok(await p.isVisible('.hero-ph svg'), 'My money slide shows a placeholder');
  ok(!/NaN|undefined/.test(await p.innerText('#app')), 'no NaN / undefined');

  console.log('With data');
  await p.evaluate(() => {
    const M = me().id, D = o => isoDay(Date.now() + o * 864e5); let n = 0;
    const add = o => put('entries', { id: 'd' + (n++), bookId: 'my-money', type: 'expense', desc: 'x', amount: 0, paidBy: M, split: {}, method: 'equal', date: D(0), cat: '🍽️', note: '', createdAt: now() + n, ...o });
    add({ desc: 'Tea', amount: 5000 }); add({ desc: 'Lunch', amount: 25000 });
    add({ desc: 'Taxi', amount: 30000, date: D(-3) }); add({ desc: 'Old', amount: 99900, date: D(-20) });
    add({ desc: 'Salary', type: 'income', amount: 5000000, date: D(-2), cat: '💼' });
    add({ desc: 'Netflix', amount: 64900, date: D(-10), repeat: 'monthly' });
    render();
  });
  const D = await p.evaluate(() => { const d = dashData(); return [d.t, d.w, !!d.next, d.next && d.next.e.desc]; });
  eq(D.slice(0, 2), [30000, 60000], 'Today and This week sums (income, old and recurring-template origin excluded)');
  ok(await p.evaluate(() => live('entries').filter(e => e.fromRule).length >= 0), 'recurring materialised');
  eq(await p.$$eval('.qt.ph', e => e.length), D[2] ? 0 : 1, 'only Next bill may remain a placeholder');
  ok((await p.innerText('.qgrid')).includes(await p.evaluate(() => money(insightsData().netWorth, primaryCurrency()))), 'Net worth tile matches the insights page figure');
  const rows = await p.$$eval('.recent .mrow', e => e.map(x => x.innerText));
  ok(rows.length === 5, 'recent activity shows 5 rows');
  ok(!(await p.$('.empty-art')) && !(await p.$('.hero-ph')), 'placeholders are gone');
  ok(/Salary/.test(rows.join()) && /\+/.test(rows.find(r => /Salary/.test(r)) || ''), 'income is shown with a plus sign');
  await p.click('.qt[data-act=open-insights]'); await p.waitForFunction(() => S.ui.view === 'insights'); ok(true, 'Net worth tile opens insights');
  await p.evaluate(() => { S.ui.view = 'home'; render(); });
  eq(p.errors, [], 'no page errors');

  console.log('Performance and widths');
  await p.evaluate(() => { const M = me().id; for (let i = 0; i < 3000; i++) S.doc.entries['bulk' + i] = { id: 'bulk' + i, bookId: 'my-money', type: 'expense', desc: 'b' + i, amount: 100, paidBy: M, split: {}, method: 'equal', date: isoDay(Date.now() - (i % 300) * 864e5), cat: '🧾', note: '', createdAt: i, updatedAt: 1 }; });
  const ms = await p.evaluate(() => { const t = performance.now(); render(); return performance.now() - t; });
  ok(ms < 1500, `3000 entries render in ${Math.round(ms)}ms`);
  for (const w of [320, 390, 430]) { await p.setViewportSize({ width: w, height: 800 }); ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `no sideways scroll at ${w}px`); }

  console.log('Add form: currency chip, date/note layout');
  await p.setViewportSize({ width: 320, height: 700 }); await p.evaluate(() => { S.ui.view = 'home'; render(); });
  await p.evaluate(() => { entrySheet(null, null, 'my-money'); }); await p.waitForSelector('#form .curchip');
  const r = await p.evaluate(() => { const a = document.querySelector('#edt').getBoundingClientRect(), n = document.querySelector('#en').getBoundingClientRect(); return [a.right <= n.left + 1, a.left >= 0, n.right <= innerWidth]; });
  eq(r, [true, true, true], 'date and note sit side by side without overlapping at 320px');
  await p.click('#form .curchip'); await p.fill('#cq', 'USD'); await p.click('.layer .cur-row[data-v=USD]');
  await p.waitForSelector('.dlg [data-x=ok]'); await p.waitForTimeout(500); await p.click('.dlg [data-x=ok]');
  await p.waitForFunction(() => /USD/.test(document.querySelector('#form .curchip').innerText));
  eq(await p.evaluate(() => personalBook().currency), 'USD', 'picking a currency in the form switches the book currency');
  await p.keyboard.press('Escape');
  await b.close(); srv.close(); console.log(`\nPASS (${pass})`);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
