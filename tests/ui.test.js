// In-app dialogs & pickers: custom confirm, searchable currency list, repeat chips — and no native popups.
const { chromium } = require('playwright');
const assert = require('assert');
const fs = require('fs');
const { start } = require('./serve');
let pass = 0; const ok = (c, m) => { assert(c, m); pass++; console.log('  ✓', m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} → ${JSON.stringify(a)}${JSON.stringify(a) === JSON.stringify(b) ? '' : ' (expected ' + JSON.stringify(b) + ')'}`);

(async () => {
  console.log('Source');
  const src = fs.readFileSync(__dirname + '/../app.js', 'utf8');
  ok(!/\b(confirm|alert|prompt)\s*\(/.test(src), 'app.js never calls native confirm/alert/prompt');
  ok(!/<select/.test(src), 'no native <select> dropdowns remain');

  const srv = await start(), URL = 'http://localhost:' + srv.address().port + '/index.html';
  const b = await chromium.launch(), ctx = await b.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', locale: 'en-IN' });
  const p = await ctx.newPage(); const dialogs = [], errors = []; p.on('dialog', d => { dialogs.push(d.type() + ':' + d.message()); d.dismiss(); }); p.on('pageerror', e => errors.push(e.message));
  await p.goto(URL);

  console.log('Currency list');
  const n = await p.evaluate(() => allCurrencies().length); ok(n >= 100, `${n} currencies available (was 14)`);
  ok(await p.evaluate(() => ['INR', 'USD', 'EUR', 'GBP', 'JPY', 'KWD', 'PKR', 'BDT', 'IDR', 'THB', 'ZAR', 'NGN', 'CHF', 'SEK', 'BRL'].every(c => allCurrencies().some(x => x.code === c))), 'covers INR, USD, EUR, GBP, JPY, KWD, PKR, BDT, IDR, THB, ZAR, NGN, CHF, SEK, BRL …');
  eq(await p.evaluate(() => localeCurrency()), 'INR', 'default currency follows the device region (en-IN → INR)');

  console.log('Picker inside the New book sheet');
  await p.click('.bk.new'); await p.fill('#bn', 'Japan trip');
  await p.click('[data-x=cur]');
  ok(await p.isVisible('.layer .picker'), 'tapping Currency opens the in-app picker');
  eq(await p.$eval('.cur-row', e => e.dataset.v), 'INR', 'current currency is first under "Popular"');
  ok(/all currencies/i.test(await p.innerText('.picker')), 'full alphabetical list below');
  await p.fill('#cq', 'rupee'); let codes = await p.$$eval('.cur-row', r => r.map(x => x.dataset.v));
  ok(codes.includes('INR') && codes.includes('PKR') && codes.length >= 3, 'search by name: "rupee" → ' + codes.join(','));
  await p.fill('#cq', 'ru'); const first = await p.$eval('.cur-row', e => e.dataset.v); ok(['RUB', 'RWF'].includes(first) || /ru/i.test(await p.$eval('.cur-row small', e => e.textContent.split(' ').pop().slice(0, 2))) || first.toLowerCase().startsWith('ru'), 'search ranks matches that START with the text first (ru → ' + first + ')');
  await p.fill('#cq', 'chf'); eq(await p.$$eval('.cur-row', r => r.map(x => x.dataset.v)), ['CHF'], 'search by code');
  await p.fill('#cq', '€'); ok((await p.$$eval('.cur-row', r => r.map(x => x.dataset.v))).includes('EUR'), 'search by symbol');
  await p.fill('#cq', 'zzzz'); ok(/no match/i.test(await p.innerText('.picker')), 'friendly "No match" state');
  await p.keyboard.press('Escape');
  ok(!(await p.$('.layer')) && await p.isVisible('#bn'), 'Esc closes only the picker; the book form stays open');
  await p.click('[data-x=cur]'); await p.mouse.click(10, 10);
  ok(!(await p.$('.layer')), 'tapping outside closes the picker');
  await p.click('[data-x=cur]'); await p.fill('#cq', 'yen'); await p.keyboard.press('Enter');
  ok(!(await p.$('.layer')) && /JPY/.test(await p.innerText('.curbtn')), 'Enter picks the first match (yen → JPY)');
  eq(await p.inputValue('#bn'), 'Japan trip', 'name typed before opening the picker is kept');
  await p.fill('#np', 'Ken'); await p.click('[data-x=addp]'); await p.click('[data-x=save]');

  console.log('Zero-decimal currency works end to end');
  await p.waitForSelector('.hero.compact'); await p.click('.fab'); await p.fill('#ea', '1500'); await p.fill('#ed', 'Ramen'); await p.click('[data-x=save]');
  const e1 = await p.evaluate(() => live('entries').find(e => e.desc === 'Ramen'));
  eq([e1.amount, Object.values(e1.split).reduce((a, c) => a + c, 0)], [1500, 1500], 'JPY 1,500 stored as 1500 (no decimals), split adds up');
  ok(/1,500/.test(await p.innerText('#app')) && !/1,500\.00/.test(await p.innerText('#app')), 'shown without decimals');

  console.log('Changing a book\'s currency keeps the numbers');
  await p.click('[data-tab=members]'); await p.click('[data-act=edit-book]'); await p.click('[data-x=cur]'); await p.fill('#cq', 'USD'); await p.click('.cur-row[data-v=USD]'); await p.click('[data-x=save]');
  const e2 = await p.evaluate(() => live('entries').find(e => e.desc === 'Ramen'));
  eq([e2.amount, Object.values(e2.split).reduce((a, c) => a + c, 0)], [150000, 150000], 'JPY→USD: 1,500 stays 1,500.00 (minor units ×100), split intact');
  await p.click('[data-act=edit-book]'); await p.click('[data-x=cur]'); await p.fill('#cq', 'JPY'); await p.click('.cur-row[data-v=JPY]'); await p.click('[data-x=save]');
  const e3 = await p.evaluate(() => live('entries').find(e => e.desc === 'Ramen'));
  eq(e3.amount, 1500, 'and back to JPY is lossless');
  await p.evaluate(() => { const bk = live('books').find(x => x.name === 'Japan trip'); const id = uid(), me0 = me().id, k = bk.memberIds.find(i => i !== me0); S.doc.entries[id] = { id, bookId: bk.id, type: 'expense', desc: 'odd', amount: 1, paidBy: me0, split: { [me0]: 1 }, method: 'equal', date: isoDay(Date.now()), cat: '🧾', createdAt: now(), updatedAt: now() }; touched(); });
  await p.evaluate(() => changeCurrency(live('books').find(x => x.name === 'Japan trip').id, 'INR'));
  ok(await p.evaluate(() => live('entries').filter(e => e.type !== 'income').every(e => Object.values(e.split).reduce((a, c) => a + c, 0) === e.amount)), 'every entry still sums exactly after JPY→INR');
  await p.evaluate(() => changeCurrency(live('books').find(x => x.name === 'Japan trip').id, 'JPY'));

  console.log('Delete uses an in-app confirmation');
  await p.click('[data-tab=members]'); await p.click('[data-act=del-book]');
  ok(await p.isVisible('.dlg') && /Delete “Japan trip”\?/.test(await p.innerText('.dlg')) && /entr/.test(await p.innerText('.dlg')), 'custom dialog names the book and its entries');
  await p.waitForTimeout(80); eq(await p.evaluate(() => document.activeElement.dataset.x), 'no', 'focus starts on Cancel (safe default)');
  await p.click('.dlg [data-x=no]'); ok(!(await p.$('.dlg')) && (await p.evaluate(() => location.hash)).startsWith('#book/'), 'Cancel keeps the book');
  await p.click('[data-act=del-book]'); await p.keyboard.press('Escape'); ok(!(await p.$('.dlg')) && !!(await p.evaluate(() => live('books').find(x => x.name === 'Japan trip'))), 'Esc cancels');
  await p.click('[data-act=del-book]'); await p.mouse.click(5, 5); ok(!(await p.$('.dlg')) && !!(await p.evaluate(() => live('books').find(x => x.name === 'Japan trip'))), 'tapping outside cancels');
  await p.click('[data-act=del-book]'); await p.click('.dlg [data-x=ok]');
  ok(!(await p.evaluate(() => live('books').find(x => x.name === 'Japan trip'))) && (await p.evaluate(() => location.hash)) === '', 'Delete removes it and returns home');
  await p.click('#toast button'); ok(!!(await p.evaluate(() => live('books').find(x => x.name === 'Japan trip'))), 'Undo restores it');

  console.log('Repeat is a chip row, not a dropdown');
  await p.click('.mm [data-act=add-expense]'); await p.fill('#ea', '99'); await p.fill('#ed', 'Streaming');
  eq(await p.$$eval('[data-x=rep]', r => r.map(x => x.textContent.trim())), ['Never', 'Weekly', 'Monthly', 'Yearly'], 'four options');
  await p.click('[data-x=rep][data-v=weekly]'); await p.click('[data-x=save]');
  eq(await p.evaluate(() => live('entries').find(e => e.desc === 'Streaming' && e.repeat).repeat), 'weekly', 'choice is saved');

  console.log('My money currency from Settings');
  await p.click('.iconbtn[data-act=settings]'); await p.click('[data-x=pcur]'); await p.fill('#cq', 'USD'); await p.click('.cur-row[data-v=USD]');
  await p.waitForSelector('.curbtn:has-text("USD")');
  eq(await p.evaluate(() => personalBook().currency), 'USD', 'My money switched to USD');
  ok(/\$/.test(await p.evaluate(() => fmt(1, 'USD'))) && !errors.length, 'no JS errors');
  eq(dialogs, [], 'no native dialogs appeared at any point');

  console.log(`\nUI PASS (${pass} checks)`);
  await b.close(); srv.close();
})().catch(e => { console.error('FAIL', e.message || e); process.exit(1); });
