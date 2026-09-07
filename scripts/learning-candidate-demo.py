"""Runnable offline candidate. The host, subtitles and model replies are synthetic."""
import argparse
import json
import shutil
import uuid
from pathlib import Path
from playwright.sync_api import sync_playwright, expect, Error as PlaywrightError

RESOURCE_ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--workspace', type=Path, default=RESOURCE_ROOT)
parser.add_argument('--dist', type=Path, default=RESOURCE_ROOT / 'dist')
parser.add_argument('--smoke', action='store_true')
args = parser.parse_args()
ROOT = args.workspace.resolve()
extension = args.dist.resolve()
assert extension.is_relative_to(ROOT) and (extension / 'manifest.json').is_file()
profile = ROOT / 'release-artifacts/lg1' / ('p-' + uuid.uuid4().hex[:8])
profile.parent.mkdir(parents=True, exist_ok=True)
URL = 'https://www.bilibili.com/video/BV1xx411c7mD/'
html = (RESOURCE_ROOT / 'tests/learning-save.mock.html').read_text(encoding='utf-8')
provider = (RESOURCE_ROOT / 'tests/learning-source-provider.js').read_text(encoding='utf-8')


def launch(playwright):
    context = playwright.chromium.launch_persistent_context(str(profile), channel='chromium', headless=args.smoke,
        viewport={'width': 1440, 'height': 900}, args=[
            '--disable-extensions-except=' + str(extension), '--load-extension=' + str(extension),
            '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost', '--no-first-run'])
    context.set_offline(True)
    context.route('**/*', lambda route: route.fulfill(status=200, content_type='text/html', body=html)
        if route.request.url.startswith(URL) else route.continue_() if route.request.url.startswith('chrome-extension:') else route.abort())
    worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
    worker.evaluate(provider)
    # Synthetic fixture provisioning only: let Playwright attach to a blank tab
    # before navigating the fixture URL. Production code is unchanged.
    worker.evaluate("""() => {
        const create = chrome.tabs.create.bind(chrome.tabs);
        chrome.tabs.create = async options => {
            if (options.url !== 'https://www.bilibili.com/video/BV1xx411c7mD/?p=1') return create(options);
            const tab = await create({ ...options, url: 'about:blank' });
            await new Promise(resolve => setTimeout(resolve, 500));
            return chrome.tabs.update(tab.id, { url: options.url });
        };
    }""")
    return context, worker


def open_video(context):
    page = context.new_page()
    page.goto(URL, wait_until='domcontentloaded')
    page.wait_for_selector('html[data-video-ready=true]', timeout=25000)
    page.get_by_role('button', name='展开助手', exact=True).click()
    return page


def save(page, button, title, note=None):
    page.get_by_role('button', name=button, exact=True).click()
    expect(page.locator('#bb-learning-editor .source')).to_contain_text('从想法到可用产品', timeout=15000)
    page.get_by_label('标题', exact=True).fill(title)
    if note is not None:
        page.locator('#bb-learning-editor textarea').fill(note)
    page.locator('#bb-learning-editor').get_by_role('button', name='保存', exact=True).click()
    expect(page.locator('#bb-learning-editor .status')).to_have_text('已保存', timeout=20000)
    page.get_by_role('button', name='关闭并保留草稿', exact=True).click()


with sync_playwright() as playwright:
    context = None
    try:
        print('准备整版离线演示：真实扩展，合成视频、字幕和固定 AI 响应。不会使用个人账号或密钥。', flush=True)
        context, worker = launch(playwright)
        extension_id = worker.url.split('/')[2]
        dashboard = context.new_page()
        dashboard.goto('chrome-extension://' + extension_id + '/dashboard/index.html#learning-notes')
        config = dashboard.evaluate("async () => { const s = await chrome.runtime.sendMessage({action:'GET_CONFIG_SNAPSHOT'}); return chrome.runtime.sendMessage({action:'UPDATE_CONFIG',params:{ai:{baseURL:'https://api.openai.com/v1',apiKey:'synthetic-not-a-secret',chatModel:'synthetic-fixed-provider'},assistant:{currentVideoAiAssistantEnabled:true},expectedConfig:s.data.config,expectedConfigRevision:s.data.revision}}); }")
        assert config['success'], config
        page = open_video(context)
        save(page, '记笔记', '先留下自己的理解', '先明确用户问题，再缩小范围。保存自己的理解，带着问题回到原句验证。')
        save(page, '存书签', '回看学习闭环的关键位置')
        page.get_by_label('主要文本来源', exact=True).click()
        page.get_by_role('button', name='重新检测字幕', exact=True).click()
        expect(page.get_by_role('button', name='生成摘要与亮点', exact=True)).to_be_enabled(timeout=20000)
        page.get_by_label('主要文本来源', exact=True).click()
        page.get_by_role('button', name='生成摘要与亮点', exact=True).click()
        expect(page.get_by_role('button', name='保存摘要', exact=True)).to_be_visible(timeout=20000)
        save(page, '保存摘要', '从想法到可用产品')
        page.get_by_role('tab', name='亮点', exact=True).click()
        save(page, '保存亮点', '一个完整的学习闭环')
        page.get_by_role('tab', name='字幕', exact=True).click()
        page.locator('.bdc-assistant-subtitle-row').first.click()
        save(page, '保存这句字幕', '先明确用户要解决的问题')
        page.get_by_role('tab', name='问答', exact=True).click()
        page.get_by_label('向当前视频提问', exact=True).fill('如何形成学习闭环？')
        page.get_by_role('button', name='提问', exact=True).click()
        expect(page.get_by_role('button', name='保存答案', exact=True)).to_be_visible(timeout=20000)
        save(page, '保存答案', '如何形成学习闭环')
        assert worker.evaluate('self.syntheticLearningRequests.ai') == 2
        context.close()

        context, worker = launch(playwright)
        page = open_video(context)
        dashboard = context.new_page()
        dashboard.goto('chrome-extension://' + extension_id + '/dashboard/index.html#learning-notes')
        expect(dashboard.locator('.learning-heading')).to_contain_text('6 条记录', timeout=15000)
        dashboard.get_by_role('button', name='如何形成学习闭环', exact=False).click()
        expect(dashboard.locator('.learning-snapshot')).to_contain_text('先明确问题')
        for blank in list(context.pages):
            if blank.url == 'about:blank': blank.close()
        if args.smoke:
            dashboard.get_by_role('button', name='回看学习闭环的关键位置', exact=False).click()
            dashboard.get_by_role('button', name='回看来源', exact=True).click()
            with context.expect_page() as opened:
                dashboard.get_by_role('button', name='确认打开来源', exact=True).click()
            source = opened.value
            expect(dashboard.locator('.learning-notice')).to_contain_text('已定位到保存的位置', timeout=30000)
            dashboard.get_by_role('button', name='返回笔记与原位置', exact=True).click()
            expect(dashboard.locator('.learning-notice')).to_contain_text('已返回')
            source.close()
            print(json.dumps({'status':'pass','checks':['six_real_saves','full_browser_restart','source_snapshot_readback','confirmed_source_open_and_return'],'data':'synthetic'}, ensure_ascii=False))
        else:
            dashboard.bring_to_front()
            print('已就绪：笔记、书签、摘要、亮点、原句与答案已重开读回。可搜索、编辑、预览来源、导出和恢复。关闭独立浏览器后清理本次数据。', flush=True)
            while context.browser.is_connected() and context.pages:
                try: context.pages[-1].wait_for_timeout(500)
                except PlaywrightError:
                    if not context.browser.is_connected(): break
    finally:
        if context:
            try: context.close()
            except PlaywrightError: pass
        target = profile.resolve()
        assert target.parent == (ROOT / 'release-artifacts/lg1').resolve()
        assert target.name.startswith('p-') and len(target.name) == 10
        if target.exists(): shutil.rmtree(target)
        print('本次合成演示数据已清理。', flush=True)
