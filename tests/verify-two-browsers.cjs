const {chromium,request}=require('playwright');
const assert=require('node:assert/strict');
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
 await page.route('**/api/sync**',route=>{
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
  const contextA=await browser.newContext();
  const contextB=await browser.newContext();
  const a=await contextA.newPage(),b=await contextB.newPage();
  await redirect(a);await redirect(b);
  a.on('pageerror',e=>console.log('PAGE-A-ERROR:',e.message));
  b.on('pageerror',e=>console.log('PAGE-B-ERROR:',e.message));
  await a.goto(site,{waitUntil:'domcontentloaded',timeout:90000});
  await expectCloud(a,'첫 업로드 필요');
  await a.getByRole('button',{name:'↑ 이 PC 내용 올리기'}).click();
  await expectCloud(a,'저장 완료');
  await b.goto(site,{waitUntil:'domcontentloaded',timeout:90000});
  await expectCloud(b,'연결됨');
  const initialA=await a.evaluate(()=>JSON.parse(localStorage.getItem('billy-counseling-scripts-v1')).items.length);
  const initialB=await b.evaluate(()=>JSON.parse(localStorage.getItem('billy-counseling-scripts-v1')).items.length);
  assert.equal(initialA,initialB,'initial data mismatch on second browser');
  console.log('PASS initial cloud upload A -> B; items',initialA);
  await addText(a,marker+' - A');
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
 }finally{
  if(apiContext){
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
