// Local notifications: bills, loans/dues, payments from other people, settings, permissions.
const { chromium } = require('playwright');
const assert = require('assert');
const { start } = require('./serve');
const { makeDrive, newDevice, signIn } = require('./harness');
let pass = 0; const ok = (c, m) => { assert(c, m); pass++; console.log('  ✓', m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} → ${JSON.stringify(a)}${JSON.stringify(a) === JSON.stringify(b) ? '' : ' (expected ' + JSON.stringify(b) + ')'}`);

const stub = perm => `(() => { window.__notes = []; let perm = ${JSON.stringify(perm)};
  window.Notification = class { constructor(t, o) { window.__notes.push({ title: t, body: o && o.body, tag: o && o.tag }); } static get permission() { return perm; } static async requestPermission() { perm = window.__grant === false ? 'denied' : 'granted'; return perm; } }; })()`;
const notes = p => p.evaluate(() => window.__notes.map(n => n.title));

(async () => {
  const srv = await start(), URL = 'http://localhost:' + srv.address().port + '/index.html', b = await chromium.launch();
  const mk = async (perm, o = {}) => { const d = await newDevice(b, URL, makeDrive(), { init: stub(perm), ...o }); await d.p.waitForSelector('.slides'); return d; };

  console.log('Settings and permission');
  let { p } = await mk('default');
  await p.click('.top .iconbtn[data-act=settings]'); await p.waitForSelector('.sheet');
  ok(await p.isDisabled('[data-x=n-bills]'), 'the per-type switches are disabled until notifications are on');
  await p.click('[data-x=n-on]'); await p.waitForFunction(() => S.meta.notif && S.meta.notif.on);
  ok(await p.evaluate(() => document.querySelector('[data-x=n-on] .switch').classList.contains('on')), 'master switch turns on after permission is granted');
  ok((await notes(p)).some(t => /Notifications are on/.test(t)), 'a confirmation notification is shown');
  ok(await p.isEnabled('[data-x=n-bills]') && await p.isVisible('[data-x=n-test]'), 'type switches and test button appear');
  await p.click('[data-x=n-test]'); eq((await notes(p)).filter(t => /Notifications are on/.test(t)).length, 2, 'test button sends another notification');
  await p.click('[data-x=n-bills]'); eq(await p.evaluate(() => S.meta.notif.bills), false, 'bills can be switched off');
  await p.click('[data-x=n-on]'); eq(await p.evaluate(() => S.meta.notif.on), false, 'master switch turns it off');
  eq(p.errors, [], 'no page errors');

  console.log('Blocked / unsupported');
  ({ p } = await mk('denied'));
  await p.click('.top .iconbtn[data-act=settings]'); await p.click('[data-x=n-on]'); await p.waitForTimeout(150);
  ok(/blocked/i.test(await p.innerText('#toast')), 'a blocked browser explains how to allow notifications');
  eq(await p.evaluate(() => !!(S.meta.notif && S.meta.notif.on)), false, 'and stays off');
  ({ p } = await mk('default', { init: 'delete window.Notification;' }));
  await p.click('.top .iconbtn[data-act=settings]'); await p.click('[data-x=n-on]'); await p.waitForTimeout(150);
  ok(/support/i.test(await p.innerText('#toast')), 'an unsupported browser says so');

  console.log('Bills, loans, payments');
  ({ p } = await mk('granted'));
  await p.evaluate(() => {
    const M = me().id, D = o => isoDay(Date.now() + o * 864e5), pr = 'smp-p-r'; S.doc.people[pr] = { id: pr, name: 'Ravi', updatedAt: 1 };
    const add = (id, o) => put('entries', { id, bookId: 'my-money', type: 'expense', desc: 'x', amount: 100000, paidBy: M, split: {}, method: 'equal', date: D(0), cat: '🧾', note: '', createdAt: now(), ...o });
    add('rentTpl', { desc: 'Rent', amount: 1500000, repeat: 'weekly', date: D(-6) });       // next occurrence tomorrow
    add('farTpl', { desc: 'Gym', repeat: 'monthly', date: D(-1) });                          // a month away
    add('gone', { desc: 'Old income', type: 'income', repeat: 'weekly', date: D(-6) });      // income never alerts
    S.meta.notif = { on: true, bills: true, loans: true, activity: true }; persist();
    const bk = { id: 'bk1', name: 'Flat', currency: 'INR', emoji: '🏠', memberIds: [M, pr], createdAt: now(), updatedAt: now() }; put('books', bk);
    put('entries', { id: 'loan1', bookId: 'bk1', type: 'expense', desc: 'Loan', amount: 500000, paidBy: pr, split: { [M]: 500000 }, method: 'exact', date: D(-20), cat: '💸', note: '', loan: { rate: 0, due: D(-2) }, createdAt: now() });
    checkAlerts(true);
  });
  let n = await notes(p);
  ok(n.some(t => /Rent due tomorrow/.test(t)), 'a bill due tomorrow triggers an alert');
  ok(!n.some(t => /Gym|Old income/.test(t)), 'far-off bills and income do not');
  ok(n.some(t => /overdue/i.test(t)), 'an overdue loan triggers an alert');
  const c = n.length; await p.evaluate(() => { lastAlertCheck = 0; checkAlerts(true); }); eq((await notes(p)).length, c, 'the same alert is not repeated');
  await p.reload(); await p.waitForSelector('.slides'); await p.evaluate(() => checkAlerts(true)); eq((await notes(p)).length, 0, 'nor after a reload (remembered)');
  await p.evaluate(() => { S.meta.notif.bills = false; S.meta.notified = {}; checkAlerts(true); }); ok(!(await notes(p)).some(t => /Rent/.test(t)), 'switching Bills off silences bill alerts');
  await p.evaluate(() => { window.__notes.length = 0; S.meta.notif.on = false; S.meta.notified = {}; checkAlerts(true); }); eq(await notes(p), [], 'master off silences everything');

  console.log('Payments from other people (arrive via sync)');
  await p.evaluate(() => { S.meta.notif = { on: true, bills: false, loans: false, activity: true }; S.meta.lastSync = 1; persist(); });
  const before = await p.evaluate(async () => { const bf = new Set(Object.keys(S.doc.entries)), M = me().id, pr = 'smp-p-r', T = now();
    put('entries', { id: 'in1', bookId: 'bk1', type: 'expense', desc: 'Dinner', amount: 80000, paidBy: pr, split: { [M]: 40000, [pr]: 40000 }, method: 'equal', date: isoDay(T), cat: '🍽️', note: '', createdAt: T });
    put('entries', { id: 'in2', bookId: 'bk1', type: 'settle', desc: '', amount: 20000, paidBy: pr, split: { [M]: 20000 }, method: 'exact', date: isoDay(T), cat: '', note: '', createdAt: T + 1 });
    put('entries', { id: 'mine', bookId: 'bk1', type: 'expense', desc: 'Mine', amount: 1000, paidBy: M, split: { [M]: 500, [pr]: 500 }, method: 'equal', date: isoDay(T), cat: '🧾', note: '', createdAt: T + 2 });
    window.__notes.length = 0; activityAlerts(bf); await new Promise(r => setTimeout(r, 80)); return window.__notes.map(x => x.title + ' | ' + x.body); });
  ok(before.some(t => /Ravi added “Dinner”/.test(t) && /You owe/.test(t)), 'someone else’s expense that includes me is announced with my share');
  ok(before.some(t => /Ravi paid you/.test(t)), 'a payment to me is announced');
  ok(!before.some(t => /Mine/.test(t)), 'my own entries never alert');
  eq(await p.evaluate(async () => { activityAlerts(null); await new Promise(r => setTimeout(r, 80)); return window.__notes.length; }), before.length, 'first sync on a device stays silent');

  console.log('Other languages');
  await p.evaluate(() => { setLang('hi'); S.meta.notified = {}; S.meta.notif = { on: true, bills: true, loans: true, activity: true }; window.__notes.length = 0; checkAlerts(true); });
  await p.waitForTimeout(80); ok((await notes(p)).some(t => /[ऀ-ॿ]/.test(t)), 'alerts are written in the app language');
  eq(p.errors, [], 'no page errors');
  await b.close(); srv.close(); console.log(`\nPASS (${pass})`);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
