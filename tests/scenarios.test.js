// Scenario tests on realistic sample data: daily, events, rent/bills, subscriptions, loans, foreign currency.
const { chromium } = require('playwright');
const assert = require('assert');
const { start } = require('./serve');
const { skipSetup } = require('./harness');
let pass = 0; const ok = (c, m) => { assert(c, m); pass++; console.log('  ✓', m); };

(async () => {
  const srv = await start(), URL = 'http://localhost:' + srv.address().port + '/index.html';
  const b = await chromium.launch(); let drive = null;
  async function device() {
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', locale: 'en-IN' });
  await skipSetup(ctx);
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
    await p.goto(URL); return { ctx, p };
  }
  const A = await device(), p = A.p;
  await p.evaluate(() => loadSampleData());

  console.log('Data shape');
  const shape = await p.evaluate(() => ({ books: live('books').map(b => b.name), entries: live('entries').length, people: live('people').length }));
  console.log('  ', JSON.stringify(shape));
  ok(shape.books.length === 7 && shape.entries > 150, 'six shared books + My money, 150+ entries generated');
  ok(await p.evaluate(() => { const r1 = JSON.stringify(S.doc.entries); const saved = JSON.parse(JSON.stringify(S.doc)); return typeof r1 === 'string' && saved; }), 'doc serialises');

  console.log('Money invariants');
  const inv = await p.evaluate(() => {
    const out = { badSum: [], nonInt: [], zeroNet: [], badSelf: [] };
    for (const e of live('entries')) {
      const sum = Object.values(e.split).reduce((a, c) => a + c, 0);
      if (e.type !== 'income' && sum !== e.amount) out.badSum.push(e.desc + ' ' + sum + '/' + e.amount);
      if (![e.amount, ...Object.values(e.split)].every(Number.isInteger)) out.nonInt.push(e.desc);
      if (e.type === 'settle' && Object.keys(e.split)[0] === e.paidBy) out.badSelf.push(e.desc);
    }
    for (const b of live('books')) { const net = netBalances(b.id); const s = Object.values(net).reduce((a, c) => a + c, 0); if (s !== 0) out.zeroNet.push(b.name + ' ' + s); }
    return out;
  });
  ok(inv.badSum.length === 0, 'every expense/payment: split sums exactly to amount ' + inv.badSum.join(';'));
  ok(inv.nonInt.length === 0, 'all amounts are integer minor units');
  ok(inv.zeroNet.length === 0, 'balances in every book sum to zero ' + inv.zeroNet.join(';'));
  ok(inv.badSelf.length === 0, 'no payment from a person to themselves');

  console.log('Scenario expectations');
  const loans = await p.evaluate(() => { const n = netBalances('smp-b-loans'); return { ravi: n['smp-p-ravi'], dev: n['smp-p-dev'], meera: n['smp-p-meera'] || 0, priya: n['smp-p-priya'] || 0, me: n[me().id] }; });
  ok(loans.ravi === -1000000, `loan: Ravi still owes 10,000 after two 5,000 instalments (got ${loans.ravi / 100})`);
  ok(loans.dev === 200000, `borrow: I owe Dev 2,000 after repaying 1,000 of 3,000 (got ${loans.dev / 100})`);
  ok(loans.meera === 0 && loans.priya === 0, 'fully-repaid borrow and lend net to exactly 0');
  ok(loans.me === 800000, `my net across loans = +8,000 (got ${loans.me / 100})`);
  const dinner = await p.evaluate(() => Object.values(S.doc.entries).find(e => e.desc === 'Seafood dinner').split);
  const dv = Object.values(dinner); ok(Math.max(...dv) - Math.min(...dv) <= 1 && dv.reduce((a, c) => a + c, 0) === 349999, '₹3,499.99 over 4 people: remainder paisa spread, nothing lost');
  const sub = await p.evaluate(() => Object.values(S.doc.entries).filter(e => e.desc.startsWith('iCloud')).every(e => Object.keys(e.split).length === 1));
  ok(sub, 'personal subscription only charges its owner');
  const skip = await p.evaluate(() => { const e = Object.values(S.doc.entries).find(e => e.desc.startsWith('Water sports')); return e.split['smp-p-dev'] === undefined && Object.keys(e.split).length === 3; });
  ok(skip, 'event expense can exclude a person');
  const pct = await p.evaluate(() => Object.values(S.doc.entries).find(e => e.desc === 'Beach shack').split);
  ok(pct['smp-p-ravi'] === 82500 && pct['smp-p-dev'] === 27500, 'percent split 30% / 10% of ₹2,750');
  const eur = await p.evaluate(() => { const n = netBalances('smp-b-berlin'); return fmt(n[me().id], 'EUR'); });
  console.log('   Berlin (EUR) my balance:', eur); ok(/€/.test(eur), 'EUR book formats in euros');

  console.log('Settle-up suggestions clear every book');
  const settled = await p.evaluate(() => {
    const res = [];
    for (const bk of live('books')) {
      for (const d of simplify(netBalances(bk.id))) put('entries', { id: uid(), bookId: bk.id, type: 'settle', desc: 'Payment', amount: d.amt, paidBy: d.from, split: { [d.to]: d.amt }, method: 'exact', date: isoDay(Date.now()), cat: '🤝', note: '', createdAt: now() });
      res.push([bk.name, Object.values(netBalances(bk.id)).every(v => v === 0)]);
    }
    return res;
  });
  ok(settled.every(([, z]) => z), 'applying suggested payments settles every book: ' + settled.map(s => s[0]).join(', '));
  await p.evaluate(() => { for (const e of live('entries')) if (e.desc === 'Payment' && !isSample(e.id)) del('entries', e.id); });

  console.log('Every screen renders');
  const bad = [];
  for (const id of await p.evaluate(() => live('books').map(x => x.id))) {
    for (const tab of ['entries', 'balances', 'members']) {
      await p.evaluate(([id, tab]) => { S.ui.tab = tab; location.hash = 'book/' + id; }, [id, tab]); await p.waitForTimeout(30);
      const t = await p.innerText('#app'); if (/NaN|undefined|\[object|Infinity/.test(t)) bad.push(id + '/' + tab);
    }
  }
  await p.evaluate(() => { location.hash = ''; }); await p.waitForTimeout(30);
  if (/NaN|undefined|\[object/.test(await p.innerText('#app'))) bad.push('home');
  ok(bad.length === 0 && p.errors.length === 0, 'no NaN/undefined/JS errors on home + every book × 3 tabs ' + bad.join(',') + p.errors.join(','));

  console.log('Edit round-trip (open every entry, save untouched)');
  const rt = await p.evaluate(async () => {
    const diffs = []; let n = 0;
    for (const e of live('entries').filter(x => isSample(x.id))) {
      S.ui.bookId = e.bookId; const before = JSON.stringify([e.amount, e.paidBy, e.split, e.repeat, e.loan]);
      entrySheet(e.id); document.querySelector('#savebtn').click(); n++;
      const a = S.doc.entries[e.id]; if (JSON.stringify([a.amount, a.paidBy, a.split, a.repeat, a.loan]) !== before) diffs.push(e.desc + ' (' + e.method + ')');
      document.querySelector('.overlay') && closeSheet();
    }
    return { n, diffs };
  });
  ok(rt.diffs.length === 0, `${rt.n} entries survive edit→save unchanged ${rt.diffs.slice(0, 5).join('; ')}`);

  console.log('Two devices + conflicts');
  await p.evaluate(() => { S.meta.wasSignedIn = true; S.meta.user = { given_name: 'Asha' }; persist(); }); await p.evaluate(() => sync(true));
  const B = await device();
  await B.p.evaluate(() => { S.meta.wasSignedIn = true; persist(); }); await B.p.evaluate(() => sync(true));
  const cnt = async q => q.evaluate(() => [live('books').length, live('entries').length, live('people').length]);
  ok(JSON.stringify(await cnt(B.p)) === JSON.stringify(await cnt(p)), 'device B receives identical books/entries/people: ' + JSON.stringify(await cnt(B.p)));
  const sameNet = async q => q.evaluate(() => live('books').map(b => JSON.stringify(netBalances(b.id))).join('|'));
  ok(await sameNet(B.p) === await sameNet(p), 'balances identical on both devices');
  // same entry edited on both while "offline": later edit wins; delete-after-edit wins
  const target = await p.evaluate(() => Object.values(S.doc.entries).find(e => e.desc === 'Netflix').id);
  await p.evaluate(id => { const e = S.doc.entries[id]; put('entries', { ...e, desc: 'Netflix (A edit)' }); }, target);
  await B.p.waitForTimeout(15);
  await B.p.evaluate(id => { const e = S.doc.entries[id]; put('entries', { ...e, desc: 'Netflix (B edit, later)' }); }, target);
  await p.evaluate(() => sync(true)); await B.p.evaluate(() => sync(true)); await p.evaluate(() => sync(true));
  ok((await p.evaluate(id => S.doc.entries[id].desc, target)) === 'Netflix (B edit, later)' && (await B.p.evaluate(id => S.doc.entries[id].desc, target)) === 'Netflix (B edit, later)', 'conflicting edits: latest edit wins on both devices');
  const victim = await p.evaluate(() => Object.values(S.doc.entries).find(e => e.desc === 'Loan to Ravi').id);
  await p.evaluate(id => { del('entries', id); }, victim); await p.evaluate(() => sync(true)); await B.p.evaluate(() => sync(true));
  ok(await B.p.evaluate(id => !live('entries').some(e => e.id === id), victim), 'deletion propagates to the other device');
  await p.evaluate(() => clearSampleData()); await p.evaluate(() => sync(true)); await B.p.evaluate(() => sync(true));
  ok((await cnt(B.p))[1] === 0 && (await cnt(B.p))[0] === 1, 'removing sample data propagates; only the built-in My money book remains');
  ok(B.p.errors.length === 0 && p.errors.length === 0, 'no JS errors during sync scenarios');

  console.log('Scale');
  const perf = await p.evaluate(() => {
    const t = now(); const bk = 'perf'; S.doc.books[bk] = { id: bk, name: 'Big', emoji: '📚', currency: 'INR', memberIds: [me().id, 'smp-p-ravi'], createdAt: t, updatedAt: t };
    for (let i = 0; i < 3000; i++) S.doc.entries['perf' + i] = { id: 'perf' + i, bookId: bk, type: 'expense', desc: 'x' + i, amount: 10000 + i, paidBy: i % 2 ? me().id : 'smp-p-ravi', split: { [me().id]: 5000, 'smp-p-ravi': 5000 + i }, method: 'exact', date: isoDay(Date.now() - (i % 300) * 864e5), cat: '🧾', createdAt: t + i, updatedAt: t };
    S.ui.view = 'book'; S.ui.bookId = bk; S.ui.tab = 'entries'; S.ui.limit = 40; const t1 = performance.now(); render(); const r = performance.now() - t1;
    const t2 = performance.now(); mergeDocs(S.doc, JSON.parse(JSON.stringify(S.doc))); const m = performance.now() - t2; return { r, m, bytes: JSON.stringify(S.doc).length };
  });
  console.log(`   3000 entries: render ${perf.r.toFixed(0)}ms, merge ${perf.m.toFixed(0)}ms, file ${(perf.bytes / 1024).toFixed(0)}KB`);
  ok(perf.r < 400 && perf.m < 500, 'renders and merges 3,000 entries quickly');

  console.log(`\nSCENARIOS PASS (${pass} checks)`);
  await b.close(); srv.close();
})().catch(e => { console.error('FAIL', e.message || e); process.exit(1); });
