import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const { chromium } = await import(pathToFileURL(process.env.UX014_PLAYWRIGHT_MODULE).href);
const html = await readFile(path.join(root,'tests/current-video-assistant-shell.mock.html'));
const bundle = await readFile(path.join(root,'dist/content/player-monitor.js'));
const out = path.join(root,'release-artifacts/resize-284');
await mkdir(out,{recursive:true});
const browser = await chromium.launch({executablePath:process.env.UX014_CHROME_EXECUTABLE,headless:true});
const report = { syntheticOnly:true, bundleSha256:createHash('sha256').update(bundle).digest('hex'), cases:[] };
try {
  const page = await browser.newPage({viewport:{width:1440,height:1000}});
  const errors = [];
  let saved = null;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.fulfill({contentType:'text/html',body:html}));
  async function load() {
    await page.goto('https://www.bilibili.com/video/BV1ShellMock9');
    if (saved) await page.evaluate(size => chrome.storage.local.set({currentVideoAssistantWindowSize:size}),saved);
    await page.addScriptTag({content:bundle.toString()});
    await page.getByRole('button',{name:'展开助手',exact:true}).click();
  }
  const card = page.locator('#bdc-current-video-assistant');
  async function bounds() {
    const b = await card.boundingBox(); const v = page.viewportSize();
    assert.ok(b.x>=0 && b.y>=0 && b.x+b.width<=v.width && b.y+b.height<=v.height);
    assert.equal(await card.evaluate(el=>el.scrollWidth>el.clientWidth),false);
    return b;
  }
  async function drag(edge,dx,dy,cancel=false) {
    const b = await card.locator(`[data-edge="${edge}"]`).boundingBox();
    const x=b.x+b.width/2,y=b.y+b.height/2;
    await page.mouse.move(x,y); await page.mouse.down(); await page.mouse.move(x+dx,y+dy,{steps:8});
    if(cancel) await page.keyboard.press('Escape');
    await page.mouse.up();
    return bounds();
  }
  await load();
  await page.getByRole('tab',{name:'问答',exact:true}).click();
  const draft = page.getByRole('textbox',{name:'向当前视频提问',exact:true});
  await draft.fill('缩放时保留的草稿');
  const initial = await bounds();
  let large = await drag('nw',-240,-160);
  assert.ok(large.width>initial.width+200 && large.height>initial.height+100);
  assert.equal(await draft.inputValue(),'缩放时保留的草稿');
  for(const [edge,dx,dy] of [['n',0,30],['s',0,-30],['e',-30,0],['w',30,0],['ne',-20,20],['nw',20,20],['se',-20,-20],['sw',20,-20]]) {
    const before=await bounds(),after=await drag(edge,dx,dy);
    assert.ok(after.width!==before.width || after.height!==before.height,edge);
  }
  const beforeCancel=await bounds();
  assert.deepEqual(await drag('nw',-50,-50,true),beforeCancel);
  saved=(await page.evaluate(()=>chrome.storage.local.get('currentVideoAssistantWindowSize'))).currentVideoAssistantWindowSize;
  await page.getByRole('button',{name:'收起',exact:true}).click();
  assert.equal(await card.locator('[data-edge]').count(),0);
  await page.getByRole('button',{name:'展开助手',exact:true}).click();
  assert.deepEqual(await bounds(),beforeCancel);
  assert.equal(await draft.inputValue(),'缩放时保留的草稿');
  await page.screenshot({path:path.join(out,'desktop.png')});
  await load();
  assert.equal((await bounds()).width,saved.width);
  assert.equal((await bounds()).height,saved.height);
  await card.locator('[data-edge="w"]').focus();
  const beforeKey=await bounds(); await page.keyboard.press('ArrowLeft');
  assert.equal((await bounds()).width,beforeKey.width+10);
  for(const [width,height] of [[390,480],[320,400],[844,390]]) {
    await page.setViewportSize({width,height}); await bounds();
    await drag('nw',-2000,-2000); await bounds();
    await page.screenshot({path:path.join(out,`${width}x${height}.png`)});
  }
  const ai=await page.evaluate(()=>window.__assistantMockMessages.filter(m=>['GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS','ASK_CURRENT_VIDEO_FULL_TEXT'].includes(m.action)));
  assert.equal(ai.length,0); assert.deepEqual(errors,[]);
  report.cases=['eight edges','draft preserved','escape rollback','collapse/reopen','saved size reload','keyboard','three narrow viewports','no implicit AI'];
  report.status='pass';
} catch(error) {report.status='fail';report.error=error.stack;process.exitCode=1;}
finally { await browser.close(); await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)); console.log(JSON.stringify({out,...report})); }
