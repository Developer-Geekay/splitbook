// Recurring entries (subscriptions/bills) and loans (due dates, interest, repayments).
const { chromium } = require('playwright');
const assert = require('assert');
const { start } = require('./serve');
let pass = 0; const ok = (c, m) => { assert(c, m); pass++; console.log('  ✓', m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} → ${JSON.stringify(a)}${JSON.stringify(a) === JSON.stringify(b) ? '' : ' (expected ' + JSON.stringify(b) + ')'}`);

(async () => {
  const srv = await start(), URL = 'http://localhost:' + srv.address().port + '/index.html';
  const b = await chromium.launch(); let drive = null;
  async function device(opts = {}) {
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', locale: 'en-IN', ...opts });
    await ctx.addInitScript(() => { window.google = { accounts: { oauth2: { initTokenClient: c => ({ requestAccessToken: () => setTimeout(() => c.callback({ access_token: 't', expires_in: 3600 }), 5) }), revoke() {} } } }; });
    await ctx.route('https://accounts.google.com/**', r => r.fulfill({ body: '', contentType: 'text/javascript' }));
    await ctx.route('**/config.js', r => r.fulfill({ body: 'window.SPLITBOOK_CONFIG={GOOGLE_CLIENT_ID:"x"}', contentType: 'text/javascript' }));
    await ctx.route('https://www.googleapis.com/**', async r => {
      const u = r.request().url(), m = r.request().method();
      if (u.includes('userinfo')) return r.fulfill({ json: { email: 'a@b.c', given_name: 'Asha' } });
      if (u.includes('/upload/')) { const body = r.request().postData(); drive = JSON.parse(m === 'PATCH' ? body : body.split('\r\n\r\n')[2].split('\r\n--')[0]); return r.fulfill({ json: { id: 'F1' } }); }
      if (u.includes('alt=media')) return r.fulfill({ json: drive });
      return r.fulfill({ json: { files: drive ? [{ id: 'F1' }] : [] } });
    });
    const p = await ctx.newPage(); p.errors = []; p.on('pageerror', e => p.errors.push(e.message));
    if (opts.fixedTime) await p.clock.setFixedTime(opts.fixedTime);
    await p.goto(URL); return { ctx, p };
  }
  const A = await device(), p = A.p;

  console.log('Recurrence dates');
  eq(await p.evaluate(() => occurrences({ date: '2026-01-31', repeat: 'monthly' }, '2026-05-01')), ['2026-02-28', '2026-03-31', '2026-04-30'], 'monthly from the 31st clamps to month end, then returns to the 31st');
  eq(await p.evaluate(() => occurrences({ date: '2028-01-31', repeat: 'monthly' }, '2028-03-01')), ['2028-02-29'], 'leap-year February');
  eq(await p.evaluate(() => occurrences({ date: '2026-03-02', repeat: 'weekly' }, '2026-03-24')), ['2026-03-09', '2026-03-16', '2026-03-23'], 'weekly');
  eq(await p.evaluate(() => occurrences({ date: '2024-02-29', repeat: 'yearly' }, '2027-03-01')), ['2025-02-28', '2026-02-28', '2027-02-28'], 'yearly from 29 Feb');
  eq(await p.evaluate(() => occurrences({ date: '2025-11-15', repeat: 'monthly' }, '2026-02-15')), ['2025-12-15', '2026-01-15', '2026-02-15'], 'monthly across a year boundary');
  eq(await p.evaluate(() => nextDue({ date: '2026-01-10', repeat: 'monthly' }, '2026-03-10')), '2026-04-10', 'next due is strictly after today');

  console.log('Local-date correctness (UTC+5:30 just after midnight)');
  const K = await device({ timezoneId: 'Asia/Kolkata', fixedTime: new Date('2026-11-05T20:00:00Z') });
  eq(await K.p.evaluate(() => isoDay(Date.now())), '2026-11-06', "'today' follows the local calendar, not UTC");
  await K.ctx.close();

  console.log('Generating recurring entries');
  await p.evaluate(() => {
    const me0 = me().id; S.doc.books.t = { id: 't', name: 'Test', emoji: '🔁', currency: 'INR', memberIds: [me0, 'smp-p-x'], createdAt: 1, updatedAt: 1 };
    S.doc.people['smp-p-x'] = { id: 'smp-p-x', name: 'Ravi', updatedAt: 1 };
    window.mkE = o => ({ id: uid(), bookId: 't', type: 'expense', desc: 'x', amount: 100000, paidBy: me0, split: { [me0]: 50000, 'smp-p-x': 50000 }, method: 'equal', date: isoDay(Date.now()), cat: '🧾', note: '', createdAt: now(), ...o });
    window.D = n => isoDay(Date.now() - n * 864e5);
    put('entries', mkE({ id: 'tplNetflix', desc: 'Netflix', repeat: 'monthly', date: D(100) }));
  });
  const exp1 = await p.evaluate(() => occurrences(S.doc.entries.tplNetflix, isoDay(Date.now())).length);
  const got1 = await p.evaluate(() => { const n = materializeRecurring(); return [n, live('entries').filter(e => e.fromRule === 'tplNetflix').length]; });
  eq(got1, [exp1, exp1], `template 100 days back creates ${exp1} past occurrences`);
  eq(await p.evaluate(() => materializeRecurring()), 0, 'running again creates nothing (idempotent)');
  ok(await p.evaluate(() => live('entries').filter(e => e.fromRule).every(e => !e.repeat && e.amount === 100000 && e.id.startsWith('tplNetflix~'))), 'occurrences are plain entries with deterministic ids');
  const del1 = await p.evaluate(() => { const e = live('entries').find(e => e.fromRule); del('entries', e.id); materializeRecurring(); return live('entries').filter(x => x.fromRule === 'tplNetflix').length; });
  eq(del1, exp1 - 1, 'a deleted occurrence is not resurrected');
  await p.evaluate(() => { const t = S.doc.entries.tplNetflix; put('entries', { ...t, amount: 120000, split: { [me().id]: 60000, 'smp-p-x': 60000 } }); materializeRecurring(); });
  ok(await p.evaluate(() => live('entries').filter(e => e.fromRule === 'tplNetflix').every(e => e.amount === 100000)), 'price change on the template does not rewrite past occurrences');
  await p.evaluate(() => { put('entries', { ...S.doc.entries.tplNetflix, repeat: undefined }); });
  const lenStop = await p.evaluate(() => { S.doc.entries.tplNetflix.date = D(200); const before = live('entries').length; materializeRecurring(); return live('entries').length - before; });
  eq(lenStop, 0, 'stopping a series generates nothing further');

  console.log('Two devices generate the same series');
  await p.evaluate(() => { put('entries', mkE({ id: 'tplRent', desc: 'Rent', repeat: 'monthly', date: D(65), amount: 3600000, split: { [me().id]: 1800000, 'smp-p-x': 1800000 } })); S.meta.wasSignedIn = true; persist(); });
  await p.evaluate(() => sync(true));
  const B = await device(); await B.p.evaluate(() => { S.meta.wasSignedIn = true; persist(); }); await B.p.evaluate(() => sync(true));
  const n0 = await B.p.evaluate(() => live('entries').filter(e => e.fromRule === 'tplRent').length);
  ok(n0 >= 2, `device B received ${n0} generated rent entries`);
  // simulate both devices generating a *new* occurrence independently (clock moves on): wipe one occurrence on both, regenerate on both
  await p.evaluate(() => { const id = live('entries').filter(e => e.fromRule === 'tplRent').sort((a, b) => b.date.localeCompare(a.date))[0].id; delete S.doc.entries[id]; });
  await B.p.evaluate(() => { const id = live('entries').filter(e => e.fromRule === 'tplRent').sort((a, b) => b.date.localeCompare(a.date))[0].id; delete S.doc.entries[id]; });
  const [ga, gb] = [await p.evaluate(() => materializeRecurring()), await B.p.evaluate(() => materializeRecurring())];
  await B.p.evaluate(() => { const e = live('entries').filter(e => e.fromRule === 'tplRent').sort((x, y) => x.date.localeCompare(y.date))[0]; put('entries', { ...e, desc: 'Rent (edited on B)' }); window.editedId = e.id; });
  const editedId = await B.p.evaluate(() => window.editedId);
  await p.evaluate(() => sync(true)); await B.p.evaluate(() => sync(true)); await p.evaluate(() => sync(true));
  const ca = await p.evaluate(() => live('entries').filter(e => e.fromRule === 'tplRent').length), cb = await B.p.evaluate(() => live('entries').filter(e => e.fromRule === 'tplRent').length);
  ok(ga === 1 && gb === 1 && ca === cb && ca === n0, `both devices regenerated 1 occurrence; after sync there are ${ca}, no duplicates`);
  eq(await p.evaluate(id => S.doc.entries[id].desc, editedId), 'Rent (edited on B)', 'an edit made on one device beats a freshly generated copy on the other');

  console.log('Add a subscription through the UI');
  await p.evaluate(() => { S.ui.view = 'book'; S.ui.bookId = 't'; S.ui.tab = 'entries'; render(); });
  await p.click('.fab'); await p.fill('#ea', '499'); await p.fill('#ed', 'Gym'); await p.fill('#edt', await p.evaluate(() => D(70)));
  await p.click('[data-x=rep][data-v=monthly]'); await p.click('[data-x=save]');
  const gym = await p.evaluate(() => ({ t: live('entries').filter(e => e.desc === 'Gym' && e.repeat).length, n: live('entries').filter(e => e.desc === 'Gym').length }));
  ok(gym.t === 1 && gym.n >= 3, `saving with "Every month" backfills past months (${gym.n} Gym entries)`);
  const txt = await p.innerText('#app'); ok(/recurring · .*\/mo/i.test(txt) && /Gym/.test(txt) && /next/i.test(txt), 'Activity shows a Recurring card with monthly cost and next date');

  console.log('Loan interest maths');
  const L = await p.evaluate(() => {
    const me0 = me().id, R = 'smp-p-x';
    S.doc.books.l = { id: 'l', name: 'Loans', emoji: '💸', currency: 'INR', memberIds: [me0, R], createdAt: 1, updatedAt: 1 };
    const loan = mkE({ id: 'L1', bookId: 'l', desc: 'Loan to Ravi', cat: '💸', amount: 2000000, paidBy: me0, split: { [R]: 2000000 }, method: 'exact', date: '2026-01-01', loan: { rate: 12, due: '2026-06-30' } });
    const rep = mkE({ id: 'R1', bookId: 'l', type: 'settle', desc: 'Payment', cat: '🤝', amount: 500000, paidBy: R, split: { [me0]: 500000 }, method: 'exact', date: '2026-04-01' });
    S.doc.entries.L1 = loan; S.doc.entries.R1 = rep;
    return loanReport('l', '2026-07-20')[0];
  });
  const expInt = Math.round(2000000 * .12 * 90 / 365 + 1500000 * .12 * 110 / 365);
  ok(Math.abs(L.accrued - expInt) <= 1, `simple interest: 12% on 20,000 for 90 days then on 15,000 for 110 days = ${expInt / 100} (got ${L.accrued / 100})`);
  eq([L.out, L.repaid, L.overdue, L.daysLeft], [1500000, 500000, true, -20], 'outstanding 15,000 · repaid 5,000 · overdue by 20 days');
  eq(await p.evaluate(() => loanReport('l', '2026-05-01')[0].overdue), false, 'same loan is not overdue before its due date');

  console.log('Adding interest to the balance, then repaying');
  const C = await p.evaluate(() => {
    const me0 = me().id, R = 'smp-p-x';
    delete S.doc.entries.L1; delete S.doc.entries.R1;
    S.doc.entries.L2 = mkE({ id: 'L2', bookId: 'l', desc: 'Bike loan', cat: '💸', amount: 1000000, paidBy: me0, split: { [R]: 1000000 }, method: 'exact', date: D(365), loan: { rate: 10, due: '' } });
    const before = netBalances('l')[R], r0 = loanReport('l')[0], cid = chargeInterest('L2');
    const r1 = loanReport('l')[0], after = netBalances('l')[R];
    return { pending0: r0.pending, pending1: r1.pending, intDebt1: r1.intDebt, delta: after - before, cid: !!cid, again: chargeInterest('L2') };
  });
  eq([C.pending0, C.pending1, C.intDebt1, C.delta, C.again], [100000, 0, 100000, -100000, null], '10% for a year on 10,000 = 1,000 → added once, balance moves by exactly that, no double-charging');
  const afterPay = await p.evaluate(() => {
    const me0 = me().id, R = 'smp-p-x';
    S.doc.entries.R2 = mkE({ id: 'R2', bookId: 'l', type: 'settle', desc: 'Payment', cat: '🤝', amount: 100000, paidBy: R, split: { [me0]: 100000 }, method: 'exact' });
    const a = loanReport('l')[0];
    S.doc.entries.R3 = mkE({ id: 'R3', bookId: 'l', type: 'settle', desc: 'Payment', cat: '🤝', amount: 1000000, paidBy: R, split: { [me0]: 1000000 }, method: 'exact' });
    const z = loanReport('l')[0];
    return { a: [a.intDebt, a.out], z: [z.out, z.intDebt, z.settled] };
  });
  eq(afterPay.a, [0, 1000000], 'a repayment clears the charged interest first, principal untouched');
  eq(afterPay.z, [0, 0, true], 'paying the principal marks the loan settled');
  eq(await p.evaluate(() => Object.values(netBalances('l')).reduce((a, c) => a + c, 0)), 0, 'book balances still sum to zero with interest entries');

  console.log('Due-soon banner');
  const ban = await p.evaluate(() => {
    const me0 = me().id, R = 'smp-p-x', out = {};
    delete S.doc.entries.L2; delete S.doc.entries.R2; delete S.doc.entries.R3; for (const e of live('entries').filter(e => e.interestFor)) delete S.doc.entries[e.id];
    for (const [k, due] of [['over', D(1)], ['soon', D(-3)], ['far', D(-30)]]) {
      for (const id of ['LB']) delete S.doc.entries[id];
      S.doc.entries.LB = mkE({ id: 'LB', bookId: 'l', desc: 'Loan ' + k, cat: '💸', amount: 500000, paidBy: me0, split: { [R]: 500000 }, method: 'exact', loan: { rate: 0, due } });
      out[k] = dueBanner().replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
    return out;
  });
  ok(/loan overdue by 1 day/.test(ban.over) && /Ravi/.test(ban.over), 'overdue loan banner: ' + ban.over);
  ok(/due in 3 days/.test(ban.soon), 'upcoming loan banner: ' + ban.soon);
  eq(ban.far, '', 'a loan due in 30 days shows no banner');

  console.log('Loan flow through the UI');
  await p.evaluate(() => { for (const id of ['LB']) delete S.doc.entries[id]; S.ui.view = 'book'; S.ui.bookId = 'l'; S.ui.tab = 'entries'; render(); });
  await p.click('.fab'); await p.fill('#ea', '8000');
  await p.click('[data-x=cat][data-v="💸"]');
  ok(await p.isVisible('#elr') && await p.isVisible('#eld'), 'picking the Loan category reveals interest and due-date fields');
  await p.fill('#elr', '12'); await p.fill('#eld', await p.evaluate(() => D(-45))); await p.click('[data-x=save]');
  const saved = await p.evaluate(() => Object.values(S.doc.entries).find(e => e.bookId === 'l' && e.amount === 800000 && !e.deleted));
  ok(saved && saved.cat === '💸' && saved.loan.rate === 12 && /^\d{4}-\d\d-\d\d$/.test(saved.loan.due) && Object.keys(saved.split).length === 1, 'loan saved with terms and a single borrower: ' + JSON.stringify(saved.loan));
  await p.click('[data-tab=balances]');
  ok((await p.innerText('#app')).includes('12% a year') && /Record repayment/.test(await p.innerText('#app')), 'Balances tab shows the loan card with interest rate and Record repayment');
  await p.click('[data-act=repay-loan]'); await p.waitForTimeout(200);
  eq(await p.inputValue('#ea'), '8000.00', 'repayment sheet is pre-filled with the outstanding amount');
  await p.fill('#ea', '3000'); await p.click('[data-x=save]');
  eq(await p.evaluate(() => { const r = loanReport('l').find(x => x.entry.amount === 800000); return [r.repaid, r.out]; }), [300000, 500000], 'part-repayment: 3,000 repaid, 5,000 outstanding');

  console.log('Sample data uses the new features');
  const S2 = await device(); await S2.p.evaluate(() => loadSampleData());
  const sm = await S2.p.evaluate(() => ({
    netflix: live('entries').filter(e => e.desc === 'Netflix').length, nExp: occurrences({ date: isoDay(Date.now() - 70 * 864e5), repeat: 'monthly' }, isoDay(Date.now())).length + 1,
    ravi: loanReport('smp-b-loans').find(r => r.entry.desc === 'Loan to Ravi'), banner: dueBanner().replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    zero: live('books').every(bk => Object.values(netBalances(bk.id)).reduce((a, c) => a + c, 0) === 0),
  }));
  eq(sm.netflix, sm.nExp, 'sample Netflix subscription generated month by month');
  ok(sm.ravi.overdue && sm.ravi.out === 1000000 && sm.ravi.accrued > 0, `sample loan: Ravi overdue, 10,000 outstanding, interest ${sm.ravi.accrued / 100}`);
  ok(/Ravi/.test(sm.banner) && /overdue/.test(sm.banner), 'home banner flags it: ' + sm.banner);
  ok(sm.zero, 'all sample books still balance to zero');

  ok([A, B, S2].every(d => d.p.errors.length === 0), 'no JS errors anywhere');
  console.log(`\nFEATURES PASS (${pass} checks)`);
  await b.close(); srv.close();
})().catch(e => { console.error('FAIL', e.message || e); process.exit(1); });
