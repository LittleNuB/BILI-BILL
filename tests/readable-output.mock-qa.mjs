import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const {chromium}=await import(pathToFileURL(process.env.UX014_PLAYWRIGHT_MODULE).href);
const html=await readFile(path.join(root,'tests/current-video-assistant-shell.mock.html'));
const bundle=await readFile(path.join(root,'dist/content/player-monitor.js'));
const out=path.join(root,'release-artifacts/readable-286'); await mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.UX014_CHROME_EXECUTABLE,headless:true});
try {
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[]; page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.pathname.startsWith('/video/')) return route.fulfill({contentType:'text/html',body:html});
    if(url.pathname==='/dist/content/player-monitor.js') return route.fulfill({contentType:'application/javascript',body:bundle});
    return route.abort();
  });
  await page.goto('https://www.bilibili.com/video/BV1ShellMock9');
  await page.getByRole('button',{name:'展开助手',exact:true}).click();
  await page.evaluate(()=>{
    const send=chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage=async message=>{
      const result=await send(message.action==='ASK_LEARNING_CHAT' ? {...message,action:'ASK_CURRENT_VIDEO_FULL_TEXT'} : message);
      if(message.action==='GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS' && result.data) Object.assign(result.data,{
        status:'invalid_output',unverifiedText:'先明确需求，再分步实现，最后验证交付。',message:'模型输出已显示，引用尚未核实。',highlights:[],summarySentences:[],keyPoints:[]
      });
      if(message.action==='ASK_LEARNING_CHAT' && result.data) Object.assign(result.data,{
        status:'invalid_output',answer:'稳定交付需要拆分任务、保持版本记录并验证关键流程。',message:'模型回答已显示，引用尚未核实。',citations:[],answerEvidenceLineNumbers:[]
      });
      if(message.action==='GET_CURRENT_VIDEO_QA_SESSIONS' && result.data?.activeSession) {
        for(const turn of result.data.activeSession.turns) Object.assign(turn,{status:'invalid_output',answer:'稳定交付需要拆分任务、保持版本记录并验证关键流程。',message:'模型回答已显示，引用尚未核实。',citations:[]});
      }
      return result;
    };
  });
  await page.getByRole('button',{name:'生成摘要与亮点',exact:true}).click();
  await page.getByText('先明确需求，再分步实现，最后验证交付。',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'预览跳转',exact:true}).count(),0);
  await page.screenshot({path:path.join(out,'summary.png')});
  await page.getByRole('tab',{name:'问答',exact:true}).click();
  await page.getByRole('textbox',{name:'聊天输入',exact:true}).fill('如何稳定交付高质量产品？');
  await page.getByRole('button',{name:'发送',exact:true}).click();
  await page.getByText('稳定交付需要拆分任务、保持版本记录并验证关键流程。',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'预览跳转',exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'保存答案',exact:true}).count(),0);
  await page.getByText('稳定交付需要拆分任务、保持版本记录并验证关键流程。',{exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(out,'qa.png')});
  assert.deepEqual(errors,[]);
  await writeFile(path.join(out,'report.json'),JSON.stringify({syntheticOnly:true,status:'pass',checks:['summary readable','qa readable','no false citations','no verified save','no page errors']}));
  console.log('PASS readable output UI: '+out);
} finally {await browser.close();}
