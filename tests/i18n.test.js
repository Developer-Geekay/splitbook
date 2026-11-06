// Languages: English + Hindi, Bengali, Marathi, Telugu, Tamil.
const { chromium } = require('playwright');
const assert = require('assert');
const fs = require('fs');
const acorn = require('acorn'), walk = require('acorn-walk');
const { start } = require('./serve');
const { makeDrive, newDevice, addIndicFonts, layoutDetect } = require('./harness');
let pass = 0; const ok = (c, m) => { assert(c, m); pass++; console.log('  ✓', m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} → ${JSON.stringify(a)}${JSON.stringify(a) === JSON.stringify(b) ? '' : ' (expected ' + JSON.stringify(b) + ')'}`);
const LANGS = ['hi', 'bn', 'mr', 'te', 'ta'], NAMES = { hi: 'Hindi', bn: 'Bengali', mr: 'Marathi', te: 'Telugu', ta: 'Tamil' };

// ---- every translatable string used by the app (found with a real parser)
function appKeys() {
  const src = fs.readFileSync(__dirname + '/../app.js', 'utf8'), ast = acorn.parse(src, { ecmaVersion: 'latest' }), keys = new Set();
  const lit = n => { if (!n) return; if (n.type === 'Literal' && typeof n.value === 'string') keys.add(n.value); else if (n.type === 'ConditionalExpression') { lit(n.consequent); lit(n.alternate); } else if (n.type === 'LogicalExpression') { lit(n.left); lit(n.right); } else if (n.type === 'TemplateLiteral' && !n.expressions.length) keys.add(n.quasis[0].value.cooked); };
  walk.simple(ast, { VariableDeclarator(n) {                      // strings that reach T() indirectly (arrays / lookup tables)
    if (n.id.type !== 'Identifier' || !n.init) return;
    if (n.id.name === 'VOICE_EXAMPLES') n.init.elements.forEach(lit);
    if (n.id.name === 'ERR') n.init.properties.forEach(pr => lit(pr.value));
  } });
  walk.simple(ast, { CallExpression(n) { const c = n.callee; if (c.type !== 'Identifier') return; if (['T', 'eT', 'hT'].includes(c.name)) lit(n.arguments[0]); if (c.name === 'Tn') { lit(n.arguments[1]); lit(n.arguments[2]); } } });
  ['week', 'month', 'year', 'Language', 'Language changed', 'you', 'last sync'].forEach(k => keys.add(k));
  for (const m of src.match(/const (?:CATS|INCOME_CATS) = \[.*\];/g)) for (const x of m.match(/'([A-Za-z ]+)'\]/g) || []) keys.add(x.slice(1, -2));
  return [...keys].filter(k => /[A-Za-z]/.test(k));
}
const ALLOW = /^(SplitBook|Google|Drive|PDF|pdf|Safari|English|Hindi|Bengali|Marathi|Telugu|Tamil|[A-Z]{2,5})$/;   // brand/format words + the English sub-labels in the language picker
const collect = () => { const at = [...document.querySelectorAll('[placeholder],[aria-label],[title],[alt]')].map(e => ['placeholder', 'aria-label', 'title', 'alt'].map(a => e.getAttribute(a) || '').join(' ')).join(' ');
  return document.body.innerText + ' ' + at + ' ' + ((document.querySelector('#toast') || {}).innerText || ''); };

(async () => {
  console.log('Dictionary');
  const keys = appKeys(); const I = new Function('window', fs.readFileSync(__dirname + '/../i18n.js', 'utf8') + ';return window.I18N;')({});
  ok(keys.length > 300, `${keys.length} translatable strings found in the code`);
  for (const l of LANGS) {
    const miss = keys.filter(k => !(I[l] && I[l][k])), empty = Object.entries(I[l]).filter(([, v]) => !String(v).trim()).map(([k]) => k);
    const ph = keys.filter(k => I[l][k] && JSON.stringify((k.match(/\{\w+\}/g) || []).sort()) !== JSON.stringify((I[l][k].match(/\{\w+\}/g) || []).sort()));
    ok(!miss.length && !empty.length && !ph.length, `${NAMES[l]}: all ${keys.length} strings translated, none empty, placeholders intact ${miss.slice(0, 3)}${ph.slice(0, 3)}`);
    ok(Object.keys(I[l]).every(k => keys.includes(k)), `${NAMES[l]}: no stale entries`);
  }
  ok(LANGS.every(l => /[ऀ-෿]/.test(I[l]['Add expense'])), 'each dictionary really is in its own script');

  const srv = await start(), URL = 'http://localhost:' + srv.address().port + '/index.html';
  const b = await chromium.launch(), devs = [];
  const dev = async o => { const d = await newDevice(b, URL, makeDrive(), o); await addIndicFonts(d.p); devs.push(d); return d; };

  console.log('Detection, switching, persistence');
  const T1 = await dev({ locale: 'ta-IN' }); eq(await T1.p.evaluate(() => [LANG, document.documentElement.lang]), ['ta', 'ta'], 'a Tamil phone opens in Tamil automatically');
  ok(/[஀-௿]/.test(await T1.p.innerText('#app')), 'and really renders Tamil text');
  const F1 = await dev({ locale: 'fr-FR' }); eq(await F1.p.evaluate(() => LANG), 'en', 'an unsupported language falls back to English');
  const D1 = await dev({ locale: 'en-IN', firstRun: true }), p = D1.p;
  ok((await p.$$('.setup .lg')).length === 6, 'the first-run setup page offers all six languages as one-tap tiles');
  await p.click('.setup .lg[data-v=hi]'); await p.waitForFunction(() => LANG === 'hi'); ok(/स्वागत|आपका पैसा/.test(await p.innerText('#app')), 'tapping हिन्दी switches the whole screen at once');
  await p.click('[data-act=setup-done]'); await p.waitForSelector('.slides'); await p.reload(); await p.waitForSelector('.slides'); eq(await p.evaluate(() => LANG), 'hi', 'the choice survives a reload');
  await p.click('.top .iconbtn[data-act=settings]'); ok(/भाषा/.test(await p.innerText('.sheet')), 'Settings has a Language row');
  await p.click('[data-x=lang]'); const rows = await p.$$eval('.layer .cur-row b', e => e.map(x => x.textContent)); eq(rows, ['English', 'हिन्दी', 'বাংলা', 'मराठी', 'తెలుగు', 'தமிழ்'], 'the picker lists each language in its own script');
  await p.click('.layer .cur-row[data-v=te]'); await p.waitForFunction(() => LANG === 'te'); ok(/[ఀ-౿]/.test(await p.innerText('.sheet')), 'picking తెలుగు updates the open Settings sheet');
  await p.keyboard.press('Escape'); await p.evaluate(() => setLang('en')); eq(await p.evaluate(() => document.documentElement.lang), 'en', 'switching back to English works');

  console.log('Numbers and dates follow the language');
  const f = await p.evaluate(() => { const o = {}; for (const l of ['en', 'hi', 'bn', 'mr', 'te', 'ta']) { setLang(l); o[l] = [fmt(12345678, 'INR'), fmt(-50, 'INR'), shortDate('2026-11-05'), dayLabel('2026-01-02')]; } setLang('en'); return o; });
  console.log('   ', JSON.stringify(f.hi), JSON.stringify(f.bn));
  ok(LANGS.every(l => /^₹1,23,456\.78$/.test(f[l][0])), 'amounts keep Latin digits and Indian lakh grouping in every language (₹1,23,456.78)');
  ok(LANGS.every(l => /^[-−]?₹0\.50$/.test(f[l][1])), 'negative amounts stay readable');
  ok(LANGS.every(l => /[ऀ-෿]/.test(f[l][2]) && /5/.test(f[l][2])), 'dates use localised month names: ' + LANGS.map(l => f[l][2]).join(' | '));

  console.log('No English leaks (user data is Devanagari, so any Latin word is a missed string)');
  const seed = pg => pg.evaluate(() => {
    const M = me().id, R = 'u-r', V = 'u-m', T0 = now(), pad = n => String(n).padStart(2, '0'), day = n => isoDay(Date.now() - n * 864e5);
    S.doc.people[R] = { id: R, name: 'रवि', updatedAt: T0 }; S.doc.people[V] = { id: V, name: 'मीरा', updatedAt: T0 };
    S.doc.books.g = { id: 'g', name: 'गोवा यात्रा', emoji: '🏖️', currency: 'INR', memberIds: [M, R, V], createdAt: 1, updatedAt: T0 };
    let n = 0; const add = (bk, o) => { const id = 'x' + n++; S.doc.entries[id] = { id, bookId: bk, type: 'expense', desc: 'चाय', amount: 10000, paidBy: M, split: { [M]: 10000 }, method: 'equal', date: day(1), cat: '🍽️', note: '', createdAt: T0 + n, updatedAt: T0, ...o }; return id; };
    for (let m = 0; m < 4; m++) { add('my-money', { type: 'income', desc: 'वेतन', amount: 5000000, cat: '💼', split: {}, date: day(10 + m * 30) }); for (let i = 0; i < 9; i++) add('my-money', { desc: 'खर्च ' + i, amount: 150000 + i * 20000, date: day(m * 30 + i * 3), cat: i % 2 ? '🛒' : '🍽️', split: { [M]: 150000 + i * 20000 } }); }
    add('my-money', { desc: 'किराया', amount: 2200000, split: { [M]: 2200000 }, cat: '🏠', repeat: 'monthly', date: day(0) });
    add('my-money', { desc: 'लैपटॉप', amount: 4800000, split: { [M]: 4800000 }, cat: '🧾', date: day(4) }); add('my-money', { desc: 'दोपहर', amount: 32000, split: { [M]: 32000 }, date: day(3) }); add('my-money', { desc: 'दोपहर', amount: 32000, split: { [M]: 32000 }, date: day(3) });
    add('g', { desc: 'होटल', amount: 900000, paidBy: M, split: { [M]: 300000, [R]: 300000, [V]: 300000 }, cat: '🏠', date: day(5) });
    add('g', { desc: 'ऋण', amount: 500000, paidBy: M, split: { [R]: 500000 }, method: 'exact', cat: '💸', date: day(60), loan: { rate: 12, due: day(10) } });
    add('g', { desc: 'टैक्सी', amount: 200000, paidBy: V, split: { [M]: 100000, [V]: 100000 }, cat: '🚗', date: day(2) });
    add('g', { type: 'settle', desc: 'Payment', amount: 100000, paidBy: R, split: { [M]: 100000 }, method: 'exact', date: day(1), cat: '🤝' });
    S.doc.entries.x1.receipts = [{ id: 'rc1', name: 'bill.pdf', type: 'application/pdf', size: 100 }];
    S.meta.wasSignedIn = false; persist(); render();
  });
  const grabs = [];
  const tour = async (pg, lang) => {
    const g = async name => grabs.push({ lang, name, text: await pg.evaluate(collect) });
    const nav = async h => { await pg.evaluate(h => { if (h === 'home') location.hash = ''; else location.hash = h; }, h); await pg.waitForTimeout(80); };
    const closeAll = async () => { for (let i = 0; i < 3; i++) await pg.keyboard.press('Escape'); await pg.evaluate(() => { document.querySelectorAll('.layer').forEach(x => x.remove()); closeSheet(); }); };
    await nav('home'); await g('home slide 1'); await pg.click('[data-act=slide][data-i="1"]'); await pg.waitForTimeout(300); await g('home slide 2');
    await nav('insights'); await pg.waitForSelector('#nw'); await g('insights');
    await nav('book/my-money'); await pg.waitForSelector('.hero.compact'); await pg.evaluate(() => { S.ui.tab = 'entries'; render(); }); await g('my money activity'); await pg.click('[data-act=tab][data-tab=summary]'); await g('my money summary');
    await pg.click('[data-act=tab][data-tab=entries]');
    await pg.click('.fab'); await pg.waitForSelector('.sheet'); await pg.fill('#ea', '250'); await g('add expense (personal)'); await pg.click('[data-x=type][data-v=income]'); await g('add income'); await pg.click('[data-x=rep][data-v=monthly]'); await g('income + repeat');
    await pg.setInputFiles('#rfile', { name: 'r.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF') }); await pg.waitForSelector('.rc-th'); await g('with receipt'); await pg.click('.rc-th'); await pg.waitForSelector('.layer.rv'); await g('receipt viewer'); await pg.keyboard.press('Escape'); await closeAll();
    await nav('book/g'); await pg.waitForSelector('.hero.compact'); await pg.evaluate(() => { S.ui.tab = 'entries'; render(); }); await g('book activity');
    await pg.click('[data-act=tab][data-tab=balances]'); await g('book balances + loans'); await pg.click('[data-act=tab][data-tab=members]'); await g('book people'); await pg.click('[data-act=tab][data-tab=entries]');
    await pg.click('.fab'); await pg.waitForSelector('.sheet'); await pg.fill('#ea', '250'); await g('add expense (shared)'); await pg.click('[data-x=custom]'); await g('custom split'); await pg.click('[data-x=method][data-v=exact]'); await g('custom exact'); await pg.click('[data-x=method][data-v=percent]'); await pg.click('[data-x=custom]');
    await pg.click('[data-x=cat][data-v="💸"]'); await g('loan form'); await pg.click('[data-x=type][data-v=settle]'); await g('payment form');
    await pg.click('#savebtn'); await g('validation toast'); await closeAll();
    await pg.click('[data-act=tab][data-tab=members]'); await pg.click('[data-act=edit-book]'); await g('edit book'); await pg.click('[data-x=cur]'); await g('currency picker'); await pg.fill('#cq', 'zzzz'); await g('currency no match'); await closeAll();
    await pg.click('[data-act=del-book]'); await g('confirm delete'); await closeAll();
    await pg.click('.top .iconbtn[data-act=settings]'); await g('settings'); await pg.click('[data-x=lang]'); await g('language picker'); await closeAll();
    await pg.evaluate(() => { S.meta.wasSignedIn = true; S.meta.user = { name: 'आशा', email: 'a@b.c' }; S.meta.lastSync = Date.now(); persist(); settingsSheet(); }); await g('settings signed in'); await closeAll(); await pg.evaluate(() => { S.meta.wasSignedIn = false; persist(); });
    await pg.evaluate(() => installSheet(true)); await g('install sheet'); await closeAll();
    await pg.evaluate(() => { S.sync = { state: 'err', error: 'x' }; paintStatus(); }); await g('sync status'); await pg.evaluate(() => { S.sync = { state: 'idle', error: '' }; });
  };
  for (const l of LANGS) {
    const D = await dev({ width: 390 }); await seed(D.p); await D.p.evaluate(l => setLang(l), l);
    await tour(D.p, l);
  }
  const leaks = [];
  for (const { lang, name, text } of grabs) {
    const words = (text.match(/[A-Za-z]{3,}/g) || []).filter(w => !ALLOW.test(w));
    if (words.length) leaks.push(`${lang} · ${name}: ${[...new Set(words)].slice(0, 8).join(', ')}`);
    if (/\{\w+\}|\$\{|\bT\(|undefined|NaN|\[object/.test(text)) leaks.push(`${lang} · ${name}: placeholder/undefined leaked`);
  }
  ok(grabs.length >= LANGS.length * 25, `${grabs.length} screens captured across ${LANGS.length} languages`);
  if (leaks.length) console.log('   LEAKS:\n    ' + leaks.join('\n    '));
  ok(leaks.length === 0, 'every screen is fully translated in every language');
  const fresh = await dev({}); await fresh.p.evaluate(() => setLang('mr'));
  const wl = await fresh.p.evaluate(collect); ok(!(wl.match(/[A-Za-z]{3,}/g) || []).filter(w => !ALLOW.test(w)).length, 'first-run welcome screen is fully Marathi');
  await fresh.p.evaluate(() => { location.hash = 'insights'; }); await fresh.p.waitForTimeout(100); ok(!(await fresh.p.evaluate(collect)).match(/Nothing to analyse/), 'empty insights state is translated too');

  console.log('Layout at 320px with real Indic fonts');
  for (const l of LANGS) {
    const D = await dev({ width: 320 }); const pg = D.p; await seed(pg); await pg.evaluate(l => setLang(l), l);
    const bad = {}, chk = async n => { const r = await pg.evaluate(layoutDetect); if (r.length) bad[n] = r; };
    await pg.click('.fab'); await pg.waitForSelector('.sheet'); await pg.fill('#ea', '9876543.21'); await chk('personal expense'); await pg.click('[data-x=type][data-v=income]'); await chk('income');
    await pg.click('[data-x=rep][data-v=monthly]'); await chk('repeat'); await pg.click('[data-x=close]');
    await pg.evaluate(() => { location.hash = 'book/g'; }); await pg.waitForSelector('.hero.compact'); await pg.click('.fab'); await pg.fill('#ea', '9876543.21'); await chk('shared');
    await pg.click('[data-x=custom]'); for (const m of ['exact', 'percent', 'shares']) { await pg.click(`[data-x=method][data-v=${m}]`); await chk('custom ' + m); } await pg.click('[data-x=custom]');
    await pg.click('[data-x=cat][data-v="💸"]'); await chk('loan'); await pg.click('[data-x=type][data-v=settle]'); await chk('payment'); await pg.click('[data-x=close]');
    await pg.click('[data-act=tab][data-tab=members]'); await pg.click('[data-act=edit-book]'); await chk('edit book'); await pg.click('[data-x=cur]'); await chk('currency picker'); await pg.keyboard.press('Escape'); await pg.click('[data-x=close]');
    await pg.click('[data-act=del-book]'); await chk('confirm'); await pg.click('.dlg [data-x=no]');
    await pg.click('.top .iconbtn[data-act=settings]'); await chk('settings'); await pg.click('[data-x=lang]'); await chk('language picker'); await pg.keyboard.press('Escape'); await pg.keyboard.press('Escape');
    await pg.evaluate(() => installSheet(true)); await chk('install'); await pg.keyboard.press('Escape');
    // pages (not sheets): nothing may scroll sideways
    const wide = []; for (const h of ['', 'book/g', 'book/my-money', 'insights']) { await pg.evaluate(h => { location.hash = h; }, h); await pg.waitForTimeout(80); if (await pg.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) wide.push(h || 'home'); }
    if (wide.length) bad.pages = wide;
    eq(bad, {}, `${NAMES[l]}: forms, pickers, dialogs and pages are clean`);
  }
  ok(devs.every(d => d.p.errors.length === 0), 'no JS errors in any language');
  ok(devs.every(d => d.p.dialogs.length === 0), 'no native dialogs');
  console.log(`\nI18N PASS (${pass} checks)`);
  await b.close(); srv.close();
})().catch(e => { console.error('FAIL', e.message || e); process.exit(1); });
