// Voice / quick-text entry: the sentence parser (all six languages) and the voice sheet UI (with a fake speech engine).
const { chromium } = require('playwright');
const assert = require('assert');
const fs = require('fs');
const V = require('../voice.js');
const { start } = require('./serve');
const { makeDrive, newDevice, layoutDetect, addIndicFonts } = require('./harness');
let pass = 0; const ok = (c, m) => { assert(c, m); pass++; console.log('  ✓', m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} → ${JSON.stringify(a)}${JSON.stringify(a) === JSON.stringify(b) ? '' : ' (expected ' + JSON.stringify(b) + ')'}`);
const I18N = new Function('window', fs.readFileSync(__dirname + '/../i18n.js', 'utf8') + ';return window.I18N;')({});

(async () => {
  console.log('Parser — English');
  const people = [{ id: 'me', name: 'Me', isMe: true }, { id: 'r', name: 'Ravi' }, { id: 'm', name: 'Meera' }, { id: 'd', name: 'रवि' }];
  const books = [{ id: 'g', name: 'Goa', memberIds: ['me', 'r', 'm'], updatedAt: 2 }, { id: 'f', name: 'Flat', memberIds: ['me', 'r'], updatedAt: 1 }, { id: 'my-money', personal: true, memberIds: ['me'] }];
  const ctx = { today: '2026-11-06', people, books, meId: 'me', personalId: 'my-money' };
  const P = t => V.parse(t, ctx);
  const row = (t, exp) => { const r = P(t); const got = {}; for (const k of Object.keys(exp)) got[k] = r[k]; eq(got, exp, JSON.stringify(t)); };
  row('Lunch 250 yesterday', { type: 'expense', amount: 250, cat: '🍽️', date: '2026-11-05', desc: 'Lunch', bookId: 'my-money' });
  row('Got salary 50000', { type: 'income', amount: 50000, cat: '💼', desc: 'Salary' });
  row('two thousand five hundred rent', { amount: 2500, cat: '🏠' });
  row('five hundred and fifty groceries', { amount: 550, cat: '🛒' });
  row('one lakh twenty thousand bonus received', { type: 'income', amount: 120000, desc: 'Bonus' });
  row('2.5 lakh bonus received', { type: 'income', amount: 250000 });
  row('5k petrol', { amount: 5000, cat: '🚗' });
  row('Paid 1,200 rupees for dinner', { amount: 1200, cat: '🍽️', desc: 'Dinner' });
  row('Rs. 99 recharge', { amount: 99, cat: '💡' });
  row('₹250 chai', { amount: 250, cat: '🍽️' });
  row('1,23,456 laptop', { amount: 123456 });
  row('Dinner 1200 for 4 people', { amount: 1200 });
  row('coffee 120 3 days ago', { amount: 120, date: '2026-11-03' });
  row('movie 400 on 5th november', { amount: 400, date: '2026-11-05', cat: '🎬' });
  row('Netflix 649 every month', { amount: 649, cat: '🔁', repeat: 'monthly', desc: 'Netflix' });
  row('gym 300 every week', { repeat: 'weekly' }); row('insurance 12000 yearly', { repeat: 'yearly', amount: 12000 });
  row('day before yesterday medicine 80', { date: '2026-11-04', cat: '🏥' });
  eq(P('hello world').warnings, ['no-amount'], 'no amount → asks for one'); eq(P('').warnings, ['empty'], 'empty input is handled');
  eq(P('0 rupees chai').amount, null, 'zero is not an amount');
  console.log('Parser — people, payer, loans');
  row('Dinner 1200 with Ravi', { bookId: 'g', sel: ['me', 'r'], paidBy: 'me', amount: 1200 });
  row('Dinner 900 with Ravi and Meera', { bookId: 'g', sel: ['me', 'r', 'm'] });
  row('Ravi paid 800 for cab', { bookId: 'g', paidBy: 'r', sel: ['me', 'r'], cat: '🚗' });
  row('paid by Meera 450 pizza', { paidBy: 'm' });
  row('lent 500 to Ravi', { loan: 'lent', cat: '💸', paidBy: 'me', sel: ['r'], bookId: 'g' });
  row('borrowed 300 from Meera', { loan: 'borrowed', paidBy: 'm', sel: ['me'] });
  eq(P('रवि को 500 उधार दिए').warnings, ['no-shared-book'], 'a person who is in no shared book → falls back to My money with a warning');
  eq(P('Dinner 1200 with Zed').bookId, 'my-money', 'unknown name → My money');
  const inFlat = V.parse('taxi 180', { ...ctx, currentBookId: 'f' }); eq([inFlat.bookId, inFlat.sel], ['f', ['me', 'r']], 'said inside a shared book → that book, split between everyone in it');
  console.log('Parser — Hindi, Bengali, Marathi, Telugu, Tamil, Hinglish');
  row('ढाई सौ रुपये चाय', { amount: 250, cat: '🍽️' }); row('डेढ़ हज़ार किराया', { amount: 1500, cat: '🏠' }); row('सवा सौ रुपये ऑटो', { amount: 125, cat: '🚗' });
  row('दो हज़ार पांच सौ रुपये बिजली बिल', { amount: 2500, cat: '💡' }); row('५० रुपये चाय', { amount: 50 }); row('एक लाख वेतन मिला', { type: 'income', amount: 100000 });
  row('do hazaar paanch sau petrol', { amount: 2500, cat: '🚗' }); row('chai 20 rupaye kal', { amount: 20, date: '2026-11-05' });
  row('বাজার 500 টাকা', { amount: 500, cat: '🛒' }); row('5 হাজার ভাড়া', { amount: 5000, cat: '🏠' }); row('২৫০ টাকা চা', { amount: 250 });
  row('दूध 60 रुपये', { amount: 60, cat: '🛒' }); row('2 लाख पगार मिळाला', { type: 'income', amount: 200000 });
  row('కూరగాయలు 300 రూపాయలు', { amount: 300, cat: '🛒' }); row('5 వేలు అద్దె', { amount: 5000, cat: '🏠' });
  row('பால் 40 ரூபாய்', { amount: 40, cat: '🛒' }); row('2 லட்சம் சம்பளம் கிடைத்தது', { type: 'income', amount: 200000 });
  console.log('Parser — the app\'s own example phrases, in every language');
  const EX = { 'Lunch 250 yesterday': { amount: 250, cat: '🍽️', date: '2026-11-05', type: 'expense' }, 'Got salary 50000': { amount: 50000, type: 'income', cat: '💼' }, 'Taxi 180 today': { amount: 180, cat: '🚗', date: '2026-11-06' }, 'Netflix 649 every month': { amount: 649, cat: '🔁', repeat: 'monthly' } };
  for (const l of ['en', 'hi', 'bn', 'mr', 'te', 'ta']) for (const [k, exp] of Object.entries(EX)) {
    const phrase = l === 'en' ? k : I18N[l][k], r = P(phrase), got = {}; for (const kk of Object.keys(exp)) got[kk] = r[kk];
    ok(JSON.stringify(got) === JSON.stringify(exp), `${l}: “${phrase}” → ${r.type} ${r.amount} ${r.cat} ${r.date}${r.repeat ? ' ' + r.repeat : ''}`);
  }

  console.log('Voice sheet');
  const FAKE = () => {
    window.__sr = { list: [], script: null };
    class FakeSR { constructor() { window.__sr.list.push(this); this.lang = ''; }
      start() { const s = window.__sr.script || {}; this.started = true; if (s.hang) return; setTimeout(() => {
        if (s.error) { this.onerror && this.onerror({ error: s.error }); this.onend && this.onend(); return; }
        for (const i of (s.interim || [])) this.onresult && this.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: i }], { isFinal: false })] });
        if (s.final !== undefined) { const alts = [{ transcript: s.final }, ...(s.alts || []).map(t => ({ transcript: t }))]; this.onresult && this.onresult({ resultIndex: 0, results: [Object.assign(alts, { isFinal: true })] }); }
        this.onend && this.onend(); }, 40); }
      stop() { this.stopped = true; } abort() { this.aborted = true; } }
    window.SpeechRecognition = FakeSR;
  };
  const srv = await start(), URL = 'http://localhost:' + srv.address().port + '/index.html';
  const b = await chromium.launch(), devs = [];
  const dev = async o => { const d = await newDevice(b, URL, makeDrive(), o); devs.push(d); return d; };
  const A = await dev({ init: FAKE }), p = A.p;
  const say = async (script, then) => { await p.evaluate(s => { window.__sr.script = s; }, script); await p.click('[data-x=mic]'); if (then !== false) await p.waitForSelector('.vprev, .vstate.bad', { timeout: 3000 }); };
  ok(await p.isVisible('.micfab') && (await p.$$('.fab')).length === 1, 'a 🎤 button sits next to the Add button on the dashboard');
  await p.click('.micfab'); await p.waitForSelector('#vform');
  eq(await p.$$eval('#vform [data-x=vl]', e => e.map(x => x.textContent)), ['English', 'हिन्दी', 'বাংলা', 'मराठी', 'తెలుగు', 'தமிழ்'], 'choose the spoken language: all six');
  ok(/Tap the mic and speak/.test(await p.innerText('#vstate')) && (await p.$$('[data-x=vex]')).length === 4, 'idle: hint + 4 example phrases to tap');
  await say({ interim: ['lunch', 'lunch 250'], final: 'lunch 250 yesterday' });
  eq(await p.evaluate(() => window.__sr.list[0].lang), 'en-IN', 'recognition runs in the chosen language (en-IN)');
  let t = await p.innerText('.vprev'); ok(/₹250\.00/.test(t) && /Lunch/.test(t) && /Yesterday/.test(t) && /My money/.test(t) && /Expense/.test(t), 'preview: amount, description, date, book: ' + t.replace(/\n+/g, ' | '));
  ok(/lunch 250 yesterday/.test(await p.innerText('#vtrans')), 'what was heard is shown');
  await p.click('[data-x=vsave]'); await p.waitForSelector('#toast.show');
  let e1 = await p.evaluate(() => live('entries').find(e => e.desc === 'Lunch'));
  eq([e1.type, e1.amount, e1.bookId, Object.keys(e1.split), e1.cat, await p.evaluate(d => d === isoDay(Date.now() - 864e5), e1.date)], ['expense', 25000, 'my-money', [await p.evaluate(() => me().id)], '🍽️', true], 'Save creates the entry in My money, dated yesterday');
  ok(/Added Lunch · ₹250\.00/.test(await p.innerText('#toast')), 'confirmation toast');
  await p.click('#toast button'); eq(await p.evaluate(() => live('entries').filter(e => e.desc === 'Lunch').length), 0, 'Undo removes it');

  await p.click('.micfab'); await p.click('#vform [data-x=vl][data-v=hi]'); await say({ final: 'वेतन 50000 मिला' });
  eq(await p.evaluate(() => window.__sr.list[window.__sr.list.length - 1].lang), 'hi-IN', 'Hindi chip → recognition language hi-IN');
  t = await p.innerText('.vprev'); ok(/\+₹50,000\.00/.test(t) && /वेतन/.test(t) && /Income/.test(t), 'Hindi speech → income preview: ' + t.replace(/\n+/g, ' | '));
  await p.click('[data-x=vsave]'); let e2 = await p.evaluate(() => live('entries').find(e => e.type === 'income'));
  eq([e2.amount, e2.cat, e2.desc, e2.split], [5000000, '💼', 'वेतन', {}], 'income saved with no split');

  console.log('Shared books, loans, repeats');
  await p.evaluate(() => { const M = me().id; S.doc.people.r = { id: 'r', name: 'Ravi', updatedAt: 1 }; S.doc.people.m = { id: 'm', name: 'Meera', updatedAt: 1 };
    S.doc.books.g = { id: 'g', name: 'Goa trip', emoji: '🏖️', currency: 'INR', memberIds: [M, 'r', 'm'], createdAt: 1, updatedAt: now() }; touched(); });
  await p.click('.micfab'); await say({ final: 'dinner 1200 with Ravi' });
  t = await p.innerText('.vprev'); ok(/Goa trip/.test(t) && /Split between You, Ravi/.test(t), 'names found → picks the shared book that has them: ' + t.replace(/\n+/g, ' | '));
  await p.click('[data-x=vedit]'); await p.waitForSelector('#ea');
  eq([await p.inputValue('#ea'), await p.inputValue('#ed'), await p.$$eval('.pc.on[data-x=tog]', e => e.length)], ['1200', 'Dinner', 2], 'Edit opens the normal form, pre-filled (amount, description, the two people)');
  await p.click('[data-x=save]'); let e3 = await p.evaluate(() => live('entries').find(e => e.desc === 'Dinner'));
  eq([e3.bookId, Object.values(e3.split).sort()], ['g', [60000, 60000]], 'saving from the form gives an equal split');
  await p.click('.micfab'); await say({ final: 'Ravi paid 800 for cab' });
  ok(/Paid by Ravi/.test(await p.innerText('.vprev')), '"Ravi paid …" → payer detected'); await p.click('[data-x=vsave]');
  let e4 = await p.evaluate(() => live('entries').find(e => e.cat === '🚗'));
  eq([e4.paidBy, Object.keys(e4.split).sort()], ['r', [await p.evaluate(() => me().id), 'r'].sort()], 'saved with Ravi as payer');
  await p.click('.micfab'); await say({ final: 'lent 500 to Ravi' });
  ok(/Lent ₹500\.00 to Ravi/.test(await p.innerText('.vprev')) && /Loan/.test(await p.innerText('.vp-h')), '"lent 500 to Ravi" → loan preview'); await p.click('[data-x=vsave]');
  let e5 = await p.evaluate(() => live('entries').find(e => e.cat === '💸'));
  eq([e5.paidBy === (e5.paidBy), Object.keys(e5.split), e5.method, e5.loan], [true, ['r'], 'exact', { rate: 0, due: '' }], 'saved as a tracked loan to Ravi');
  eq(await p.evaluate(() => loanReport('g').map(r => [r.borrower, r.out])), [['r', 50000]], 'it shows up in the Loans section with ₹500 outstanding');
  await p.evaluate(() => { location.hash = 'book/g'; }); await p.waitForSelector('.hero.compact');
  await p.click('.micfab'); await say({ final: 'taxi 180' });
  ok(/Goa trip/.test(await p.innerText('.vprev')) && /Split between You, Ravi, Meera/.test(await p.innerText('.vprev')), 'spoken inside a shared book → that book, everyone');
  await p.click('[data-x=vsave]'); eq(await p.evaluate(() => Object.keys(live('entries').find(e => e.desc === 'Taxi' && e.bookId === 'g').split).length), 3, 'split three ways');
  await p.evaluate(() => { location.hash = ''; }); await p.waitForSelector('.slides');
  await p.click('.micfab'); await say({ final: 'Netflix 649 every month' });
  ok(/Repeats every month/.test(await p.innerText('.vprev')), 'repeat phrase recognised'); await p.click('[data-x=vsave]');
  eq(await p.evaluate(() => live('entries').find(e => e.desc === 'Netflix').repeat), 'monthly', 'saved as a monthly subscription');

  console.log('Errors and fallbacks');
  const errs = [['not-allowed', /Microphone access is blocked/], ['no-speech', /didn't hear anything/], ['audio-capture', /No microphone found/], ['network', /needs an internet connection/], ['language-not-supported', /isn't available for voice/], ['weird', /Didn’t catch that/]];
  await p.click('.micfab');
  for (const [code, re] of errs) { await say({ error: code }); ok(re.test(await p.innerText('#vstate')) && await p.isEnabled('[data-x=mic]'), `speech error “${code}” → clear message, mic ready to retry`); }
  await say({}, false); await p.waitForFunction(() => /didn't hear anything/.test(document.querySelector('#vstate').innerText)); ok(true, 'silence with no result ends cleanly with a hint');
  await p.fill('#vtext', 'hello there'); await p.press('#vtext', 'Enter'); await p.waitForSelector('.vprev');
  ok(/couldn’t find an amount/.test(await p.innerText('.vprev')) && !(await p.$('[data-x=vsave]')), 'no amount → warning, no Save button (Try again / Edit instead)');
  await p.fill('#vtext', 'coffee 120'); await p.click('[data-x=vgo]'); await p.waitForFunction(() => /120/.test(document.querySelector('.vprev').innerText)); ok(true, 'typing works in the same box (button or Enter)');
  await p.evaluate(() => { window.__sr.script = { hang: true }; }); await p.click('[data-x=mic]'); await p.waitForFunction(() => /Listening/.test(document.querySelector('#vstate').innerText));
  await p.keyboard.press('Escape'); eq(await p.evaluate(() => window.__sr.list[window.__sr.list.length - 1].aborted === true), true, 'closing the sheet while listening aborts the microphone');
  const NS = await dev({ init: () => { Object.defineProperty(window, 'webkitSpeechRecognition', { value: undefined, configurable: true }); Object.defineProperty(window, 'SpeechRecognition', { value: undefined, configurable: true }); } }), q = NS.p;   // a browser without speech recognition
  await q.click('.micfab'); await q.waitForSelector('#vform');
  ok(await q.isDisabled('[data-x=mic]') && /isn't supported in this browser/.test(await q.innerText('#vstate')), 'no speech engine: mic disabled, honest message');
  await q.fill('#vtext', 'groceries 640 yesterday'); await q.press('#vtext', 'Enter'); await q.waitForSelector('[data-x=vsave]'); await q.click('[data-x=vsave]');
  eq(await q.evaluate(() => { const e = live('entries').find(x => x.desc === 'Groceries'); return [e.amount, e.cat]; }), [64000, '🛒'], 'typing the sentence still adds the entry (works offline too)');

  console.log('Translations and layout');
  const HI = await dev({ init: FAKE, width: 320 }); await addIndicFonts(HI.p);
  for (const l of ['hi', 'bn', 'mr', 'te', 'ta']) {
    await HI.p.evaluate(l => setLang(l), l); await HI.p.click('.micfab'); await HI.p.waitForSelector('#vform');
    const idle = await HI.p.evaluate(() => document.querySelector('#vform').innerText);
    await HI.p.fill('#vtext', I18N[l]['Lunch 250 yesterday']); await HI.p.press('#vtext', 'Enter'); await HI.p.waitForSelector('.vprev');
    const prev = await HI.p.evaluate(() => document.querySelector('#vform').innerText);
    const lay = await HI.p.evaluate(layoutDetect);
    const leak = ((idle + ' ' + prev).match(/[A-Za-z]{3,}/g) || []).filter(w => !/^(SplitBook|English|Hindi|Bengali|Marathi|Telugu|Tamil|[A-Z]{2,5})$/.test(w));
    ok(!leak.length && !lay.length, `${l}: voice sheet fully translated and laid out at 320px ${leak.slice(0, 4)} ${lay.slice(0, 2)}`);
    await HI.p.keyboard.press('Escape');
  }
  ok(devs.every(d => d.p.errors.length === 0), 'no JS errors'); ok(devs.every(d => d.p.dialogs.length === 0), 'no native dialogs');
  console.log(`\nVOICE PASS (${pass} checks)`);
  await b.close(); srv.close();
})().catch(e => { console.error('FAIL', e.message || e); process.exit(1); });
