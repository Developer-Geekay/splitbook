// Net worth & money check-up: engine numbers verified against hand-computed figures, then the page.
const { chromium } = require('playwright');
const assert = require('assert');
const { start } = require('./serve');
const { skipSetup } = require('./harness');
let pass = 0; const ok = (c, m) => { assert(c, m); pass++; console.log('  ✓', m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} → ${JSON.stringify(a)}${JSON.stringify(a) === JSON.stringify(b) ? '' : ' (expected ' + JSON.stringify(b) + ')'}`);
const near = (a, b, m, tol = 1) => ok(Math.abs(a - b) <= tol, `${m} → ${a} (expected ${b})`);

(async () => {
  const srv = await start(), URL = 'http://localhost:' + srv.address().port + '/index.html';
  const b = await chromium.launch(), ctx = await b.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', locale: 'en-IN' });
  await skipSetup(ctx);
  const p = await ctx.newPage(); const errors = []; p.on('pageerror', e => errors.push(e.message)); await p.goto(URL);

  // ----- a life with known numbers (major units ×100). asOf = 15 Nov 2026 -----
  await p.evaluate(() => {
    const M = me().id, R = 'smp-p-r', Dv = 'smp-p-d', pad = n => String(n).padStart(2, '0');
    S.doc.people[R] = { id: R, name: 'Ravi', updatedAt: 1 }; S.doc.people[Dv] = { id: Dv, name: 'Dev', updatedAt: 1 };
    let n = 0; const T = now();
    const add = o => { const id = 'ins' + (n++); S.doc.entries[id] = { id, bookId: 'my-money', type: 'expense', desc: 'x', amount: 0, paidBy: M, split: {}, method: 'equal', date: '2026-11-01', cat: '🍽️', note: '', createdAt: T + n, updatedAt: T, ...o }; };
    const spend = (date, desc, major, cat) => add({ date, desc, amount: major * 100, split: { [M]: major * 100 }, cat });
    for (const d of ['2026-08-01', '2026-09-01', '2026-10-01', '2026-11-01']) add({ type: 'income', desc: 'Salary', amount: 10000000, date: d, cat: '💼', split: {} });
    for (let i = 0; i < 24; i++) spend(`2026-08-${pad(1 + i)}`, `Spend 08-${i}`, 2500, i % 2 ? '🛒' : '🍽️');
    for (let i = 0; i < 22; i++) spend(`2026-09-${pad(1 + i)}`, `Spend 09-${i}`, 2500, i % 2 ? '🛒' : '🍽️');
    for (let i = 0; i < 26; i++) spend(`2026-10-${pad(1 + i)}`, `Spend 10-${i}`, 2500, i % 2 ? '🛒' : '🍽️');
    spend('2026-10-20', 'Cinema night', 3000, '🎬');
    for (let i = 0; i < 8; i++) spend(`2026-11-${pad(1 + i)}`, `Food ${i}`, 2500, '🍽️');
    for (let i = 0; i < 6; i++) spend(`2026-11-${pad(9 + i)}`, `Fun ${i}`, 2500, '🎬');
    spend('2026-11-05', 'Laptop', 48000, '🧾'); spend('2026-11-03', 'Lunch', 320, '🍽️'); spend('2026-11-03', 'Lunch', 320, '🍽️');
    add({ id: 'tplRent', desc: 'Rent', amount: 2200000, split: { [M]: 2200000 }, date: '2026-11-20', cat: '🏠', repeat: 'monthly' });   // future-dated template
    S.doc.books['bk-a'] = { id: 'bk-a', name: 'Trip', emoji: '🏖️', currency: 'INR', memberIds: [M, R], createdAt: 1, updatedAt: T };
    S.doc.books['bk-b'] = { id: 'bk-b', name: 'Cab pool', emoji: '🚕', currency: 'INR', memberIds: [M, Dv], createdAt: 1, updatedAt: T };
    S.doc.books['bk-usd'] = { id: 'bk-usd', name: 'US trip', emoji: '🗽', currency: 'USD', memberIds: [M, R], createdAt: 1, updatedAt: T };
    const sh = (id, bk, o) => { S.doc.entries[id] = { id, bookId: bk, type: 'expense', method: 'equal', cat: '🏠', note: '', createdAt: T + n++, updatedAt: T, ...o }; };
    sh('hotel', 'bk-a', { desc: 'Hotel', amount: 300000, paidBy: M, split: { [M]: 150000, [R]: 150000 }, date: '2026-11-02' });
    sh('loanR', 'bk-a', { desc: 'Loan to Ravi', amount: 500000, paidBy: M, split: { [R]: 500000 }, method: 'exact', cat: '💸', date: '2026-09-01', loan: { rate: 0, due: '2026-10-01' } });
    sh('cab', 'bk-b', { desc: 'Cab share', amount: 200000, paidBy: Dv, split: { [M]: 100000, [Dv]: 100000 }, date: '2026-11-04' });
    sh('usd1', 'bk-usd', { desc: 'Museum', amount: 6000, paidBy: R, split: { [M]: 3000, [R]: 3000 }, date: '2026-11-03' });
    persist();
  });

  console.log('Engine numbers (as of 15 Nov 2026)');
  const D = await p.evaluate(() => { const d = insightsData('2026-11-15'); return { cur: d.cur, months: d.months.slice(-4).map(x => [x.k, x.inc, x.exp]), sr: d.savingsRate, avgInc: d.avgInc, avgExp: d.avgExp, proj: d.projected, cash: d.cash, owed: d.owed, owe: d.owe, nw: d.netWorth, series: d.series.map(x => [x.k, x.v]), fixedOut: d.fixedOut, fixedRatio: d.fixedRatio, runway: d.runway, lent: d.lentOut, borrowed: d.borrowedOut, overdue: d.overdue.map(o => o.r.daysLeft), out: d.outliers.map(o => o.e.desc), dups: d.dups.map(g => [g[0].desc, g.length]), score: d.score, grade: d.grade, titles: d.findings.map(f => f.title), others: d.others, cats: d.cats.filter(c => ['Fun', 'Food'].includes(c.name)).map(c => [c.name, c.now, c.avg]) }; });
  eq(D.cur, 'INR', 'primary currency = My money currency');
  eq(D.months, [['2026-08', 10000000, 6000000], ['2026-09', 10000000, 5500000], ['2026-10', 10000000, 6800000], ['2026-11', 10000000, 8614000]], 'monthly income/spending incl. my share of shared (Nov: 83,640 + 1,500 + 1,000) — future-dated rent excluded');
  near(D.sr, 0.39, 'savings rate = (3×100,000 − 183,000) / 300,000', 1e-9);
  eq([D.avgInc, D.avgExp], [10000000, 6100000], 'averages over the last 3 completed months');
  eq(D.proj, 17228000, 'month-end projection: 86,140 in 15 of 30 days → 172,280');
  eq([D.cash, D.owed, D.owe, D.nw], [13336000, 650000, 100000, 13886000], 'net worth = cash 133,360 + owed 6,500 − owe 1,000 = 138,860');
  eq(D.series.find(x => x[0] === '2026-08')[1], 4000000, 'history: end of Aug = 40,000');
  eq(D.series.find(x => x[0] === '2026-09')[1], 9000000, 'history: end of Sep = 90,000 (incl. 5,000 lent)');
  eq(D.series.find(x => x[0] === '2026-10')[1], 12200000, 'history: end of Oct = 122,000');
  eq(D.series[11][1], D.nw, 'last point of the chart equals today\'s net worth');
  eq(D.series[0][1], 0, 'months before any data are zero');
  eq([D.fixedOut, D.fixedRatio], [2200000, 0.22], 'recurring rent 22,000/mo = 22% of income');
  near(D.runway, 13336000 / 6100000, 'runway = cash / average spending', 1e-9);
  eq([D.lent, D.borrowed, D.overdue], [500000, 0, [-45]], 'loan to Ravi: 5,000 lent, overdue by 45 days');
  eq(D.out, ['Laptop'], 'only the laptop is flagged as an unusual spend');
  eq(D.dups, [['Lunch', 2]], 'the twice-recorded Lunch is flagged as a possible duplicate');
  eq(D.others, { USD: { owed: 0, owe: 3000 } }, 'USD book kept apart (30.00 owed by me) and not added to INR net worth');
  eq(D.cats.find(c => c[0] === 'Fun'), ['Fun', 1500000, 100000], 'Fun: 15,000 now vs 1,000 average');
  eq(D.score, 65, 'health score = 100 − overdue 10 − runway 8 − pace 8 − owe 3 − duplicate 3 − unusual 3');
  eq(D.grade, 'Good', 'grade for 65');
  const T = D.titles.join(' | ');
  ok(/Saving 39% of income/.test(T), 'finding: saving 39%');
  ok(/On pace to spend/.test(T), 'finding: spending pace warning');
  ok(/Fun is up 1400%/.test(T), 'finding: category spike (Fun +1400%)');
  ok(/Fixed bills are 22% of income/.test(T), 'finding: fixed bills healthy');
  ok(/Cash covers 2\.2 months/.test(T), 'finding: runway 2.2 months');
  ok(/1 overdue loan/.test(T) && /5,000\.00 lent out/.test(T), 'findings: overdue loan + money lent out');
  ok(/You owe .*1,000\.00 in shared books/.test(T), 'finding: you owe in shared books');
  ok(/Unusual spend: Laptop/.test(T) && /Possible duplicate: Lunch/.test(T), 'findings: unusual spend + duplicate');
  ok(/without a receipt/.test(T), 'finding: big spends without receipts');
  const nr = await p.evaluate(() => insightsData('2026-11-15').noReceipt.length), expNr = await p.evaluate(() => {
    const m = me().id, lo = isoDay(new Date('2026-11-15T00:00').getTime() - 90 * 864e5); let c = 0;
    for (const e of live('entries')) { const bk = S.doc.books[e.bookId]; if (bk.currency !== 'INR' || e.type !== 'expense' || e.date < lo || e.date > '2026-11-15' || e.amount < 100000 || (e.receipts || []).length) continue;
      const cost = bk.personal ? e.amount : (e.cat === '💸' ? 0 : (e.split[m] || 0)); if (cost) c++; } return c; });
  eq(nr, expNr, `receipt audit counts ${nr} qualifying spends (independent recount)`);

  console.log('Empty / edge states');
  const empty = await p.evaluate(() => { const keep = JSON.parse(JSON.stringify(S.doc)); S.doc = emptyDoc(); ensureMe(); ensurePersonal(); const d = insightsData('2026-11-15'); const r = { nw: d.netWorth, score: d.score, f: d.findings.length, has: d.hasData, series: d.series.every(x => x.v === 0) }; S.doc = keep; return r; });
  eq(empty, { nw: 0, score: null, f: 0, has: false, series: true }, 'no data: zero net worth, no score, no findings, no crash');
  const onlyInc = await p.evaluate(() => { const keep = JSON.parse(JSON.stringify(S.doc)); S.doc = emptyDoc(); ensureMe(); ensurePersonal(); const M = me().id; S.doc.entries.i1 = { id: 'i1', bookId: 'my-money', type: 'income', amount: 500000, paidBy: M, split: {}, date: '2026-10-01', cat: '💼', desc: 'Pay', createdAt: 1, updatedAt: 1 }; const d = insightsData('2026-11-15'); const r = d.findings.map(f => f.title); S.doc = keep; return r; });
  ok(!onlyInc.some(t => /NaN|undefined/.test(t)), 'income only (no spending): findings are sane: ' + onlyInc.join(' | '));

  console.log('The page');
  await p.evaluate(() => { S.doc = S.doc; render(); });
  await p.evaluate(() => { location.hash = 'insights'; }); await p.waitForSelector('#nw');
  const page = await p.innerText('#app');
  ok(!/NaN|undefined|Infinity|\[object/.test(page), 'page renders without NaN/undefined');
  for (const h of ['Net worth', 'Money check-up', 'Cash flow', 'Where it goes', 'Subscriptions', 'Shared books', 'Biggest spends']) ok(new RegExp(h, 'i').test(page), `section: ${h}`);
  ok((await p.$$('svg.chart')).length === 2 && !!(await p.$('svg.ring')), 'net-worth line chart, cash-flow bar chart and score ring drawn');
  eq(await p.innerText('#nw'), await p.evaluate(() => money(insightsData().netWorth, insightsData().cur)), 'headline equals the engine\'s net worth (today)');
  ok(/Other currencies/.test(page), 'other-currency balances called out separately');
  await p.click('[data-act=open-loans]'); await p.waitForSelector('.hero.compact');
  ok((await p.evaluate(() => S.ui.tab)) === 'balances' && /Loan to Ravi/.test(await p.innerText('#app')), 'finding action "Open loans" jumps to the loan');
  await p.click('[data-act=back]'); await p.waitForSelector('.sl-tabs');
  await p.evaluate(() => { location.hash = 'insights'; }); await p.waitForSelector('#nw'); await p.click('[data-act=back]'); await p.waitForSelector('.sl-tabs');
  ok(await p.isVisible('.sl-tabs'), 'Back returns to the dashboard');
  ok(errors.length === 0, 'no JS errors: ' + errors.join(';'));

  console.log(`\nINSIGHTS PASS (${pass} checks)`);
  await b.close(); srv.close();
})().catch(e => { console.error('FAIL', e.message || e); process.exit(1); });
