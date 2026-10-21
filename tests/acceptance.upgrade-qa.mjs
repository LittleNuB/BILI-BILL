import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root=await fs.realpath(process.cwd());
const old=await fs.realpath(process.argv[2]);
const next=await fs.realpath(process.argv[3]);
assert.ok(old.startsWith(root+path.sep)&&next.startsWith(root+path.sep));
const plan=JSON.parse(await fs.readFile(path.join(next,'../plan.json'),'utf8'));assert.ok(plan.reuseFrom);
const out=path.join(root,`release-artifacts/acceptance-upgrade-${Date.now()}`);await fs.mkdir(out);
const {chromium}=await import(pathToFileURL(process.env.UX014_PLAYWRIGHT_MODULE).href);
const results=[];
for(const [name,exe]of [['Chrome',process.env.UX014_CHROME_EXECUTABLE],['Edge',process.env.UX014_EDGE_EXECUTABLE]]){
 const profile=await fs.mkdtemp(path.join(out,name+'-isolated-'));
 const context=await chromium.launchPersistentContext(profile,{executablePath:exe,headless:true,viewport:{width:1280,height:900},ignoreDefaultArgs:['--disable-extensions'],args:['--enable-unsafe-extension-debugging','--proxy-server=http://127.0.0.1:9']});
 try{
  await context.route(/^https?:\/\//,r=>r.abort());context.setDefaultTimeout(10000);
  const cdp=await context.browser().newBrowserCDPSession();
  const {id}=await cdp.send('Extensions.loadUnpacked',{path:old});
  const page=await context.newPage();await page.goto(`chrome-extension://${id}/acceptance/index.html`);
  await page.getByText('已读取记录。尚未授权本次会话。',{exact:true}).waitFor();
  const worker=context.serviceWorkers().find(w=>w.url().includes(id));
  const seeded=await worker.evaluate(async()=>{
   const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))).map(n=>n.toString(16).padStart(2,'0')).join('');
   const book=(await chrome.storage.local.get('developerAcceptanceV1')).developerAcceptanceV1,r=book.reports[0];
   for(const target of r.plan.targets){const body={version:1,target:{id:target.id,bvid:target.bvid,page:target.page},cid:111,title:'合成升级测试，无真实材料',capturedAt:'2026-10-06T00:00:00Z',build:{sourceCommit:'synthetic',buildHash:'synthetic'},source:'bilibili_subtitle',sourceType:'bilibili_player_v2',language:'zh-CN',evidence:'mock',lines:[{lineNo:1,startSeconds:0,endSeconds:1,text:'仅用于隔离升级测试'}]};r.materials[target.id]={...body,hash:await digest(JSON.stringify(body))};}
   const step=r.plan.steps.find(s=>s.feature==='chat');r.rows.push({id:step.id,target:step.target,feature:'chat',state:'complete',attempted:true,tokenReservation:100000,startedAt:'2026-10-06T00:00:00Z',model:'synthetic',materialHash:r.materials[step.target].hash,build:{sourceCommit:'synthetic',buildHash:'synthetic'},parameters:{},messages:[],inputHash:'synthetic',text:'合成升级历史回答',observation:{model:'synthetic',finishReason:'stop',usage:{totalTokens:15,promptTokens:12,completionTokens:3}},checks:{format:true,failures:[]}});
   r.evidence.mock=true;await chrome.storage.local.set({developerAcceptanceV1:book});
   return {ledgerId:book.ledgerId,materials:r.materials,planHash:r.planHash};
  });
  await page.close();
  const changed=await cdp.send('Extensions.loadUnpacked',{path:next});assert.equal(changed.id,id);
  const upgraded=await context.newPage();await upgraded.goto(`chrome-extension://${id}/acceptance/index.html`);
  try { await upgraded.getByText('已读取记录。尚未授权本次会话。',{exact:true}).waitFor(); } catch(error) { console.log(await upgraded.locator('body').innerText()); for(const w of context.serviceWorkers()) console.log(JSON.stringify(await w.evaluate(async()=>({book:(await chrome.storage.local.get('developerAcceptanceV1')).developerAcceptanceV1})))); throw error; }
  const status=JSON.parse(await upgraded.locator('#results').innerText());
  assert.equal(status.planId,plan.id);assert.equal(status.budget.measured,58508);assert.equal(status.budget.newCalls,0);
  assert.equal(status.materials.length,2);for(const m of status.materials)assert.equal(m.hash,seeded.materials[m.target.id].hash);
  assert.equal(status.evidence.mock,true);assert.equal(await upgraded.locator('#approve').isEnabled(),false);
  await upgraded.screenshot({path:path.join(out,name+'-wide.png'),fullPage:true});
  await upgraded.setViewportSize({width:420,height:860});assert.equal(await upgraded.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  await upgraded.screenshot({path:path.join(out,name+'-narrow.png'),fullPage:true});
  await upgraded.reload();await upgraded.getByText('已读取记录。尚未授权本次会话。',{exact:true}).waitFor();assert.equal(JSON.parse(await upgraded.locator('#results').innerText()).budget.measured,58508);
  results.push({name,status:'pass',sameExtensionId:id,storedMaterialHashesPreserved:true,priorChargesPreserved:true,actualRequests:0,kind:'isolated_mock_history_real_package_upgrade'});
 }finally{await context.close();}
}
await fs.writeFile(path.join(out,'report.json'),JSON.stringify({output:out,results},null,2));console.log(JSON.stringify({output:out,results}));
