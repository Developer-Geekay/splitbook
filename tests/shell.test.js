// App shell: dashboard slider (Overall · My money), no duplicate add buttons, PWA install prompt, and a layout sweep for overlaps.
const { chromium } = require('playwright');
const assert = require('assert');
const { start } = require('./serve');
const { makeDrive, newDevice } = require('./harness');
let pass = 0; const ok = (c, m) => { assert(c, m); pass++; console.log('  ✓', m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} → ${JSON.stringify(a)}${JSON.stringify(a) === JSON.stringify(b) ? '' : ' (expected ' + JSON.stringify(b) + ')'}`);

(async () => {
  const srv = await start(), URL = 'http://localhost:' + srv.address().port + '/index.html';
  const b = await chromium.launch(), devs = [];
  const dev = async (o = {}) => { const d = await newDevice(b, URL, makeDrive(), o); devs.push(d); return d; };

  console.log('Dashboard slider');
  const A = await dev(), p = A.p;
  eq(await p.$$eval('.sl-tabs button', e => e.map(x => x.textContent)), ['Overall', 'My money'], 'two tabs: Overall · My money');
  eq((await p.$$('.slide')).length, 2, 'two slides');
  ok((await p.$$('[data-act=add-income],[data-act=add-expense]')).length === 0 && (await p.$$('.hero.alt .btn')).length === 0, 'no "+ Income / − Expense" buttons on the dashboard any more');
  eq((await p.$$('.fab')).length, 1, 'one floating Add button is the single way to add');
  eq(await p.evaluate(() => $('#slides').scrollLeft), 0, 'brand-new user lands on slide 1 (welcome / overall)');
  ok(await p.isVisible('#wn'), 'welcome card with the name field is on slide 1');
  await p.click('.sl-tabs button:nth-child(2)'); await p.waitForFunction(() => $('#slides').scrollLeft > 100);
  await p.waitForFunction(() => document.querySelectorAll('.sl-tabs button')[1].classList.contains('on') && Math.abs($('#slides').scrollLeft - slideStep($('#slides'))) < 3); ok(true, 'tapping "My money" slides over and highlights the tab');
  eq(await p.evaluate(() => localStorage.getItem('sb.slide')), '1', 'last slide is remembered');
  await p.reload(); await p.waitForSelector('.slides');
  ok(await p.evaluate(() => $('#slides').scrollLeft > 100 && document.querySelectorAll('.sl-tabs button')[1].classList.contains('on')), 'after reload it opens on My money again');
  await p.click('.sl-tabs button:nth-child(1)'); await p.waitForFunction(() => $('#slides').scrollLeft < 5);
  await p.evaluate(() => { const el = $('#slides'); el.scrollTo({ left: slideStep(el), behavior: 'instant' }); });
  await p.waitForFunction(() => document.querySelectorAll('.sl-tabs button')[1].classList.contains('on')); ok(true, 'swiping updates the tab highlight');
  const kept = await p.evaluate(() => { const l = $('#slides').scrollLeft; render(); return [l, $('#slides').scrollLeft]; });
  ok(kept[0] > 100 && Math.abs(kept[0] - kept[1]) < 3, 'a re-render (e.g. after sync) does not throw you back to the first slide');
  const my = await p.innerText('.hero.alt'); ok(/My money/.test(my) && /left this month/.test(my) && /Income/.test(my) && /Spent/.test(my) && /Net worth/.test(my), 'My money slide: month balance, income, spent, link to net worth');
  await p.click('.hero.alt [data-act=open-insights]'); await p.waitForSelector('.top h1:has-text("Net worth")'); ok((await p.evaluate(() => location.hash)) === '#insights' && /Nothing to analyse yet/.test(await p.innerText('#app')), 'slide link opens the Net worth & insights page (friendly empty state before any data)');
  await p.click('[data-act=back]'); await p.waitForSelector('.slides');
  await p.click('.top [data-act=open-insights]'); await p.waitForSelector('.top h1:has-text("Net worth")'); ok(true, '📊 button in the header opens it too');
  await p.click('[data-act=back]'); await p.waitForSelector('.slides');
  await p.click('.fab'); await p.fill('#ea', '250'); await p.fill('#ed', 'Coffee'); await p.click('[data-x=save]');
  await p.reload(); await p.waitForSelector('.slides');
  ok(await p.evaluate(() => /Shared balances/.test($('.slide:first-child').innerText)), 'no shared books yet: slide 1 invites you to create one (does not feel empty)');
  await p.evaluate(() => { const M = me().id; S.doc.books.sb = { id: 'sb', name: 'Flat', emoji: '🏠', currency: 'INR', memberIds: [M], createdAt: 1, updatedAt: now() }; touched(); });
  ok(await p.evaluate(() => /Overall balance/.test($('.slide:first-child').innerText)), 'with a shared book, slide 1 is the Overall balance');
  const d2 = await dev(), q = d2.p;
  await q.evaluate(() => { localStorage.removeItem('sb.slide'); }); await q.fill('#wn', 'Priya');
  await q.click('.fab'); await q.fill('#ea', '40'); await q.click('[data-x=save]'); await q.reload(); await q.waitForSelector('.slides');
  ok(await q.evaluate(() => $('#slides').scrollLeft > 100), 'a user with only My money entries opens on the My money slide');

  console.log('Install prompt');
  const fire = pg => pg.evaluate(() => { window.__installCalls = 0; const ev = new Event('beforeinstallprompt', { cancelable: true }); ev.prompt = async () => { window.__installCalls++; }; ev.userChoice = Promise.resolve({ outcome: 'accepted' }); window.dispatchEvent(ev); });
  const I = await dev(); await fire(I.p);
  await I.p.waitForSelector('.layer.install', { timeout: 6000 }); ok(true, 'first visit: the install sheet appears by itself');
  const t = await I.p.innerText('.layer.install'); ok(/Install SplitBook/.test(t) && /offline/i.test(t) && /Not now/.test(t), 'explains the benefits, with Install / Not now');
  await I.p.click('.layer.install [data-x=later]'); ok(!(await I.p.$('.layer.install')), '"Not now" dismisses it');
  eq(await I.p.evaluate(() => !!S.meta.installAsked), true, 'we remember we asked');
  await I.p.reload(); await fire(I.p); await I.p.waitForTimeout(3300); ok(!(await I.p.$('.layer.install')), 'not shown again on the next visit (asked once)');
  await I.p.click('.top .iconbtn[data-act=settings]'); ok(/Install SplitBook/.test(await I.p.innerText('.sheet')) && !!(await I.p.$('[data-x=install]')), 'Settings still offers "Install app" while it is not installed');
  await I.p.click('[data-x=install]'); await I.p.waitForSelector('.layer.install'); await I.p.click('.layer.install [data-x=go]');
  await I.p.waitForFunction(() => window.__installCalls === 1); ok(true, 'Install triggers the browser\'s install prompt');
  await I.p.waitForFunction(() => S.meta.installed === true); await I.p.click('.top .iconbtn[data-act=settings]');
  ok(!(await I.p.$('[data-x=install]')), 'once installed the Settings row disappears');
  const J = await dev({ standalone: true }); await fire(J.p); await J.p.waitForTimeout(3300);
  ok(!(await J.p.$('.layer.install')), 'already running as an installed app: no popup'); await J.p.click('.top .iconbtn[data-act=settings]');
  ok(!(await J.p.$('[data-x=install]')), 'and no "Install app" row in Settings');
  const K = await dev({ ctx: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', hasTouch: true, isMobile: true } });
  await K.p.waitForSelector('.layer.install', { timeout: 8000 }); const ik = await K.p.innerText('.layer.install');
  ok(/Share/.test(ik) && /Add to Home Screen/.test(ik) && !(await K.p.$('.layer.install [data-x=go]')), 'iPhone Safari: shows the Share → Add to Home Screen steps (no fake Install button)');
  await K.p.click('.layer.install [data-x=later]');
  const G = await dev(); await fire(G.p); await G.p.waitForSelector('.layer.install'); await G.p.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
  await G.p.waitForFunction(() => !document.querySelector('.layer.install')); ok(true, 'the "appinstalled" event closes the sheet');
  eq(await G.p.evaluate(() => S.meta.installed), true, 'and is remembered');

  console.log('Layout sweep (no overlaps, no sideways scrolling) at 320 / 360 / 390 / 430 px');
  const detect = () => {
    const root = document.querySelector('.layer .sheet, .layer .dlg, .overlay .sheet'); if (!root) return ['no sheet'];
    const out = [], sr = root.getBoundingClientRect(), scroller = e => { for (let n = e.parentElement; n && n !== root; n = n.parentElement) { const o = getComputedStyle(n).overflowX; if (o === 'auto' || o === 'scroll') return true; } return false; };
    const els = [...root.querySelectorAll('input:not([type=checkbox]):not([type=file]),button,select,textarea,label.rc,.cur-row,.pc,.who label')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' });
    const nm = e => (e.id || e.dataset.x || e.className || e.tagName).toString().slice(0, 24);
    for (const e of els) { if (scroller(e)) continue; const r = e.getBoundingClientRect(); if (r.right > sr.right + 1 || r.left < sr.left - 1) out.push('OVERFLOW ' + nm(e) + ' ' + Math.round(r.left) + '..' + Math.round(r.right)); }
    for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) { const a = els[i], c = els[j]; if (a.contains(c) || c.contains(a) || a.classList.contains('rc-x') || c.classList.contains('rc-x')) continue; /* the × badge sits on its tile by design */ const x = a.getBoundingClientRect(), y = c.getBoundingClientRect();
      if (Math.min(x.right, y.right) - Math.max(x.left, y.left) > 2 && Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top) > 2) out.push('OVERLAP ' + nm(a) + ' × ' + nm(c)); }
    if (document.documentElement.scrollWidth > innerWidth + 1) out.push('PAGE scrolls sideways');
    const a = document.querySelector('#ea'); if (a && a.scrollWidth > a.clientWidth + 1) out.push('AMOUNT clipped');
    return out;
  };
  for (const w of [320, 360, 390, 430]) {
    const D = await dev({ width: w, locale: 'en-IN' }), pg = D.p, bad = {}; const chk = async n => { const r = await pg.evaluate(detect); if (r.length) bad[n] = r; };
    await pg.evaluate(() => { loadSampleData(); const R = 'smp-p-ravi'; S.doc.people[R].name = 'Bartholomew Montgomery-Smythe'; S.doc.people['smp-p-meera'].name = 'Alexandria Vandersloot'; touched(); });
    await pg.click('.fab'); await pg.waitForSelector('.sheet'); await pg.fill('#ea', '9876543.21'); await pg.fill('#ed', 'A very long description of what this expense was actually for'); await chk('personal expense');
    await pg.click('[data-x=type][data-v=income]'); await chk('personal income'); await pg.click('[data-x=rep][data-v=monthly]'); await chk('income + repeat');
    await pg.setInputFiles('#rfile', { name: 'a.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF') }); await pg.waitForSelector('.rc-th'); await chk('with receipt'); await pg.click('[data-x=close]');
    await pg.evaluate(() => { location.hash = 'book/smp-b-goa'; }); await pg.waitForSelector('.hero.compact'); await pg.click('.fab'); await pg.fill('#ea', '9876543.21'); await chk('shared equal');
    await pg.click('[data-x=custom]'); for (const m of ['exact', 'percent', 'shares']) { await pg.click(`[data-x=method][data-v=${m}]`); await chk('custom ' + m); } await pg.click('[data-x=custom]');
    await pg.click('[data-x=cat][data-v="💸"]'); await chk('loan'); await pg.click('[data-x=type][data-v=settle]'); await chk('payment'); await pg.click('[data-x=close]');
    await pg.click('[data-act=tab][data-tab=members]'); await pg.click('[data-act=edit-book]'); await chk('edit book'); await pg.click('[data-x=cur]'); await chk('currency picker'); await pg.keyboard.press('Escape'); await pg.click('[data-x=close]');
    await pg.click('[data-act=del-book]'); await chk('confirm dialog'); await pg.click('.dlg [data-x=no]');
    await pg.click('.top .iconbtn[data-act=settings]'); await chk('settings'); await pg.keyboard.press('Escape');
    await pg.evaluate(() => installSheet(true)); await chk('install sheet'); await pg.keyboard.press('Escape');
    eq(bad, {}, `${w}px: every form, picker and dialog is clean`);
  }
  ok(devs.every(d => d.p.errors.length === 0), 'no JS errors anywhere');
  ok(devs.every(d => d.p.dialogs.length === 0), 'no native dialogs');
  console.log(`\nSHELL PASS (${pass} checks)`);
  await b.close(); srv.close();
})().catch(e => { console.error('FAIL', e.message || e); process.exit(1); });
