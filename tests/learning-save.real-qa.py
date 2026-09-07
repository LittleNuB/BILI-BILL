import json
import hashlib
import shutil
import subprocess
import uuid
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
RUN = ROOT / 'release-artifacts' / 'lg1' / ('qa-' + str(uuid.uuid4()))
PROFILE = ROOT / 'release-artifacts' / 'lg1' / ('p-' + uuid.uuid4().hex[:8])
URL = 'https://www.bilibili.com/video/BV1xx411c7mD/'
HTML = (ROOT / 'tests' / 'learning-save.mock.html').read_text(encoding='utf-8')
RUN.mkdir(parents=True)
report = {'kind': 'synthetic-host-real-extension', 'checks': [], 'errors': [], 'profileRemoved': False}
report['sourceCommit'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
report['workingTreeDirty'] = bool(subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=normal'], cwd=ROOT, text=True).strip())
report['distSha256'] = {str(path.relative_to(ROOT / 'dist')).replace('\\', '/'): hashlib.sha256(path.read_bytes()).hexdigest()
    for path in sorted((ROOT / 'dist').rglob('*')) if path.is_file()}

with sync_playwright() as p:
    context = None
    try:
        context = p.chromium.launch_persistent_context(str(PROFILE), channel='chromium', headless=True,
            viewport={'width': 1440, 'height': 900}, args=[
                '--disable-extensions-except=' + str(ROOT / 'dist'), '--load-extension=' + str(ROOT / 'dist'),
                '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost', '--no-first-run'])
        context.set_offline(True)
        context.route('**/*', lambda route: route.fulfill(status=200, content_type='text/html', body=HTML)
            if route.request.url.startswith(URL) else route.continue_() if route.request.url.startswith('chrome-extension:') else route.abort())
        worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
        extension_id = worker.url.split('/')[2]
        report['browser'] = context.browser.version
        page = context.new_page()
        page.on('pageerror', lambda error: report['errors'].append(str(error)))
        page.goto(URL, wait_until='domcontentloaded')
        page.wait_for_selector('html[data-video-ready=true]', timeout=25000)
        page.wait_for_selector('#bdc-current-video-assistant', timeout=20000)
        page.get_by_role('button', name='展开助手', exact=True).click()
        page.get_by_role('button', name='记笔记', exact=True).click()
        expect(page.locator('#bb-learning-editor .source')).to_contain_text('从想法到可用产品', timeout=15000)
        page.get_by_label('标题', exact=True).fill('先验证最小闭环')
        page.get_by_label('笔记', exact=True).fill('先把保存、重开和找回做成可用流程，再增加自动化。\n清晰的边界与失败反馈也是产品的一部分。')
        page.screenshot(path=str(RUN / 'note-editor-desktop.png'))
        page.locator('#bb-learning-editor').get_by_role('button', name='保存', exact=True).click()
        expect(page.locator('#bb-learning-editor .status')).to_have_text('已保存', timeout=15000)
        page.get_by_role('button', name='关闭并保留草稿').click()
        report['checks'].append('note_saved_without_subtitle_or_ai')
        page.get_by_role('button', name='存书签', exact=True).click()
        expect(page.locator('#bb-learning-editor .source')).to_contain_text('0:02')
        page.locator('#bb-learning-editor').get_by_role('button', name='保存', exact=True).click()
        expect(page.locator('#bb-learning-editor .status')).to_have_text('已保存', timeout=15000)
        page.get_by_role('button', name='关闭并保留草稿').click()
        report['checks'].append('bookmark_saved_from_real_synthetic_video_position')
        dashboard = context.new_page()
        dashboard.goto('chrome-extension://' + extension_id + '/dashboard/index.html#learning-notes')
        expect(dashboard.locator('.learning-heading')).to_contain_text('2 条记录', timeout=15000)
        dashboard.get_by_role('button', name='先验证最小闭环', exact=False).click()
        expect(dashboard.locator('.learning-body')).to_contain_text('清晰的边界')
        dashboard.screenshot(path=str(RUN / 'learning-desktop.png'))
        dashboard.set_viewport_size({'width': 390, 'height': 844})
        dashboard.screenshot(path=str(RUN / 'learning-mobile-detail.png'))
        assert dashboard.evaluate('document.documentElement.scrollWidth <= innerWidth')
        dashboard.get_by_role('button', name='关闭详情').click()
        dashboard.screenshot(path=str(RUN / 'learning-mobile-list.png'))
        report['checks'].append('desktop_mobile_list_and_detail')
        page.close()
        dashboard.close()
        context.close()
        context = p.chromium.launch_persistent_context(str(PROFILE), channel='chromium', headless=True,
            viewport={'width': 1440, 'height': 900}, args=[
                '--disable-extensions-except=' + str(ROOT / 'dist'), '--load-extension=' + str(ROOT / 'dist'),
                '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost', '--no-first-run'])
        context.set_offline(True)
        dashboard = context.new_page()
        dashboard.goto('chrome-extension://' + extension_id + '/dashboard/index.html#learning-notes')
        expect(dashboard.locator('.learning-heading')).to_contain_text('2 条记录', timeout=15000)
        dashboard.get_by_role('button', name='先验证最小闭环', exact=False).click()
        expect(dashboard.locator('.learning-body')).to_contain_text('清晰的边界')
        report['checks'].append('full_browser_and_extension_restart_persistence')
        dashboard.get_by_role('button', name='删除', exact=True).click()
        dashboard.get_by_role('button', name='确认删除', exact=True).click()
        expect(dashboard.locator('.learning-heading')).to_contain_text('1 条记录')
        dashboard.reload()
        expect(dashboard.locator('.learning-heading')).to_contain_text('1 条记录')
        report['checks'].append('single_delete_and_reload')
        report['status'] = 'pass'
    except Exception as error:
        report['status'] = 'fail'
        report['errors'].append(str(error))
        if context:
            for index, page in enumerate(context.pages):
                try: print('LG1 failure DOM', page.locator('#bb-learning-editor').inner_text(timeout=1000))
                except Exception: pass
                try: page.screenshot(path=str(RUN / ('failure-' + str(index) + '.png')))
                except Exception: pass
        raise
    finally:
        if context: context.close()
        target = PROFILE.resolve()
        assert target.parent == (ROOT / 'release-artifacts' / 'lg1').resolve() and target.name.startswith('p-') and len(target.name) == 10
        assert RUN.resolve().parent == (ROOT / 'release-artifacts' / 'lg1').resolve()
        if target.exists(): shutil.rmtree(target)
        report['profileRemoved'] = not target.exists()
        (RUN / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({'run': str(RUN), **report}, ensure_ascii=False))
