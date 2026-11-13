const {chromium,request}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
let failNextWrite=false,ownedVerification=false;const pageErrors=[];
const site='https://billy-rp-quickdesk.onrender.com/';
const api='https://billy-rp-sync-api-j26u.onrender.com/api/verification-sync';
const marker='검증 전용 '+process.env.GITHUB_RUN_ID;
let browser,apiContext,revision;
const sleep=(n)=>new Promise(r=>setTimeout(r,n));
async function expectCloud(page,what){
 await page.waitForFunction((text)=>(document.querySelector('[role="status"]')?.textContent||'').includes(text),what,{timeout:60000}).catch(async()=>{
  const statuses=await page.locator('[role="status"]').allTextContents();throw Error('No cloud status '+what+': '+statuses.join(' / '));
 });
}
async function redirect(page){
 if(process.env.TEST_LOCAL_HTML==='1')await page.route(site,r=>r.fulfill({contentType:'text/html',body:fs.readFileSync('index.html','utf8')}));
 await page.route('**/api/sync**',route=>{
  if(failNextWrite&&route.request().method()==='PUT'){failNextWrite=false;return route.abort('failed')}
  const u=route.request().url().replace('/api/sync','/api/verification-sync');
  return route.continue({url:u});
 });
}
async function addText(page,title){
 await page.locator('#addBtn').click();
 await page.locator('#fTitle').fill(title);
 await page.locator('#fBody').fill('브라우저 분리 자동 동기화 검증 데이터 - 실제 상담 문구와 무관');
 await page.getByRole('button',{name:'저장하기'}).click();
}
(async()=>{
 try{
  apiContext=await request.newContext({timeout:75000});
  for(let n=0;n<5;n++){
   try{const h=await apiContext.get(api);assert.equal(h.status(),200);break}catch(e){if(n===4)throw e;await sleep(10000)}
  }
  const existing=await(await apiContext.get(api)).json();
  if(existing.state)throw Error('Verification namespace not empty; refusing to overwrite test content');
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  const contextA=await browser.newContext({viewport:{width:1440,height:1000}});
  const contextB=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const a=await contextA.newPage(),b=await contextB.newPage();
  await redirect(a);await redirect(b);
  a.on('pageerror',e=>pageErrors.push(e.message));
  b.on('pageerror',e=>pageErrors.push(e.message));
  await a.goto(site,{waitUntil:'domcontentloaded',timeout:90000});
  await expectCloud(a,'첫 업로드 필요');
  ownedVerification=true;
  await a.getByRole('button',{name:'지금 저장',exact:true}).click();
  await expectCloud(a,'저장 완료');
  await b.goto(site,{waitUntil:'domcontentloaded',timeout:90000});
  await expectCloud(b,'저장 완료');
  fs.mkdirSync('test-results',{recursive:true});
  for(const [p,name] of [[a,'desktop'],[b,'mobile']]){
   assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'page overflow '+name);
   assert.ok(await p.locator('#backupBtn').isVisible());
   await p.screenshot({path:'test-results/'+name+'.png',fullPage:true});
  }
  const initialA=await a.evaluate(()=>JSON.parse(localStorage.getItem('billy-counseling-scripts-v1')).items.length);
  const initialB=await b.evaluate(()=>JSON.parse(localStorage.getItem('billy-counseling-scripts-v1')).items.length);
  assert.equal(initialA,initialB,'initial data mismatch on second browser');
  console.log('PASS initial cloud upload A -> B; items',initialA);
  failNextWrite=true;
  await addText(a,marker+' - A');
  await expectCloud(a,'재시도 대기');
  await expectCloud(a,'저장 완료');
  await b.waitForFunction((m)=>(JSON.parse(localStorage.getItem('billy-counseling-scripts-v1')||'{}').items||[]).some(i=>i.title===m),marker+' - A',{timeout:60000});
  console.log('PASS browser A edit -> cloud autosave -> browser B refresh');
  await addText(b,marker+' - B');
  await expectCloud(b,'저장 완료');
  await a.waitForFunction((m)=>(JSON.parse(localStorage.getItem('billy-counseling-scripts-v1')||'{}').items||[]).some(i=>i.title===m),marker+' - B',{timeout:60000});
  console.log('PASS browser B edit -> cloud autosave -> browser A refresh');
  const state=await(await apiContext.get(api)).json();
  revision=state.revision;
  assert.ok(state.state.items.some(i=>i.title===marker+' - A'));
  assert.ok(state.state.items.some(i=>i.title===marker+' - B'));
  console.log('PASS both edits persisted in cloud; production counseling DB untouched');
  await b.locator('#search').fill(marker+' - A');
  assert.equal(await b.locator('.itemrow').count(),1);
  await b.locator('#clearSearch').click();
  await b.locator('#viewGrid').click();assert.ok(await b.locator('.card').count()>0);
  await b.locator('#viewSplit').click();
  await b.locator('#settingsBtn').click();
  assert.ok(await b.evaluate(()=>document.querySelector('.modal').scrollWidth<=innerWidth));
  await b.screenshot({path:'test-results/mobile-settings.png',fullPage:true});
  await b.locator('#closeModal').click();
  assert.equal(pageErrors.length,0,pageErrors.join(' / '));
  console.log('PASS mobile search, view switching, categories, visible backup; no JS errors');
 }finally{
  if(apiContext&&ownedVerification){
   const state=await(await apiContext.get(api)).json().catch(()=>({}));
   if(state.revision){
    const cleanup=await apiContext.delete(api,{data:{revision:state.revision}});
    console.log('Verification data cleanup:',cleanup.status());
    if(cleanup.status()!==200)process.exitCode=1;
   }
  }
  if(browser)await browser.close();
  if(apiContext)await apiContext.dispose();
 }
})().catch(e=>{console.error(e);process.exitCode=1});
