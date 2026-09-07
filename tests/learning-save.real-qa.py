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

def learning_snapshot(page):
    # This page belongs only to this run's new, synthetic extension profile.
    return page.evaluate("""async () => {
        const database = await new Promise((resolve, reject) => { const r = indexedDB.open('BiliAnalyticsDB'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
        try {
            const transaction = database.transaction(['lgAssets', 'lgMeta'], 'readonly');
            const read = name => new Promise((resolve, reject) => { const r = transaction.objectStore(name).getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
            return JSON.stringify(await Promise.all([read('lgAssets'), read('lgMeta')]));
        } finally { database.close(); }
    }""")

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
        page.get_by_label('笔记', exact=True).fill('取消与草稿验证')
        page.keyboard.press('Escape')
        expect(page.locator('#bb-learning-editor')).to_have_count(0)
        page.get_by_role('button', name='记笔记', exact=True).click()
        expect(page.get_by_label('笔记', exact=True)).to_have_value('取消与草稿验证')
        expect(page.locator('#bb-learning-editor').get_by_role('button', name='保存', exact=True)).to_be_enabled()
        # Only the isolated test worker delays its normal page check, making cancellation observable.
        worker.evaluate("""() => {
            globalThis.__lg1Send = chrome.tabs.sendMessage.bind(chrome.tabs);
            chrome.tabs.sendMessage = async (...args) => {
                if (args[1]?.action === 'CHECK_LEARNING_CONTEXT') await new Promise(r => setTimeout(r, 1200));
                return globalThis.__lg1Send(...args);
            };
        }""")
        page.locator('#bb-learning-editor').get_by_role('button', name='保存', exact=True).click()
        page.get_by_role('button', name='取消保存', exact=True).click()
        expect(page.locator('#bb-learning-editor .status')).to_contain_text('已取消', timeout=15000)
        expect(page.get_by_label('笔记', exact=True)).to_have_value('取消与草稿验证')
        worker.evaluate('() => { chrome.tabs.sendMessage = globalThis.__lg1Send; delete globalThis.__lg1Send; }')
        probe = context.new_page()
        probe.goto('chrome-extension://' + extension_id + '/dashboard/index.html#learning-notes')
        expect(probe.locator('.learning-heading')).to_contain_text('0 条记录', timeout=15000)
        probe.wait_for_timeout(2100)
        probe.reload()
        expect(probe.locator('.learning-heading')).to_contain_text('0 条记录')
        probe.close()
        report['checks'].append('cancel_no_write_after_2s_and_escape_preserves_draft')
        page.evaluate("history.pushState({}, '', '?p=2')")
        page.locator('#bb-learning-editor').get_by_role('button', name='保存', exact=True).click()
        expect(page.locator('#bb-learning-editor .status')).to_contain_text('已变化', timeout=15000)
        expect(page.get_by_label('笔记', exact=True)).to_have_value('取消与草稿验证')
        expect(page.locator('#bb-learning-editor').get_by_role('button', name='保存', exact=True)).to_be_disabled()
        page.evaluate("""() => { history.pushState({}, '', location.pathname); document.body.append(document.createElement('hr')); }""")
        expect(page.locator('#bdc-current-video-assistant').get_by_role('button', name='记笔记', exact=True)).to_be_visible(timeout=15000)
        page.get_by_role('button', name='重新确认当前视频', exact=True).click()
        expect(page.locator('#bb-learning-editor .status')).to_contain_text('已重新确认', timeout=15000)
        report['checks'].append('stale_part_rejected_draft_retained_explicit_recapture')
        page.get_by_label('标题', exact=True).fill('先验证最小闭环')
        page.get_by_label('笔记', exact=True).fill('先把保存、重开和找回做成可用流程，再增加自动化。\n清晰的边界与失败反馈也是产品的一部分。')
        page.screenshot(path=str(RUN / 'note-editor-desktop.png'))
        page.locator('#bb-learning-editor').get_by_role('button', name='保存', exact=True).click()
        expect(page.locator('#bb-learning-editor .status')).to_have_text('已保存', timeout=15000)
        with context.expect_page() as opened:
            page.locator('#bb-learning-editor').get_by_role('link', name='学习笔记', exact=True).click()
        linked = opened.value
        expect(linked.locator('.learning-heading')).to_contain_text('1 条记录', timeout=15000)
        linked.close()
        report['checks'].append('editor_link_opens_real_learning_dashboard')
        page.get_by_role('button', name='关闭并保留草稿').click()
        report['checks'].append('note_saved_without_subtitle_or_ai')
        page.get_by_role('button', name='存书签', exact=True).click()
        expect(page.locator('#bb-learning-editor .source')).to_contain_text('0:02')
        page.evaluate("window.player = { getVideoInfo: () => ({ bvid: 'BV1xx411c7mD', cid: 456, p: 1 }) }")
        page.locator('#bb-learning-editor').get_by_role('button', name='保存', exact=True).click()
        expect(page.locator('#bb-learning-editor .status')).to_contain_text('已变化', timeout=15000)
        page.evaluate('delete window.player')
        page.get_by_role('button', name='重新确认当前视频', exact=True).click()
        expect(page.locator('#bb-learning-editor .status')).to_contain_text('已重新确认', timeout=15000)
        report['checks'].append('same_url_same_element_live_player_cid_change_rejected')
        page.locator('#bb-learning-editor').get_by_role('button', name='保存', exact=True).click()
        expect(page.locator('#bb-learning-editor .status')).to_have_text('已保存', timeout=15000)
        page.get_by_role('button', name='关闭并保留草稿').click()
        report['checks'].append('bookmark_saved_from_real_synthetic_video_position')
        dashboard = context.new_page()
        dashboard.goto('chrome-extension://' + extension_id + '/dashboard/index.html#learning-notes')
        expect(dashboard.locator('.learning-heading')).to_contain_text('2 条记录', timeout=15000)
        expect(dashboard.locator('.bb-export-actions')).to_have_count(0)
        dashboard.get_by_role('button', name='先验证最小闭环', exact=False).click()
        expect(dashboard.locator('.learning-body')).to_contain_text('清晰的边界')
        dashboard.screenshot(path=str(RUN / 'learning-desktop.png'))
        dashboard.set_viewport_size({'width': 390, 'height': 844})
        dashboard.reload()
        expect(dashboard.locator('.learning-heading')).to_contain_text('2 条记录', timeout=15000)
        dashboard.get_by_role('button', name='先验证最小闭环', exact=False).click()
        expect(dashboard.locator('.bb-nav-item[aria-current=page]')).to_be_in_viewport()
        dashboard.screenshot(path=str(RUN / 'learning-mobile-detail.png'))
        assert dashboard.evaluate('document.documentElement.scrollWidth <= innerWidth')
        dashboard.get_by_role('button', name='关闭详情').click()
        dashboard.screenshot(path=str(RUN / 'learning-mobile-list.png'))
        report['checks'].append('desktop_mobile_list_and_detail')
        dashboard.set_viewport_size({'width': 1440, 'height': 900})
        dashboard.get_by_role('button', name='0:02 的书签', exact=False).click()
        count_before_preview = len(context.pages)
        dashboard.get_by_role('button', name='回看来源', exact=True).click()
        expect(dashboard.get_by_role('region', name='来源预览')).to_contain_text('0:02')
        assert len(context.pages) == count_before_preview
        context.route(URL + '?p=1', lambda route: route.fulfill(status=200, content_type='text/html', body=HTML.replace('video.currentTime = 2;', 'video.currentTime = 1;')))
        with context.expect_page() as opened:
            dashboard.get_by_role('button', name='确认打开来源', exact=True).click()
        source_page = opened.value
        # Extension-created tabs can start their first request before Playwright attaches.
        # Load the same synthetic URL through the owned route, never enable external access.
        source_page.goto(URL + '?p=1', wait_until='domcontentloaded')
        expect(dashboard.locator('.learning-notice')).to_contain_text('已定位到保存的位置', timeout=30000)
        assert abs(source_page.locator('video').evaluate('(video) => video.currentTime') - 2) < 0.2
        dashboard.get_by_role('button', name='返回笔记与原位置', exact=True).click()
        expect(dashboard.locator('.learning-notice')).to_contain_text('已返回')
        assert abs(source_page.locator('video').evaluate('(video) => video.currentTime') - 1) < 0.2
        source_page.close()
        report['checks'].append('source_preview_no_navigation_confirm_seek_and_return_original_position')
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
        before_clear = learning_snapshot(dashboard)
        result = dashboard.evaluate("() => chrome.runtime.sendMessage({action: 'CLEAR_CURRENT_VIDEO_SUBTITLE_CACHE'})")
        assert result['success'] and result['data']['status'] == 'completed', result
        assert learning_snapshot(dashboard) == before_clear
        result = dashboard.evaluate("() => chrome.runtime.sendMessage({action: 'CANCEL_SYNC'})")
        assert result['success'], result
        for attempt in range(50):
            sync = dashboard.evaluate("() => chrome.runtime.sendMessage({action: 'GET_SYNC_STATUS'})")
            if sync['success'] and not sync['data']['syncProgress']['syncing']: break
            dashboard.wait_for_timeout(200)
        else: raise AssertionError('Synthetic startup sync did not stop before the ordinary reset test')
        result = dashboard.evaluate("() => chrome.runtime.sendMessage({action: 'CLEAR_ALL_LOCAL_DATA', params: {confirmation: '清理本地数据'}})")
        assert result['success'] and result['data']['status'] == 'completed', result
        assert learning_snapshot(dashboard) == before_clear
        report['checks'].append('ordinary_cache_clear_and_settings_reset_preserve_full_learning_tables')
        dashboard.get_by_role('button', name='编辑笔记', exact=True).click()
        dashboard.get_by_label('编辑标签', exact=True).fill('面试\n学习闭环')
        dashboard.get_by_role('button', name='保存修改', exact=True).click()
        expect(dashboard.locator('.learning-tags')).to_contain_text('面试')
        dashboard.get_by_label('搜索已保存内容', exact=True).fill('面试')
        expect(dashboard.locator('.learning-row')).to_have_count(1)
        dashboard.get_by_label('笔记类型', exact=True).select_option('bookmark')
        expect(dashboard.locator('.learning-row')).to_have_count(0)
        dashboard.get_by_label('笔记类型', exact=True).select_option('')
        dashboard.get_by_label('搜索已保存内容', exact=True).fill('')
        expect(dashboard.locator('.learning-row')).to_have_count(2)
        report['checks'].append('personal_edit_tags_and_saved_search_filters')
        dashboard.locator('.learning-backup > summary').click()
        with dashboard.expect_download() as download:
            dashboard.get_by_role('button', name='导出备份', exact=True).click()
        backup_path = RUN / 'synthetic-learning-backup.json'
        download.value.save_as(str(backup_path))
        before_import = learning_snapshot(dashboard)
        dashboard.get_by_label('选择学习备份', exact=True).set_input_files(str(backup_path))
        expect(dashboard.get_by_role('region', name='恢复预览')).to_contain_text('新增 0 条')
        dashboard.get_by_role('button', name='确认恢复', exact=True).click()
        expect(dashboard.locator('.learning-backup')).to_contain_text('已恢复，新增 0 条')
        assert learning_snapshot(dashboard) == before_import
        dashboard.get_by_role('button', name='清空学习笔记', exact=True).click()
        dashboard.get_by_label('输入清空确认', exact=True).fill('清空学习笔记')
        dashboard.get_by_role('button', name='确认清空', exact=True).click()
        expect(dashboard.locator('.learning-heading')).to_contain_text('0 条记录')
        dashboard.get_by_label('选择学习备份', exact=True).set_input_files(str(backup_path))
        expect(dashboard.get_by_role('region', name='恢复预览')).to_contain_text('新增 2 条')
        dashboard.get_by_role('button', name='确认恢复', exact=True).click()
        expect(dashboard.locator('.learning-heading')).to_contain_text('2 条记录')
        assert json.loads(learning_snapshot(dashboard))[0] == json.loads(before_import)[0]
        dashboard.screenshot(path=str(RUN / 'learning-backup-restored.png'))
        report['checks'].append('real_extension_worker_export_idempotent_restore_clear_and_restore_full_rows')
        dashboard.get_by_role('button', name='先验证最小闭环', exact=False).click()
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
        print(json.dumps({'run': str(RUN), **{key: report[key] for key in ['status', 'checks', 'errors', 'profileRemoved', 'sourceCommit', 'workingTreeDirty']}}, ensure_ascii=False))
