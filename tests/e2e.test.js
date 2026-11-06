const {chromium}=require('playwright');
const assert=require('assert');const {start}=require('./serve');const {skipSetup}=require('./harness');
(async()=>{
const srv=await start();const URL='http://localhost:'+srv.address().port+'/index.html';const b=await chromium.launch();
let driveFile=null; // fake Drive shared by both devices
async function device(){
  const ctx=await b.newContext({viewport:{width:390,height:800},serviceWorkers:'block'});
  await skipSetup(ctx);
  await ctx.addInitScript(()=>{window.google={accounts:{oauth2:{initTokenClient:c=>({requestAccessToken:()=>setTimeout(()=>c.callback({access_token:'tok',expires_in:3600}),10)}),revoke(){}}}};});
  await ctx.route('https://accounts.google.com/**',r=>r.fulfill({body:'',contentType:'text/javascript'}));
  await ctx.route('https://www.googleapis.com/**',async r=>{
    const u=r.request().url(),m=r.request().method();
    if(u.includes('userinfo'))return r.fulfill({json:{email:'a@b.c',given_name:'Asha'}});
    if(u.includes('/upload/')){const body=r.request().postData();
      driveFile=JSON.parse(m==='PATCH'?body:body.split('\r\n\r\n')[2].split('\r\n--')[0]);return r.fulfill({json:{id:'F1'}});}
    if(u.includes('alt=media'))return r.fulfill({json:driveFile});
    return r.fulfill({json:{files:driveFile?[{id:'F1'}]:[]}});
  });
  await ctx.route('**/config.js',r=>r.fulfill({body:'window.SPLITBOOK_CONFIG={GOOGLE_CLIENT_ID:"x.apps.googleusercontent.com"}',contentType:'text/javascript'}));const p=await ctx.newPage(); p.on('pageerror',e=>{console.error('PAGEERR',e);process.exitCode=1});
  await p.addInitScript(()=>{window.SPLITBOOK_CONFIG={GOOGLE_CLIENT_ID:'x.apps.googleusercontent.com'}});
  await p.goto(URL); return {ctx,p};
}
const A=await device(), p=A.p;
// create book with a friend
await p.click('.bk.new'); await p.fill('#bn','Goa trip'); await p.fill('#np','Ravi'); await p.click('[data-x=addp]'); await p.click('[data-x=save]');
// add expense 100.01 split equally, paid by me (offline)
await A.ctx.setOffline(true);
await p.click('.fab'); await p.fill('#ed','Dinner'); await p.fill('#ea','100.01'); await p.click('[data-x=save]');
await p.click('[data-tab=balances]');
const txt=await p.innerText('main'); console.log(txt.replace(/\n+/g,' | '));
assert(/Ravi/.test(txt)); assert(/50\.01|50\.00/.test(txt));
await A.ctx.setOffline(false);
// sign in -> sync up
await p.click('.iconbtn[data-act=settings]'); await p.click('[data-x=in]'); await p.waitForFunction(()=>document.querySelector('#status')?.textContent.includes('Synced'),null,{timeout:8000});
assert(driveFile && Object.keys(driveFile.entries).length===1,'uploaded');
// device B signs in -> receives data
const B=await device(); await B.p.click('.iconbtn[data-act=settings]'); await B.p.click('[data-x=in]');
await B.p.waitForFunction(()=>document.body.innerText.includes('Goa trip'),null,{timeout:8000});
console.log('B sees book; people on B:',await B.p.evaluate(()=>Object.values(S.doc.people).filter(x=>!x.deleted).map(x=>x.name)));
// B edits offline, then A edits offline; both reconnect
await B.p.click('.bk:has-text("Goa trip")'); await B.ctx.setOffline(true);
await B.p.click('.fab'); await B.p.fill('#ed','Taxi'); await B.p.fill('#ea','40'); await B.p.click('[data-x=save]');
await B.ctx.setOffline(false); await B.p.evaluate(()=>sync(true)); await B.p.waitForFunction(()=>document.querySelector('#status')?.textContent.includes('Synced'));
await p.evaluate(()=>sync(true)); await p.waitForFunction(()=>Object.values(S.doc.entries).length===2,null,{timeout:8000});
await p.click('[data-tab=entries]'); console.log((await p.innerText('main')).replace(/\n+/g,' | '));

// delete on A propagates
await p.evaluate(()=>{const id=Object.keys(S.doc.entries)[0];del('entries',id)}); await p.evaluate(()=>sync(true));
await B.p.evaluate(()=>sync(true)); const n=await B.p.evaluate(()=>live('entries').length); assert.equal(n,1);
// one-tap settle + undo
await p.click('[data-tab=balances]');
const before=await p.evaluate(()=>live('entries').length);
await p.click('[data-act=settle]');
assert.equal(await p.evaluate(()=>live('entries').length),before+1,'settle recorded');
await p.click('#toast button');
assert.equal(await p.evaluate(()=>live('entries').length),before,'settle undone');
// settings must not expose the Google client id
await p.click('.iconbtn[data-act=settings]');
assert(!(await p.content()).includes('id="cid"'),'no client id field');
console.log('E2E PASS'); await b.close();srv.close();
})().catch(e=>{console.error(e);process.exit(1)});
