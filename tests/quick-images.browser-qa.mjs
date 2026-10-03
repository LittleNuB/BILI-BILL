import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const root = process.cwd(), out = path.join(root, 'release-artifacts', `quick-images-${Date.now()}`);
await mkdir(out, { recursive: true });
async function waitForData(page, check) {
  const until=Date.now()+15000;
  while (Date.now()<until) { if (await page.evaluate(check)) return; await new Promise(resolve=>setTimeout(resolve,100)); }
  throw Error('Database condition timed out: '+check.toString());
}
const backend = await build({ stdin: { resolveDir: root, loader: 'ts', contents: `
import { db } from './src/background/storage/db';
import { KnowledgeRepository } from './src/background/storage/open-knowledge-repo';
import { handleKnowledgeNote } from './src/background/messages/knowledge-note-handlers';
import { createSource } from './src/shared/open-knowledge/sources';
import { videoPageId } from './src/shared/open-knowledge/format';
import { askLearningChat, learningChatProgress } from './src/background/learning-chat';
import { getCurrentVideoQaSessionsView } from './src/background/storage/current-video-qa-session-repo';
import { DEFAULT_CONFIG } from './src/shared/types/config';
const raw = chrome.runtime.sendMessage.bind(chrome.runtime);
chrome.storage.onChanged.removeListener = listener => { const index=storageChangeListeners.indexOf(listener); if(index>=0)storageChangeListeners.splice(index,1); };
window.qa = { repo: new KnowledgeRepository(db), db, videoPageId, calls: [], pauseCalls: 0 };
const source = async (_tab, anchor) => {
  const response = await raw({action:'GET_CURRENT_VIDEO_SUBTITLE_VIEW_SOURCES'}), view = response.data?.sources?.[0];
  if (!view) return { sources: [], quote: '' };
  const segments = view.lines.map(line => ({fromMs:Math.round(line.startSeconds*1000),toMs:Math.round(line.endSeconds*1000),text:line.text}));
  return { quote: '', sources: [await createSource({kind:'subtitles',video:{bvid:anchor.bvid,cid:anchor.cid,page:anchor.page,title:anchor.title},label:'B站字幕',language:'zh',version:'synthetic',capturedAt:0,text:segments.map(line=>line.text).join('\\n'),segments,derivedFrom:null,legacyAsset:null})] };
};
chrome.runtime.sendMessage = async message => {
  qa.calls.push(message); const p = message.params || {};
  if (message.action === 'KNOWLEDGE_NOTE') { const response = await handleKnowledgeNote(p, 1, source); qa.calls.push({reply:p.mode,response}); return response; }
  if (message.action === 'GET_CURRENT_VIDEO_QA_SESSIONS') return {success:true,data:await getCurrentVideoQaSessionsView(p.sessionId)};
  if (message.action === 'ASK_LEARNING_CHAT') { qa.chat=await askLearningChat({...p,tabId:1,resolveSource:async()=>({source:null,text:'',videoKey:'BV1ImageQA01:2202:1',stillCurrent:async()=>true})}); return {success:true,data:qa.chat}; }
  if (message.action === 'GET_LEARNING_CHAT_PROGRESS') return {success:true,data:learningChatProgress(p.requestId,1)};
  return raw(message);
};
HTMLMediaElement.prototype.pause = function(){qa.pauseCalls++;};
qa.ready = (async()=>{
  await chrome.storage.local.set({ userConfig: {...DEFAULT_CONFIG,ai:{baseURL:'https://example.invalid',apiKey:'synthetic',chatModel:'text'},assistant:{...DEFAULT_CONFIG.assistant,currentVideoAiAssistantEnabled:true}} });
  const canvas = document.createElement('canvas'); canvas.width=640;canvas.height=360;
  const ctx=canvas.getContext('2d');ctx.fillStyle='#f7f7f7';ctx.fillRect(0,0,640,360);ctx.fillStyle='#fa7298';ctx.fillRect(60,80,180,160);ctx.fillStyle='#00aeec';ctx.fillRect(270,130,280,60);ctx.fillStyle='#18191c';ctx.font='26px sans-serif';ctx.fillText('Synthetic learning frame',50,40);
  qa.upload=canvas.toDataURL('image/png');
  const video=document.querySelector('video');video.muted=true;video.srcObject=canvas.captureStream(10);
  qa.stage='playing';setInterval(()=>{ctx.fillRect(50,320,10,10);},100);await window.nativeVideoPlay.call(video);qa.stage='ready';
  const originalFetch=window.fetch.bind(window);window.fetch=(url, options)=>String(url).includes('example.invalid')?Promise.resolve(new Response(JSON.stringify({choices:[{message:{content:'画面观察：这是用于测试的色块。拓展知识：可以用不同色块表示模块。'}}]}))):originalFetch(url,options);
})();
` }, bundle: true, write: false, format: 'esm', platform: 'browser' });
const original = await readFile(path.join(root, 'tests/current-video-assistant-shell.mock.html'), 'utf8');
const html = original.replaceAll('BV1ShellMock9','BV1ImageQA01').replace('<html lang="zh-CN">','<html lang="zh-CN" data-theme="light">').replace('<script type="module" src="/dist/content/player-monitor.js"></script>', '<script type="module">import "/qa-backend.js"; await window.qa.ready; await import("/dist/content/player-monitor.js");</script>');
assert.notEqual(html, original);
const content = await readFile(path.join(root, 'dist/content/player-monitor.js'));
const { chromium } = await import(pathToFileURL(process.env.UX014_PLAYWRIGHT_MODULE).href);
const report = { syntheticOnly: true, browsers: [], limitations: ['Production content bundle and real IndexedDB/image decode; Bilibili, runtime message transport and model responses are synthetic.', 'Native toolbar activeTab permission and real Bilibili playback remain integration acceptance.'] };
try {
  for (const [name, executablePath] of [['Chrome', process.env.UX014_CHROME_EXECUTABLE], ['Edge', process.env.UX014_EDGE_EXECUTABLE]]) {
    const browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors=[];
    try {
      page.on('pageerror', error=>{errors.push(error.message);console.log('PAGE ERROR',error.message);});
      await page.addInitScript(()=>{window.nativeVideoPlay=HTMLMediaElement.prototype.play;});
      await page.route('**/*', route=>{
        const url=new URL(route.request().url());
        if(url.pathname.startsWith('/video/'))return route.fulfill({contentType:'text/html',body:html});
        if(url.pathname==='/qa-backend.js')return route.fulfill({contentType:'text/javascript',body:Buffer.from(backend.outputFiles[0].contents)});
        if(url.pathname==='/dist/content/player-monitor.js')return route.fulfill({contentType:'text/javascript',body:content});
        return route.abort();
      });
      await page.goto('https://www.bilibili.com/video/BV1ImageQA01', {waitUntil:'commit'});
      await page.getByRole('button',{name:'Bili-Bill · 记笔记',exact:true}).waitFor();
      await page.evaluate(()=>{document.documentElement.setAttribute('data-theme','light');window.__assistantMockSetPlaybackPosition(12.5);});
      await page.getByRole('button',{name:'Bili-Bill · 记笔记',exact:true}).click();
      const input=page.getByRole('textbox',{name:'笔记输入',exact:true});
      await input.fill('持续播放中记录的中文草稿');
      await waitForData(page,async()=> (await qa.db.okCaptures.toArray()).some(row=>row.text==='持续播放中记录的中文草稿'));
      await page.waitForFunction(()=>qa.calls.some(row=>row.reply==='edit'&&row.response.success));
      report.beforeReload = await page.evaluate(async()=>({url:location.href,drafts:await qa.db.okCaptures.toArray()}));
      assert.equal(await page.evaluate(()=>qa.pauseCalls),0);
      await page.reload();
      report.afterReload = await page.evaluate(async()=>({url:location.href,drafts:await qa.db.okCaptures.toArray()}));
      await page.getByRole('button',{name:'Bili-Bill · 记笔记',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('[aria-label="笔记输入"]')?.value==='持续播放中记录的中文草稿');
      await page.evaluate(()=>window.__assistantMockSetPlaybackPosition(99));
      await page.getByRole('button',{name:'保存',exact:true}).click();
      await waitForData(page,async()=> (await qa.repo.readPage(qa.videoPageId('BV1ImageQA01'))).heads.some(row=>row.body.includes('持续播放中记录的中文草稿')));
      assert.match(await page.evaluate(async()=> (await qa.repo.readPage(qa.videoPageId('BV1ImageQA01'))).heads[0].body),/0:12/);
      await page.getByRole('button',{name:'保存截图',exact:true}).click();
      await waitForData(page,async()=> (await qa.repo.readPage(qa.videoPageId('BV1ImageQA01'))).heads[0].attachmentIds.length===1);
      assert.equal(await page.locator('.bdc-note-images img').evaluate(el=>el.naturalWidth),640);
      await page.getByRole('textbox',{name:'笔记输入',exact:true}).fill('截图之后补充想法');
      await page.getByRole('button',{name:'保存',exact:true}).click();
      await waitForData(page,async()=> (await qa.repo.readPage(qa.videoPageId('BV1ImageQA01'))).heads[0].body.includes('截图之后补充想法'));
      assert.equal(await page.evaluate(async()=> (await qa.repo.readPage(qa.videoPageId('BV1ImageQA01'))).heads[0].body.match(/!\[/g).length),1);
      await page.getByRole('button',{name:'保存截图',exact:true}).click();
      await page.getByRole('button',{name:'AI 解读',exact:true}).click();
      await page.getByText('尚未启用支持图片的模型。本次未发送图片，请在设置中配置图片模型。',{exact:true}).first().waitFor();
      await page.evaluate(()=>chrome.storage.local.set({learningVisionModel:{enabled:true,model:'synthetic-vision'}}));
      await page.getByRole('textbox',{name:'聊天输入',exact:true}).fill('解释图片');
      await page.getByRole('button',{name:'发送',exact:true}).click();
      await page.getByText('画面观察：这是用于测试的色块。拓展知识：可以用不同色块表示模块。',{exact:true}).first().waitFor();
      await page.waitForFunction(()=>qa.chat?.ai.status==='generated' && document.querySelector('[aria-label="聊天输入"]')?.value==='');
      assert.equal(await page.getByText('回答失败，问题已保留。请确认当前视频和 AI 设置后重试。',{exact:true}).count(),0);
      for(const [width,height] of [[1440,1000],[390,760]]){
        await page.setViewportSize({width,height});
        await page.waitForFunction(()=>{const r=document.querySelector('#bdc-current-video-assistant').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1;});
        assert.equal(await page.locator('#bdc-current-video-assistant').evaluate(el=>el.scrollWidth>el.clientWidth),false);
        await page.screenshot({path:path.join(out, name+'-'+width+'.png')});
      }
      assert.deepEqual(errors,[]);
      report.browsers.push({name,version:browser.version(),status:'pass',checks:['click-time note without pause','draft survives reload','native video frame decode/save','image text edit without duplicate picture','vision disabled sends no image','explicit image chat','1440/390 layout']});
    }catch(error){
      report.diagnostics={errors,state:await page.evaluate(async()=>({stage:window.qa?.stage,calls:window.qa?.calls.filter(row=>row.reply||row.action==='KNOWLEDGE_NOTE').slice(-20),drafts:await window.qa?.db.okCaptures.toArray(),videoReady:document.querySelector('video')?.readyState,buttons:[...document.querySelectorAll('button')].map(el=>el.getAttribute('aria-label')||el.textContent)})).catch(()=>null)};
      await page.screenshot({path:path.join(out,name+'-failure.png')}).catch(()=>{});throw error;
    }finally{await browser.close();}
  }
  report.status='pass';
}catch(error){report.status='fail';report.error=String(error);throw error;}
finally{await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(path.join(out,'report.json'));}
