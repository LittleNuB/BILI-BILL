import hashlib
import json
import shutil
import subprocess
import uuid
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
RUN = ROOT / 'release-artifacts' / 'lg1' / ('source-' + str(uuid.uuid4()))
PROFILE = ROOT / 'release-artifacts' / 'lg1' / ('p-' + uuid.uuid4().hex[:8])
URL = 'https://www.bilibili.com/video/BV1xx411c7mD/'
HTML = (ROOT / 'tests/learning-save.mock.html').read_text(encoding='utf-8')
RUN.mkdir(parents=True)
report = {'kind': 'synthetic-provider-real-extension', 'checks': [], 'errors': []}
report['sourceCommit'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
report['workingTreeDirty'] = bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True).strip())
report['distSha256'] = {str(path.relative_to(ROOT / 'dist')).replace('\\', '/'): hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted((ROOT / 'dist').rglob('*')) if path.is_file()}

with sync_playwright() as p:
    context = None
    try:
        context = p.chromium.launch_persistent_context(str(PROFILE), channel='chromium', headless=True, viewport={'width': 1440, 'height': 900}, args=[
            '--disable-extensions-except=' + str(ROOT / 'dist'), '--load-extension=' + str(ROOT / 'dist'), '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost', '--no-first-run'])
        context.set_offline(True)
        context.route('**/*', lambda route: route.fulfill(status=200, content_type='text/html', body=HTML) if route.request.url.startswith(URL) else route.continue_() if route.request.url.startswith('chrome-extension:') else route.abort())
        worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
        worker.evaluate((ROOT / 'tests/learning-source-provider.js').read_text(encoding='utf-8'))
        extension_id = worker.url.split('/')[2]
        dashboard = context.new_page()
        dashboard.goto('chrome-extension://' + extension_id + '/dashboard/index.html#learning-notes')
        config = dashboard.evaluate("async () => { const snapshot = await chrome.runtime.sendMessage({ action: 'GET_CONFIG_SNAPSHOT' }); return chrome.runtime.sendMessage({ action: 'UPDATE_CONFIG', params: { ai: { baseURL: 'https://api.openai.com/v1', apiKey: 'synthetic-not-a-secret', chatModel: 'synthetic-fixed-provider' }, assistant: { currentVideoAiAssistantEnabled: true }, expectedConfig: snapshot.data.config, expectedConfigRevision: snapshot.data.revision } }); }")
        assert config['success'], config
        page = context.new_page()
        page.on('pageerror', lambda error: report['errors'].append(str(error)))
        page.goto(URL, wait_until='domcontentloaded')
        page.wait_for_selector('html[data-video-ready=true]', timeout=25000)
        page.get_by_role('button', name='展开助手', exact=True).click()
        assert worker.evaluate('self.syntheticLearningRequests.ai') == 0
        page.get_by_label('主要文本来源', exact=True).click()
        page.get_by_role('button', name='重新检测字幕', exact=True).click()
        expect(page.get_by_role('button', name='生成摘要与亮点', exact=True)).to_be_enabled(timeout=20000)
        page.get_by_label('主要文本来源', exact=True).click()
        page.get_by_role('button', name='生成摘要与亮点', exact=True).click()
        expect(page.get_by_role('button', name='保存摘要', exact=True)).to_be_visible(timeout=20000)

        def save(label, title):
            page.get_by_role('button', name=label, exact=True).click()
            expect(page.locator('#bb-learning-editor .source')).to_contain_text('从想法到可用产品', timeout=15000)
            page.get_by_label('标题', exact=True).fill(title)
            page.locator('#bb-learning-editor').get_by_role('button', name='保存', exact=True).click()
            expect(page.locator('#bb-learning-editor .status')).to_have_text('已保存', timeout=20000)
            page.get_by_role('button', name='关闭并保留草稿', exact=True).click()

        save('保存摘要', '学习闭环摘要')
        page.get_by_role('tab', name='亮点', exact=True).click()
        save('保存亮点', '关键亮点')
        page.get_by_role('tab', name='字幕', exact=True).click()
        page.locator('.bdc-assistant-subtitle-row').first.click()
        save('保存这句字幕', '原句摘录')
        page.get_by_role('tab', name='问答', exact=True).click()
        page.get_by_label('向当前视频提问', exact=True).fill('如何形成学习闭环？')
        page.get_by_role('button', name='提问', exact=True).click()
        expect(page.get_by_role('button', name='保存答案', exact=True)).to_be_visible(timeout=20000)
        save('保存答案', '学习方法回答')
        page.screenshot(path=str(RUN / 'answer-saved.png'))
        dashboard.reload()
        expect(dashboard.locator('.learning-heading')).to_contain_text('4 条记录', timeout=15000)
        for title in ['学习闭环摘要', '关键亮点', '原句摘录', '学习方法回答']:
            dashboard.get_by_role('button', name=title, exact=False).click()
            expect(dashboard.locator('.learning-snapshot')).to_contain_text('保存时的内容')
        dashboard.screenshot(path=str(RUN / 'saved-source-detail.png'))
        counts = worker.evaluate('self.syntheticLearningRequests')
        assert counts['ai'] == 2, counts
        report['providerRequests'] = counts
        report['checks'] += ['no_implicit_ai', 'real_summary_highlights_subtitle_answer_save', 'saved_source_body_and_citations_readback']
        for width in [1440, 390]:
            dashboard.set_viewport_size({'width': width, 'height': 900})
            for index in range(dashboard.locator('.bb-nav-item').count()):
                item = dashboard.locator('.bb-nav-item').nth(index)
                label = item.inner_text()
                item.click()
                dashboard.wait_for_timeout(250)
                assert dashboard.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), label
                dashboard.screenshot(path=str(RUN / ('dashboard-' + str(width) + '-' + str(index) + '.png')), full_page=True)
        report['checks'].append('all_dashboard_pages_desktop_mobile_no_horizontal_overflow')
        report['status'] = 'pass'
    except Exception as error:
        report['status'] = 'fail'; report['errors'].append(str(error))
        if context:
            for index, page in enumerate(context.pages):
                try: page.screenshot(path=str(RUN / ('failure-' + str(index) + '.png')))
                except Exception: pass
        raise
    finally:
        if context: context.close()
        target = PROFILE.resolve()
        assert target.parent == (ROOT / 'release-artifacts/lg1').resolve() and target.name.startswith('p-') and len(target.name) == 10
        if target.exists(): shutil.rmtree(target)
        report['profileRemoved'] = not target.exists()
        (RUN / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({'run': str(RUN), **{key: value for key, value in report.items() if key != 'distSha256'}}, ensure_ascii=True))
