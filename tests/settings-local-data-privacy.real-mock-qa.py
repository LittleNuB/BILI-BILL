from __future__ import annotations

import json
import mimetypes
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import unquote, urlparse

from playwright.sync_api import Page, Route, expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
DASHBOARD_INDEX = DIST / "dashboard" / "index.html"

QA_URL = "http://bili-bill-real-mock.test/dashboard/index.html#settings"

PUBLIC_CARD_TITLES = [
    "观看历史",
    "收藏与智能索引",
    "B站字幕正文",
    "摘要与亮点",
    "问答会话",
    "动态账单",
    "盲盒抽取记录",
]

DIAGNOSTIC_CATEGORY_TITLES = [
    *PUBLIC_CARD_TITLES,
    "本地 AI 设置",
]

FORBIDDEN_VISIBLE_TERMS = [
    "未消费",
    "猜你喜欢",
    "fallback",
    "transcript",
    "confidence",
    "sourceHash",
    "segmentId",
    "subtitle_url",
    "BVID",
    "CID",
]

FORBIDDEN_EXPORT_TERMS = [
    *FORBIDDEN_VISIBLE_TERMS,
    "Cookie",
    "profile",
    "login-state",
    "Key.txt",
    "apiKey",
    "userConfig",
    "sourceIdentity",
    "sourceIdentityKey",
    "syncStatus",
    "usageBytes",
    "bvid",
    "cid",
    "C:\\",
    "/Users/",
]


def main() -> None:
    ensure_dashboard_bundle()
    run_browser_qa()
    print("PASS settings-local-data-privacy.real-mock-qa")


def ensure_dashboard_bundle() -> None:
    if os.environ.get("BILI_BILL_REAL_MOCK_QA_SKIP_BUILD") == "1":
        if not DASHBOARD_INDEX.exists():
            raise AssertionError(
                "dist/dashboard/index.html is missing. Run npm run build or unset "
                "BILI_BILL_REAL_MOCK_QA_SKIP_BUILD."
            )
        return

    npm = "npm.cmd" if os.name == "nt" else "npm"
    result = subprocess.run(
        [npm, "run", "build"],
        cwd=ROOT,
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    if result.returncode != 0:
        raise AssertionError(
            "npm run build failed before real Settings QA could run:\n"
            + result.stdout[-8000:]
        )
    if not DASHBOARD_INDEX.exists():
        raise AssertionError("npm run build completed but dist/dashboard/index.html was not created.")


def run_browser_qa() -> None:
    with sync_playwright() as playwright:
        downloads_dir = Path(tempfile.mkdtemp(prefix="bili-bill-settings-real-qa-"))
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(
            accept_downloads=True,
            viewport={"width": 1280, "height": 820},
        )
        page = context.new_page()
        console_errors: list[str] = []
        page.on(
            "console",
            lambda message: console_errors.append(message.text) if message.type == "error" else None,
        )
        page.on("pageerror", lambda error: console_errors.append(str(error)))
        page.add_init_script(CHROME_MOCK_SCRIPT)
        page.route("**/*", route_dist_asset)

        try:
            page.goto(QA_URL, wait_until="networkidle")
            wait_for_settings(page)
            assert_settings_cards(page)
            assert_config_toggles(page, current_video=True, smart_favorites=False, dynamic_bill=True)
            assert_paused_creator_restore(page)
            assert_no_horizontal_overflow(page, "desktop settings")
            assert_no_forbidden_text(page.locator("body").inner_text(), FORBIDDEN_VISIBLE_TERMS, "settings page")
            assert_external_config_removal_resets_open_page(page)

            enable_smart_favorites_and_save(page)
            before_nav_reads = qa_state(page)["summaryRequestCount"]
            page.get_by_role("button", name="更多工具", exact=True).click()
            page.get_by_role("button", name="观看账单", exact=True).click()
            page.wait_for_function("!document.querySelector('.settings-page')")
            page.get_by_role("navigation").get_by_role("button", name="设置", exact=True).click()
            wait_for_settings(page)
            page.wait_for_function(
                "(before) => window.__BiliBillSettingsRealMockQa.state().summaryRequestCount > before",
                arg=before_nav_reads,
            )
            assert_config_toggles(page, current_video=True, smart_favorites=True, dynamic_bill=True)

            before_reload_reads = qa_state(page)["summaryRequestCount"]
            page.reload(wait_until="networkidle")
            wait_for_settings(page)
            page.wait_for_function(
                "(before) => window.__BiliBillSettingsRealMockQa.state().summaryRequestCount > before",
                arg=before_reload_reads,
            )
            assert_config_toggles(page, current_video=True, smart_favorites=True, dynamic_bill=True)
            assert_settings_cards(page)

            diagnostic = export_diagnostic_json(page, downloads_dir)
            assert_diagnostic_schema(diagnostic)
            exported = json.dumps(diagnostic, ensure_ascii=False)
            assert_no_forbidden_text(exported, FORBIDDEN_EXPORT_TERMS, "diagnostic export")

            assert_history_syncing_keeps_recent_time(page)
            assert_independent_category_clears(page)
            assert_metadata_only_category_clears(page)
            assert_category_clear_receipt_survives_refresh_failure(page)
            assert_clear_all_receipt_survives_refresh_failure(page)
            assert_clear_all_success(page)
            assert_clear_all_partial_failure_survives_refresh(page)

            page.set_viewport_size({"width": 375, "height": 812})
            wait_for_settings(page)
            assert_no_horizontal_overflow(page, "narrow settings")
            assert_no_forbidden_text(page.locator("body").inner_text(), FORBIDDEN_VISIBLE_TERMS, "narrow settings page")

            settings_console_errors = [
                error for error in console_errors
                if "settings" in error.lower()
                or "local-data" in error.lower()
                or "local data" in error.lower()
                or "runtime exception" in error.lower()
            ]
            if settings_console_errors:
                raise AssertionError(
                    "Settings-attributable console errors:\n" + "\n".join(settings_console_errors)
                )
        finally:
            context.close()
            browser.close()
            shutil.rmtree(downloads_dir, ignore_errors=True)


def route_dist_asset(route: Route) -> None:
    parsed = urlparse(route.request.url)
    path = unquote(parsed.path)
    if path in ("", "/"):
        path = "/dashboard/index.html"
    if path == "/favicon.ico":
        route.fulfill(status=204, body="")
        return

    target = safe_dist_path(path)
    if not target.exists() or not target.is_file():
        route.fulfill(status=404, body=f"Missing QA asset: {path}")
        return

    content_type = content_type_for(target)
    if target == DASHBOARD_INDEX:
        route.fulfill(
            status=200,
            body=target.read_text(encoding="utf-8"),
            content_type="text/html; charset=utf-8",
        )
    else:
        route.fulfill(status=200, path=str(target), content_type=content_type)


def safe_dist_path(url_path: str) -> Path:
    relative = Path(*[part for part in url_path.lstrip("/").split("/") if part])
    target = (DIST / relative).resolve()
    dist_root = DIST.resolve()
    if os.path.commonpath([str(dist_root), str(target)]) != str(dist_root):
        raise AssertionError(f"Refusing to serve path outside dist: {url_path}")
    return target


def content_type_for(path: Path) -> str:
    if path.suffix == ".js":
        return "text/javascript; charset=utf-8"
    if path.suffix == ".css":
        return "text/css; charset=utf-8"
    guessed, _ = mimetypes.guess_type(path.name)
    return guessed or "application/octet-stream"


def wait_for_settings(page: Page) -> None:
    expect(page.locator(".settings-page")).to_be_visible()
    expect(page.locator(".settings-data-card")).to_have_count(7)


def assert_settings_cards(page: Page) -> None:
    cards = page.locator(".settings-data-card")
    expect(cards).to_have_count(7)
    for title in PUBLIC_CARD_TITLES:
        expect(cards.filter(has_text=title).first).to_be_visible()

    blind_card = cards.filter(has_text="盲盒抽取记录").first
    expect(blind_card).to_be_visible()
    expect(blind_card.get_by_text("3 条")).to_be_visible()
    expect(blind_card.get_by_text("不提供单独开关或单独清理入口")).to_be_visible()
    if blind_card.locator("button, input, select, textarea").count() != 0:
        raise AssertionError("Blind-box public card must remain count-only without controls.")

    favorites_card = cards.filter(has_text="收藏与智能索引").first
    expect(favorites_card.get_by_text("已同步 4 个收藏夹", exact=False)).to_be_visible()


def assert_independent_category_clears(page: Page) -> None:
    cases = [
        ("清理观看历史", "观看历史", "0 条", "history"),
        ("清理收藏与索引", "收藏与智能索引", "0 条", "favorites"),
        ("清理字幕缓存", "B站字幕正文", "0 个来源", "currentVideoSubtitles"),
        ("清理摘要亮点缓存", "摘要与亮点", "0 个分P", "currentVideoSummaryHighlights"),
        ("清理问答会话", "问答会话", "0 个会话", "currentVideoQaSessions"),
        ("清理动态账单", "动态账单", "0 项", "dynamicBill"),
    ]
    cards = page.locator(".settings-data-card")
    for button_label, card_title, expected_value, category_id in cases:
        button = page.get_by_role("button", name=button_label, exact=True)
        expect(button).to_be_enabled()
        button.click()
        card = cards.filter(has_text=card_title).first
        expect(card.locator("strong")).to_have_text(expected_value)
        expect(button).to_be_disabled()
        expect(page.locator(".settings-alert-success")).to_contain_text("回读后为 0")
        if category_id not in qa_state(page)["clearedCategories"]:
            raise AssertionError(f"Production Settings did not request clear for {category_id}")

    expect(cards.filter(has_text="盲盒抽取记录").first.get_by_text("3 条")).to_be_visible()


def assert_history_syncing_keeps_recent_time(page: Page) -> None:
    page.evaluate("window.__BiliBillSettingsRealMockQa.reset({historySyncing: true})")
    page.reload(wait_until="networkidle")
    wait_for_settings(page)
    history_card = page.locator(".settings-data-card").filter(has_text="观看历史").first
    expect(history_card.locator("small")).to_contain_text("最近同步：")
    expect(history_card.locator("small")).to_contain_text("正在同步观看历史")

    page.evaluate("window.__BiliBillSettingsRealMockQa.reset()")
    page.reload(wait_until="networkidle")
    wait_for_settings(page)


def assert_paused_creator_restore(page: Page) -> None:
    pause_list = page.get_by_test_id("settings-dynamic-bill-pauses")
    expect(pause_list.get_by_text("当前暂停 1 位 UP", exact=True)).to_be_visible()
    expect(pause_list.get_by_text("名称暂不可用的 UP 主", exact=True)).to_be_visible()
    expect(pause_list).not_to_contain_text("9527")
    expect(pause_list.get_by_text("约 12 天后自动恢复", exact=False)).to_be_visible()
    pause_list.get_by_role("button", name="恢复提醒", exact=True).click()
    expect(pause_list.get_by_text("当前暂停 0 位 UP", exact=True)).to_be_visible()
    expect(pause_list.get_by_text("当前没有暂停提醒的 UP。", exact=True)).to_be_visible()
    expect(page.locator(".settings-alert-success")).to_contain_text("已恢复「名称暂不可用的 UP 主」的动态账单提醒")
    state = qa_state(page)
    if state["restoredCreatorMids"] != [9527]:
        raise AssertionError(f"Unexpected restored creator state: {state!r}")


def assert_external_config_removal_resets_open_page(page: Page) -> None:
    page.evaluate("window.__BiliBillSettingsRealMockQa.reset()")
    page.reload(wait_until="networkidle")
    wait_for_settings(page)

    page.evaluate("window.__BiliBillSettingsRealMockQa.emitRevisionOnlyClearEvent()")
    assert_config_toggles(page, current_video=True, smart_favorites=False, dynamic_bill=True)
    expect(page.get_by_text("Key 已保存", exact=True)).to_be_visible()
    notice = page.locator(".settings-alert-success")
    if notice.count() > 0 and "本地 AI 设置已清理" in (notice.text_content() or ""):
        raise AssertionError("A revision-only failed clear was presented as completed")
    if qa_state(page)["config"]["ai"]["apiKey"] != "stored-local-test-token":
        raise AssertionError("A revision-only failed clear changed the stored config fixture")

    page.evaluate("window.__BiliBillSettingsRealMockQa.reset()")
    page.reload(wait_until="networkidle")
    wait_for_settings(page)

    stale_smart_toggle = page.locator(".settings-toggle", has_text="智能收藏问答")
    stale_smart_toggle.click()
    expect(stale_smart_toggle.locator("input")).to_be_checked()
    page.evaluate("window.__BiliBillSettingsRealMockQa.removeUserConfigExternally(false)")
    page.get_by_role("button", name="保存设置", exact=True).click()
    expect(page.locator(".settings-alert-success")).to_contain_text("已在其他页面更新")
    state = qa_state(page)
    if state["updateConfigCount"] != 0 or state["config"]["ai"]["apiKey"] != "":
        raise AssertionError("A save raced ahead of delayed config-removal delivery")
    if state["configRequestCount"] < 2:
        raise AssertionError("Settings did not re-read the current config before saving")
    assert_config_toggles(page, current_video=False, smart_favorites=False, dynamic_bill=False)

    page.evaluate("window.__BiliBillSettingsRealMockQa.reset()")
    page.reload(wait_until="networkidle")
    wait_for_settings(page)
    racing_smart_toggle = page.locator(".settings-toggle", has_text="智能收藏问答")
    racing_smart_toggle.click()
    page.evaluate("window.__BiliBillSettingsRealMockQa.clearBeforeNextConfigUpdate()")
    page.get_by_role("button", name="保存设置", exact=True).click()
    expect(page.locator(".settings-alert-success")).to_contain_text("已在其他页面更新")
    state = qa_state(page)
    if state["updateConfigCount"] != 0 or state["rejectedUpdateConfigCount"] != 1:
        raise AssertionError("A completed clear between config read and update was not rejected")
    if state["config"]["ai"]["apiKey"] != "":
        raise AssertionError("A rejected stale update restored the cleared API key")
    assert_config_toggles(page, current_video=False, smart_favorites=False, dynamic_bill=False)

    page.evaluate("window.__BiliBillSettingsRealMockQa.reset()")
    page.reload(wait_until="networkidle")
    wait_for_settings(page)
    page.evaluate("window.__BiliBillSettingsRealMockQa.removeUserConfigExternally()")
    assert_config_toggles(page, current_video=False, smart_favorites=False, dynamic_bill=False)
    expect(page.locator(".settings-alert-success")).to_contain_text("当前表单已恢复默认状态")

    smart_toggle = page.locator(".settings-toggle", has_text="智能收藏问答")
    smart_toggle.click()
    page.get_by_role("button", name="保存设置", exact=True).click()
    page.wait_for_function(
        "window.__BiliBillSettingsRealMockQa.state().updateConfigCount === 1"
    )
    state = qa_state(page)
    if state["config"]["ai"]["apiKey"] != "":
        raise AssertionError("A cleared mock API key was restored by a stale Settings page")
    assert_config_toggles(page, current_video=False, smart_favorites=True, dynamic_bill=False)

    page.evaluate("window.__BiliBillSettingsRealMockQa.reset()")
    page.reload(wait_until="networkidle")
    wait_for_settings(page)


def assert_metadata_only_category_clears(page: Page) -> None:
    page.evaluate("window.__BiliBillSettingsRealMockQa.reset({metadataOnlyCategories: true})")
    page.reload(wait_until="networkidle")
    wait_for_settings(page)

    cases = [
        ("清理观看历史", "history", "清理前存在本地状态", "回读后已清空"),
        ("清理字幕缓存", "currentVideoSubtitles", "清理前共 1 项本地数据", "回读后为 0"),
        ("清理动态账单", "dynamicBill", "清理前存在本地状态", "回读后已清空"),
    ]
    for label, category_id, before_copy, after_copy in cases:
        button = page.get_by_role("button", name=label, exact=True)
        expect(button).to_be_enabled()
        button.click()
        expect(button).to_be_disabled()
        success = page.locator(".settings-alert-success")
        expect(success).to_contain_text(before_copy)
        expect(success).to_contain_text(after_copy)
        if category_id not in qa_state(page)["clearedCategories"]:
            raise AssertionError(f"Metadata-only category was not cleared: {category_id}")


def assert_category_clear_receipt_survives_refresh_failure(page: Page) -> None:
    page.evaluate(
        "window.__BiliBillSettingsRealMockQa.reset({failSummaryAfterCategoryClear: true})"
    )
    page.reload(wait_until="networkidle")
    wait_for_settings(page)

    page.get_by_role("button", name="清理观看历史", exact=True).click()
    expect(page.locator(".settings-alert-success")).to_contain_text("已清理观看历史")
    warning = page.locator(".settings-alert-error")
    expect(warning).to_contain_text("清理已完成并完成回读")
    expect(warning).to_contain_text("页面最新状态刷新失败")
    assert_no_forbidden_text(warning.inner_text(), ["QA_SUMMARY_REFRESH_FAILED"], "category refresh warning")


def assert_clear_all_receipt_survives_refresh_failure(page: Page) -> None:
    cases = [
        ("failSummaryAfterClearAll", "QA_SUMMARY_REFRESH_FAILED"),
        ("failConfigAfterClearAll", "QA_CONFIG_REFRESH_FAILED"),
    ]
    for option, raw_error in cases:
        page.evaluate(
            "(option) => window.__BiliBillSettingsRealMockQa.reset({[option]: true})",
            option,
        )
        page.reload(wait_until="networkidle")
        wait_for_settings(page)

        page.get_by_role("button", name="清理本地数据", exact=True).click()
        danger = page.locator(".settings-danger-box")
        danger.locator("input").fill("清理本地数据")
        danger.get_by_role("button", name="确认清理", exact=True).click()

        expect(page.locator(".settings-alert-success")).to_contain_text("已清理本地数据并完成回读")
        warning = page.locator(".settings-alert-error")
        expect(warning).to_contain_text("清理已完成并完成回读")
        expect(warning).to_contain_text("页面最新状态刷新失败")
        assert_no_forbidden_text(warning.inner_text(), [raw_error], "clear-all refresh warning")


def assert_clear_all_success(page: Page) -> None:
    page.evaluate("window.__BiliBillSettingsRealMockQa.reset()")
    page.reload(wait_until="networkidle")
    wait_for_settings(page)

    page.get_by_role("button", name="清理本地数据", exact=True).click()
    danger = page.locator(".settings-danger-box")
    expect(danger).to_be_visible()
    expect(danger).to_contain_text("当前视频主要文本选择")
    expect(danger).to_contain_text("浮窗状态")
    confirm = danger.get_by_role("button", name="确认清理", exact=True)
    expect(confirm).to_be_disabled()
    confirmation = danger.locator("input")
    confirmation.fill("清理")
    expect(confirm).to_be_disabled()
    confirmation.fill("清理本地数据")
    expect(confirm).to_be_enabled()
    confirm.click()

    expect(danger).to_be_hidden()
    success = page.locator(".settings-alert-success")
    expect(success).to_contain_text("已清理本地数据并完成回读")
    expect(success).to_contain_text("已完成类别：观看历史、收藏与智能索引、B站字幕正文")
    expect(success).not_to_contain_text("字幕正文 0 段")
    expect(success).to_contain_text("当前视频主要文本选择")
    expect(success).to_contain_text("浮窗状态")
    assert_config_toggles(page, current_video=False, smart_favorites=False, dynamic_bill=False)
    state = qa_state(page)
    if state["clearAllCount"] != 1:
        raise AssertionError(f"Production Settings did not request clear-all: {state!r}")
    expected_cleared = {
        "history",
        "favorites",
        "currentVideoSubtitles",
        "currentVideoSummaryHighlights",
        "currentVideoQaSessions",
        "dynamicBill",
        "blindBoxDrawHistory",
        "localSettings",
    }
    if set(state["clearedCategories"]) != expected_cleared:
        raise AssertionError(f"Clear-all did not cover every registered category: {state!r}")
    for value in ["0 条", "0 个来源", "0 个分P", "0 个会话", "0 项"]:
        expect(page.locator(".settings-data-card").get_by_text(value, exact=True).first).to_be_visible()


def assert_clear_all_partial_failure_survives_refresh(page: Page) -> None:
    page.evaluate(
        "window.__BiliBillSettingsRealMockQa.reset({"
        "nextClearAllMode: 'partial', failSummaryAfterClearAll: true})"
    )
    page.reload(wait_until="networkidle")
    wait_for_settings(page)

    page.get_by_role("button", name="清理本地数据", exact=True).click()
    danger = page.locator(".settings-danger-box")
    danger.locator("input").fill("清理本地数据")
    danger.get_by_role("button", name="确认清理", exact=True).click()

    failure = page.locator(".settings-alert-error")
    expect(failure).to_contain_text("以下类别清理失败：动态账单")
    expect(failure).to_contain_text("请稍后重试失败类别")
    assert_no_forbidden_text(failure.inner_text(), ["QA_SUMMARY_REFRESH_FAILED"], "partial clear failure")
    state = qa_state(page)
    if state["clearAllCount"] != 1 or state["failNextSummary"]:
        raise AssertionError(f"Partial clear refresh path did not execute as expected: {state!r}")


def assert_config_toggles(
    page: Page,
    *,
    current_video: bool,
    smart_favorites: bool,
    dynamic_bill: bool,
) -> None:
    expected = {
        "当前视频 AI 助手": current_video,
        "智能收藏问答": smart_favorites,
        "动态账单解释": dynamic_bill,
    }
    for title, checked in expected.items():
        toggle_input = page.locator(".settings-toggle", has_text=title).locator("input")
        if checked:
            expect(toggle_input).to_be_checked()
        else:
            expect(toggle_input).not_to_be_checked()


def enable_smart_favorites_and_save(page: Page) -> None:
    smart_toggle = page.locator(".settings-toggle", has_text="智能收藏问答")
    smart_toggle.click()
    expect(smart_toggle.locator("input")).to_be_checked()
    page.get_by_role("button", name="保存设置").click()
    page.wait_for_function(
        "window.__BiliBillSettingsRealMockQa.state().config.assistant.smartFavoritesQaAiEnabled === true"
    )
    expect(page.locator(".settings-alert-success", has_text="设置已保存")).to_be_visible()


def export_diagnostic_json(page: Page, downloads_dir: Path) -> dict:
    page.get_by_role("button", name="导出诊断摘要").click()
    dialog = page.get_by_role("dialog", name="确认导出诊断摘要")
    expect(dialog).to_be_visible()
    expect(dialog.get_by_text("诊断文件只会保存到本机，不会自动上传。", exact=True)).to_be_visible()
    expect(dialog.get_by_text("包含", exact=True)).to_be_visible()
    expect(dialog.get_by_text("不包含", exact=True)).to_be_visible()

    with page.expect_download() as download_info:
        dialog.get_by_role("button", name="确认导出").click()
    download = download_info.value
    target = downloads_dir / download.suggested_filename
    download.save_as(str(target))
    if not target.exists():
        raise AssertionError("Diagnostic download did not create a JSON file.")
    return json.loads(target.read_text(encoding="utf-8"))


def assert_diagnostic_schema(diagnostic: dict) -> None:
    assert_list_equal(
        list(diagnostic.keys()),
        ["导出时间", "应用", "隐私边界", "本地数据类别", "功能状态"],
        "diagnostic top-level keys",
    )
    assert_list_equal(list(diagnostic["应用"].keys()), ["产品", "诊断格式版本"], "diagnostic app keys")
    assert_list_equal(list(diagnostic["隐私边界"].keys()), ["包含", "不包含"], "privacy boundary keys")
    assert_list_equal(
        list(diagnostic["功能状态"].keys()),
        ["当前视频文本", "当前视频助手", "动态账单", "视频盲盒"],
        "diagnostic feature-state keys",
    )

    if diagnostic["应用"] != {"产品": "Bili-Bill", "诊断格式版本": 1}:
        raise AssertionError(f"Unexpected diagnostic app block: {diagnostic['应用']!r}")

    categories = diagnostic["本地数据类别"]
    if len(categories) != 8:
        raise AssertionError(f"Expected 8 diagnostic categories, got {len(categories)}")
    assert_list_equal(
        [category["类别"] for category in categories],
        DIAGNOSTIC_CATEGORY_TITLES,
        "diagnostic category labels",
    )
    for category in categories:
        assert_list_equal(list(category.keys()), ["类别", "数量", "占用字节"], "category keys")
        if not isinstance(category["数量"], int) or not isinstance(category["占用字节"], int):
            raise AssertionError(f"Category counts must be integers: {category!r}")

    includes = diagnostic["隐私边界"]["包含"]
    excludes = diagnostic["隐私边界"]["不包含"]
    if not any("数量" in item and "占用" in item for item in includes):
        raise AssertionError(f"Privacy include list is not aggregate-only enough: {includes!r}")
    for expected in ["完整记录", "登录状态", "密钥", "本地敏感路径", "内部字段"]:
        if not any(expected in item for item in excludes):
            raise AssertionError(f"Privacy exclude list missing {expected!r}: {excludes!r}")

    blind_box_state = diagnostic["功能状态"]["视频盲盒"]
    if blind_box_state != {"最近抽取": 3, "最多保留": 50}:
        raise AssertionError(f"Unexpected blind-box diagnostic state: {blind_box_state!r}")


def assert_no_horizontal_overflow(page: Page, label: str) -> None:
    overflow = page.evaluate(
        """() => Math.ceil(Math.max(
            document.documentElement.scrollWidth,
            document.body.scrollWidth
        ) - window.innerWidth)"""
    )
    if overflow > 1:
        raise AssertionError(f"{label} has horizontal overflow: {overflow}px")


def assert_no_forbidden_text(text: str, terms: list[str], label: str) -> None:
    lowered = text.lower()
    for term in terms:
        if term.lower() in lowered:
            raise AssertionError(f"{label} exposed forbidden term: {term}")


def qa_state(page: Page) -> dict:
    return page.evaluate("window.__BiliBillSettingsRealMockQa.state()")


def assert_list_equal(actual: list, expected: list, label: str) -> None:
    if actual != expected:
        raise AssertionError(f"{label} mismatch:\nactual:   {actual!r}\nexpected: {expected!r}")


CHROME_MOCK_SCRIPT = r"""
(() => {
  const STORE_KEY = 'bili-bill-settings-real-mock-qa-v1';
  const storageChangeListeners = new Set();
  const FIXED_NOW = 1718000000000;
  const CATEGORY_IDS = [
    'history',
    'favorites',
    'currentVideoSubtitles',
    'currentVideoSummaryHighlights',
    'currentVideoQaSessions',
    'dynamicBill',
    'blindBoxDrawHistory',
    'localSettings',
  ];
  const INDEPENDENT_CATEGORY_IDS = CATEGORY_IDS.slice(0, 6);
  const FIXTURE_PAUSE = {
    version: 'pause-9527-v1',
    creatorMid: 9527,
    creatorName: '',
    startedAt: FIXED_NOW - 3 * 86400000,
    expiresAt: FIXED_NOW + 12 * 86400000,
    source: 'user',
    remainingDays: 12,
  };

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function initialConfig() {
    return {
      dailyWatchGoal: 60,
      weeklyWatchGoal: 420,
      overDependencyThreshold: 0.3,
      syncIntervalMinutes: 5,
      retentionDays: 90,
      showSidebar: true,
      theme: 'dark',
      ai: {
        baseURL: 'https://api.example.test',
        apiKey: 'stored-local-test-token',
        chatModel: 'qa-model',
      },
      assistant: {
        currentVideoAiAssistantEnabled: true,
        smartFavoritesQaAiEnabled: false,
      },
      dynamicBill: {
        aiExplanationsEnabled: true,
      },
    };
  }

  function initialState() {
    return {
      config: initialConfig(),
      summaryRequestCount: 0,
      configRequestCount: 0,
      updateConfigCount: 0,
      rejectedUpdateConfigCount: 0,
      clearBeforeNextConfigUpdate: false,
      configRevisionCounter: 0,
      configRevision: {
        token: 'qa-config-revision-0',
        configPresent: true,
        mutation: 'state',
      },
      clearedCategories: [],
      restoredCreatorMids: [],
      clearAllCount: 0,
      nextClearAllMode: 'completed',
      failSummaryAfterCategoryClear: false,
      failSummaryAfterClearAll: false,
      failConfigAfterClearAll: false,
      failNextConfig: false,
      failNextSummary: false,
      metadataOnlyCategories: false,
      historySyncing: false,
    };
  }

  function clearedConfig() {
    const config = initialConfig();
    config.ai.baseURL = 'https://api.deepseek.com';
    config.ai.apiKey = '';
    config.ai.chatModel = 'deepseek-v4-flash';
    config.assistant.currentVideoAiAssistantEnabled = false;
    config.assistant.smartFavoritesQaAiEnabled = false;
    config.dynamicBill.aiExplanationsEnabled = false;
    return config;
  }

  function managedConfigMatches(observed, current) {
    return observed.ai.baseURL === current.ai.baseURL
      && observed.ai.chatModel === current.ai.chatModel
      && observed.ai.apiKey === current.ai.apiKey
      && observed.assistant.currentVideoAiAssistantEnabled === current.assistant.currentVideoAiAssistantEnabled
      && observed.assistant.smartFavoritesQaAiEnabled === current.assistant.smartFavoritesQaAiEnabled
      && observed.dynamicBill.aiExplanationsEnabled === current.dynamicBill.aiExplanationsEnabled;
  }

  function advanceConfigRevision(state, configPresent, mutation) {
    state.configRevisionCounter += 1;
    state.configRevision = {
      token: 'qa-config-revision-' + state.configRevisionCounter,
      configPresent,
      mutation,
    };
  }

  function loadState() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY)) || initialState();
    } catch {
      return initialState();
    }
  }

  function saveState(state) {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  }

  function summary(state) {
    state.summaryRequestCount += 1;
    const activeCreatorPauses = (state.restoredCreatorMids || []).includes(FIXTURE_PAUSE.creatorMid)
      ? []
      : [clone(FIXTURE_PAUSE)];
    const result = {
      checkedAt: FIXED_NOW,
      categories: [
        { id: 'history', label: '观看历史', count: 128, usageBytes: 4096 },
        { id: 'favorites', label: '收藏与智能索引', count: 24, usageBytes: 2048 },
        { id: 'currentVideoSubtitles', label: 'B站字幕正文', count: 3, usageBytes: 8192 },
        { id: 'currentVideoSummaryHighlights', label: '摘要与亮点', count: 2, usageBytes: 2048 },
        { id: 'currentVideoQaSessions', label: '问答会话', count: 1, usageBytes: 1024 },
        { id: 'dynamicBill', label: '动态账单', count: 9, usageBytes: 3072 },
        { id: 'blindBoxDrawHistory', label: '盲盒抽取记录', count: 3, usageBytes: 96 },
        { id: 'localSettings', label: '本地 AI 设置', count: 3, usageBytes: 512 },
      ],
      history: {
        totalRecords: 128,
        oldestViewAt: 1700000000,
        newestViewAt: 1718000000,
        lastSyncedAt: FIXED_NOW,
        syncing: state.historySyncing === true,
        backfillComplete: true,
      },
      favorites: {
        folderCount: 4,
        reportedItems: 28,
        storedItems: 24,
        indexedItems: 21,
        failedIndexItems: 1,
        pendingIndexItems: 2,
        incompleteFolders: 0,
        syncComplete: true,
        lastSyncedAt: FIXED_NOW,
        lastIndexedAt: FIXED_NOW,
      },
      currentVideoSubtitles: {
        sourceCount: 3,
        sourceIdentityCount: 3,
        segmentCount: 42,
        staleSegmentCount: 4,
        cachedVideoCount: 2,
        usageBytes: 8192,
        lastUpdatedAt: FIXED_NOW,
      },
      currentVideoSummaryHighlights: {
        cachedPartCount: 2,
        usageBytes: 2048,
        latestGeneratedAt: FIXED_NOW,
      },
      currentVideoQaSessions: {
        sessionCount: 1,
        usageBytes: 1024,
        latestUsedAt: FIXED_NOW,
      },
      dynamicBill: {
        activeFollowedCreatorCount: 12,
        followedVideoUpdateCount: 8,
        billItemCount: 6,
        rotationRecordCount: 4,
        creatorPauseCount: activeCreatorPauses.length,
        feedbackActionCount: 0,
        creatorFeedbackCount: 0,
        creatorReviewPromptCount: 0,
        activeCreatorPauses,
        unopenedItems: 2,
        openedItems: 1,
        consumedItems: 2,
        processedItems: 1,
        explanationCount: 5,
        lastGeneratedAt: FIXED_NOW,
        lastSyncedAt: FIXED_NOW,
        syncStatus: 'success',
      },
      blindBoxDrawHistory: {
        recentDrawCount: 3,
        maxRecentDraws: 50,
        usageBytes: 96,
        lastUpdatedAt: FIXED_NOW,
      },
    };
    if (state.metadataOnlyCategories) {
      const historyCategory = result.categories.find(category => category.id === 'history');
      const subtitleCategory = result.categories.find(category => category.id === 'currentVideoSubtitles');
      const dynamicBillCategory = result.categories.find(category => category.id === 'dynamicBill');
      Object.assign(historyCategory, { count: 0, usageBytes: 128 });
      Object.assign(subtitleCategory, { count: 1, usageBytes: 96 });
      Object.assign(dynamicBillCategory, { count: 0, usageBytes: 160 });
      Object.assign(result.history, {
        totalRecords: 0,
        oldestViewAt: null,
        newestViewAt: null,
      });
      Object.assign(result.currentVideoSubtitles, {
        sourceCount: 1,
        sourceIdentityCount: 1,
        segmentCount: 0,
        staleSegmentCount: 0,
        cachedVideoCount: 0,
        usageBytes: 96,
      });
      Object.assign(result.dynamicBill, {
        activeFollowedCreatorCount: 0,
        followedVideoUpdateCount: 0,
        billItemCount: 0,
        rotationRecordCount: 0,
        creatorPauseCount: 0,
        feedbackActionCount: 0,
        creatorFeedbackCount: 0,
        creatorReviewPromptCount: 0,
        activeCreatorPauses: [],
        unopenedItems: 0,
        openedItems: 0,
        consumedItems: 0,
        processedItems: 0,
        explanationCount: 0,
        lastGeneratedAt: null,
      });
    }
    const cleared = new Set(state.clearedCategories || []);
    for (const category of result.categories) {
      if (!cleared.has(category.id)) continue;
      category.count = 0;
      category.usageBytes = 0;
    }
    if (cleared.has('history')) {
      Object.assign(result.history, {
        totalRecords: 0,
        oldestViewAt: null,
        newestViewAt: null,
        lastSyncedAt: null,
      });
    }
    if (cleared.has('favorites')) {
      Object.assign(result.favorites, {
        folderCount: 0,
        reportedItems: 0,
        storedItems: 0,
        indexedItems: 0,
        failedIndexItems: 0,
        pendingIndexItems: 0,
        incompleteFolders: 0,
        syncComplete: false,
        lastSyncedAt: null,
        lastIndexedAt: null,
      });
    }
    if (cleared.has('currentVideoSubtitles')) {
      Object.assign(result.currentVideoSubtitles, {
        sourceCount: 0,
        sourceIdentityCount: 0,
        segmentCount: 0,
        staleSegmentCount: 0,
        cachedVideoCount: 0,
        usageBytes: 0,
        lastUpdatedAt: null,
      });
    }
    if (cleared.has('currentVideoSummaryHighlights')) {
      Object.assign(result.currentVideoSummaryHighlights, {
        cachedPartCount: 0,
        usageBytes: 0,
        latestGeneratedAt: null,
      });
    }
    if (cleared.has('currentVideoQaSessions')) {
      Object.assign(result.currentVideoQaSessions, {
        sessionCount: 0,
        usageBytes: 0,
        latestUsedAt: null,
      });
    }
    if (cleared.has('dynamicBill')) {
      Object.assign(result.dynamicBill, {
        activeFollowedCreatorCount: 0,
        followedVideoUpdateCount: 0,
        billItemCount: 0,
        rotationRecordCount: 0,
        creatorPauseCount: 0,
        feedbackActionCount: 0,
        creatorFeedbackCount: 0,
        creatorReviewPromptCount: 0,
        activeCreatorPauses: [],
        unopenedItems: 0,
        openedItems: 0,
        consumedItems: 0,
        processedItems: 0,
        explanationCount: 0,
        lastGeneratedAt: null,
        lastSyncedAt: null,
        syncStatus: 'idle',
      });
    }
    if (cleared.has('blindBoxDrawHistory')) {
      Object.assign(result.blindBoxDrawHistory, {
        recentDrawCount: 0,
        usageBytes: 0,
        lastUpdatedAt: null,
      });
    }
    return result;
  }

  function dashboardOverview() {
    return {
      weeklyWatchTime: 3600,
      monthlyWatchTime: 14400,
      weeklyChange: 0.12,
      monthlyChange: -0.05,
      avgCompletion: 0.68,
      streakDays: 3,
      streakStartDate: '2024-06-08',
      streakEndDate: '2024-06-10',
      longestStreak: 9,
      longestStreakStartDate: '2024-05-01',
      longestStreakEndDate: '2024-05-09',
      hourlyHeatmap: Array.from({ length: 24 }, (_, hour) =>
        Array.from({ length: 7 }, (_, day) => (hour + day) % 4 === 0 ? 20 : 0)
      ),
      efficiencyScore: 82,
      weekStart: '2024-06-03',
      weekEnd: '2024-06-09',
      monthStart: '2024-06-01',
      monthEnd: '2024-06-30',
      weeklyRecordCount: 12,
      monthlyRecordCount: 48,
      weeklyLocalPcWatchTime: 1200,
      weeklyLocalPcDays: 2,
      oldestRecordDate: '2024-05-01',
      newestRecordDate: '2024-06-10',
      historyCoverageStatus: 'complete',
      historyCoverageNote: '本地测试摘要覆盖到历史末尾。',
      streakTrustworthy: true,
      streakCoverageNote: '本地测试摘要足够判断连续天数。',
      historySyncDiagnostics: null,
    };
  }

  function deviceData() {
    return {
      breakdown: [
        { label: '手机', deviceType: 1, watchTime: 1800, videoCount: 8, avgCompletion: 0.7, percentage: 60 },
        { label: 'PC', deviceType: 3, watchTime: 1200, videoCount: 4, avgCompletion: 0.6, percentage: 40 },
      ],
      hourly: {
        mobile: Array.from({ length: 24 }, (_, hour) => hour === 21 ? 600 : 0),
        pc: Array.from({ length: 24 }, (_, hour) => hour === 22 ? 300 : 0),
      },
      deviceCompletion: { mobile: 0.7, pc: 0.6 },
    };
  }

  async function handleMessage(message) {
    const state = loadState();
    let data;
    switch (message.action) {
      case 'GET_SYNC_STATUS':
        data = {
          lastSyncTime: FIXED_NOW,
          totalRecords: 128,
          syncing: false,
          backfillComplete: true,
          syncProgress: null,
        };
        break;
      case 'GET_CONFIG':
        if (state.failNextConfig) {
          state.failNextConfig = false;
          saveState(state);
          return { success: false, error: 'QA_CONFIG_REFRESH_FAILED' };
        }
        state.configRequestCount += 1;
        data = clone(state.config);
        break;
      case 'GET_CONFIG_SNAPSHOT':
        if (state.failNextConfig) {
          state.failNextConfig = false;
          saveState(state);
          return { success: false, error: 'QA_CONFIG_REFRESH_FAILED' };
        }
        state.configRequestCount += 1;
        data = {
          config: clone(state.config),
          revision: state.configRevision.token,
        };
        break;
      case 'UPDATE_CONFIG':
        if (state.clearBeforeNextConfigUpdate) {
          state.clearBeforeNextConfigUpdate = false;
          state.config = clearedConfig();
          advanceConfigRevision(state, false, 'clear');
        }
        if (message.params && message.params.expectedConfig
            && (!managedConfigMatches(message.params.expectedConfig, state.config)
              || message.params.expectedConfigRevision !== state.configRevision.token)) {
          state.rejectedUpdateConfigCount += 1;
          saveState(state);
          return { success: false, error: 'LOCAL_SETTINGS_STALE_CONFIG' };
        }
        state.updateConfigCount += 1;
        state.config = {
          ...state.config,
          ai: {
            ...state.config.ai,
            ...(message.params && message.params.ai ? message.params.ai : {}),
          },
          assistant: {
            ...state.config.assistant,
            ...(message.params && message.params.assistant ? message.params.assistant : {}),
          },
          dynamicBill: {
            ...state.config.dynamicBill,
            ...(message.params && message.params.dynamicBill ? message.params.dynamicBill : {}),
          },
        };
        advanceConfigRevision(state, true, 'save');
        data = {
          config: clone(state.config),
          revision: state.configRevision.token,
        };
        break;
      case 'GET_LOCAL_DATA_PRIVACY_SUMMARY':
        if (state.failNextSummary) {
          state.failNextSummary = false;
          saveState(state);
          return { success: false, error: 'QA_SUMMARY_REFRESH_FAILED' };
        }
        data = summary(state);
        break;
      case 'CLEAR_LOCAL_DATA_CATEGORY': {
        const categoryId = message.params && message.params.categoryId;
        const before = summary(state);
        const category = before.categories.find(item => item.id === categoryId);
        if (!category || !INDEPENDENT_CATEGORY_IDS.includes(categoryId)) {
          saveState(state);
          return { success: false, error: 'LOCAL_DATA_CATEGORY_NOT_CLEARABLE' };
        }
        state.clearedCategories = [...new Set([...(state.clearedCategories || []), categoryId])];
        if (state.failSummaryAfterCategoryClear) {
          state.failNextSummary = true;
          state.failSummaryAfterCategoryClear = false;
        }
        data = {
          operation: 'clear_local_data_category',
          status: 'completed',
          completedAt: FIXED_NOW,
          cleared: {},
          categoryResults: {
            completed: [{
              id: category.id,
              label: category.label,
              beforeCount: category.count,
              beforeUsageBytes: category.usageBytes,
              afterCount: 0,
              afterUsageBytes: 0,
            }],
            failed: [],
          },
        };
        break;
      }
      case 'CLEAR_ALL_LOCAL_DATA': {
        if (!message.params || message.params.confirmation !== '清理本地数据') {
          saveState(state);
          return { success: false, error: 'LOCAL_DATA_CLEAR_CONFIRMATION_REQUIRED' };
        }
        const before = summary(state);
        const failedIds = state.nextClearAllMode === 'partial' ? ['dynamicBill'] : [];
        const completedIds = CATEGORY_IDS.filter(id => !failedIds.includes(id));
        state.clearAllCount += 1;
        state.clearedCategories = [...new Set([
          ...(state.clearedCategories || []),
          ...completedIds,
        ])];
        if (completedIds.includes('localSettings')) {
          state.config = clearedConfig();
          advanceConfigRevision(state, false, 'clear');
        }
        if (state.failSummaryAfterClearAll) {
          state.failNextSummary = true;
          state.failSummaryAfterClearAll = false;
        }
        if (state.failConfigAfterClearAll) {
          state.failNextConfig = true;
          state.failConfigAfterClearAll = false;
        }
        state.nextClearAllMode = 'completed';
        data = {
          operation: 'clear_all_local_data',
          status: failedIds.length > 0 ? 'partial_failure' : 'completed',
          completedAt: FIXED_NOW,
          cleared: { localSettings: completedIds.includes('localSettings') },
          categoryResults: {
            completed: before.categories
              .filter(category => completedIds.includes(category.id))
              .map(category => ({
                id: category.id,
                label: category.label,
                beforeCount: category.count,
                beforeUsageBytes: category.usageBytes,
                afterCount: 0,
                afterUsageBytes: 0,
              })),
            failed: before.categories
              .filter(category => failedIds.includes(category.id))
              .map(category => ({
                id: category.id,
                label: category.label,
                message: category.label + '清理失败，已完成的其他类别不会受影响。',
              })),
          },
        };
        break;
      }
      case 'RESTORE_DYNAMIC_BILL_CREATOR_REMINDER': {
        const creatorMid = Number(message.params && message.params.creatorMid);
        const pauseVersion = String(message.params && message.params.pauseVersion || '');
        if ((state.restoredCreatorMids || []).includes(creatorMid)) {
          data = { status: 'not_found' };
          break;
        }
        if (creatorMid !== FIXTURE_PAUSE.creatorMid || pauseVersion !== FIXTURE_PAUSE.version) {
          data = { status: 'stale', currentPause: clone(FIXTURE_PAUSE) };
          break;
        }
        state.restoredCreatorMids = [...new Set([
          ...(state.restoredCreatorMids || []),
          creatorMid,
        ])];
        data = { status: 'restored', pause: clone(FIXTURE_PAUSE) };
        break;
      }
      case 'GET_DASHBOARD_DATA':
        data = dashboardOverview();
        break;
      case 'GET_DEVICE_DATA':
        data = deviceData();
        break;
      case 'EXPORT_DATA_PAGE':
        data = { records: [], total: 0, offset: 0, nextOffset: 0, hasMore: false };
        break;
      case 'TEST_AI_CONNECTION':
        data = { ok: true, model: state.config.ai.chatModel, checkedAt: FIXED_NOW, latencyMs: 12 };
        break;
      default:
        saveState(state);
        return { success: false, error: 'QA mock does not implement action: ' + message.action };
    }
    saveState(state);
    return { success: true, data };
  }

  window.chrome = {
    runtime: {
      sendMessage: handleMessage,
      getURL: path => path,
    },
    storage: {
      onChanged: {
        addListener(listener) {
          storageChangeListeners.add(listener);
        },
        removeListener(listener) {
          storageChangeListeners.delete(listener);
        },
      },
      local: {
        async get() {
          return {};
        },
        async set() {},
      },
    },
    permissions: {
      contains(_options, callback) {
        callback(true);
      },
      request(_options, callback) {
        callback(true);
      },
    },
  };

  window.__BiliBillSettingsRealMockQa = {
    state() {
      return clone(loadState());
    },
    reset(options = {}) {
      const state = { ...initialState(), ...clone(options) };
      saveState(state);
      return clone(state);
    },
    removeUserConfigExternally(emitChange = true) {
      const state = loadState();
      const oldValue = clone(state.config);
      const oldRevision = clone(state.configRevision);
      state.config = clearedConfig();
      advanceConfigRevision(state, false, 'clear');
      saveState(state);
      if (emitChange) {
        for (const listener of storageChangeListeners) {
          listener({
            userConfig: { oldValue, newValue: undefined },
            userConfigRevision: { oldValue: oldRevision, newValue: clone(state.configRevision) },
          }, 'local');
        }
      }
      return clone(state);
    },
    clearBeforeNextConfigUpdate() {
      const state = loadState();
      state.clearBeforeNextConfigUpdate = true;
      saveState(state);
      return clone(state);
    },
    emitRevisionOnlyClearEvent() {
      const state = loadState();
      const failedClearRevision = {
        token: 'qa-failed-clear-revision',
        configPresent: false,
        mutation: 'clear',
      };
      for (const listener of storageChangeListeners) {
        listener({
          userConfigRevision: {
            oldValue: clone(state.configRevision),
            newValue: failedClearRevision,
          },
        }, 'local');
      }
      return clone(state);
    },
  };

  if (!localStorage.getItem(STORE_KEY)) {
    saveState(initialState());
  }
})();
"""


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"FAIL settings-local-data-privacy.real-mock-qa: {error}", file=sys.stderr)
        raise
