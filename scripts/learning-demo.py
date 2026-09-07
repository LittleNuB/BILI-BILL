"""Offline interview demo using the real extension and an isolated synthetic host."""
import argparse
import json
import shutil
import uuid
from pathlib import Path
from playwright.sync_api import sync_playwright, expect, Error as PlaywrightError

ROOT = Path(__file__).resolve().parents[1]
URL = 'https://www.bilibili.com/video/BV1xx411c7mD/'
parser = argparse.ArgumentParser(description='Bili-Bill offline learning demo')
parser.add_argument('--dist', type=Path, default=ROOT / 'dist')
parser.add_argument('--smoke', action='store_true')
args = parser.parse_args()
extension = args.dist.resolve()
assert extension.is_relative_to(ROOT) and (extension / 'manifest.json').is_file()
profile = ROOT / 'release-artifacts' / 'lg1' / ('p-' + uuid.uuid4().hex[:8])
profile.parent.mkdir(parents=True, exist_ok=True)
html = (ROOT / 'tests' / 'learning-save.mock.html').read_text(encoding='utf-8')


def launch(playwright):
    context = playwright.chromium.launch_persistent_context(str(profile), channel='chromium', headless=args.smoke,
        viewport={'width': 1440, 'height': 900}, args=[
            '--disable-extensions-except=' + str(extension), '--load-extension=' + str(extension),
            '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost', '--no-first-run'])
    context.set_offline(True)
    context.route('**/*', lambda route: route.fulfill(status=200, content_type='text/html', body=html)
        if route.request.url.startswith(URL) else route.continue_() if route.request.url.startswith('chrome-extension:') else route.abort())
    return context


def video_page(context):
    page = context.new_page()
    page.goto(URL, wait_until='domcontentloaded')
    page.wait_for_selector('html[data-video-ready=true]', timeout=25000)
    page.get_by_role('button', name='展开助手', exact=True).click()
    return page


with sync_playwright() as playwright:
    context = None
    try:
        print('正在启动独立离线演示，准备合成样例。不会使用个人账号或浏览记录。', flush=True)
        context = launch(playwright)
        worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
        extension_id = worker.url.split('/')[2]
        page = video_page(context)
        page.get_by_role('button', name='记笔记', exact=True).click()
        expect(page.locator('#bb-learning-editor .source')).to_contain_text('从想法到可用产品', timeout=15000)
        page.get_by_label('标题', exact=True).fill('先验证最小闭环')
        page.get_by_label('笔记', exact=True).fill('看完之后，留下自己的理解。\n先验证保存、重开和再次使用，再扩展更多能力。')
        page.locator('#bb-learning-editor').get_by_role('button', name='保存', exact=True).click()
        expect(page.locator('#bb-learning-editor .status')).to_have_text('已保存', timeout=15000)
        page.get_by_role('button', name='关闭并保留草稿', exact=True).click()
        page.get_by_role('button', name='存书签', exact=True).click()
        expect(page.locator('#bb-learning-editor .source')).to_contain_text('0:02')
        page.get_by_label('标题', exact=True).fill('关于验证闭环的提醒')
        page.locator('#bb-learning-editor').get_by_role('button', name='保存', exact=True).click()
        expect(page.locator('#bb-learning-editor .status')).to_have_text('已保存', timeout=15000)
        context.close()

        # Reopen the entire browser, not just a page, before presenting saved data.
        context = launch(playwright)
        page = video_page(context)
        dashboard = context.new_page()
        dashboard.goto('chrome-extension://' + extension_id + '/dashboard/index.html#learning-notes')
        expect(dashboard.locator('.learning-heading')).to_contain_text('2 条记录', timeout=15000)
        dashboard.get_by_role('button', name='先验证最小闭环', exact=False).click()
        expect(dashboard.locator('.learning-body')).to_contain_text('留下自己的理解')
        for blank in list(context.pages):
            if blank.url == 'about:blank': blank.close()
        if args.smoke:
            print(json.dumps({'status': 'pass', 'checks': ['real_extension_save', 'full_restart_readback'], 'data': 'synthetic'}, ensure_ascii=False))
        else:
            dashboard.bring_to_front()
            print('演示已就绪：两个标签页分别是视频和学习笔记。关闭此独立浏览器后自动清理演示数据。', flush=True)
            while context.browser.is_connected():
                pages = context.pages
                if not pages: break
                try: pages[-1].wait_for_timeout(500)
                except PlaywrightError:
                    if not context.browser.is_connected(): break
    finally:
        if context:
            try: context.close()
            except PlaywrightError: pass
        target = profile.resolve()
        assert target.parent == (ROOT / 'release-artifacts' / 'lg1').resolve()
        assert target.name.startswith('p-') and len(target.name) == 10
        if target.exists(): shutil.rmtree(target)
        print('本次合成演示数据已清理。', flush=True)
