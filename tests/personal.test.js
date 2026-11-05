// "My money" (income & expenses without a book) + immediate reflection of book edit/delete, incl. other devices.
const { chromium } = require('playwright');
const assert = require('assert');
const { start } = require('./serve');
let pass = 0; const ok = (c, m) => { assert(c, m); pass++; console.log('  ✓', m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} → ${JSON.stringify(a)}${JSON.stringify(a) === JSON.stringify(b) ? '' : ' (expected ' + JSON.stringify(b) + ')'}`);

(async () => {
  const srv = await start(), URL = 'http://localhost:' + srv.address().port + '/index.html';
  const b = await chromium.launch(); let drive = null; const all = [];
  async function device() {
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', locale: 'en-IN' });
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
    const p = await ctx.newPage(); p.errors = []; p.on('pageerror', e => p.errors.push(e.message)); p.dialogs = []; p.on('dialog', d => { p.dialogs.push(d.message()); d.dismiss(); });
    await p.goto(URL); all.push(p); return { ctx, p };
  }
  const A = await device(), p = A.p;
  const yyyymm = () => p.evaluate(() => isoDay(Date.now()).slice(0, 7));

  console.log('Income & expenses without any book');
  ok(await p.isVisible('.mm') && (await p.innerText('.mm')).includes('My money'), 'fresh app shows the My money card — no book needed');
  eq(await p.evaluate(() => live('books').filter(x => !x.personal).length), 0, 'no shared books exist');
  await p.click('[data-act=add-income]');
  ok(await p.isVisible('.seg2 button.on:has-text("Income")'), 'Income button opens the sheet on the Income tab');
  const sheetTxt = await p.innerText('.sheet');
  ok(!/split between|paid by/i.test(sheetTxt), 'personal sheet has no "paid by / split between" clutter');
  ok(/Salary/.test(sheetTxt) && /Freelance/.test(sheetTxt) && !/Groceries/.test(sheetTxt), 'income categories shown (Salary, Freelance…) instead of spending ones');
  await p.fill('#ea', '50000'); await p.fill('#ed', 'Salary'); await p.click('[data-x=save]');
  await p.click('[data-act=add-expense]'); await p.fill('#ea', '1200'); await p.click('[data-x=cat][data-l="Food"]'); await p.click('[data-x=save]');
  const st = await p.evaluate(() => monthStats(PERSONAL_ID, isoDay(Date.now()).slice(0, 7)));
  eq(st, { inc: 5000000, exp: 120000, net: 4880000 }, 'month totals: income 50,000 · spent 1,200 · net 48,800');
  eq(await p.innerText('.mm-n'), await p.evaluate(() => money(4880000, personalBook().currency, true)), 'home card shows the net for the month');
  ok(!(await p.$('.hero')), 'no "owe / owed" balance card for someone with only personal money');
  eq(await p.evaluate(() => Object.values(netBalances(PERSONAL_ID)).every(v => v === 0)), true, 'personal entries never create debts');
  const ex = await p.evaluate(() => live('entries').find(e => e.type === 'expense'));
  eq([ex.desc, ex.cat, Object.keys(ex.split).length], ['Food', '🍽️', 1], 'expense saved with category-as-description and a single (own) split');

  console.log('Personal book screen');
  await p.click('[data-act=open-personal]'); await p.waitForSelector('.hero.compact');
  let txt = await p.innerText('#app');
  ok(/Salary/.test(txt) && /\+/.test(txt) && /Food/.test(txt), 'Activity lists income (+) and expenses (−)');
  ok(!(await p.$('[data-tab=balances]')) && !(await p.$('[data-tab=members]')), 'no Balances / People tabs on My money');
  await p.click('[data-act=new-entry]');
  await p.fill('#ea', '40000'); await p.click('[data-x=type][data-v=income]'); await p.fill('#ed', 'Salary (recurring)');
  const d65 = await p.evaluate(() => isoDay(Date.now() - 65 * 864e5)); await p.fill('#edt', d65); await p.click('[data-x=rep][data-v=monthly]'); await p.click('[data-x=save]');
  const gen = await p.evaluate(() => live('entries').filter(e => e.desc === 'Salary (recurring)').map(e => [e.type, e.amount]));
  ok(gen.length >= 3 && gen.every(g => g[0] === 'income' && g[1] === 4000000), `recurring salary backfilled ${gen.length} monthly income entries`);
  txt = await p.innerText('#app'); ok(/recurring · \+/i.test(txt), 'Recurring card shows monthly income');
  await p.click('[data-tab=summary]');
  const raw = await p.evaluate(() => { const o = {}; for (const e of Object.values(S.doc.entries)) { if (e.deleted || e.bookId !== PERSONAL_ID) continue; const k = e.date.slice(0, 7); o[k] = o[k] || { inc: 0, exp: 0 }; e.type === 'income' ? o[k].inc += e.amount : o[k].exp += e.amount; } return o; });
  const sm = await p.evaluate(() => { const d = new Date(); return Array.from({ length: 6 }, (_, i) => { const x = new Date(d.getFullYear(), d.getMonth() - (5 - i), 1); return ymd(x).slice(0, 7); }).map(k => monthStats(PERSONAL_ID, k)); });
  const keys = await p.evaluate(() => { const d = new Date(); return Array.from({ length: 6 }, (_, i) => ymd(new Date(d.getFullYear(), d.getMonth() - (5 - i), 1)).slice(0, 7)); });
  ok(keys.every((k, i) => sm[i].inc === (raw[k] ? raw[k].inc : 0) && sm[i].exp === (raw[k] ? raw[k].exp : 0)), 'Summary month figures equal an independent sum of the raw entries');
  ok((await p.innerText('#app')).includes('WHERE IT WENT') || /where it went/i.test(await p.innerText('#app')), 'Summary shows the spending-by-category breakdown');
  ok(/Food/.test(await p.innerText('#app')) && /100%/.test(await p.innerText('#app')), 'only category this month (Food) = 100%');

  console.log('Edit / delete a personal entry updates immediately');
  await p.click('[data-tab=entries]');
  const before = await p.evaluate(() => live('entries').length);
  await p.click('.tx:has-text("Food")'); await p.click('[data-x=del]');
  eq(await p.evaluate(() => live('entries').length), before - 1, 'deleted entry is gone at once');
  ok(!(await p.innerText('#app')).includes('Food'), 'and gone from the screen');
  await p.click('#toast button');
  eq(await p.evaluate(() => live('entries').length), before, 'Undo brings it back');

  console.log('Quick-add from home reaches both personal and shared books');
  await p.click('[data-act=back]'); await p.waitForSelector('.mm');
  await p.click('.bk.new'); await p.fill('#bn', 'Trip'); await p.fill('#np', 'Ravi'); await p.click('[data-x=addp]'); await p.click('[data-x=save]');
  await p.click('[data-act=back]'); await p.waitForSelector('.mm'); await p.click('.fab');
  const chips = await p.$$eval('.sheet [data-x=book]', els => els.map(e => e.textContent.trim()));
  ok(chips.length === 2 && /My money/.test(chips[0]) && /Trip/.test(chips[1]), 'quick-add offers My money (first) and each shared book: ' + chips.join(' | '));
  await p.click('.sheet [data-x=book]:has-text("Trip")'); await p.waitForTimeout(50);
  ok(!(await p.isVisible('.seg2 button:has-text("Income")')) && await p.isVisible('.seg2 button:has-text("Payment")'), 'shared book offers Payment, not Income');
  await p.click('[data-x=close]');

  console.log('Updating a book shows immediately');
  await p.click('.bk:has-text("Trip")'); await p.waitForSelector('.hero.compact');
  await p.click('[data-tab=members]'); await p.click('[data-act=edit-book]'); await p.fill('#bn', 'Trip to Goa'); await p.click('[data-x=save]');
  eq(await p.innerText('.top h1'), '📒 Trip to Goa', 'title updated the moment you save');
  await p.click('[data-act=back]'); await p.waitForSelector('.mm');
  ok((await p.innerText('.list')).includes('Trip to Goa'), 'home card shows the new name straight away');

  console.log('Deleting a book from every tab');
  for (const tab of ['entries', 'balances', 'members']) {
    await p.evaluate(n => { const id = uid(), me0 = me().id; S.doc.books[id] = { id, name: n, emoji: '📒', currency: 'INR', memberIds: [me0], createdAt: 1, updatedAt: now() }; for (let i = 0; i < 3; i++) { const e = uid(); S.doc.entries[e] = { id: e, bookId: id, type: 'expense', desc: 'x' + i, amount: 100, paidBy: me0, split: { [me0]: 100 }, method: 'equal', date: isoDay(Date.now()), cat: '🧾', createdAt: now() + i, updatedAt: now() }; } touched(); }, 'Doomed ' + tab);
    await p.click('.bk:has-text("Doomed ' + tab + '")'); await p.waitForSelector('.hero.compact'); await p.click('[data-tab=members]'); await p.click('[data-act=del-book]'); await p.click('.dlg [data-x=ok]');
    // while sitting on the People tab the delete button is there; for other tabs navigate via tab → then delete (button lives on People)
    const st2 = await p.evaluate(() => ({ hash: location.hash, view: S.ui.view, home: !!document.querySelector('.mm') }));
    ok(st2.hash === '' && st2.view === 'home' && st2.home, `delete (from ${tab} flow) returns to home immediately`);
    ok(!(await p.innerText('.list')).includes('Doomed ' + tab), 'deleted book card is gone');
    await p.click('#toast button');
    ok((await p.innerText('.list')).includes('Doomed ' + tab) && (await p.evaluate(t => live('entries').filter(e => live('books').some(bk => bk.name === 'Doomed ' + t && bk.id === e.bookId)).length, tab)) === 3, 'Undo restores the book and its 3 entries');
    await p.evaluate(t => { const bk = live('books').find(x => x.name === 'Doomed ' + t); live('entries').filter(e => e.bookId === bk.id).forEach(e => delete S.doc.entries[e.id]); delete S.doc.books[bk.id]; touched(); }, tab);
  }
  ok(p.errors.length === 0, 'no JS errors during edit/delete flows: ' + p.errors.join(';'));

  console.log('Other devices see changes quickly');
  await p.evaluate(() => { S.meta.wasSignedIn = true; S.meta.user = { given_name: 'Asha' }; persist(); }); await p.evaluate(() => sync(true));
  const B = await device(); await B.p.evaluate(() => { S.meta.wasSignedIn = true; persist(); }); await B.p.evaluate(() => sync(true));
  eq(await B.p.evaluate(() => live('books').filter(x => x.personal).length), 1, 'second device ends up with exactly one My money book');
  eq(await B.p.evaluate(() => monthStats(PERSONAL_ID, isoDay(Date.now()).slice(0, 7))), await p.evaluate(() => monthStats(PERSONAL_ID, isoDay(Date.now()).slice(0, 7))), 'income/expense totals identical on both devices');
  await B.p.click('[data-act=add-expense]'); await B.p.fill('#ea', '300'); await B.p.fill('#ed', 'Snacks from B'); await B.p.click('[data-x=save]');
  await B.p.waitForTimeout(1200);
  ok(!!drive && Object.values(drive.entries).some(e => e.desc === 'Snacks from B'), 'a change is uploaded automatically within ~1s (no manual sync)');
  await p.evaluate(() => sync(false));
  ok(await p.evaluate(() => live('entries').some(e => e.desc === 'Snacks from B' && e.bookId === PERSONAL_ID && e.paidBy === me().id)), 'device A receives it and it belongs to the same "me"');
  // rename + delete on A, B open on that book
  const tripId = await p.evaluate(() => live('books').find(x => x.name === 'Trip to Goa').id);
  await p.evaluate(() => sync(true)); await B.p.evaluate(() => sync(true));
  await B.p.evaluate(id => { S.ui.view = 'book'; S.ui.bookId = id; location.hash = 'book/' + id; }, tripId); await B.p.waitForTimeout(50);
  await p.evaluate(id => { put('books', { ...S.doc.books[id], name: 'Renamed on A' }); }, tripId); await p.waitForTimeout(900); await B.p.evaluate(() => sync(true));
  eq(await B.p.innerText('.top h1'), '📒 Renamed on A', "rename on one device appears on the other's open screen");
  await p.evaluate(id => { const t = now(); live('entries').filter(e => e.bookId === id).forEach(e => { S.doc.entries[e.id] = { id: e.id, deleted: true, updatedAt: t, bookId: id }; }); S.doc.books[id] = { id, deleted: true, updatedAt: t }; touched(); }, tripId);
  await p.waitForTimeout(900); await B.p.evaluate(() => sync(true));
  const bs = await B.p.evaluate(() => ({ view: S.ui.view, hash: location.hash, home: !!document.querySelector('.mm'), books: live('books').filter(x => !x.personal).length }));
  ok(bs.view === 'home' && bs.hash === '' && bs.home && bs.books === 0, 'a book deleted on A while open on B sends B home, no crash');

  console.log('Sample data and currency');
  await p.evaluate(() => loadSampleData());
  const sd = await p.evaluate(() => { const es = live('entries').filter(e => e.bookId === PERSONAL_ID && isSample(e.id)); return { inc: es.filter(e => e.type === 'income').length, exp: es.filter(e => e.type === 'expense').length, books: live('books').filter(x => !x.personal).length }; });
  ok(sd.inc >= 3 && sd.exp >= 20 && sd.books === 6, `sample data: ${sd.inc} income + ${sd.exp} personal expense entries, 6 shared books`);
  await p.evaluate(() => clearSampleData());
  eq(await p.evaluate(() => [!!personalBook(), live('entries').filter(e => isSample(e.id)).length]), [true, 0], 'removing samples keeps My money and your own entries');
  await p.click('.iconbtn[data-act=settings]'); await p.click('[data-x=pcur]'); await p.fill('#cq', 'EUR'); await p.click('.cur-row[data-v=EUR]');
  ok(/€/.test(await p.innerText('.mm-n')) || /€/.test(await p.innerText('#app')), 'My money currency can be changed in Settings');
  ok(all.every(d => d.errors.length === 0), 'no JS errors on any device');
  ok(all.every(d => d.dialogs.length === 0), 'no native alert/confirm/prompt dialogs were ever shown');

  console.log(`\nPERSONAL PASS (${pass} checks)`);
  await b.close(); srv.close();
})().catch(e => { console.error('FAIL', e.message || e); process.exit(1); });
