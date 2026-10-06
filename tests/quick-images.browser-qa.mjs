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
async function waitForChatSettled(page, question) {
  await page.waitForFunction(expected => {
    const latest = qa.calls.filter(row => row.action === 'ASK_LEARNING_CHAT').at(-1)?.params;
    return latest?.question === expected && qa.chat?.requestId === latest.requestId
      && !document.querySelector('[data-chat-live]')
      && [...document.querySelectorAll('.bdc-chat-question')].some(el => el.textContent.includes(expected));
  }, question);
}
const backend = await build({ stdin: { resolveDir: root, loader: 'ts', contents: `
import { db } from './src/background/storage/db';
import { KnowledgeRepository } from './src/background/storage/open-knowledge-repo';
import { handleKnowledgeNote } from './src/background/messages/knowledge-note-handlers';
import { createSource } from './src/shared/open-knowledge/sources';
import { videoPageId } from './src/shared/open-knowledge/format';
import { askLearningChat, learningChatProgress } from './src/background/learning-chat';
import { getCurrentVideoQaSessionsView, deleteCurrentVideoQaSession, renameCurrentVideoQaSession } from './src/background/storage/current-video-qa-session-repo';
import { DEFAULT_CONFIG } from './src/shared/types/config';
import { appendKnowledgeAnswer } from './src/content/player-monitor/knowledge-citations';
const raw = chrome.runtime.sendMessage.bind(chrome.runtime);
chrome.storage.onChanged.removeListener = listener => { const index=storageChangeListeners.indexOf(listener); if(index>=0)storageChangeListeners.splice(index,1); };
window.qa = { repo: new KnowledgeRepository(db), db, videoPageId, calls: [], pauseCalls: 0, sessionReads: 0, appendKnowledgeAnswer };
const source = async (_tab, anchor) => {
  const response = await raw({action:'GET_CURRENT_VIDEO_SUBTITLE_VIEW_SOURCES'}), view = response.data?.sources?.[0];
  if (!view) return { sources: [], quote: '' };
  const segments = view.lines.map(line => ({fromMs:Math.round(line.startSeconds*1000),toMs:Math.round(line.endSeconds*1000),text:line.text}));
  return { quote: '', sources: [await createSource({kind:'subtitles',video:{bvid:anchor.bvid,cid:anchor.cid,page:anchor.page,title:anchor.title},label:'B站字幕',language:'zh',version:'synthetic',capturedAt:0,text:segments.map(line=>line.text).join('\\n'),segments,derivedFrom:null,legacyAsset:null})] };
};
chrome.runtime.sendMessage = async message => {
  qa.calls.push(message); const p = message.params || {};
  if (message.action === 'KNOWLEDGE_NOTE') { const response = await handleKnowledgeNote(p, 1, source); qa.calls.push({reply:p.mode,response});
    if (p.mode === 'preview-images' && qa.corruptImage) return {success:true,data:['data:image/png;base64,bm90LWFuLWltYWdl']};
    return response; }
  if (message.action === 'GET_CURRENT_VIDEO_QA_SESSIONS') { if (qa.failHistoryOnce) { qa.failHistoryOnce=false; throw Error('synthetic read failure'); }
    const data=await getCurrentVideoQaSessionsView(p.sessionId);
    await new Promise(resolve => setTimeout(resolve, 30)); qa.sessionReads++;
    return {success:true,data}; }
  if (message.action === 'DELETE_CURRENT_VIDEO_QA_SESSION') return {success:true,data:await deleteCurrentVideoQaSession(p.sessionId,p.deleteAssociatedMemory)};
  if (message.action === 'RENAME_CURRENT_VIDEO_QA_SESSION') { await renameCurrentVideoQaSession(p.sessionId,p.title); return {success:true,data:await getCurrentVideoQaSessionsView(p.sessionId)}; }
  if (message.action === 'ASK_LEARNING_CHAT') { qa.chat=await askLearningChat({...p,tabId:1,resolveSource:async()=>({source:null,text:'',videoKey:'BV1ImageQA01:2202:1',stillCurrent:async()=>true})}); return {success:true,data:qa.chat}; }
  if (message.action === 'GET_LEARNING_CHAT_PROGRESS') return {success:true,data:learningChatProgress(p.requestId,1)};
  if (message.action === 'CANCEL_LEARNING_CHAT') { learningChatProgress(p.requestId,1,true); return {success:true,data:{}}; }
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
  const originalFetch=window.fetch.bind(window);window.fetch=(url, options)=>{
    if(!String(url).includes('example.invalid'))return originalFetch(url,options);
    qa.lastPayload=JSON.parse(options.body);
    if(qa.slowModel)return new Promise((resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});});
    if(qa.failModel)return Promise.resolve(new Response('{}',{status:429}));
    return Promise.resolve(new Response(JSON.stringify({choices:[{message:{content:qa.markdownReply||'画面观察：这是用于测试的色块。拓展知识：可以用不同色块表示模块。'}}]})));
  };
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
      await page.getByRole('button',{name:'收起笔记，保留草稿',exact:true}).click();
      assert.equal(await page.getByRole('textbox',{name:'笔记输入',exact:true}).count(),0);
      await page.getByRole('button',{name:'Bili-Bill · 记笔记',exact:true}).click();
      assert.equal(await input.inputValue(),'持续播放中记录的中文草稿');
      await page.evaluate(()=>window.__assistantMockSetPlaybackPosition(99));
      await page.getByRole('button',{name:'保存',exact:true}).click();
      await waitForData(page,async()=> (await qa.repo.readPage(qa.videoPageId('BV1ImageQA01'))).heads.some(row=>row.body.includes('持续播放中记录的中文草稿')));
      assert.match(await page.evaluate(async()=> (await qa.repo.readPage(qa.videoPageId('BV1ImageQA01'))).heads[0].body),/0:12/);
      await page.locator('.bdc-assistant-header').getByRole('button',{name:'截图到笔记',exact:true}).click();
      await waitForData(page,async()=> (await qa.repo.readPage(qa.videoPageId('BV1ImageQA01'))).heads[0].attachmentIds.length===1);
      assert.equal(await page.locator('.bdc-note-images img').evaluate(el=>el.naturalWidth),640);
      await page.getByRole('button',{name:'查看大图',exact:true}).click();
      assert.equal(await page.getByRole('dialog',{name:'图片预览'}).locator('img').evaluate(el=>el.naturalWidth),640);
      await page.keyboard.press('Escape');
      assert.equal(await page.getByRole('dialog',{name:'图片预览'}).count(),0);
      await page.getByRole('textbox',{name:'笔记输入',exact:true}).fill('截图之后补充想法');
      await page.getByRole('button',{name:'保存',exact:true}).click();
      await waitForData(page,async()=> (await qa.repo.readPage(qa.videoPageId('BV1ImageQA01'))).heads[0].body.includes('截图之后补充想法'));
      assert.equal(await page.evaluate(async()=> (await qa.repo.readPage(qa.videoPageId('BV1ImageQA01'))).heads[0].body.match(/!\[/g).length),1);
      await page.locator('.bdc-assistant-header').getByRole('button',{name:'截图到笔记',exact:true}).click();
      const beforePrepare = await page.evaluate(()=>qa.calls.filter(c=>c.action==='ASK_LEARNING_CHAT').length);
      await page.getByRole('button',{name:'带图提问',exact:true}).click();
      assert.equal(await page.evaluate(()=>qa.calls.filter(c=>c.action==='ASK_LEARNING_CHAT').length),beforePrepare);
      await page.getByRole('button',{name:'查看待发图片 1',exact:true}).waitFor();
      await page.getByRole('button',{name:'发送',exact:true}).click();
      await page.getByText('尚未启用支持图片的模型。本次未发送图片，请在设置中配置图片模型。',{exact:true}).first().waitFor();
      await page.locator('.bdc-assistant-source-details > summary').click();
      const readsBeforeRefresh = await page.evaluate(()=>qa.calls.filter(row=>row.action==='GET_CURRENT_VIDEO_CONTEXT').length);
      await page.getByRole('button',{name:'重新检测字幕',exact:true}).click();
      await page.waitForFunction(before=>qa.calls.filter(row=>row.action==='GET_CURRENT_VIDEO_CONTEXT').length>before,readsBeforeRefresh);
      await page.getByRole('button',{name:'重新检测字幕',exact:true}).waitFor();
      assert.equal(await page.getByText('尚未启用支持图片的模型。本次未发送图片，请在设置中配置图片模型。',{exact:true}).count(),1, 'Subtitle refresh within the same video part must preserve conversation feedback');
      await page.locator('.bdc-assistant-source-details > summary').click();
      await page.getByRole('button',{name:'关闭提示',exact:true}).click();
      assert.equal(await page.getByText('尚未启用支持图片的模型。本次未发送图片，请在设置中配置图片模型。',{exact:true}).count(),0);
      await page.evaluate(()=>chrome.storage.local.set({learningVisionModel:{enabled:true,model:'synthetic-vision'},learningChatStreaming:false}));
      await page.getByRole('textbox',{name:'聊天输入',exact:true}).fill('解释图片');
      await page.getByRole('button',{name:'发送',exact:true}).click();
      await page.getByText('画面观察：这是用于测试的色块。拓展知识：可以用不同色块表示模块。',{exact:true}).first().waitFor();
      await waitForChatSettled(page,'解释图片');
      assert.equal(await page.evaluate(()=>qa.chat.ai.status),'generated');
      assert.equal(await page.getByRole('textbox',{name:'聊天输入',exact:true}).inputValue(),'');
      assert.equal(await page.getByText('回答失败，问题已保留。请确认当前视频和 AI 设置后重试。',{exact:true}).count(),0);
      assert.equal(await page.locator('[aria-label="待发送图片"]').count(),0);
      await page.locator('.bdc-chat-message').getByRole('button',{name:'查看已发送图片 1',exact:true}).last().click();
      await page.getByRole('dialog',{name:'图片预览'}).waitFor();
      assert.equal(await page.getByRole('dialog',{name:'图片预览'}).locator('img').evaluate(el=>el.naturalWidth),640);
      await page.getByRole('button',{name:'关闭图片预览',exact:true}).click();
      await page.evaluate(()=>{qa.failModel=true;});
      await page.getByRole('textbox',{name:'聊天输入',exact:true}).fill('这张图的细节是什么');
      await page.getByRole('button',{name:'发送',exact:true}).click();
      await page.getByRole('button',{name:'重试',exact:true}).waitFor();
      await waitForChatSettled(page,'这张图的细节是什么');
      assert.equal(await page.getByText('请求过于频繁，请稍后重试。',{exact:true}).count(),1);
      assert.equal(await page.getByRole('textbox',{name:'聊天输入',exact:true}).inputValue(),'');
      assert.equal(await page.evaluate(()=>qa.lastPayload.stream),false);
      await page.getByRole('button',{name:'停止引用图片 1',exact:true}).click();
      await page.evaluate(()=>{qa.failModel=false;});
      await page.getByRole('button',{name:'重试',exact:true}).click();
      await waitForChatSettled(page,'这张图的细节是什么');
      assert.equal(await page.evaluate(()=>qa.chat.ai.status),'generated');
      await page.getByRole('button',{name:'重试',exact:true}).waitFor({state:'detached'});
      assert.equal(await page.evaluate(()=>qa.lastPayload.messages.at(-1).content[1].type),'image_url');
      assert.equal(await page.getByRole('button',{name:'停止引用图片 1',exact:true}).count(),0);
      const chat=page.getByRole('textbox',{name:'聊天输入',exact:true});
      await chat.fill('只发文字'); await page.getByRole('button',{name:'发送',exact:true}).click();
      await waitForChatSettled(page,'只发文字');
      assert.equal(await page.evaluate(()=>qa.chat.ai.status),'generated');
      assert.equal(await page.evaluate(()=>typeof qa.lastPayload.messages.at(-1).content),'string');
      assert.equal(await page.getByRole('button',{name:'发送',exact:true}).isDisabled(),true);
      await chat.fill('原会话草稿');
      const beforeNewChatRead=await page.evaluate(()=>qa.sessionReads);
      await page.getByRole('button',{name:'新对话',exact:true}).click();
      assert.equal(await chat.inputValue(),'');
      assert.equal(await page.locator('.bdc-chat-message').count(),0);
      assert.equal(await page.locator('.bdc-chat-image-context').count(),0);
      await page.getByLabel('历史对话',{exact:true}).click();
      await page.locator('.bdc-chat-menu .bdc-assistant-session-button').first().click();
      assert.equal(await chat.inputValue(),'原会话草稿');
      await page.getByRole('button',{name:'新对话',exact:true}).click();
      await chat.fill('保留这一问');
      await page.getByRole('tab',{name:'字幕',exact:true}).click();
      await page.locator('.bdc-assistant-subtitle-line-text').first().evaluate(el=>{
        const range=document.createRange();range.selectNodeContents(el);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
        el.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));selection.removeAllRanges();
      });
      await page.getByRole('button',{name:'移除引用',exact:true}).click();
      assert.equal(await page.locator('.bdc-composer-quote').count(),0);
      assert.equal(await chat.inputValue(),'保留这一问');
      await page.getByRole('tab',{name:'对话',exact:true}).click();
      await page.getByRole('button',{name:'切换到笔记',exact:true}).click();
      const noteDraft = page.getByRole('textbox',{name:'笔记输入',exact:true});
      await noteDraft.fill('聊天截图不能覆盖这份笔记草稿');
      await page.getByRole('button',{name:'切换到提问',exact:true}).click();
      assert.equal(await chat.inputValue(),'保留这一问');
      assert.equal(await page.getByRole('button',{name:'切换到提问',exact:true}).getAttribute('aria-pressed'),'true');
      await page.evaluate(()=>{qa.corruptImage=true;});
      await page.evaluate(async()=>{
        const blob=await (await fetch(qa.upload)).blob(), transfer=new DataTransfer();
        transfer.items.add(new File([blob],'synthetic.png',{type:'image/png'}));
        document.querySelector('[aria-label="聊天输入"]').dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true}));
      });
      await page.getByRole('button',{name:'查看待发图片 1',exact:true}).filter({hasText:'重新载入'}).waitFor();
      await page.evaluate(()=>{qa.corruptImage=false;});
      await page.getByRole('button',{name:'查看待发图片 1',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('.bdc-chat-attachment img')?.naturalWidth===640);
      await page.waitForFunction(async()=> {
        const drafts=await qa.db.okCaptures.toArray();
        return drafts.some(row=>row.text==='聊天截图不能覆盖这份笔记草稿') && !drafts.some(row=>row.anchor.method==='upload');
      });
      assert.equal(await chat.inputValue(),'保留这一问');
      await page.getByRole('button',{name:'切换到笔记',exact:true}).click();
      assert.equal(await noteDraft.inputValue(),'聊天截图不能覆盖这份笔记草稿');
      await page.getByRole('button',{name:'切换到提问',exact:true}).click();
      assert.equal(await page.getByRole('textbox',{name:'笔记输入',exact:true}).count(),0);
      await page.getByRole('button',{name:'查看待发图片 1',exact:true}).click();
      await page.getByRole('dialog',{name:'图片预览'}).waitFor(); await page.keyboard.press('Escape');
      await page.getByRole('button',{name:'移除待发图片 1',exact:true}).click();
      assert.equal(await page.locator('[aria-label="待发送图片"]').count(),0);
      assert.equal(await chat.inputValue(),'保留这一问');
      const beforeCaptureCalls = await page.evaluate(()=>qa.calls.filter(c=>c.action==='ASK_LEARNING_CHAT').length);
      await page.getByRole('button',{name:'截图到对话',exact:true}).click();
      await page.getByRole('button',{name:'查看待发图片 1',exact:true}).waitFor();
      assert.equal(await chat.inputValue(),'保留这一问');
      assert.equal(await page.evaluate(()=>qa.calls.filter(c=>c.action==='ASK_LEARNING_CHAT').length),beforeCaptureCalls);
      assert.equal(await page.locator('.bdc-assistant-header').getByRole('button',{name:'截图到笔记',exact:true}).innerText(),'截图笔记');
      assert.equal(await page.getByRole('button',{name:'截图到对话',exact:true}).innerText(),'截图对话');
      await page.screenshot({path:path.join(out,name+'-screenshot-destinations.png')});
      await page.getByRole('button',{name:'移除待发图片 1',exact:true}).click();
      assert.equal(await page.locator('[aria-label="待发送图片"]').count(),0);
      const calls=await page.evaluate(()=>qa.calls.filter(c=>c.action==='ASK_LEARNING_CHAT').length);
      await chat.dispatchEvent('keydown',{key:'Enter',isComposing:true,keyCode:229});
      await chat.press('Shift+Enter');
      assert.equal(await page.evaluate(()=>qa.calls.filter(c=>c.action==='ASK_LEARNING_CHAT').length),calls);
      await chat.dispatchEvent('compositionstart');
      await page.getByRole('button',{name:'发送',exact:true}).click();
      assert.equal(await page.evaluate(()=>qa.calls.filter(c=>c.action==='ASK_LEARNING_CHAT').length),calls);
      await chat.dispatchEvent('compositionend');
      await page.evaluate(()=>{qa.slowModel=true;});
      await chat.fill('停止这一轮'); await chat.press('Enter');
      await page.getByRole('button',{name:'停止生成',exact:true}).waitFor();
      await chat.fill('回答期间可写下一问');
      await page.getByRole('button',{name:'新对话',exact:true}).click();
      await chat.fill('另一会话草稿');
      await page.getByLabel('历史对话',{exact:true}).click();
      await page.locator('.bdc-chat-menu .bdc-assistant-session-button').filter({hasText:'停止这一轮'}).click();
      assert.equal(await chat.inputValue(),'回答期间可写下一问');
      await page.getByRole('button',{name:'停止生成',exact:true}).click();
      await page.getByRole('button',{name:'重试',exact:true}).waitFor();
      await page.evaluate(()=>{qa.slowModel=false;qa.markdownReply='## 学习建议\n\n先明确 **学习目标**。\n\n- 记录关键论点\n- 回到来源核对\n\n```js\nconst items = [1];\n```\n\n<script>window.__unsafe = true</script>\n\n[参考链接](https://example.com/learn)\n\n![外部图片](https://example.com/tracking.png)';});
      await page.getByRole('button',{name:'重试',exact:true}).click();
      await page.locator('.bdc-chat-answer h2').waitFor();
      assert.equal(await page.locator('.bdc-chat-answer li').count(),2);
      assert.equal(await page.locator('.bdc-chat-answer pre code').textContent(),'const items = [1];\n');
      assert.equal(await page.evaluate(()=>Boolean(window.__unsafe)),false);
      assert.equal(await page.locator('.bdc-chat-answer img').count(),0);
      assert.equal(await page.locator('.bdc-chat-source[open]').count(),0);
      assert.equal(await page.locator('.bdc-chat-answer a').count(),0);
      await page.context().grantPermissions(['clipboard-read','clipboard-write']);
      await page.getByRole('button',{name:'复制回答',exact:true}).click();
      await page.getByRole('button',{name:'已复制',exact:true}).waitFor();
      assert.match(await page.evaluate(()=>navigator.clipboard.readText()),/学习建议/);
      const beforeRegenerate=await page.evaluate(()=>qa.calls.filter(row=>row.action==='ASK_LEARNING_CHAT').length);
      await page.getByRole('button',{name:'重新生成',exact:true}).click();
      await page.waitForFunction(count=>qa.calls.filter(row=>row.action==='ASK_LEARNING_CHAT').length===count+1,beforeRegenerate);
      await page.getByRole('button',{name:'重新生成',exact:true}).waitFor();
      assert.equal(await chat.inputValue(),'回答期间可写下一问');
      assert.equal(await page.locator('.bdc-chat-message').count(),1);
      await page.getByRole('button',{name:'收起',exact:true}).click();
      await page.getByRole('button',{name:'展开助手',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('[role=tab][aria-selected=true]')?.textContent==='对话');
      assert.equal(await chat.inputValue(),'回答期间可写下一问');
      await chat.fill('');
      await page.getByLabel('对话设置',{exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('summary[aria-label="对话设置"]').parentElement.open);
      await page.getByLabel('历史对话',{exact:true}).click();
      await page.waitForFunction(count=>qa.sessionReads>count,beforeNewChatRead);
      assert.equal(await page.getByLabel('历史对话',{exact:true}).evaluate(el=>el.parentElement.open),true);
      assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'历史对话');
      await page.evaluate(()=>document.querySelector('.bdc-chat-timeline').scrollTop=0);
      assert.equal(await page.getByLabel('对话设置',{exact:true}).evaluate(el=>el.parentElement.open),false);
      await page.getByLabel('历史对话',{exact:true}).click();
      for(const [width,height] of [[1440,1000],[390,760],[320,480],[844,390]]){
        await page.setViewportSize({width,height});
        await page.waitForFunction(()=>{const r=document.querySelector('#bdc-current-video-assistant').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1;});
        assert.equal(await page.locator('#bdc-current-video-assistant').evaluate(el=>el.scrollWidth>el.clientWidth),false);
        assert.equal(await page.locator('.bdc-assistant-header').evaluate(el=>el.scrollWidth>el.clientWidth),false);
        assert.equal(await page.getByRole('button',{name:'截图到对话',exact:true}).evaluate(el=>el.scrollWidth>el.clientWidth),false);
        const form=await page.locator('.bdc-chat-composer').boundingBox(), timeline=await page.locator('.bdc-chat-timeline').boundingBox();
        assert.ok(timeline.height>=24, `Chat history must remain visible at ${width}x${height}`);
        assert.ok(timeline.y+timeline.height<=form.y+1); assert.ok(form.y+form.height<=height);
        await page.screenshot({path:path.join(out, name+'-'+width+'.png')});
        await page.getByRole('button',{name:'切换到笔记',exact:true}).click();
        assert.equal(await page.locator('.bdc-composer-controls').getByRole('button',{name:'截图到笔记',exact:true}).count(),1);
        assert.equal(await page.getByRole('button',{name:'截图到对话',exact:true}).count(),0);
        await page.getByRole('textbox',{name:'笔记输入',exact:true}).fill('保持独立的笔记草稿');
        await page.getByRole('button',{name:'保存',exact:true}).scrollIntoViewIfNeeded();
        const save=await page.getByRole('button',{name:'保存',exact:true}).boundingBox();
        assert.ok(save.y>=0 && save.y+save.height<=height);
        await page.getByRole('button',{name:'收起笔记，保留草稿',exact:true}).click();
      }
      await page.evaluate(()=>{
        const fixture=document.createElement('div');fixture.id='citation-fixture';document.body.prepend(fixture);
        qa.appendKnowledgeAnswer(fixture,'**个人笔记 [1]** 和代码 `arr[1]`，未知 [99]。[参考](https://example.com/learn)',[{number:1,id:'a'.repeat(64),title:'引用测试',label:'个人笔记',videoTitle:'合成视频',excerpt:'来源节选',digest:'b'.repeat(64)}],text=>text);
      });
      assert.equal(await page.locator('#citation-fixture strong').getByRole('button',{name:'查看知识引用 1',exact:true}).count(),1);
      assert.equal(await page.locator('#citation-fixture code').textContent(),'arr[1]');
      assert.equal(await page.getByRole('button',{name:'查看知识引用 99',exact:true}).count(),0);
      page.once('dialog',async dialog=>{assert.match(dialog.message(),/https:\/\/example.com\/learn/);await dialog.dismiss();});
      await page.locator('#citation-fixture a').click();
      assert.equal(page.context().pages().length,1);
      await page.locator('#citation-fixture').evaluate(el=>el.remove());
      await page.getByLabel('历史对话',{exact:true}).click();
      await page.getByRole('button',{name:'删除当前对话',exact:true}).click();
      await page.getByRole('button',{name:'取消',exact:true}).click();
      assert.equal(await page.locator('.bdc-chat-message').count(),1);
      page.once('dialog',dialog=>dialog.accept('这份对话有明确标题'));
      await page.getByRole('button',{name:'重命名当前对话',exact:true}).click();
      await page.locator('.bdc-chat-session-title').filter({hasText:'这份对话有明确标题'}).waitFor();
      assert.equal(await page.getByLabel('历史对话',{exact:true}).evaluate(el=>el.parentElement.open),true);
      await page.getByRole('button',{name:'删除当前对话',exact:true}).click();
      await page.getByRole('button',{name:'确认删除',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('.bdc-chat-session-title')?.textContent==='新对话');
      assert.equal(await page.locator('.bdc-chat-message').count(),0);
      assert.equal(await page.evaluate(async()=> (await qa.db.currentVideoQaSessions.toArray()).some(row=>row.title==='这份对话有明确标题')),false);
      assert.ok(await page.evaluate(async()=> (await qa.repo.readPage(qa.videoPageId('BV1ImageQA01'))).heads[0].attachmentIds.length>0));
      await page.evaluate(()=>{qa.failHistoryOnce=true;});
      await page.getByRole('button',{name:'新对话',exact:true}).click();
      await page.getByText('本地问答会话读取失败，请稍后重试。',{exact:true}).waitFor();
      await chat.fill('读取失败也保留的草稿');
      await page.getByRole('button',{name:'重新读取对话',exact:true}).click();
      await page.getByText('本地问答会话读取失败，请稍后重试。',{exact:true}).waitFor({state:'detached'});
      assert.equal(await chat.inputValue(),'读取失败也保留的草稿');
      await page.evaluate(()=>{qa.failHistoryOnce=true;});
      await page.getByRole('button',{name:'新对话',exact:true}).click();
      await page.getByText('本地问答会话读取失败，请稍后重试。',{exact:true}).waitFor();
      await page.getByRole('button',{name:'关闭提示',exact:true}).click();
      assert.equal(await page.getByText('本地问答会话读取失败，请稍后重试。',{exact:true}).count(),0);
      assert.deepEqual(errors,[]);
      report.browsers.push({name,version:browser.version(),status:'pass',checks:['click-time note without pause','draft survives reload and close/reopen','native video frame decode/save','image text edit without duplicate picture','prepare image chat does not send','vision disabled sends no image','explicit image chat','note and chat image preview','failed image decode retries','chat capture preserves note draft and finishes only temporary editor','distinct mode icons and selected state','non-stream failure shown once','retry retains original image after context removal','removed image absent from follow-up','separate session drafts and images','paste stays chat and pending image removable','IME, composing click and Shift+Enter do not submit','stop and retry preserves next draft','safe Markdown and link confirmation','copy answer','reopen returns original conversation','delete cancel preserves conversation','rename and confirm delete preserve knowledge images','history read failure retries and dismisses without clearing draft','separate history/settings','1440/390/320/short layout']});
      report.browsers.at(-1).checks.push('same video subtitle refresh preserves dismissible chat feedback');
    }catch(error){
      report.diagnostics={errors,state:await page.evaluate(async()=>({
        stage:window.qa?.stage,
        calls:window.qa?.calls.filter(row=>row.action==='ASK_LEARNING_CHAT'||row.action==='GET_CURRENT_VIDEO_QA_SESSIONS'||row.action==='CANCEL_LEARNING_CHAT').slice(-30).map(row=>({action:row.action,requestId:row.params?.requestId,turnId:row.params?.turnId,sessionId:row.params?.sessionId,question:row.params?.question})),
        result:window.qa?.chat && {question:qa.chat.question,requestId:qa.chat.requestId,turnId:qa.chat.turnId,status:qa.chat.ai?.status,message:qa.chat.message},
        sessions:(await window.qa?.db.currentVideoQaSessions.toArray())?.map(row=>({sessionId:row.sessionId,turns:row.turns.map(turn=>({turnId:turn.turnId,requestId:turn.requestId,question:turn.question,status:turn.status,message:turn.message}))})),
        drafts:(await window.qa?.db.okCaptures.toArray())?.map(row=>({id:row.id,text:row.text,method:row.anchor.method})),
        input:document.querySelector('[aria-label="聊天输入"]')?.value,
        timeline:document.querySelector('.bdc-chat-timeline')?.textContent,
        videoReady:document.querySelector('video')?.readyState,
        layout:{width:innerWidth,height:innerHeight,regions:['#bdc-current-video-assistant','.bdc-assistant-body','.bdc-assistant-chat','.bdc-chat-toolbar','.bdc-chat-timeline','.bdc-chat-composer','.bdc-composer-controls'].map(selector=>{
          const element=document.querySelector(selector),style=element&&getComputedStyle(element);
          return {selector,rect:element?.getBoundingClientRect().toJSON(),minHeight:style?.minHeight,padding:style?.padding,flex:style?.flex};
        })},
        buttons:[...document.querySelectorAll('button')].map(el=>({label:el.getAttribute('aria-label')||el.textContent,disabled:el.disabled})),
      })).catch(()=>null)};
      await page.screenshot({path:path.join(out,name+'-failure.png')}).catch(()=>{});throw error;
    }finally{await browser.close();}
  }
  report.status='pass';
}catch(error){report.status='fail';report.error=String(error);throw error;}
finally{await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(path.join(out,'report.json'));}
