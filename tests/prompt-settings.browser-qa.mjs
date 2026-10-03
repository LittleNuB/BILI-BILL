import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const root=process.cwd(),out=path.join(root,'release-artifacts',`prompt-settings-${Date.now()}`);
await mkdir(out,{recursive:true});
const bundle=await build({stdin:{resolveDir:root,loader:'tsx',contents:`
import {render} from 'preact';
import {PromptSettings} from './dashboard/modules/settings/PromptSettings';
import {KnowledgePage} from './dashboard/modules/knowledge/KnowledgePage';
import {handlePromptSettings} from './src/background/ai/prompt-settings';
import {DEFAULT_CONFIG} from './src/shared/types/config';
import {knowledgeRepository as repo} from './dashboard/modules/knowledge/runtime';
const values=JSON.parse(localStorage.getItem('qa-storage')||'null')||{userConfig:{...DEFAULT_CONFIG,ai:{baseURL:'https://example.invalid',apiKey:'synthetic',chatModel:'test'}}};
const listeners=new Set();
window.chrome={runtime:{sendMessage:message=>handlePromptSettings(message.params)},storage:{local:{get:async keys=>Object.fromEntries((typeof keys==='string'?[keys]:keys).map(key=>[key,values[key]])),
set:async change=>{Object.assign(values,change);localStorage.setItem('qa-storage',JSON.stringify(values));for(const listener of listeners)listener(Object.fromEntries(Object.entries(change).map(([key,value])=>[key,{newValue:value}])),'local');}},
onChanged:{addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)}}};
window.qa={repo,values,calls:[],knowledge:()=>render(<KnowledgePage/>,document.getElementById('app')),prompts:()=>render(<PromptSettings/>,document.getElementById('app'))};
const original=fetch;window.fetch=(url,options)=>{if(!String(url).includes('example.invalid'))return original(url,options);qa.calls.push(JSON.parse(options.body));return Promise.resolve(new Response(JSON.stringify({choices:[{message:{content:'用简明中文先回答，再补充一个具体例子。'}}]})));};
qa.knowledge();
`},bundle:true,write:false,format:'esm',platform:'browser',outdir:'synthetic',jsx:'automatic',jsxImportSource:'preact'});
const css=await readFile(path.join(root,'dashboard/styles/dashboard.css'),'utf8')+bundle.outputFiles.find(file=>file.path.endsWith('.css')).text;
const server=createServer((req,res)=>{if(req.url==='/app.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles.find(file=>file.path.endsWith('.js')).text);}else if(req.url==='/app.css'){res.setHeader('Content-Type','text/css');res.end(css);}else{res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><div id="app"></div><script type="module" src="/app.js"></script>');}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const {chromium}=await import(pathToFileURL(process.env.UX014_PLAYWRIGHT_MODULE).href);
const report={syntheticOnly:true,browsers:[]};
try{
  for(const [name,executablePath] of [['Chrome',process.env.UX014_CHROME_EXECUTABLE],['Edge',process.env.UX014_EDGE_EXECUTABLE]]){
    const browser=await chromium.launch({executablePath,headless:true});
    try{
      const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
      await page.goto('http://127.0.0.1:'+server.address().port);
      await page.getByRole('heading',{name:'从一条笔记开始'}).waitFor();
      await page.screenshot({path:path.join(out,name+'-start.png')});
      await page.getByRole('button',{name:'新建个人页',exact:true}).click();
      await page.getByLabel('页面正文',{exact:true}).fill('先保存自己的学习心得');
      await page.getByRole('button',{name:'保存',exact:true}).click();
      await page.getByText('先保存自己的学习心得',{exact:true}).last().waitFor();
      assert.equal(await page.evaluate(()=>qa.calls.length),0);
      await page.evaluate(()=>qa.prompts());
      const input=page.getByLabel('当前提示词',{exact:true});await input.waitFor();
      await page.getByLabel('提示词功能',{exact:true}).selectOption('chat');
      await input.fill('先举例，然后解释原理。');
      await page.getByRole('button',{name:'保存',exact:true}).click();await page.getByText('已应用',{exact:true}).waitFor();
      assert.equal(await page.evaluate(()=>qa.values.learningAiPrompts.values.chat),'先举例，然后解释原理。');
      await page.getByLabel('提示词改写要求').fill('更简洁，并保留例子');
      await page.getByRole('button',{name:'生成预览',exact:true}).click();
      await page.getByRole('button',{name:'应用改写',exact:true}).waitFor();
      assert.equal(await page.evaluate(()=>qa.values.learningAiPrompts.values.chat),'先举例，然后解释原理。');
      await page.screenshot({path:path.join(out,name+'-preview.png'),fullPage:true});
      await page.getByRole('button',{name:'应用改写',exact:true}).click();
      await page.waitForFunction(()=>qa.values.learningAiPrompts.values.chat==='用简明中文先回答，再补充一个具体例子。');
      await page.getByRole('button',{name:'撤销',exact:true}).click();
      await page.waitForFunction(()=>qa.values.learningAiPrompts.values.chat==='先举例，然后解释原理。');
      await page.getByRole('button',{name:'恢复默认',exact:true}).click();
      await page.waitForFunction(()=>!qa.values.learningAiPrompts.values.chat);
      for(const width of [1280,390]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);await page.screenshot({path:path.join(out,name+'-'+width+'.png'),fullPage:true});}
      assert.deepEqual(errors,[]);report.browsers.push({name,version:browser.version(),status:'pass',checks:['empty-library onboarding','personal notes without AI/folder','feature prompt editing','rewrite preview not auto applied','apply undo reset','1280/390 layout']});
    }finally{await browser.close();}
  }
  report.status='pass';
}catch(error){report.status='fail';report.error=String(error);process.exitCode=1;}
finally{await new Promise(resolve=>server.close(resolve));await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output:out,...report},null,2));}
