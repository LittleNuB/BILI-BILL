import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const root = process.cwd(), out = path.join(root, 'release-artifacts', `prompt-evaluation-ui-${Date.now()}`);
await mkdir(out, { recursive: true });
const pageBundle = await build({ entryPoints: ['src/dev/prompt-eval/page.tsx'], bundle: true, write: false, outfile: 'page.js', format: 'esm', jsx: 'automatic', jsxImportSource: 'preact' });
const backend = await build({ entryPoints: ['src/dev/prompt-eval/worker.ts'], bundle: true, write: false, format: 'esm',
  define: { __EVAL_BUILD__: JSON.stringify({ sourceCommit: 'synthetic-browser-qa', buildHash: 'fixture', datasetHash: 'fixture', baselineCommit: 'prior' }) } });
const setup = `
const event=()=>{const handlers=new Set();return{addListener:fn=>handlers.add(fn),removeListener:fn=>handlers.delete(fn),emit:(...args)=>{for(const fn of handlers)fn(...args)}}};
const changed=event(),onConnect=event();
const stored=JSON.parse(localStorage.getItem('qa-eval-store')||'null')||{userConfig:{ai:{apiKey:'synthetic',chatModel:'test-text',baseURL:'https://example.invalid'},assistant:{currentVideoAiAssistantEnabled:true}},learningVisionModel:{enabled:true,model:'test-vision'},learningChatStreaming:false};
const connect=(name,url='https://eval.test/prompt-eval/index.html')=>{const a=event(),b=event(),gone=event();const client={postMessage:v=>b.emit(structuredClone(v)),onMessage:a,onDisconnect:gone,disconnect:()=>gone.emit()};const server={name,sender:{id:'test-extension',url},postMessage:v=>a.emit(structuredClone(v)),onMessage:b,onDisconnect:gone,disconnect:()=>gone.emit()};onConnect.emit(server);return client};
globalThis.chrome={runtime:{id:'test-extension',getURL:p=>'https://eval.test/'+p,onConnect,connect:({name})=>connect(name)},storage:{local:{get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,structuredClone(stored[k])])),set:async values=>{Object.assign(stored,structuredClone(values));localStorage.setItem('qa-eval-store',JSON.stringify(stored));changed.emit(Object.fromEntries(Object.entries(values).map(([k,newValue])=>[k,{newValue}])),'local')}},onChanged:changed}};
window.qa={stored,calls:[],slow:false,connect,changed};
const nativeFetch=fetch;
globalThis.fetch=async(url,options)=>{
if(!String(url).startsWith('https://example.invalid'))return nativeFetch(url,options);
const body=JSON.parse(options.body);qa.calls.push(body);
if(qa.slow)return new Promise((resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true})});
let content='视频内容：先确认材料范围。\\n\\n拓展知识：这是自动化检查的固定回答，不是实际模型结果。';
if(body.response_format) content=JSON.stringify({summarySentences:[{text:'合成摘要。',evidenceLineNumbers:[1]}],keyPoints:[{text:'合成要点。',evidenceLineNumbers:[1]}],highlights:[{title:'合成亮点',description:'不同的亮点描述。',evidenceLineNumbers:[1]}]});
else if(body.max_tokens===6000)content=JSON.stringify({lines:JSON.parse(body.messages.at(-1).content)});
return new Response(JSON.stringify({model:body.model,usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30},choices:[{finish_reason:'stop',message:{content}}]}));};
`;
const html = (await readFile('src/dev/prompt-eval/index.html', 'utf8')).replace('<script type="module" src="page.js"></script>', '<script type="module" src="start.js"></script>');
const { chromium } = await import(pathToFileURL(process.env.UX014_PLAYWRIGHT_MODULE).href);
const report = { status: 'running', syntheticOnly: true, realModelAcceptance: 'not_completed', browsers: [], limitation: 'Browser UI + production evaluation worker/transport with mocked extension messaging, configuration and model responses; not installed-extension or real-model acceptance.' };
try {
  for (const [name, executablePath] of [['Chrome', process.env.UX014_CHROME_EXECUTABLE], ['Edge', process.env.UX014_EDGE_EXECUTABLE]]) {
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== 'https://eval.test') return route.abort();
        const filename = url.pathname.split('/').at(-1);
        if (filename === 'index.html') return route.fulfill({ contentType: 'text/html', body: html });
        if (filename === 'start.js') return route.fulfill({ contentType: 'text/javascript', body: `${setup}\nawait import('./worker.js'); await import('./page.js');` });
        if (filename === 'worker.js') return route.fulfill({ contentType: 'text/javascript', body: backend.outputFiles[0].text });
        if (filename === 'page.js') return route.fulfill({ contentType: 'text/javascript', body: pageBundle.outputFiles.find(f => f.path.endsWith('.js')).text });
        if (filename === 'page.css') return route.fulfill({ contentType: 'text/css', body: pageBundle.outputFiles.find(f => f.path.endsWith('.css')).text });
        if (['chart.png', 'code.png', 'blur.png', 'conflict.png'].includes(filename)) return route.fulfill({ contentType: 'image/png', body: await readFile(path.join(root, 'tests/fixtures/prompt-eval/images', filename)) });
        return route.abort();
      });
      await page.goto('https://eval.test/prompt-eval/index.html');
      await page.getByRole('button', { name: '开始32次对照' }).waitFor();
      assert.equal(await page.evaluate(() => qa.calls.length), 0, 'No request just from opening');
      await page.evaluate(() => qa.connect('bili-bill-prompt-evaluation-v1','https://evil.invalid').postMessage({action:'run'}));
      assert.equal(await page.evaluate(() => qa.calls.length), 0, 'Wrong sender cannot run');
      await page.getByRole('button', { name: '开始32次对照' }).click();
      await page.waitForFunction(() => qa.stored.developerPromptEvaluationV1.rows.every(r => r.state === 'complete'));
      assert.equal(await page.evaluate(() => qa.calls.length), 32);
      assert.equal(await page.evaluate(() => qa.calls.filter(c => c.model === 'test-vision' && c.messages.at(-1).content[1].image_url.url.startsWith('data:image/png')).length), 8);
      await page.getByRole('tab', { name: '质量评分' }).click();
      for (const label of ['正确性', '来源诚实', '任务完成度', '可读性', '简洁性']) await page.getByLabel(label, { exact: true }).selectOption('2');
      await page.getByLabel('事实与禁止项').selectOption('true');
      await page.getByLabel('评分人', { exact: true }).fill('自动化模拟评分');
      await page.getByLabel('评语与依据').fill('仅测试评分操作，不是实际模型质量结论。');
      await page.getByRole('button', { name: '保存评分' }).click();
      await page.waitForFunction(() => qa.stored.developerPromptEvaluationV1.rows[0].grade?.reviewer === '自动化模拟评分');
      const downloadEvent = page.waitForEvent('download'); await page.getByRole('button', { name: '导出结果' }).click();
      const download = await downloadEvent; await download.saveAs(path.join(out, `${name}-synthetic-export.json`));
      const exported = JSON.parse(await readFile(path.join(out, `${name}-synthetic-export.json`), 'utf8'));
      assert.equal(exported.rows.length, 32); assert.equal(exported.cases.length, 16);
      assert.ok(!JSON.stringify(exported).includes('apiKey')); assert.equal(exported.rows[0].observation.usage.totalTokens, 30);
      await page.getByRole('tab', { name: '模型回答' }).click();
      await page.screenshot({ path: path.join(out, `${name}-1280.png`) });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: path.join(out, `${name}-390.png`) });
      await page.getByText('补测此案例', { exact: true }).click(); await page.getByLabel('补测原因').fill('验证停止');
      await page.evaluate(() => qa.slow = true);
      await page.getByRole('button', { name: '追加一次生成' }).click(); await page.waitForFunction(() => qa.calls.length === 33);
      await page.getByRole('button', { name: '停止', exact: true }).click();
      await page.waitForFunction(() => qa.stored.developerPromptEvaluationV1.rows.at(-1).state === 'cancelled');
      await page.reload(); await page.getByRole('button', { name: '导出结果' }).waitFor();
      assert.equal(await page.evaluate(() => qa.calls.length), 0, 'Reload never auto-runs');
      await page.waitForFunction(() => qa.stored.developerPromptEvaluationV1.rows.length === 33);
      assert.deepEqual(errors, []);
      report.browsers.push({ name, version: browser.version(), status: 'pass', cases: ['no auto-run', 'sender restriction', '32 real worker-path synthetic calls', '8 vision image payloads', 'grading', 'safe export', 'stop', 'reload', '1280/390 layout'] });
    } finally { await browser.close(); }
  }
  report.status = 'pass';
} finally { await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); }
console.log(JSON.stringify({ output: out, status: report.status }));
