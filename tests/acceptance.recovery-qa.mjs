import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root=await fs.realpath(process.cwd()), extension=await fs.realpath(process.argv[2]);
const old=process.argv[3] && await fs.realpath(process.argv[3]);
assert.ok(extension.startsWith(root+path.sep)); if(old) assert.ok(old.startsWith(root+path.sep));
const out=path.join(root,`release-artifacts/acceptance-recovery-${Date.now()}`);await fs.mkdir(out);
const backup=JSON.parse(await fs.readFile(path.join(extension,'acceptance/recovery.json'),'utf8'));
const plan=JSON.parse(await fs.readFile(path.join(extension,'../plan.json'),'utf8'));
const expected=58493+backup.reports.flatMap(r=>r.rows).reduce((sum,row)=>sum+row.observation.usage.totalTokens,0);
const {chromium}=await import(pathToFileURL(process.env.UX014_PLAYWRIGHT_MODULE).href);
const results=[];
try {
for(const [name,executablePath] of [['Chrome',process.env.UX014_CHROME_EXECUTABLE],['Edge',process.env.UX014_EDGE_EXECUTABLE]]) {
 for(const scenario of ['empty','prefix','complete','conflict']) {
  const profile=await fs.mkdtemp(path.join(out,`${name}-${scenario}-isolated-`));
  const installed=path.join(out,`${name}-${scenario}-extension`);await fs.cp(old||extension,installed,{recursive:true});
  const launch=()=>chromium.launchPersistentContext(profile,{executablePath,headless:true,viewport:{width:1280,height:960},ignoreDefaultArgs:['--disable-extensions'],args:['--enable-unsafe-extension-debugging','--proxy-server=http://127.0.0.1:9']});
  const open=async context=>{ context.setDefaultTimeout(10000);await context.route(/^https?:\/\//,r=>r.abort());const cdp=await context.browser().newBrowserCDPSession();const {id}=await cdp.send('Extensions.loadUnpacked',{path:installed});const page=await context.newPage();await page.goto(`chrome-extension://${id}/acceptance/index.html`);await page.waitForFunction(()=>document.querySelector('#build')?.textContent);return {id,page,worker:context.serviceWorkers().find(w=>w.url().includes(id))};};
  let context=await launch();let id;
  try {
   const before=await open(context);id=before.id;
   if(scenario!=='empty') {
    const seed=structuredClone(backup);if(scenario!=='complete') seed.reports=seed.reports.slice(0,1);
    if(scenario==='conflict')seed.reports[0].pause='LOCAL_DIFFERENCE';
    await before.worker.evaluate(async book=>chrome.storage.local.set({developerAcceptanceV1:book}),seed);
   }
  } finally {await context.close();}
  // Replace files only in the test-owned installation, retain the same profile and path.
  await fs.cp(extension,installed,{recursive:true});context=await launch();
  try {
   const current=await open(context),{page,worker}=current;assert.equal(current.id,id);
   const errors=[];page.on('pageerror',e=>errors.push(e.message));
   if(scenario==='conflict') {
    await page.waitForFunction(()=>document.querySelector('#results')?.textContent.includes('storedPlans'));
    assert.equal(await page.locator('#recovery').isVisible(),false);assert.equal(await page.locator('#approve').isEnabled(),false);
    const stored=await worker.evaluate(async()=>(await chrome.storage.local.get('developerAcceptanceV1')).developerAcceptanceV1);
    assert.equal(stored.reports[0].pause,'LOCAL_DIFFERENCE');
   } else {
    if(scenario!=='complete') {
     await page.locator('#recover').waitFor();
     const before=await worker.evaluate(async()=>(await chrome.storage.local.get('developerAcceptanceV1')).developerAcceptanceV1);
     await page.evaluate(()=>document.getElementById('recover').click());
     assert.deepEqual(await worker.evaluate(async()=>(await chrome.storage.local.get('developerAcceptanceV1')).developerAcceptanceV1),before);
     await page.getByRole('button',{name:'恢复已核对的验收记录',exact:true}).click();
    }
    await page.getByText('已读取记录。尚未授权本次会话。',{exact:true}).waitFor();
    const state=JSON.parse(await page.locator('#results').innerText());
    assert.equal(state.planId,plan.id);assert.equal(state.budget.measured,expected);assert.equal(state.budget.newCalls,0);assert.equal(state.budget.unknown,0);
    const stored=await worker.evaluate(async()=>(await chrome.storage.local.get('developerAcceptanceV1')).developerAcceptanceV1);
    assert.equal(stored.ledgerId,backup.ledgerId);assert.deepEqual(stored.reports.slice(0,backup.reports.length),backup.reports);
    for(const m of state.materials)assert.equal(m.hash,backup.reports.at(-1).materials[m.target.id].hash);
    assert.equal(await page.locator('#pairing').innerText(),'');
    await page.locator('#consent').check();await page.locator('#legacy').check();assert.equal(await page.locator('#approve').isEnabled(),true);
    await page.setViewportSize({width:420,height:860});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    await page.screenshot({path:path.join(out,`${name}-${scenario}.png`),fullPage:true});
    await page.reload();await page.getByText('已读取记录。尚未授权本次会话。',{exact:true}).waitFor();
    assert.equal(JSON.parse(await page.locator('#results').innerText()).budget.measured,expected);assert.equal(await page.locator('#pairing').innerText(),'');
   }
   assert.deepEqual(errors,[]);results.push({name,scenario,id,status:'pass',measured:scenario==='conflict'?null:expected,modelCalls:0});
  } finally {await context.close();}
 }
}
} finally {await fs.writeFile(path.join(out,'report.json'),JSON.stringify({networkBlocked:true,personalBrowserStateRead:false,modelCalls:0,results},null,2));}
console.log(JSON.stringify({out,results}));
