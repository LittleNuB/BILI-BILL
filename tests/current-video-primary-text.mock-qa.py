from pathlib import Path
import os
import subprocess
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
MOCK_HTML = ROOT / "tests" / "current-video-assistant-shell.mock.html"
MOCK_URL = "https://www.bilibili.com/video/BV1ShellMock9"
PLAYER_MONITOR_BUNDLE = ROOT / "dist" / "content" / "player-monitor.js"
FORBIDDEN_VISIBLE_TERMS = [
    "未消费",
    "猜你喜欢",
    "fallback",
    "transcript",
    "confidence",
    "sourceHash",
    "segmentId",
    "subtitle_url",
    "document is not defined",
    "MOCK_PRIMARY_TEXT_STORAGE_READ_FAILED",
    "MOCK_PRIMARY_TEXT_STORAGE_WRITE_FAILED",
    "MOCK_PRIMARY_TEXT_STORAGE_READBACK_FAILED",
    "MOCK_SEGMENT_BACKEND_RAW_FAILURE",
]
FORBIDDEN_ASSISTANT_IDENTITY_TERMS = [
    "BVID",
    "CID",
    "BV1ShellMock9",
    "BV1OtherMock8",
    "BV1RawLeak99",
    "2202",
    "3303",
    "4404",
]
FULL_TEXT_OR_SEARCH_ACTIONS = {
    "GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS",
    "GET_VIDEO_KNOWLEDGE",
    "ASK_CURRENT_VIDEO_FULL_TEXT",
}


def route_mock(route):
    request = route.request
    parsed = urlparse(request.url)
    path = parsed.path
    if path.startswith("/video/"):
        route.fulfill(
            status=200,
            content_type="text/html; charset=utf-8",
            body=MOCK_HTML.read_text(encoding="utf-8"),
        )
        return

    local_path = ROOT / path.lstrip("/")
    if local_path.exists() and local_path.is_file():
        content_type = "application/javascript; charset=utf-8" if local_path.suffix == ".js" else "text/plain; charset=utf-8"
        route.fulfill(
            status=200,
            content_type=content_type,
            body=local_path.read_bytes(),
        )
        return

    route.fulfill(status=404, body="not found")


def build_player_monitor_bundle():
    npm = "npm.cmd" if os.name == "nt" else "npm"
    command = [npm, "exec", "--", "vite", "build", "--config", "vite.player-monitor.config.ts"]
    result = subprocess.run(
        command,
        cwd=ROOT,
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=120,
    )
    if result.returncode != 0:
        raise AssertionError(f"player-monitor content bundle build failed:\n{result.stdout}")
    if not PLAYER_MONITOR_BUNDLE.exists():
        raise AssertionError(f"player-monitor content bundle was not generated: {PLAYER_MONITOR_BUNDLE}")


def message_actions(page):
    return page.evaluate("[...(window.__assistantMockMessages || [])].map((message) => message.action)")


def last_message_for(page, action):
    return page.evaluate(
        """(action) => {
            const messages = window.__assistantMockMessages || [];
            return [...messages].reverse().find((message) => message.action === action) || null;
        }""",
        action,
    )


def message_count_for(page, action):
    return page.evaluate(
        """(action) => (window.__assistantMockMessages || [])
            .filter((message) => message.action === action).length""",
        action,
    )


def current_video_context_updates(page):
    return page.evaluate(
        """() => (window.__assistantMockMessages || [])
            .filter((message) => message.action === "CURRENT_VIDEO_CONTEXT_UPDATE")
            .map((message) => message.payload)"""
    )


def assert_no_full_text_or_search(page):
    actions = message_actions(page)
    leaked = [action for action in actions if action in FULL_TEXT_OR_SEARCH_ACTIONS]
    assert leaked == [], f"unexpected user-action request before interaction: {leaked}"


def assert_clean_visible_text(page):
    assert "GET_CURRENT_VIDEO_SUMMARY" not in message_actions(page), "legacy bounded summary route was called"
    text = page.locator("body").inner_text()
    for term in FORBIDDEN_VISIBLE_TERMS:
        assert term not in text, f"visible raw term leaked: {term}"
    for term in FORBIDDEN_ASSISTANT_IDENTITY_TERMS:
        assert term not in text, f"visible current-video identity leaked: {term}"


def assert_no_horizontal_overflow(page):
    overflow = page.evaluate("document.documentElement.scrollWidth > window.innerWidth + 1")
    assert not overflow, "page has horizontal overflow"


def open_source_details(page):
    details = page.locator(".bdc-assistant-source-details")
    if not details.evaluate("(element) => element.open"):
        details.locator("summary").first.click()


def expand_assistant(page):
    page.get_by_role("button", name="展开助手", exact=True).click()
    # These legacy flows exercise source controls; UX QA covers default closure.
    open_source_details(page)


def source_refresh_button(page):
    open_source_details(page)
    return page.get_by_role("button", name="重新检测字幕").first


def select_assistant_tab(page, name):
    page.get_by_role("tab", name=name).click()


def run_flow(page):
    page.route("**/*", route_mock)
    page.goto(MOCK_URL)
    expect(page.locator("#bdc-current-video-assistant")).to_be_visible()
    expect(page.get_by_role("button", name="展开助手", exact=True)).to_be_visible()
    assert_no_full_text_or_search(page)

    expand_assistant(page)
    expect(page.get_by_text("主要文本来源").first).to_be_visible()
    expect(page.get_by_text("本地转录")).to_have_count(0)
    expect(page.get_by_text("暂不可用", exact=True)).to_have_count(0)
    expect(page.get_by_text("问这个视频", exact=True)).to_have_count(0)
    select_assistant_tab(page, "问答")
    expect(page.get_by_text("问这个视频", exact=True)).to_be_visible()
    assert_no_full_text_or_search(page)

    source_refresh_button(page).click()
    expect(page.get_by_text("B站字幕").first).to_be_visible()
    expect(page.get_by_text("用于视频助手").first).to_be_visible()
    actions_after_redetect = message_actions(page)
    assert "GET_CURRENT_VIDEO_TRANSCRIPT_EVIDENCE" in actions_after_redetect
    assert not any(action in FULL_TEXT_OR_SEARCH_ACTIONS for action in actions_after_redetect)

    expect(page.locator(".bdc-assistant-source-card").filter(has_text="B站字幕").get_by_text("查看来源")).to_have_count(0)
    storage_before_select = page.evaluate("window.__assistantMockStorage.currentVideoPrimaryTextSelections || null")
    assert storage_before_select in (None, {}), "source card must not save the assistant source before explicit selection"

    page.locator(".bdc-assistant-source-card").filter(has_text="B站字幕").get_by_role("button", name="用于视频助手").click()
    expect(page.get_by_text("已用于当前视频助手").first).to_be_visible()
    storage_after_select = page.evaluate("window.__assistantMockStorage.currentVideoPrimaryTextSelections || {}")
    assert storage_after_select, "explicit assistant source selection was not saved"

    source_refresh_button(page).click()
    page.wait_for_function(
        """() => [...(window.__assistantMockMessages || [])].reverse().some(
            (message) => message.action === "GET_CURRENT_VIDEO_TRANSCRIPT_EVIDENCE"
                && message.params?.selectedSourceIdentityKey
        )"""
    )
    refresh_message = last_message_for(page, "GET_CURRENT_VIDEO_TRANSCRIPT_EVIDENCE")
    assert refresh_message["params"].get("selectedSourceIdentityKey"), "selected source key was not sent with subtitle refresh"

    page.locator("textarea").fill("subagent 在哪里")
    page.get_by_role("button", name="提问").click()
    expect(page.get_by_text("回答：有证据").first).to_be_visible()
    expect(page.get_by_text("引用片段", exact=True)).to_be_visible()
    assert page.locator(".bdc-assistant-answer-card").first.evaluate(
        """answer => {
            const citationTitle = [...document.querySelectorAll('.bdc-assistant-citation-title')]
                .find((node) => node.textContent.trim() === '引用片段');
            return Boolean(citationTitle && (answer.compareDocumentPosition(citationTitle) & Node.DOCUMENT_POSITION_FOLLOWING));
        }"""
    )
    search_message = last_message_for(page, "ASK_CURRENT_VIDEO_FULL_TEXT")
    assert search_message["params"].get("selectedSourceIdentityKey"), "selected source key was not sent with search"

    page.get_by_role("button", name="预览跳转").first.click()
    expect(page.get_by_text("确认跳转前预览")).to_be_visible()
    page.get_by_role("button", name="确认跳转").click()
    expect(page.get_by_role("button", name="返回原位置")).to_be_visible()
    jump_message = last_message_for(page, "REQUEST_CURRENT_VIDEO_QA_CITATION_JUMP")
    assert jump_message["params"].get("selectedSourceIdentityKey"), "selected source key was not sent with jump"

    page.get_by_role("button", name="返回原位置").click()
    expect(page.get_by_text("已返回 0:12")).to_be_visible()

    assert_clean_visible_text(page)
    assert_no_horizontal_overflow(page)


def read_download_text(download):
    path = download.path()
    if not path:
        raise AssertionError("download path was not available")
    return Path(path).read_text(encoding="utf-8")


def open_subtitle_tab(page, query="subtitleCached=1&sourceVersion=v2"):
    page.route("**/*", route_mock)
    page.goto(f"{MOCK_URL}?{query}")
    expect(page.locator("#bdc-current-video-assistant")).to_be_visible()
    expand_assistant(page)
    page.get_by_role("tab", name="字幕").click()
    expect(page.get_by_label("搜索当前字幕来源")).to_be_visible()
    return page.locator("#bdc-current-video-assistant")


def run_subtitle_single_source_flow(page):
    assistant = open_subtitle_tab(page)
    assert "GET_CURRENT_VIDEO_SUBTITLE_VIEW_SOURCES" in message_actions(page)
    assert message_count_for(page, "ASK_CURRENT_VIDEO_FULL_TEXT") == 0
    expect(assistant.get_by_text("正在查看：B站字幕").first).to_be_visible()
    expect(assistant.get_by_text("本地转录")).to_have_count(0)
    expect(assistant.get_by_role("radiogroup", name="字幕查看来源")).to_have_count(0)

    initial_position = page.evaluate("window.__assistantMockPlaybackPosition()")
    first_row = assistant.locator(".bdc-assistant-subtitle-row").filter(has_text="开场介绍子代理和当前视频助手。").first
    search = page.get_by_label("搜索当前字幕来源")
    search.focus()
    page.evaluate("window.__assistantMockSetPlaybackPosition(4)")
    page.wait_for_function(
        """() => [...document.querySelectorAll('.bdc-assistant-subtitle-row-active')]
            .some((row) => row.textContent.includes('这里说明 Tool Use 可以帮助调用本地工具。'))"""
    )
    expect(search).to_be_focused()
    first_row.focus()
    page.evaluate("window.__assistantMockSetPlaybackPosition(8)")
    page.wait_for_function(
        """() => [...document.querySelectorAll('.bdc-assistant-subtitle-row-active')]
            .some((row) => row.textContent.includes('100万上下文不等于可以混用视频来源。'))"""
    )
    expect(first_row).to_be_focused()
    export_button = assistant.get_by_role("button", name="导出 TXT")
    export_button.focus()
    page.evaluate("window.__assistantMockSetPlaybackPosition(12)")
    page.wait_for_function(
        """() => [...document.querySelectorAll('.bdc-assistant-subtitle-row-active')]
            .some((row) => row.textContent.includes('字幕搜索只在当前查看来源内进行。'))"""
    )
    expect(export_button).to_be_focused()

    expect(first_row).to_be_visible()
    assistant.locator(".bdc-assistant-subtitle-row").filter(has_text="这里说明 Tool Use 可以帮助调用本地工具。").first.click()
    expect(assistant.get_by_text("字幕原文：这里说明 Tool Use 可以帮助调用本地工具。")).to_be_visible()
    assert page.evaluate("window.__assistantMockPlaybackPosition()") == initial_position
    expect(assistant.get_by_text("已暂停跟随：正在手动浏览字幕。")).to_be_visible()

    assistant.get_by_role("button", name="回到当前字幕").click()
    expect(assistant.get_by_role("button", name="正在跟随播放")).to_be_visible()

    search.fill("子代理")
    assistant.get_by_role("button", name="查找").click()
    expect(assistant.get_by_text("找到 1 处匹配。")).to_be_visible()
    expect(assistant.locator(".bdc-assistant-subtitle-result").filter(has_text="开场介绍子代理和当前视频助手。").first).to_be_visible()
    assert message_count_for(page, "ASK_CURRENT_VIDEO_FULL_TEXT") == 0

    search.fill("tool use")
    assistant.get_by_role("button", name="查找").click()
    expect(assistant.get_by_text("找到 1 处匹配。")).to_be_visible()
    expect(assistant.locator(".bdc-assistant-subtitle-result").filter(has_text="这里说明 Tool Use 可以帮助调用本地工具。").first).to_be_visible()

    search.fill("视频")
    assistant.get_by_role("button", name="查找").click()
    expect(assistant.get_by_text("找到 2 处匹配。")).to_be_visible()
    assistant.get_by_role("button", name="下一个").click()
    expect(assistant.get_by_text("已暂停跟随：正在查看搜索结果。")).to_be_visible()
    assistant.get_by_role("button", name="上一个").click()

    search.fill("完全不存在")
    assistant.get_by_role("button", name="查找").click()
    expect(assistant.get_by_text("当前字幕来源里没有匹配结果。")).to_be_visible()

    page.evaluate("window.__assistantMockSetPlaybackPosition(12)")
    assistant.locator(".bdc-assistant-subtitle-row").filter(has_text="这里说明 Tool Use 可以帮助调用本地工具。").first.click()
    expect(assistant.get_by_text("确认跳转前预览")).to_be_visible()
    assert page.evaluate("window.__assistantMockPlaybackPosition()") == 12
    assistant.get_by_role("button", name="确认跳转").click()
    expect(assistant.get_by_text("可返回 0:12")).to_be_visible()
    assert page.evaluate("window.__assistantMockPlaybackPosition()") == 3
    assert last_message_for(page, "REQUEST_CURRENT_VIDEO_SUBTITLE_JUMP")["params"]["confirmed"] is True
    assistant.get_by_role("button", name="返回原位置").click()
    expect(assistant.get_by_text("已返回 0:12")).to_be_visible()
    assert page.evaluate("window.__assistantMockPlaybackPosition()") == 12

    with page.expect_download() as txt_info:
        assistant.get_by_role("button", name="导出 TXT").click()
    txt_download = txt_info.value
    assert txt_download.suggested_filename == "页内助手 Shell Mock 视频-主视频-B站字幕-字幕全文.txt"
    txt = read_download_text(txt_download)
    assert "字幕全文（B站字幕）" in txt
    assert "[0:03-0:07] 这里说明 Tool Use 可以帮助调用本地工具。" in txt

    with page.expect_download() as srt_info:
        assistant.get_by_role("button", name="导出 SRT").click()
    srt_download = srt_info.value
    assert srt_download.suggested_filename == "页内助手 Shell Mock 视频-主视频-B站字幕-字幕全文.srt"
    srt = read_download_text(srt_download)
    assert "1\n00:00:00,000 --> 00:00:03,000\n开场介绍子代理和当前视频助手。" in srt
    assert "4\n00:00:11,000 --> 00:00:16,000\n字幕搜索只在当前查看来源内进行。" in srt

    actions = message_actions(page)
    assert "GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS" not in actions
    assert "GET_VIDEO_KNOWLEDGE" not in actions
    assert message_count_for(page, "ASK_CURRENT_VIDEO_FULL_TEXT") == 0
    assert_clean_visible_text(page)
    assert_no_horizontal_overflow(page)


def run_subtitle_dual_source_independence_flow(page):
    assistant = open_subtitle_tab(page, "subtitleCached=1&sourceVersion=v2&savedSource=current&localTranscript=1")
    source_control = assistant.get_by_role("radiogroup", name="字幕查看来源")
    expect(source_control).to_be_visible()
    bili_option = source_control.get_by_role("radio").filter(has_text="B站字幕")
    expect(bili_option).to_have_attribute("aria-checked", "true")
    expect(bili_option).to_contain_text("视频助手正在使用")
    expect(source_control.get_by_role("radio", name="本地转录")).to_have_attribute("aria-checked", "false")
    storage_before = page.evaluate("JSON.stringify(window.__assistantMockStorage.currentVideoPrimaryTextSelections || {})")
    page.get_by_label("搜索当前字幕来源").fill("SubAgent")
    assistant.get_by_role("button", name="查找").click()
    expect(assistant.get_by_text("当前字幕来源里没有匹配结果。")).to_be_visible()
    bili_option.press("ArrowRight")
    expect(source_control.get_by_role("radio", name="本地转录")).to_have_attribute("aria-checked", "true")
    expect(page.get_by_label("搜索当前字幕来源")).to_have_value("SubAgent")
    expect(assistant.locator(".bdc-assistant-subtitle-row").filter(has_text="Local source mentions SubAgent with English casing.").first).to_be_visible()
    expect(assistant.get_by_text("找到 1 处匹配。")).to_be_visible()
    expect(assistant.locator(".bdc-assistant-subtitle-result").filter(has_text="Local source mentions SubAgent with English casing.").first).to_be_visible()
    storage_after = page.evaluate("JSON.stringify(window.__assistantMockStorage.currentVideoPrimaryTextSelections || {})")
    assert storage_before == storage_after, "subtitle viewing source switch changed primary assistant selection"
    assert message_count_for(page, "SAVE_CURRENT_VIDEO_PRIMARY_TEXT_SELECTION") == 0

    page.get_by_label("搜索当前字幕来源").fill("Tool Use")
    assistant.get_by_role("button", name="查找").click()
    expect(assistant.get_by_text("当前字幕来源里没有匹配结果。")).to_be_visible()

    with page.expect_download() as download_info:
        assistant.get_by_role("button", name="导出 SRT").click()
    download = download_info.value
    assert download.suggested_filename == "页内助手 Shell Mock 视频-主视频-本地转录-字幕全文.srt"
    assert "这一行只存在于本地完成稿。" in read_download_text(download)
    assert_clean_visible_text(page)
    assert_no_horizontal_overflow(page)


def run_subtitle_stale_source_flow(page):
    assistant = open_subtitle_tab(page)
    page.evaluate("window.__assistantMockSetPlaybackPosition(20)")
    assistant.locator(".bdc-assistant-subtitle-row").filter(has_text="开场介绍子代理和当前视频助手。").first.click()
    expect(assistant.get_by_text("确认跳转前预览")).to_be_visible()
    page.evaluate("window.__assistantMockReplaceSubtitleSource('v9')")
    assistant.get_by_role("button", name="确认跳转").click()
    expect(assistant.get_by_text("当前字幕来源或字幕行已变化，请重新打开预览后再跳转。")).to_be_visible()
    assert page.evaluate("window.__assistantMockPlaybackPosition()") == 20
    assert_clean_visible_text(page)
    assert_no_horizontal_overflow(page)


def run_subtitle_late_source_response_flow(page):
    page.route("**/*", route_mock)
    page.goto(f"{MOCK_URL}?subtitleCached=1&sourceVersion=v2")
    expect(page.locator("#bdc-current-video-assistant")).to_be_visible()
    expand_assistant(page)
    page.evaluate("window.__assistantMockDeferNextProtectedAction('GET_CURRENT_VIDEO_SUBTITLE_VIEW_SOURCES')")
    page.get_by_role("tab", name="字幕").click()
    page.wait_for_function("window.__assistantMockPendingProtectedResponseCount() === 1")

    page.evaluate("window.__assistantMockSwitchToPart(2)")
    expect(page.get_by_text("P2 / 2", exact=True)).to_be_visible()
    expect(page.get_by_label("搜索当前字幕来源")).to_be_visible()
    page.evaluate("window.__assistantMockResolveProtectedResponses()")
    page.wait_for_timeout(50)

    expect(page.get_by_text("P2 / 2", exact=True)).to_be_visible()
    expect(page.get_by_label("搜索当前字幕来源")).to_be_visible()
    expect(page.get_by_text("字幕来源已变化，请刷新字幕页后再查看。")).to_have_count(0)
    assert_clean_visible_text(page)
    assert_no_horizontal_overflow(page)


def run_missing_selection_flow(page):
    page.route("**/*", route_mock)
    page.goto(MOCK_URL)
    expect(page.locator("#bdc-current-video-assistant")).to_be_visible()

    expand_assistant(page)
    expect(page.get_by_text("主要文本来源").first).to_be_visible()
    source_refresh_button(page).click()
    expect(page.get_by_text("B站字幕").first).to_be_visible()
    page.locator(".bdc-assistant-source-card").filter(has_text="B站字幕").get_by_role("button", name="用于视频助手").click()
    expect(page.get_by_text("已用于当前视频助手").first).to_be_visible()

    storage_after_select = page.evaluate("window.__assistantMockStorage.currentVideoPrimaryTextSelections || {}")
    saved_keys = list(storage_after_select.values())
    assert saved_keys, "explicit V1 source selection was not saved"
    saved_v1_key = saved_keys[0]

    page.evaluate("window.__assistantMockReplaceSubtitleSource()")
    search_count_before = message_count_for(page, "ASK_CURRENT_VIDEO_FULL_TEXT")
    source_refresh_button(page).click()
    page.wait_for_function(
        """(expected) => [...(window.__assistantMockMessages || [])].reverse().some(
            (message) => message.action === "GET_CURRENT_VIDEO_TRANSCRIPT_EVIDENCE"
                && message.params?.selectedSourceIdentityKey === expected
        )""",
        arg=saved_v1_key,
    )

    expect(page.get_by_text("此前选择的主要文本来源已不可用。").first).to_be_visible()
    select_assistant_tab(page, "问答")
    expect(page.locator("textarea")).to_be_disabled()
    expect(page.get_by_role("button", name="提问")).to_be_disabled()
    assert message_count_for(page, "ASK_CURRENT_VIDEO_FULL_TEXT") == search_count_before

    assert_clean_visible_text(page)
    assert_no_horizontal_overflow(page)


def run_late_switch_flow(page):
    page.route("**/*", route_mock)
    page.goto(MOCK_URL)
    expect(page.locator("#bdc-current-video-assistant")).to_be_visible()

    expand_assistant(page)
    expect(page.get_by_text("主要文本来源").first).to_be_visible()
    page.evaluate("window.__assistantMockSwitchDuringTranscript()")
    source_refresh_button(page).click()

    select_assistant_tab(page, "字幕")
    expect(page.get_by_text("当前视频或分 P 已切换，请在当前分 P 重新检测字幕。")).to_be_visible()
    expect(page.locator(".bdc-assistant-source-card").filter(has_text="B站字幕")).to_have_count(0)
    assert_no_full_text_or_search(page)
    assert_clean_visible_text(page)
    assert_no_horizontal_overflow(page)


def run_deferred_storage_flow(page):
    page.route("**/*", route_mock)
    page.goto(f"{MOCK_URL}?subtitleCached=1&sourceVersion=v2&deferPrimaryTextStorage=1&savedSource=v1")
    expect(page.locator("#bdc-current-video-assistant")).to_be_visible()

    expand_assistant(page)
    expect(page.get_by_text("正在读取本页保存的主要文本来源选择").first).to_be_visible()
    select_assistant_tab(page, "问答")
    expect(page.locator("textarea")).to_be_disabled()
    expect(page.get_by_role("button", name="提问")).to_be_disabled()

    counts_before = {
        action: message_count_for(page, action)
        for action in [
            "ASK_CURRENT_VIDEO_FULL_TEXT",
            "REQUEST_CURRENT_VIDEO_QA_CITATION_JUMP",
        ]
    }
    page.get_by_role("button", name="提问").evaluate("(button) => button.click()")
    for action, count in counts_before.items():
        assert message_count_for(page, action) == count, f"{action} should stay blocked before storage resolves"

    saved_v1_key = page.evaluate(
        """() => Object.values(window.__assistantMockStorage.currentVideoPrimaryTextSelections || {})[0] || null"""
    )
    assert saved_v1_key and saved_v1_key.endswith("mock-source-hash-hidden-v1")
    page.evaluate("window.__assistantMockResolvePrimaryTextStorage()")
    expect(page.get_by_text("此前选择的主要文本来源已不可用。").first).to_be_visible()
    expect(page.locator("textarea")).to_be_disabled()
    expect(page.get_by_role("button", name="提问")).to_be_disabled()

    source_refresh_button(page).click()
    page.wait_for_function(
        """() => [...(window.__assistantMockMessages || [])].reverse().some(
            (message) => message.action === "GET_CURRENT_VIDEO_TRANSCRIPT_EVIDENCE"
                && message.params?.primaryTextSelectionsReady === false
                && !message.params?.selectedSourceIdentityKey
        )""",
    )
    refresh_message = last_message_for(page, "GET_CURRENT_VIDEO_TRANSCRIPT_EVIDENCE")
    assert refresh_message["params"].get("primaryTextSelectionsReady") is False
    assert not refresh_message["params"].get("selectedSourceIdentityKey")

    page.get_by_role("button", name="提问").evaluate("(button) => button.click()")
    assert message_count_for(page, "ASK_CURRENT_VIDEO_FULL_TEXT") == counts_before["ASK_CURRENT_VIDEO_FULL_TEXT"]
    assert_clean_visible_text(page)
    assert_no_horizontal_overflow(page)


def run_single_v2_without_saved_selection_flow(page):
    page.route("**/*", route_mock)
    page.goto(f"{MOCK_URL}?subtitleCached=1&sourceVersion=v2")
    expect(page.locator("#bdc-current-video-assistant")).to_be_visible()

    expand_assistant(page)
    source_refresh_button(page).click()
    expect(page.get_by_text("B站字幕").first).to_be_visible()
    select_assistant_tab(page, "问答")
    expect(page.locator("textarea")).to_be_enabled()
    current_v2_key = page.evaluate("window.__assistantMockCurrentSourceIdentityKey()")

    page.locator("textarea").fill("subagent 在哪里")
    page.get_by_role("button", name="提问").click()
    expect(page.get_by_text("回答：有证据").first).to_be_visible()
    search_message = last_message_for(page, "ASK_CURRENT_VIDEO_FULL_TEXT")
    assert search_message["params"].get("primaryTextSelectionsReady") is True
    assert search_message["params"].get("selectedSourceIdentityKey") == current_v2_key

    page.get_by_role("button", name="预览跳转").last.click()
    page.get_by_role("button", name="确认跳转").last.click()
    jump_message = last_message_for(page, "REQUEST_CURRENT_VIDEO_QA_CITATION_JUMP")
    assert jump_message["params"].get("primaryTextSelectionsReady") is True
    assert jump_message["params"].get("selectedSourceIdentityKey") == current_v2_key

    assert_clean_visible_text(page)
    assert_no_horizontal_overflow(page)


def run_rejected_storage_single_v2_flow(page):
    page.route("**/*", route_mock)
    page.goto(f"{MOCK_URL}?subtitleCached=1&sourceVersion=v2&rejectPrimaryTextStorage=1&savedSource=v1&seedOtherSelections=1")
    expect(page.locator("#bdc-current-video-assistant")).to_be_visible()

    expand_assistant(page)
    expect(page.get_by_text("正在读取本页保存的主要文本来源选择").first).to_be_visible()
    select_assistant_tab(page, "问答")
    expect(page.locator("textarea")).to_be_disabled()

    blocked_actions = [
        "ASK_CURRENT_VIDEO_FULL_TEXT",
        "REQUEST_CURRENT_VIDEO_QA_CITATION_JUMP",
    ]
    counts_before_reject = {action: message_count_for(page, action) for action in blocked_actions}
    source_refresh_button(page).evaluate("(button) => button.click()")
    page.locator("textarea").evaluate(
        """(textarea) => {
            textarea.value = "subagent 在哪里";
            textarea.dispatchEvent(new Event("input", { bubbles: true }));
        }"""
    )
    page.get_by_role("button", name="提问").evaluate("(button) => button.click()")
    for action, count in counts_before_reject.items():
        assert message_count_for(page, action) == count, f"{action} should stay blocked while storage read is pending"

    page.evaluate("window.__assistantMockRejectPrimaryTextStorage()")
    expect(page.get_by_text("保存的主要文本来源选择读取失败").first).to_be_visible()
    current_v2_key = page.evaluate("window.__assistantMockCurrentSourceIdentityKey()")
    expect(page.locator("textarea")).to_be_disabled()

    counts_after_reject = {action: message_count_for(page, action) for action in blocked_actions}
    page.get_by_role("button", name="提问").evaluate("(button) => button.click()")
    for action, count in counts_after_reject.items():
        assert message_count_for(page, action) == count, f"{action} should stay blocked after storage read rejection"

    source_refresh_button(page).click()
    expect(page.get_by_text("B站字幕").first).to_be_visible()
    refresh_after_reject = last_message_for(page, "GET_CURRENT_VIDEO_TRANSCRIPT_EVIDENCE")
    assert refresh_after_reject["params"].get("primaryTextSelectionsReady") is False
    assert not refresh_after_reject["params"].get("selectedSourceIdentityKey")

    page.evaluate("window.__assistantMockRejectNextPrimaryTextStorageSet()")
    page.locator(".bdc-assistant-source-card").filter(has_text="B站字幕").get_by_role("button", name="用于视频助手").click()
    expect(page.get_by_text("保存主要文本来源失败").first).to_be_visible()
    expect(page.locator("textarea")).to_be_disabled()
    storage_after_failed_set = page.evaluate("window.__assistantMockStorage.currentVideoPrimaryTextSelections || {}")
    assert current_v2_key not in list(storage_after_failed_set.values()), "failed save must roll back in-memory selection"
    counts_after_failed_set = {action: message_count_for(page, action) for action in blocked_actions}
    page.get_by_role("button", name="提问").evaluate("(button) => button.click()")
    for action, count in counts_after_failed_set.items():
        assert message_count_for(page, action) == count, f"{action} should stay blocked after source save rejection"

    page.evaluate("window.__assistantMockRejectNextPrimaryTextStorageReadback()")
    page.locator(".bdc-assistant-source-card").filter(has_text="B站字幕").get_by_role("button", name="用于视频助手").click()
    page.wait_for_timeout(50)
    expect(page.get_by_text("保存主要文本来源失败").first).to_be_visible()
    expect(page.locator("textarea")).to_be_disabled()

    page.locator(".bdc-assistant-source-card").filter(has_text="B站字幕").get_by_role("button", name="用于视频助手").click()
    expect(page.get_by_text("已用于当前视频助手").first).to_be_visible()
    expect(page.locator("textarea")).to_be_enabled()
    storage_after_success = page.evaluate("window.__assistantMockStorage.currentVideoPrimaryTextSelections || {}")
    assert current_v2_key in list(storage_after_success.values()), "successful explicit selection must persist exact V2"
    assert storage_after_success.get("BV1OtherSavedA:7101:1", "").endswith("source-a")
    assert storage_after_success.get("BV1OtherSavedB:7202:2", "").endswith("source-b")
    assert message_count_for(page, "SAVE_CURRENT_VIDEO_PRIMARY_TEXT_SELECTION") >= 3

    page.locator("textarea").fill("subagent 在哪里")
    page.get_by_role("button", name="提问").click()
    expect(page.get_by_text("回答：有证据").first).to_be_visible()
    search_message = last_message_for(page, "ASK_CURRENT_VIDEO_FULL_TEXT")
    assert search_message["params"].get("primaryTextSelectionsReady") is True
    assert search_message["params"].get("selectedSourceIdentityKey") == current_v2_key

    assert_clean_visible_text(page)
    assert_no_horizontal_overflow(page)


def run_loaded_selection_save_failure_flow(page):
    page.route("**/*", route_mock)
    page.goto(f"{MOCK_URL}?subtitleCached=1&sourceVersion=v2")
    expect(page.locator("#bdc-current-video-assistant")).to_be_visible()
    expand_assistant(page)
    source_refresh_button(page).click()
    expect(page.get_by_text("B站字幕").first).to_be_visible()
    select_assistant_tab(page, "问答")
    expect(page.locator("textarea")).to_be_enabled()

    page.locator("textarea").fill("subagent 在哪里")
    page.get_by_role("button", name="提问").click()
    expect(page.get_by_role("button", name="预览跳转").first).to_be_visible()
    page.get_by_role("button", name="预览跳转").first.click()
    expect(page.get_by_role("button", name="确认跳转")).to_be_visible()

    blocked_actions = [
        "ASK_CURRENT_VIDEO_FULL_TEXT",
        "REQUEST_CURRENT_VIDEO_QA_CITATION_JUMP",
    ]

    page.evaluate("window.__assistantMockRejectNextPrimaryTextStorageSet()")
    page.locator(".bdc-assistant-source-card").filter(has_text="B站字幕").get_by_role("button", name="用于视频助手").click()
    expect(page.get_by_text("保存主要文本来源失败").first).to_be_visible()
    expect(page.locator("textarea")).to_be_disabled()
    expect(page.get_by_role("button", name="确认跳转")).to_be_disabled()

    counts_after_set_failure = {action: message_count_for(page, action) for action in blocked_actions}
    page.get_by_role("button", name="提问").evaluate("(button) => button.click()")
    page.get_by_role("button", name="确认跳转").evaluate("(button) => button.click()")
    for action, count in counts_after_set_failure.items():
        assert message_count_for(page, action) == count, f"{action} should stay blocked after set failure"

    page.evaluate("window.__assistantMockRejectNextPrimaryTextStorageReadback()")
    page.locator(".bdc-assistant-source-card").filter(has_text="B站字幕").get_by_role("button", name="用于视频助手").click()
    expect(page.get_by_text("保存主要文本来源失败").first).to_be_visible()
    expect(page.locator("textarea")).to_be_disabled()

    page.locator(".bdc-assistant-source-card").filter(has_text="B站字幕").get_by_role("button", name="用于视频助手").click()
    expect(page.get_by_text("已用于当前视频助手").first).to_be_visible()
    expect(page.locator("textarea")).to_be_enabled()
    assert_clean_visible_text(page)
    assert_no_horizontal_overflow(page)


def run_loaded_storage_change_invalidation_flow(page):
    page.route("**/*", route_mock)
    page.goto(f"{MOCK_URL}?subtitleCached=1&sourceVersion=v2&savedSource=current")
    expect(page.locator("#bdc-current-video-assistant")).to_be_visible()
    expand_assistant(page)
    source_refresh_button(page).click()
    old_source_key = page.evaluate("window.__assistantMockCurrentSourceIdentityKey()")
    page.evaluate("window.__assistantMockClearPrimaryTextSelectionsForLocalSettings()")

    page.evaluate("window.__assistantMockReplaceSubtitleSource('v3')")
    source_refresh_button(page).click()
    current_source_key = page.evaluate("window.__assistantMockCurrentSourceIdentityKey()")
    assert current_source_key != old_source_key

    page.locator(".bdc-assistant-source-card").filter(has_text="B站字幕").get_by_role("button", name="用于视频助手").click()
    expect(page.get_by_text("已用于当前视频助手").first).to_be_visible()
    select_assistant_tab(page, "问答")
    page.locator("textarea").fill("清理竞态")
    page.evaluate("window.__assistantMockDeferNextProtectedAction('ASK_CURRENT_VIDEO_FULL_TEXT')")
    page.get_by_role("button", name="提问").click()
    page.evaluate("window.__assistantMockClearPrimaryTextSelectionsForClearAll()")
    page.evaluate("window.__assistantMockResolveProtectedResponses()")
    page.wait_for_timeout(50)
    expect(page.get_by_text("回答：有证据").first).to_be_visible()
    expect(page.locator("textarea")).to_be_enabled()
    page.get_by_role("button", name="提问").click()
    expect(page.get_by_text("回答：有证据").first).to_be_visible()
    search_message = last_message_for(page, "ASK_CURRENT_VIDEO_FULL_TEXT")
    assert search_message["params"].get("primaryTextSelectionsReady") is True
    assert search_message["params"].get("selectedSourceIdentityKey") == current_source_key
    assert search_message["params"].get("selectedSourceIdentityKey") != old_source_key
    page.evaluate("window.__assistantMockSetInvalidPrimaryTextSelections()")
    expect(page.get_by_text("回答：有证据").first).to_be_visible()
    assert_clean_visible_text(page)
    assert_no_horizontal_overflow(page)


def run_fail_closed_page_knowledge_copy(page):
    page.route("**/*", route_mock)
    page.goto(f"{MOCK_URL}?subtitleCached=1&sourceVersion=v2&savedSource=current&knowledgeNoEvidence=1")
    expect(page.locator("#bdc-current-video-assistant")).to_be_visible()
    expand_assistant(page)
    source_refresh_button(page).click()
    page.get_by_role("button", name="刷新节点").click()
    expect(page.get_by_text("当前没有可引用的字幕正文；知识节点暂不可用。")).to_be_visible()
    expect(page.get_by_text("简介辅助", exact=True)).to_have_count(0)
    expect(page.get_by_text("分 P / 章节辅助", exact=True)).to_have_count(0)
    assert_clean_visible_text(page)
    assert_no_horizontal_overflow(page)


def run_navigation_epoch_flow(page, mode):
    page.route("**/*", route_mock)
    query = "deferInitialContext=1" if mode == "collect" else "deferVideoDetection=1"
    page.goto(f"{MOCK_URL}?{query}")

    if mode == "collect":
        page.wait_for_function("window.__assistantMockPendingInitialViewFetchCount() === 1")
    else:
        expect(page.locator("#bdc-current-video-assistant")).to_be_visible()
        expand_assistant(page)
        expect(page.get_by_text("P1 / 2", exact=True)).to_be_visible()

    page.evaluate("window.__assistantMockClearMessages()")
    page.evaluate("window.__assistantMockNavigateToPartWithoutCollect(2)")
    if mode == "detect":
        page.evaluate("window.__assistantMockReleaseVideoDetection()")

    if mode == "collect":
        expect(page.get_by_role("button", name="展开助手", exact=True)).to_be_visible(timeout=5000)
        expand_assistant(page)
    expect(page.get_by_text("P2 / 2", exact=True)).to_be_visible(timeout=5000)
    if mode == "collect":
        page.evaluate("window.__assistantMockResolveInitialViewFetch()")
    page.wait_for_timeout(150)

    assistant_text = page.locator("#bdc-current-video-assistant").inner_text()
    assert "P2 / 2" in assistant_text
    assert "P1 / 2" not in assistant_text
    updates = current_video_context_updates(page)
    assert updates, f"{mode} navigation did not publish the current context"
    assert all(
        update.get("kind") != "video"
        or (update.get("cid") == 3303 and update.get("currentPart", {}).get("page") == 2)
        for update in updates
    ), f"{mode} navigation published a stale context: {updates}"
    assert_clean_visible_text(page)
    assert_no_horizontal_overflow(page)


def prepare_timestamp_controls(page):
    page.route("**/*", route_mock)
    page.goto(f"{MOCK_URL}?subtitleCached=1&sourceVersion=v2&savedSource=current")
    expect(page.locator("#bdc-current-video-assistant")).to_be_visible()
    expand_assistant(page)
    source_refresh_button(page).click()
    select_assistant_tab(page, "问答")
    expect(page.locator("textarea")).to_be_enabled()
    page.locator("textarea").fill("延迟操作")
    page.get_by_role("button", name="提问").click()
    expect(page.get_by_text("回答：有证据").first).to_be_visible()
    page.get_by_role("button", name="预览跳转").first.click()
    expect(page.get_by_text("确认跳转前预览")).to_be_visible()


def start_newer_timestamp_jump(page):
    assistant = page.locator("#bdc-current-video-assistant")
    page.evaluate("window.__assistantMockSetPlaybackPosition(30)")
    source_button = page.locator(".bdc-assistant-source-card").filter(has_text="B站字幕").get_by_role("button", name="用于视频助手")
    if source_button.count() > 0 and source_button.first.is_enabled():
        source_button.first.click()
        expect(page.get_by_text("已用于当前视频助手").first).to_be_visible()
    page.locator("textarea").fill("较新的操作")
    page.get_by_role("button", name="提问").click()
    expect(page.get_by_text("回答：有证据").first).to_be_visible()
    page.get_by_role("button", name="预览跳转").first.click()
    page.get_by_role("button", name="确认跳转").click()
    expect(assistant.get_by_text("已跳到引用位置，可返回原位置。")).to_be_visible()
    expect(assistant.get_by_role("button", name="返回原位置")).to_be_visible()


def run_late_assistant_timestamp_flow(page, operation, invalidation, newer=False):
    prepare_timestamp_controls(page)
    assistant = page.locator("#bdc-current-video-assistant")
    if operation == "return":
        page.get_by_role("button", name="确认跳转").click()
        expect(assistant.get_by_role("button", name="返回原位置")).to_be_visible()
        page.evaluate("window.__assistantMockDeferNextProtectedAction('RETURN_CURRENT_VIDEO_SEGMENT_JUMP')")
        page.get_by_role("button", name="返回原位置").click()
        expect(page.get_by_text("正在返回原位置...")).to_be_visible()
    else:
        page.evaluate("window.__assistantMockDeferNextProtectedAction('REQUEST_CURRENT_VIDEO_QA_CITATION_JUMP')")
        page.get_by_role("button", name="确认跳转").click()
        expect(page.get_by_text("正在确认跳转...")).to_be_visible()
        expect(page.get_by_role("button", name="已预览")).to_be_disabled()
        expect(page.get_by_role("button", name="正在跳转...")).to_be_disabled()

    if invalidation == "part":
        page.evaluate("window.__assistantMockSwitchToPart(2)")
        expect(page.get_by_text("P2 / 2", exact=True)).to_be_visible()
    elif invalidation == "video":
        page.evaluate("window.__assistantMockSwitchToVideo()")
        expect(page.get_by_text("延迟保存后切换的新视频", exact=True).first).to_be_visible()
    elif invalidation == "localSettings":
        page.evaluate("window.__assistantMockClearPrimaryTextSelectionsForLocalSettings()")
    else:
        page.evaluate("window.__assistantMockClearPrimaryTextSelectionsForClearAll()")

    if newer:
        start_newer_timestamp_jump(page)
    else:
        expect(assistant.get_by_role("button", name="返回原位置")).to_have_count(0)

    page.evaluate("window.__assistantMockResolveProtectedResponses()")
    page.wait_for_timeout(50)
    expect(page.get_by_text("正在确认跳转...")).to_have_count(0)
    expect(page.get_by_text("正在返回原位置...")).to_have_count(0)
    if newer:
        expect(assistant.get_by_text("已跳到引用位置，可返回原位置。")).to_be_visible()
        expect(assistant.get_by_role("button", name="返回原位置")).to_be_visible()
        expect(assistant.get_by_text("已返回 0:12")).to_have_count(0)
    else:
        expect(assistant.get_by_role("button", name="返回原位置")).to_have_count(0)
        expect(assistant.get_by_text("已返回 0:12")).to_have_count(0)
    assert_clean_visible_text(page)
    assert_no_horizontal_overflow(page)


def wait_for_content_timestamp_result(page, slot):
    page.wait_for_function(
        "(slot) => window.__assistantMockContentTimestampResult(slot) !== null",
        arg=slot,
    )
    return page.evaluate("(slot) => window.__assistantMockContentTimestampResult(slot)", slot)


def run_content_timestamp_operation_epoch_flow(page):
    page.route("**/*", route_mock)
    page.goto(f"{MOCK_URL}?subtitleCached=1&sourceVersion=v2&savedSource=current")
    expect(page.locator("#bdc-current-video-assistant")).to_be_visible()

    initial_position = page.evaluate("window.__assistantMockPlaybackPosition()")
    page.evaluate("window.__assistantMockRejectNextTimestampOperationLease()")
    page.evaluate("window.__assistantMockStartContentTimestampJump('lease-denied', 'lease-denied', 3)")
    denied_response = wait_for_content_timestamp_result(page, "lease-denied")
    assert denied_response["ok"] is False
    assert page.evaluate("window.__assistantMockPendingTimestampSeekCount()") == 0
    assert page.evaluate("window.__assistantMockPlaybackPosition()") == initial_position
    expect(page.locator("#bdc-current-video-return")).to_have_count(0)

    page.evaluate("window.__assistantMockDeferNextTimestampOperationLease()")
    page.evaluate("window.__assistantMockStartContentTimestampJump('selection-old', 'selection-old', 4)")
    page.wait_for_function("window.__assistantMockPendingTimestampOperationLeaseCount() === 1")
    assert page.evaluate("window.__assistantMockPendingTimestampSeekCount()") == 0
    page.evaluate("window.__assistantMockClearPrimaryTextSelectionsForLocalSettings()")
    page.evaluate("window.__assistantMockResolveTimestampOperationLeases()")
    selection_response = wait_for_content_timestamp_result(page, "selection-old")
    assert selection_response["ok"] is False
    assert "当前视频" in selection_response["message"]
    assert page.evaluate("window.__assistantMockPlaybackPosition()") == initial_position
    expect(page.locator("#bdc-current-video-return")).to_have_count(0)

    page.evaluate("window.__assistantMockDeferNextTimestampSeek()")
    page.evaluate("window.__assistantMockStartContentTimestampJump('older', 'older', 4)")
    page.wait_for_function("window.__assistantMockPendingTimestampSeekCount() === 1")
    page.evaluate("window.__assistantMockStartContentTimestampJump('newer', 'newer', 8)")
    newer_response = wait_for_content_timestamp_result(page, "newer")
    assert newer_response["ok"] is True
    expect(page.locator("#bdc-current-video-return")).to_contain_text("0:04")
    page.evaluate("window.__assistantMockResolveTimestampSeeks()")
    older_response = wait_for_content_timestamp_result(page, "older")
    assert older_response["ok"] is False
    expect(page.locator("#bdc-current-video-return")).to_contain_text("0:04")
    assert_clean_visible_text(page)


def run_history_only_navigation_blocks_timestamp_jump(page):
    page.route("**/*", route_mock)
    page.goto(f"{MOCK_URL}?subtitleCached=1&sourceVersion=v2&savedSource=current")
    expect(page.locator("#bdc-current-video-assistant")).to_be_visible()

    initial_position = page.evaluate("window.__assistantMockPlaybackPosition()")
    page.evaluate("window.__assistantMockReplaceHistoryOnlyToPart(2)")
    page.evaluate("window.__assistantMockStartContentTimestampJump('history-only-jump', 'history-only-jump', 4)")
    response = wait_for_content_timestamp_result(page, "history-only-jump")
    assert response["ok"] is False
    assert "当前视频" in response["message"]
    assert page.evaluate("window.__assistantMockPlaybackPosition()") == initial_position
    expect(page.locator("#bdc-current-video-return")).to_have_count(0)
    assert_clean_visible_text(page)


def run_history_only_navigation_blocks_timestamp_return(page):
    page.route("**/*", route_mock)
    page.goto(f"{MOCK_URL}?subtitleCached=1&sourceVersion=v2&savedSource=current")
    expect(page.locator("#bdc-current-video-assistant")).to_be_visible()

    page.evaluate("window.__assistantMockStartContentTimestampJump('history-return-seed', 'history-return-seed', 8)")
    seed_response = wait_for_content_timestamp_result(page, "history-return-seed")
    assert seed_response["ok"] is True
    seeded_position = page.evaluate("window.__assistantMockPlaybackPosition()")
    page.evaluate("window.__assistantMockReplaceHistoryOnlyToPart(2)")
    page.evaluate("window.__assistantMockStartContentTimestampReturn('history-only-return')")
    response = wait_for_content_timestamp_result(page, "history-only-return")
    assert response["ok"] is False
    assert page.evaluate("window.__assistantMockPlaybackPosition()") == seeded_position
    expect(page.locator("#bdc-current-video-return")).to_have_count(0)
    assert_clean_visible_text(page)


def run_content_timestamp_return_epoch_flow(page):
    page.route("**/*", route_mock)
    page.goto(f"{MOCK_URL}?subtitleCached=1&sourceVersion=v2&savedSource=current")
    expect(page.locator("#bdc-current-video-assistant")).to_be_visible()

    page.evaluate("window.__assistantMockDeferNextTimestampSeek()")
    page.evaluate("window.__assistantMockStartContentTimestampJump('seed-return', 'seed-return', 8)")
    page.wait_for_function("window.__assistantMockPendingTimestampSeekCount() === 1")
    page.evaluate("window.__assistantMockResolveTimestampSeeks()")
    seed_response = wait_for_content_timestamp_result(page, "seed-return")
    assert seed_response["ok"] is True

    page.evaluate("window.__assistantMockDeferNextTimestampSeek()")
    page.evaluate("window.__assistantMockStartContentTimestampReturn('older-return')")
    page.wait_for_function("window.__assistantMockPendingTimestampSeekCount() === 1")
    page.evaluate("window.__assistantMockStartContentTimestampJump('newer-jump', 'newer-jump', 20)")
    newer_jump = wait_for_content_timestamp_result(page, "newer-jump")
    assert newer_jump["ok"] is True
    page.evaluate("window.__assistantMockResolveTimestampSeeks()")
    older_return = wait_for_content_timestamp_result(page, "older-return")
    assert older_return["ok"] is False

    page.evaluate("window.__assistantMockStartContentTimestampReturn('newer-return')")
    newer_return = wait_for_content_timestamp_result(page, "newer-return")
    assert newer_return["ok"] is True, "late old return cleared the newer jump return point"
    assert_clean_visible_text(page)


def run_content_timestamp_navigation_epoch_flow(page, target):
    page.route("**/*", route_mock)
    page.goto(f"{MOCK_URL}?subtitleCached=1&sourceVersion=v2&savedSource=current")
    expect(page.locator("#bdc-current-video-assistant")).to_be_visible()

    page.evaluate("window.__assistantMockDeferNextTimestampSeek()")
    page.evaluate("window.__assistantMockStartContentTimestampJump('nav-old', 'nav-old', 4)")
    page.wait_for_function("window.__assistantMockPendingTimestampSeekCount() === 1")
    if target == "part":
        page.evaluate("window.__assistantMockNavigateToPartWithoutCollect(2)")
    else:
        page.evaluate("window.__assistantMockSwitchToVideo()")
    page.evaluate("window.__assistantMockResolveTimestampSeeks()")
    response = wait_for_content_timestamp_result(page, "nav-old")
    assert response["ok"] is False
    assert "当前视频" in response["message"]
    expect(page.locator("#bdc-current-video-return")).to_have_count(0)
    assert_clean_visible_text(page)


def run_delayed_video_rebind_flow(page, reuse_same_element=False):
    page.route("**/*", route_mock)
    page.goto(MOCK_URL)
    expect(page.locator("#bdc-current-video-assistant")).to_be_visible()
    page.evaluate("window.__assistantMockClearMessages()")
    if reuse_same_element:
        page.evaluate("window.__assistantMockNavigateToPartWithoutCollect(2)")
        page.wait_for_timeout(1400)
        page.evaluate("window.__assistantMockDispatchVideoEvent('current', 'play')")
    else:
        page.evaluate("window.__assistantMockNavigateWithDelayedVideoReplacement(2, 6500)")
        page.wait_for_function("window.__assistantMockVideoReplacementDone()")
        page.wait_for_timeout(1300)
        page.evaluate("window.__assistantMockClearMessages()")
        page.evaluate("window.__assistantMockDispatchVideoEvent('old', 'play')")
        page.wait_for_timeout(50)
        old_actions = page.evaluate(
            """() => (window.__assistantMockMessages || [])
                .filter((message) => message.action === "PLAYER_ACTION")
                .map((message) => message.payload)"""
        )
        assert old_actions == [], f"detached video kept an active listener after rebind: {old_actions}"
        page.evaluate("window.__assistantMockClearMessages()")
        page.evaluate("window.__assistantMockDispatchVideoEvent('new', 'play')")
    page.wait_for_timeout(50)
    actions = page.evaluate(
        """() => (window.__assistantMockMessages || [])
            .filter((message) => message.action === "PLAYER_ACTION")
            .map((message) => message.payload)"""
    )
    assert len(actions) == 1, f"expected one listener on the current video element, got {actions}"
    assert actions[0].get("cid") == 3303, f"player event kept the old part identity: {actions}"
    if not reuse_same_element:
        page.evaluate("window.__assistantMockClearMessages()")
        page.wait_for_timeout(5200)
        heartbeats = page.evaluate(
            """() => (window.__assistantMockMessages || [])
                .filter((message) => message.action === "PLAYER_HEARTBEAT")
                .map((message) => message.payload)"""
        )
        assert len(heartbeats) == 1, f"expected one current heartbeat after rebind, got {heartbeats}"
        assert heartbeats[0].get("cid") == 3303, f"heartbeat kept the old part identity: {heartbeats}"
    assert_clean_visible_text(page)


def run_video_removed_without_replacement_flow(page):
    page.route("**/*", route_mock)
    page.goto(MOCK_URL)
    expect(page.locator("#bdc-current-video-assistant")).to_be_visible()
    page.evaluate("window.__assistantMockClearMessages()")
    page.evaluate("window.__assistantMockRemoveVideoWithoutReplacement(2)")
    page.wait_for_timeout(6200)
    page.evaluate("window.__assistantMockDispatchVideoEvent('old', 'play')")
    page.wait_for_timeout(50)
    old_messages = page.evaluate(
        """() => (window.__assistantMockMessages || [])
            .filter((message) => message.action === "PLAYER_ACTION" || message.action === "PLAYER_HEARTBEAT")
            .map((message) => message.payload)"""
    )
    assert old_messages == [], f"detached video kept listener or heartbeat while no replacement existed: {old_messages}"

    page.evaluate("window.__assistantMockClearMessages()")
    page.evaluate("window.__assistantMockInsertZeroDurationVideo()")
    page.wait_for_timeout(2200)
    zero_duration_messages = page.evaluate(
        """() => (window.__assistantMockMessages || [])
            .filter((message) => message.action === "PLAYER_ACTION" || message.action === "PLAYER_HEARTBEAT")
            .map((message) => message.payload)"""
    )
    assert zero_duration_messages == [], f"zero-duration replacement should not bind: {zero_duration_messages}"

    page.evaluate("window.__assistantMockMakeInsertedVideoReady()")
    page.wait_for_timeout(1600)
    page.evaluate("window.__assistantMockClearMessages()")
    page.evaluate("window.__assistantMockDispatchVideoEvent('new', 'play')")
    page.wait_for_timeout(50)
    actions = page.evaluate(
        """() => (window.__assistantMockMessages || [])
            .filter((message) => message.action === "PLAYER_ACTION")
            .map((message) => message.payload)"""
    )
    assert len(actions) == 1, f"expected one listener after valid replacement appears, got {actions}"
    assert actions[0].get("cid") == 3303, f"valid replacement rebound to the wrong part identity: {actions}"
    page.evaluate("window.__assistantMockClearMessages()")
    page.wait_for_timeout(5200)
    heartbeats = page.evaluate(
        """() => (window.__assistantMockMessages || [])
            .filter((message) => message.action === "PLAYER_HEARTBEAT")
            .map((message) => message.payload)"""
    )
    assert len(heartbeats) == 1, f"expected exactly one heartbeat after recovery, got {heartbeats}"
    assert heartbeats[0].get("cid") == 3303, f"heartbeat recovered with the wrong part identity: {heartbeats}"
    assert_clean_visible_text(page)


def run_missing_title_flow(page):
    page.route("**/*", route_mock)
    page.goto(f"{MOCK_URL}?missingTitle=1")
    expect(page.locator("#bdc-current-video-assistant")).to_be_visible()
    expand_assistant(page)
    expect(page.get_by_text("当前视频", exact=True).first).to_be_visible()
    assert_clean_visible_text(page)
    assert_no_horizontal_overflow(page)


def run_content_listener_controlled_error_flow(page):
    page.route("**/*", route_mock)
    page.goto(MOCK_URL)
    expect(page.locator("#bdc-current-video-assistant")).to_be_visible()
    jump_response = page.evaluate(
        """() => new Promise((resolve, reject) => {
          const contentListener = (() => {
            const listeners = window.__contentRuntimeListenersForQa || [];
            return listeners[0] || null;
          })();
          if (!contentListener) {
            reject(new Error("content listener unavailable"));
            return;
          }
          const context = [...(window.__assistantMockMessages || [])]
            .reverse()
            .find((message) => message.action === "CURRENT_VIDEO_CONTEXT_UPDATE")?.payload;
          if (!context || context.kind !== "video") {
            reject(new Error("video context unavailable"));
            return;
          }
          const originalCreateElement = document.createElement.bind(document);
          document.createElement = () => { throw new Error("document is not defined"); };
          const keepOpen = contentListener({
            action: "CURRENT_VIDEO_TIMESTAMP_JUMP",
            payload: {
              candidateId: "qa-controlled-error",
              confirmed: true,
              contextBvid: context.bvid,
              contextCid: context.cid,
              contextPage: context.currentPart.page,
              contextUrl: context.url,
              contextCollectedAt: context.collectedAt,
              targetSeconds: 4,
              targetTimeLabel: "0:04",
              sourceLabel: "字幕证据",
              confidence: 0.8,
              confidenceLabel: "高",
              evidencePreview: "受控错误测试",
              sourceIdentityKey: context.transcriptEvidence?.sourceIdentityKey || window.__assistantMockCurrentSourceIdentityKey(),
              operationLeaseId: "qa-controlled-error-lease",
            },
          }, {}, (response) => {
            document.createElement = originalCreateElement;
            resolve(response);
          });
          if (keepOpen !== true) {
            document.createElement = originalCreateElement;
            reject(new Error("jump listener did not keep channel open"));
          }
        })"""
    )
    assert jump_response["ok"] is False
    assert jump_response["message"] == "跳转失败，请确认当前视频页和播放器仍然可用后重试。"
    assert "document is not defined" not in jump_response["message"]

    return_response = page.evaluate(
        """() => new Promise((resolve, reject) => {
          const contentListener = (window.__contentRuntimeListenersForQa || [])[0];
          if (!contentListener) {
            reject(new Error("content listener unavailable"));
            return;
          }
          const originalQuerySelector = document.querySelector.bind(document);
          document.querySelector = () => { throw new Error("document is not defined"); };
          const keepOpen = contentListener(
            { action: "CURRENT_VIDEO_TIMESTAMP_RETURN", payload: {} },
            {},
            (response) => {
              document.querySelector = originalQuerySelector;
              resolve(response);
            },
          );
          if (keepOpen !== true) {
            document.querySelector = originalQuerySelector;
            reject(new Error("return listener did not keep channel open"));
          }
        })"""
    )
    assert return_response["ok"] is False
    assert return_response["message"] == "返回失败，请确认当前视频页和播放器仍然可用后重试。"
    assert "document is not defined" not in return_response["message"]


def run_selection_save_blocks_operations_flow(page):
    page.route("**/*", route_mock)
    page.goto(f"{MOCK_URL}?subtitleCached=1&sourceVersion=v2")
    expect(page.locator("#bdc-current-video-assistant")).to_be_visible()

    expand_assistant(page)
    source_refresh_button(page).click()
    expect(page.get_by_text("B站字幕").first).to_be_visible()
    select_assistant_tab(page, "问答")

    page.locator("textarea").fill("subagent 在哪里")
    page.get_by_role("button", name="提问").click()
    expect(page.get_by_text("回答：有证据").first).to_be_visible()
    page.get_by_role("button", name="预览跳转").first.click()
    expect(page.get_by_text("确认跳转前预览")).to_be_visible()

    page.evaluate("window.__assistantMockDeferNextPrimaryTextSelectionSave()")
    counts_before = {
        action: message_count_for(page, action)
        for action in [
            "ASK_CURRENT_VIDEO_FULL_TEXT",
            "REQUEST_CURRENT_VIDEO_QA_CITATION_JUMP",
        ]
    }
    page.locator(".bdc-assistant-source-card").filter(has_text="B站字幕").get_by_role("button", name="用于视频助手").click()
    expect(page.get_by_role("button", name="保存中...")).to_be_visible()
    expect(page.locator("textarea")).to_be_disabled()
    expect(page.get_by_role("button", name="确认跳转")).to_be_disabled()

    page.get_by_role("button", name="提问").evaluate("(button) => button.click()")
    page.get_by_role("button", name="确认跳转").evaluate("(button) => button.click()")
    for action, count in counts_before.items():
        assert message_count_for(page, action) == count, f"{action} should stay blocked while source save is pending"

    page.evaluate("window.__assistantMockResolvePrimaryTextSelectionSave()")
    expect(page.get_by_text("已用于当前视频助手").first).to_be_visible()
    expect(page.locator("textarea")).to_be_enabled()
    assert_clean_visible_text(page)
    assert_no_horizontal_overflow(page)


def run_selection_save_context_switch_flow(page, reject_save, switch_target):
    page.route("**/*", route_mock)
    page.goto(f"{MOCK_URL}?subtitleCached=1&sourceVersion=v2")
    expect(page.locator("#bdc-current-video-assistant")).to_be_visible()

    expand_assistant(page)
    source_refresh_button(page).click()
    expect(page.get_by_text("P1 / 2", exact=True)).to_be_visible()
    page.evaluate("window.__assistantMockDeferNextPrimaryTextSelectionSave()")
    if reject_save:
        page.evaluate("window.__assistantMockRejectNextPrimaryTextStorageSet()")
    page.locator(".bdc-assistant-source-card").filter(has_text="B站字幕").get_by_role("button", name="用于视频助手").click()
    expect(page.get_by_role("button", name="保存中...")).to_be_visible()

    if switch_target == "part":
        page.evaluate("window.__assistantMockSwitchToPart(2)")
        expect(page.get_by_text("P2 / 2", exact=True)).to_be_visible()
        new_part_key = "BV1ShellMock9:3303:2"
    else:
        page.evaluate("window.__assistantMockSwitchToVideo()")
        expect(page.get_by_text("延迟保存后切换的新视频", exact=True).first).to_be_visible()
        new_part_key = "BV1OtherMock8:4404:1"
    page.evaluate("window.__assistantMockResolvePrimaryTextSelectionSave()")
    page.wait_for_function("window.__assistantMockPrimaryTextSelectionSaveSettledCount() === 1")
    page.wait_for_timeout(20)

    assistant_text = page.locator("#bdc-current-video-assistant").inner_text()
    if switch_target == "part":
        assert "P2 / 2" in assistant_text
        assert "P1 / 2" not in assistant_text
    else:
        assert "延迟保存后切换的新视频" in assistant_text
        assert "页内助手 Shell Mock 视频" not in assistant_text
    assert "已用于当前视频助手" not in assistant_text
    assert "保存主要文本来源失败" not in assistant_text
    saved = page.evaluate("window.__assistantMockStorage.currentVideoPrimaryTextSelections || {}")
    old_part_key = "BV1ShellMock9:2202:1"
    if reject_save:
        assert old_part_key not in saved
    else:
        assert saved.get(old_part_key, "").endswith("mock-source-hash-hidden-v2")
    assert new_part_key not in saved
    save_message = last_message_for(page, "SAVE_CURRENT_VIDEO_PRIMARY_TEXT_SELECTION")
    assert save_message["params"]["cid"] == 2202
    assert save_message["params"]["page"] == 1
    assert_clean_visible_text(page)
    assert_no_horizontal_overflow(page)


def run_search_no_candidate_flow(page):
    page.route("**/*", route_mock)
    page.goto(f"{MOCK_URL}?subtitleCached=1&sourceVersion=v2")
    expect(page.locator("#bdc-current-video-assistant")).to_be_visible()
    expand_assistant(page)
    source_refresh_button(page).click()
    select_assistant_tab(page, "问答")
    page.locator("textarea").fill("没有候选")
    page.get_by_role("button", name="提问").click()
    expect(page.get_by_text("当前视频文本没有足够内容回答这个问题。")).to_be_visible()
    expect(page.get_by_role("button", name="预览跳转")).to_have_count(0)
    assert_clean_visible_text(page)
    assert_no_horizontal_overflow(page)


def run_search_backend_failure_flow(page):
    page.route("**/*", route_mock)
    page.goto(f"{MOCK_URL}?subtitleCached=1&sourceVersion=v2")
    expect(page.locator("#bdc-current-video-assistant")).to_be_visible()
    expand_assistant(page)
    source_refresh_button(page).click()
    select_assistant_tab(page, "问答")
    page.locator("textarea").fill("后台失败")
    page.get_by_role("button", name="提问").click()
    expect(page.get_by_text("回答失败，问题已保留。请确认当前视频页和 AI 设置后重试。")).to_be_visible()
    assert_clean_visible_text(page)
    assert_no_horizontal_overflow(page)


def run_full_text_context_too_long_flow(page):
    page.route("**/*", route_mock)
    page.goto(f"{MOCK_URL}?subtitleCached=1&sourceVersion=v2")
    expect(page.locator("#bdc-current-video-assistant")).to_be_visible()
    expand_assistant(page)
    source_refresh_button(page).click()
    select_assistant_tab(page, "问答")
    question = "正文过长时请完整回答"
    page.locator("textarea").fill(question)
    page.get_by_role("button", name="提问").click()
    expect(page.get_by_text("状态：正文过长")).to_be_visible()
    expect(page.get_by_text("系统不会截断或分段发送", exact=False)).to_be_visible()
    expect(page.locator("textarea")).to_have_value(question)
    expect(page.get_by_role("button", name="重试本题")).to_be_visible()
    first_ask = last_message_for(page, "ASK_CURRENT_VIDEO_FULL_TEXT")
    page.locator("textarea").fill("这是编辑后的新问题")
    page.get_by_role("button", name="重试本题").click()
    expect(page.get_by_text("状态：正文过长")).to_be_visible()
    retry_ask = last_message_for(page, "ASK_CURRENT_VIDEO_FULL_TEXT")
    assert retry_ask["params"]["requestId"] != first_ask["params"]["requestId"]
    assert retry_ask["params"]["turnId"] == first_ask["params"]["turnId"]
    assert retry_ask["params"]["question"] == question
    expect(page.locator("textarea")).to_have_value(question)
    expect(page.get_by_role("button", name="预览跳转")).to_have_count(0)
    assert_clean_visible_text(page)
    assert_no_horizontal_overflow(page)


def run_full_text_parallel_sessions_flow(page):
    page.route("**/*", route_mock)
    page.goto(f"{MOCK_URL}?subtitleCached=1&sourceVersion=v2")
    expect(page.locator("#bdc-current-video-assistant")).to_be_visible()
    expand_assistant(page)
    source_refresh_button(page).click()
    select_assistant_tab(page, "问答")

    first_question = "subagent A 会话问题"
    second_question = "subagent B 会话问题"
    page.locator("textarea").fill(first_question)
    page.evaluate("window.__assistantMockDeferNextProtectedAction('ASK_CURRENT_VIDEO_FULL_TEXT')")
    page.get_by_role("button", name="提问").click()
    page.wait_for_function("window.__assistantMockPendingProtectedResponseCount() === 1")
    expect(page.get_by_role("button", name="回答中...")).to_be_disabled()

    page.get_by_role("button", name="新建会话").click()
    expect(page.locator("textarea")).to_be_enabled()
    page.locator("textarea").fill(second_question)
    page.get_by_role("button", name="提问").click()
    expect(page.locator(".bdc-assistant-question-text")).to_have_text(second_question)
    expect(page.locator("textarea")).to_be_enabled()

    asks = page.evaluate(
        """() => (window.__assistantMockMessages || [])
            .filter((message) => message.action === 'ASK_CURRENT_VIDEO_FULL_TEXT')"""
    )
    assert len(asks) == 2
    assert asks[0]["params"]["sessionId"] != asks[1]["params"]["sessionId"]
    assert asks[0]["params"]["requestId"] != asks[1]["params"]["requestId"]
    assert message_count_for(page, "CANCEL_CURRENT_VIDEO_FULL_TEXT_QA") == 0

    page.evaluate("window.__assistantMockResolveProtectedResponses()")
    page.wait_for_function("window.__assistantMockPendingProtectedResponseCount() === 0")
    page.wait_for_timeout(50)
    expect(page.locator(".bdc-assistant-question-text")).to_have_text(second_question)
    expect(page.locator(".bdc-assistant-session-button-active")).to_contain_text(second_question)
    expect(page.locator("textarea")).to_be_enabled()
    assert message_count_for(page, "CANCEL_CURRENT_VIDEO_FULL_TEXT_QA") == 0
    assert_clean_visible_text(page)
    assert_no_horizontal_overflow(page)


def run_full_text_parallel_session_failure_flow(page):
    page.route("**/*", route_mock)
    page.goto(f"{MOCK_URL}?subtitleCached=1&sourceVersion=v2")
    expect(page.locator("#bdc-current-video-assistant")).to_be_visible()
    expand_assistant(page)
    source_refresh_button(page).click()
    select_assistant_tab(page, "问答")

    first_question = "subagent A 延迟失败"
    second_question = "subagent B 正常回答"
    page.locator("textarea").fill(first_question)
    page.evaluate("window.__assistantMockDeferNextProtectedAction('ASK_CURRENT_VIDEO_FULL_TEXT')")
    page.get_by_role("button", name="提问").click()
    page.wait_for_function("window.__assistantMockPendingProtectedResponseCount() === 1")

    page.get_by_role("button", name="新建会话").click()
    page.locator("textarea").fill(second_question)
    page.get_by_role("button", name="提问").click()
    expect(page.locator(".bdc-assistant-question-text")).to_have_text(second_question)

    page.evaluate("window.__assistantMockRejectProtectedResponses()")
    page.wait_for_function("window.__assistantMockPendingProtectedResponseCount() === 0")
    page.wait_for_timeout(50)
    expect(page.locator(".bdc-assistant-question-text")).to_have_text(second_question)
    expect(page.locator(".bdc-assistant-session-button-active")).to_contain_text(second_question)
    expect(page.get_by_text("回答失败，问题已保留。请确认当前视频页和 AI 设置后重试。")).to_have_count(0)
    expect(page.get_by_text("正在核对全片内容...")).to_have_count(0)
    expect(page.locator("textarea")).to_be_enabled()

    first_session = page.locator(".bdc-assistant-session-button").filter(has_text=first_question).first
    expect(first_session).to_be_visible()
    first_session.click()
    expect(page.get_by_text("回答失败，问题已保留。请确认当前视频页和 AI 设置后重试。")).to_be_visible()
    expect(page.get_by_role("button", name="重试本题")).to_be_visible()
    assert message_count_for(page, "CANCEL_CURRENT_VIDEO_FULL_TEXT_QA") == 0
    assert_clean_visible_text(page)
    assert_no_horizontal_overflow(page)


def run_full_text_raw_identity_copy_flow(page):
    page.route("**/*", route_mock)
    page.goto(f"{MOCK_URL}?subtitleCached=1&sourceVersion=v2")
    expect(page.locator("#bdc-current-video-assistant")).to_be_visible()
    expand_assistant(page)
    source_refresh_button(page).click()
    select_assistant_tab(page, "问答")
    page.locator("textarea").fill("subagent 原始身份泄漏")
    page.get_by_role("button", name="提问").click()
    expect(page.get_by_text("回答：有证据").first).to_be_visible()
    expect(page.get_by_text("内部信息已隐藏", exact=False).first).to_be_visible()
    expect(page.get_by_text("视频编号已隐藏", exact=False).first).to_be_visible()
    assert_clean_visible_text(page)
    assert_no_horizontal_overflow(page)


def assistant_tab_panel(page, tab):
    return page.locator(f'[data-assistant-tab-content="{tab}"]')


def assert_only_assistant_tab(page, tab):
    panels = page.locator("[data-assistant-tab-content]")
    expect(panels).to_have_count(1)
    expect(assistant_tab_panel(page, tab)).to_be_visible()


def summary_section(page):
    return assistant_tab_panel(page, "summary")


def highlights_section(page):
    return assistant_tab_panel(page, "highlights")


def open_selected_summary_assistant(page, query=""):
    page.route("**/*", route_mock)
    suffix = f"&{query}" if query else ""
    page.goto(f"{MOCK_URL}?subtitleCached=1&savedSource=current{suffix}")
    expect(page.locator("#bdc-current-video-assistant")).to_be_visible()
    assert message_count_for(page, "GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS") == 0
    expand_assistant(page)
    section = summary_section(page)
    expect(section).to_be_visible()
    source_refresh_button(page).click()
    expect(page.get_by_text("B站字幕").first).to_be_visible()
    page.wait_for_function(
        """() => (window.__assistantMockMessages || []).some(
            (message) => message.action === "GET_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS_CACHE"
        )"""
    )
    assert message_count_for(page, "GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS") == 0
    return section


def run_tab_isolation_flow(page):
    section = open_selected_summary_assistant(page, "cachedSummary=1")
    expect(page.get_by_text("辅助：字幕正文状态")).to_have_count(0)
    expect(page.get_by_text("字幕轨道", exact=True)).to_have_count(0)
    expect(page.get_by_text("字幕正文", exact=True)).to_have_count(0)
    expect(page.get_by_role("button", name="重新检测字幕")).to_have_count(1)
    assert_only_assistant_tab(page, "summary")
    expect(page.get_by_role("tab", name="摘要")).to_have_attribute("aria-selected", "true")
    expect(page.get_by_role("tab", name="摘要")).to_have_attribute("aria-controls", "bdc-current-video-assistant-panel-summary")
    expect(page.get_by_role("tab", name="亮点")).not_to_have_attribute("aria-controls", "bdc-current-video-assistant-panel-highlights")
    expect(section.locator(".bdc-assistant-summary-text").first).to_be_visible()
    expect(section.locator(".bdc-assistant-citation-title").filter(has_text="关键要点")).to_be_visible()
    expect(section.locator(".bdc-assistant-candidate-card")).to_have_count(0)

    summary_tab = page.get_by_role("tab", name="摘要")
    summary_tab.focus()
    summary_tab.press("ArrowRight")
    expect(page.get_by_role("tab", name="亮点")).to_be_focused()
    expect(page.get_by_role("tab", name="亮点")).to_have_attribute("aria-selected", "true")
    assert_only_assistant_tab(page, "highlights")
    page.get_by_role("tab", name="亮点").press("ArrowLeft")
    expect(page.get_by_role("tab", name="摘要")).to_be_focused()
    assert_only_assistant_tab(page, "summary")
    page.get_by_role("tab", name="摘要").press("End")
    expect(page.get_by_role("tab", name="字幕")).to_be_focused()
    expect(page.get_by_role("tab", name="字幕")).to_have_attribute("aria-selected", "true")
    assert_only_assistant_tab(page, "subtitles")
    page.get_by_role("tab", name="字幕").press("Home")
    expect(page.get_by_role("tab", name="摘要")).to_be_focused()
    expect(page.get_by_role("tab", name="摘要")).to_have_attribute("aria-selected", "true")
    assert_only_assistant_tab(page, "summary")

    select_assistant_tab(page, "亮点")
    section = highlights_section(page)
    assert_only_assistant_tab(page, "highlights")
    expect(page.get_by_role("tab", name="亮点")).to_have_attribute("aria-selected", "true")
    expect(section.locator(".bdc-assistant-candidate-card")).to_have_count(4)
    expect(section.locator(".bdc-assistant-citation-title").filter(has_text="摘要")).to_have_count(0)

    select_assistant_tab(page, "问答")
    assert_only_assistant_tab(page, "qa")
    expect(page.get_by_role("tab", name="问答")).to_have_attribute("aria-selected", "true")
    expect(page.locator("textarea")).to_be_visible()
    expect(page.get_by_label("搜索当前字幕来源")).to_have_count(0)

    select_assistant_tab(page, "字幕")
    assert_only_assistant_tab(page, "subtitles")
    expect(page.get_by_role("tab", name="字幕")).to_have_attribute("aria-selected", "true")
    expect(page.get_by_label("搜索当前字幕来源")).to_be_visible()
    expect(page.locator("textarea")).to_have_count(0)

    assert_no_full_text_or_search(page)
    assert_clean_visible_text(page)


def run_content_subtitle_return_toast_flow(page):
    page.route("**/*", route_mock)
    page.goto(f"{MOCK_URL}?subtitleCached=1&sourceVersion=v2")
    expect(page.locator("#bdc-current-video-assistant")).to_be_visible()

    page.evaluate(
        "window.__assistantMockStartContentTimestampJump('subtitle-return-toast', 'subtitle-line', 3, 'subtitle_view')"
    )
    response = wait_for_content_timestamp_result(page, "subtitle-return-toast")
    assert response["ok"] is True, response
    toast = page.locator("#bdc-current-video-return")
    expect(toast).to_be_visible()
    toast.get_by_role("button", name="返回").click()
    page.wait_for_function(
        """() => (window.__assistantMockMessages || [])
            .some((message) => message.action === 'RETURN_CURRENT_VIDEO_SUBTITLE_JUMP')"""
    )
    assert message_count_for(page, "RETURN_CURRENT_VIDEO_SUBTITLE_JUMP") == 1
    assert message_count_for(page, "RETURN_CURRENT_VIDEO_SEGMENT_JUMP") == 0
    assert_clean_visible_text(page)
    assert_no_horizontal_overflow(page)


def run_summary_highlights_success_flow(page, highlight_count):
    section = open_selected_summary_assistant(page, f"highlightCount={highlight_count}")
    expect(section.get_by_text("可在这里手动生成摘要与亮点；打开面板不会自动发送正文。")).to_be_visible()
    assert message_count_for(page, "GET_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS_CACHE") >= 1

    section.get_by_role("button", name="生成摘要与亮点").click()
    expect(section.get_by_text("页内助手使用一次完整正文请求生成合并结果", exact=False)).to_be_visible()
    expect(section.get_by_text("先确认当前主要文本来源。")).to_be_visible()
    expect(section.locator(".bdc-assistant-summary-text").first).to_be_visible()
    expect(section.locator(".bdc-assistant-citation-title").filter(has_text="关键要点")).to_be_visible()
    expect(section.locator(".bdc-assistant-candidate-card")).to_have_count(0)
    page.get_by_role("tab", name="亮点").click()
    section = highlights_section(page)
    cards = section.locator(".bdc-assistant-candidate-card")
    expect(cards).to_have_count(highlight_count)
    generate_message = last_message_for(page, "GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS")
    assert generate_message["params"].get("requestId")
    assert generate_message["params"].get("selectedSourceIdentityKey")

    initial_position = page.evaluate("window.__assistantMockPlaybackPosition()")
    cards.first.get_by_role("button", name="预览跳转").click()
    expect(section.get_by_text("确认跳转前预览")).to_be_visible()
    assert page.evaluate("window.__assistantMockPlaybackPosition()") == initial_position
    section.get_by_role("button", name="确认跳转", exact=True).click()
    expect(section.get_by_text("已跳到亮点位置，可返回原位置。")).to_be_visible()
    assert page.evaluate("window.__assistantMockPlaybackPosition()") == 0
    jump_message = last_message_for(page, "REQUEST_CURRENT_VIDEO_HIGHLIGHT_JUMP")
    for field in ["cacheKey", "requestId", "generatedAt", "model", "highlightId"]:
        assert jump_message["params"].get(field) is not None, f"highlight jump missing {field} binding"

    section.get_by_role("button", name="返回原位置", exact=True).click()
    expect(section.get_by_text("已返回原位置。")).to_be_visible()
    assert page.evaluate("window.__assistantMockPlaybackPosition()") == initial_position
    assert_clean_visible_text(page)
    assert_no_horizontal_overflow(page)


def run_summary_cache_restore_flow(page, authorization_off=False):
    query = "cachedSummary=1"
    if authorization_off:
        query += "&summaryDisabled=1"
    section = open_selected_summary_assistant(page, query)
    expect(section.get_by_text("页内助手使用一次完整正文请求生成合并结果", exact=False)).to_be_visible()
    assert message_count_for(page, "GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS") == 0
    expect(section.locator(".bdc-assistant-candidate-card")).to_have_count(0)
    page.get_by_role("tab", name="亮点").click()
    section = highlights_section(page)
    expect(section.locator(".bdc-assistant-candidate-card")).to_have_count(4)
    if authorization_off:
        expect(section.get_by_text("此前生成", exact=True)).to_be_visible()
        expect(section.get_by_text("关闭授权后仍可查看，但不能重新生成。", exact=False)).to_be_visible()
        expect(section.get_by_role("button", name="重新生成")).to_be_disabled()
    else:
        assert message_count_for(page, "GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS") == 0
        expect(section.get_by_role("button", name="重新生成")).to_be_enabled()
    assert_clean_visible_text(page)
    assert_no_horizontal_overflow(page)


def run_summary_live_config_disable_flow(page):
    section = open_selected_summary_assistant(page, "cachedSummary=1")
    expect(section.get_by_text("页内助手使用一次完整正文请求生成合并结果", exact=False)).to_be_visible()
    page.evaluate("window.__assistantMockEmitUserConfigChange('disable')")
    expect(section.get_by_text("此前生成", exact=True)).to_be_visible()
    expect(section.get_by_role("button", name="重新生成")).to_be_disabled()
    assert message_count_for(page, "GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS") == 0
    assert_clean_visible_text(page)
    assert_no_horizontal_overflow(page)


def run_summary_live_config_model_change_flow(page):
    section = open_selected_summary_assistant(page)
    page.evaluate("window.__assistantMockDeferNextProtectedAction('GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS')")
    section.get_by_role("button", name="生成摘要与亮点").click()
    expect(section.get_by_text("正在生成摘要、关键要点和视频亮点，请稍等。")).to_be_visible()
    page.wait_for_function("window.__assistantMockPendingProtectedResponseCount() === 1")
    generation_message = last_message_for(page, "GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS")

    page.evaluate("window.__assistantMockEmitUserConfigChange('model')")
    page.wait_for_function("(window.__assistantMockMessages || []).some(message => message.action === 'CANCEL_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS')")
    cancel_message = last_message_for(page, "CANCEL_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS")
    assert cancel_message["params"]["requestId"] == generation_message["params"]["requestId"]
    assert cancel_message["params"]["selectedSourceIdentityKey"] == generation_message["params"]["selectedSourceIdentityKey"]
    page.evaluate("window.__assistantMockResolveProtectedResponses()")
    page.wait_for_timeout(50)
    expect(section.get_by_text("页内助手使用一次完整正文请求生成合并结果 1", exact=False)).to_have_count(0)
    assert page.evaluate("window.__assistantMockSummaryCache()") is None

    section.get_by_role("button", name="生成摘要与亮点").click()
    expect(section.get_by_text("页内助手使用一次完整正文请求生成合并结果 1", exact=False)).to_be_visible()
    assert page.evaluate("window.__assistantMockSummaryCache().model") == "mock-model-v2"
    assert message_count_for(page, "GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS") == 2
    assert_clean_visible_text(page)
    assert_no_horizontal_overflow(page)


def run_summary_live_config_model_change_after_ready_flow(page):
    section = open_selected_summary_assistant(page, "cachedSummary=1")
    old_text = "页内助手使用一次完整正文请求生成合并结果 1。"
    expect(section.get_by_text(old_text)).to_be_visible()
    page.evaluate("window.__assistantMockEmitUserConfigChange('model')")
    expect(section.get_by_text("此前生成", exact=True)).to_be_visible()
    expect(section.get_by_text(old_text)).to_be_visible()
    section.get_by_role("button", name="重新生成").click()
    expect(section.get_by_text("页内助手使用一次完整正文请求生成合并结果 2", exact=False)).to_be_visible()
    assert page.evaluate("window.__assistantMockSummaryCache().model") == "mock-model-v2"
    assert_clean_visible_text(page)
    assert_no_horizontal_overflow(page)


def run_summary_terminal_state_flow(page, state):
    query_by_state = {
        "disabled": "summaryDisabled=1",
        "unconfigured": "summaryUnconfigured=1",
        "no_text": "summaryState=no_text",
        "invalid": "summaryState=invalid",
        "error": "summaryState=error",
    }
    expected_by_state = {
        "disabled": "当前视频 AI 助手未开启，本次没有发送正文。",
        "unconfigured": "AI 服务尚未配置完整，本次没有发送正文。",
        "no_text": "当前没有可用的主要正文，无法生成摘要与亮点。",
        "invalid": "模型返回内容无法完整引用当前正文，旧结果不会被替换。",
        "error": "摘要与亮点生成失败，旧结果不会被替换。",
    }
    section = open_selected_summary_assistant(page, query_by_state[state])
    if state in {"disabled", "unconfigured"}:
        expect(section.get_by_role("button", name="生成摘要与亮点")).to_be_disabled()
    else:
        section.get_by_role("button", name="生成摘要与亮点").click()
        assert message_count_for(page, "GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS") == 1
    expect(section.get_by_text(expected_by_state[state])).to_be_visible()
    assert_clean_visible_text(page)
    assert_no_horizontal_overflow(page)


def run_summary_cancel_after_source_change_flow(page):
    section = open_selected_summary_assistant(page)
    page.evaluate("window.__assistantMockDeferNextProtectedAction('GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS')")
    section.get_by_role("button", name="生成摘要与亮点").click()
    expect(section.get_by_text("正在生成摘要、关键要点和视频亮点，请稍等。")).to_be_visible()
    page.wait_for_function("window.__assistantMockPendingProtectedResponseCount() === 1")
    generate_message = last_message_for(page, "GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS")
    old_request_id = generate_message["params"]["requestId"]
    old_source = generate_message["params"]["selectedSourceIdentityKey"]

    page.evaluate("window.__assistantMockSwitchToPart(2)")
    expect(page.get_by_text("P2 / 2", exact=True)).to_be_visible()
    page.get_by_role("button", name="取消生成").click()
    cancel_message = last_message_for(page, "CANCEL_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS")
    assert cancel_message["params"]["requestId"] == old_request_id
    assert cancel_message["params"]["selectedSourceIdentityKey"] == old_source
    page.evaluate("window.__assistantMockResolveProtectedResponses()")
    expect(page.get_by_text("页内助手使用一次完整正文请求生成合并结果", exact=False)).to_have_count(0)
    assert page.evaluate("window.__assistantMockSummaryCache()") is None
    assert_clean_visible_text(page)
    assert_no_horizontal_overflow(page)


def run_summary_late_old_source_response_after_selection_change_flow(page):
    section = open_selected_summary_assistant(page)
    page.evaluate("window.__assistantMockDeferNextProtectedAction('GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS')")
    section.get_by_role("button", name="生成摘要与亮点").click()
    expect(section.get_by_text("正在生成摘要、关键要点和视频亮点，请稍等。")).to_be_visible()
    page.wait_for_function("window.__assistantMockPendingProtectedResponseCount() === 1")
    generate_message = last_message_for(page, "GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS")
    old_request_id = generate_message["params"]["requestId"]
    old_source = generate_message["params"]["selectedSourceIdentityKey"]
    b_text = "页内助手使用一次完整正文请求生成合并结果 7。"
    late_a_text = "页内助手使用一次完整正文请求生成合并结果 8。"

    evidence_reads_before = message_count_for(page, "GET_CURRENT_VIDEO_TRANSCRIPT_EVIDENCE")
    page.evaluate("window.__assistantMockReplaceSubtitleSource('b')")
    source_refresh_button(page).click()
    page.wait_for_function(
        """(before) => (window.__assistantMockMessages || []).filter(
            (message) => message.action === "GET_CURRENT_VIDEO_TRANSCRIPT_EVIDENCE"
        ).length > before""",
        arg=evidence_reads_before,
    )
    new_source = page.evaluate("window.__assistantMockCurrentSourceIdentityKey()")
    page.evaluate("window.__assistantMockSeedSummaryCacheForCurrentSource(7)")
    page.evaluate(
        "(sourceIdentityKey) => window.__assistantMockSelectSourceIdentityForCurrentPart(sourceIdentityKey)",
        new_source,
    )
    page.evaluate("window.__assistantMockResolveProtectedResponses()")
    page.wait_for_function("window.__assistantMockSummaryCacheForCurrentSource() !== null")
    expect(section.get_by_text(b_text)).to_be_visible()

    assert message_count_for(page, "CANCEL_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS") == 0
    assert message_count_for(page, "GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS") == 1
    assert page.evaluate("(source) => window.__assistantMockSummaryCacheForSource(source).requestId", old_source) == old_request_id
    assert page.evaluate("window.__assistantMockSummaryCacheForCurrentSource().requestId") != old_request_id
    expect(section.get_by_text(late_a_text)).to_have_count(0)
    expect(section.get_by_text(b_text)).to_be_visible()
    assert_clean_visible_text(page)
    assert_no_horizontal_overflow(page)


def run_summary_preview_replacement_race_flow(page):
    open_selected_summary_assistant(page, "cachedSummary=1")
    page.get_by_role("tab", name="亮点").click()
    section = highlights_section(page)
    expect(section.locator(".bdc-assistant-candidate-card")).to_have_count(4)
    initial_position = page.evaluate("window.__assistantMockPlaybackPosition()")
    section.locator(".bdc-assistant-candidate-card").first.get_by_role("button", name="预览跳转").click()
    expect(section.get_by_text("确认跳转前预览")).to_be_visible()
    page.evaluate("window.__assistantMockReplaceSummaryGeneration()")
    section.get_by_role("button", name="确认跳转", exact=True).click()
    expect(section.get_by_text("亮点结果或页面状态已变化，请重新预览后再试。")).to_be_visible()
    expect(section.get_by_role("button", name="返回原位置", exact=True)).to_have_count(0)
    assert page.evaluate("window.__assistantMockPlaybackPosition()") == initial_position
    assert_clean_visible_text(page)
    assert_no_horizontal_overflow(page)


def run_summary_prior_refresh_failure_flow(page, failure):
    query = "cachedSummary=1&summaryState=invalid" if failure == "invalid" else "cachedSummary=1&summaryReject=1"
    expected = (
        "模型返回内容无法完整引用当前正文，旧结果不会被替换。"
        if failure == "invalid"
        else "摘要与亮点生成失败，请确认当前视频页仍然打开后重试。"
    )
    section = open_selected_summary_assistant(page, query)
    old_text = "页内助手使用一次完整正文请求生成合并结果 1。"
    expect(section.get_by_text(old_text)).to_be_visible()
    section.get_by_role("button", name="重新生成").click()
    expect(section.get_by_text(expected)).to_be_visible()
    expect(section.get_by_text(old_text)).to_be_visible()
    expect(section.get_by_text("此前生成", exact=True)).to_be_visible()
    assert_clean_visible_text(page)
    assert_no_horizontal_overflow(page)


def run_summary_prior_cancel_flow(page):
    section = open_selected_summary_assistant(page, "cachedSummary=1")
    old_text = "页内助手使用一次完整正文请求生成合并结果 1。"
    page.evaluate("window.__assistantMockDeferNextProtectedAction('GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS')")
    section.get_by_role("button", name="重新生成").click()
    expect(section.get_by_text("正在生成摘要、关键要点和视频亮点，请稍等。")).to_be_visible()
    expect(section.get_by_text(old_text)).to_be_visible()
    expect(section.get_by_text("此前生成", exact=True)).to_be_visible()
    page.get_by_role("button", name="取消生成").click()
    expect(section.get_by_text("本次生成已取消，此前结果保持不变。")).to_be_visible()
    expect(section.get_by_text(old_text)).to_be_visible()
    page.evaluate("window.__assistantMockResolveProtectedResponses()")
    expect(section.get_by_text(old_text)).to_be_visible()
    assert_clean_visible_text(page)
    assert_no_horizontal_overflow(page)


def run_summary_prior_cancel_after_source_selection_change_flow(page):
    section = open_selected_summary_assistant(page, "cachedSummary=1")
    old_text = "页内助手使用一次完整正文请求生成合并结果 1。"
    b_text = "页内助手使用一次完整正文请求生成合并结果 7。"
    expect(section.get_by_text(old_text)).to_be_visible()
    page.evaluate("window.__assistantMockDeferNextProtectedAction('GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS')")
    section.get_by_role("button", name="重新生成").click()
    expect(section.get_by_text("正在生成摘要、关键要点和视频亮点，请稍等。")).to_be_visible()
    expect(section.get_by_text(old_text)).to_be_visible()
    expect(section.get_by_text("此前生成", exact=True)).to_be_visible()
    page.wait_for_function("window.__assistantMockPendingProtectedResponseCount() === 1")
    generation_message = last_message_for(page, "GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS")
    old_request_id = generation_message["params"]["requestId"]
    old_source = generation_message["params"]["selectedSourceIdentityKey"]
    evidence_reads_before = message_count_for(page, "GET_CURRENT_VIDEO_TRANSCRIPT_EVIDENCE")
    page.evaluate("window.__assistantMockReplaceSubtitleSource('b')")
    source_refresh_button(page).click()
    page.wait_for_function(
        """(before) => (window.__assistantMockMessages || []).filter(
            (message) => message.action === "GET_CURRENT_VIDEO_TRANSCRIPT_EVIDENCE"
        ).length > before""",
        arg=evidence_reads_before,
    )
    new_source = page.evaluate("window.__assistantMockCurrentSourceIdentityKey()")
    page.evaluate("window.__assistantMockSeedSummaryCacheForCurrentSource(7)")

    page.evaluate(
        "(sourceIdentityKey) => window.__assistantMockSelectSourceIdentityForCurrentPart(sourceIdentityKey)",
        new_source,
    )
    expect(section.get_by_text(old_text)).to_have_count(0)
    page.get_by_role("button", name="取消生成").click()
    page.wait_for_function("(window.__assistantMockMessages || []).some(message => message.action === 'CANCEL_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS')")
    cancel_message = last_message_for(page, "CANCEL_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS")
    assert cancel_message["params"]["requestId"] == old_request_id
    assert cancel_message["params"]["selectedSourceIdentityKey"] == old_source
    assert message_count_for(page, "GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS") == 1
    expect(section.get_by_text(b_text)).to_be_visible()

    page.evaluate("window.__assistantMockResolveProtectedResponses()")
    page.wait_for_function("window.__assistantMockSummaryCacheForCurrentSource() !== null")
    assert page.evaluate("window.__assistantMockSummaryCacheForCurrentSource().requestId") != old_request_id
    expect(section.get_by_text(old_text)).to_have_count(0)
    expect(section.get_by_text(b_text)).to_be_visible()
    assert message_count_for(page, "GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS") == 1
    assert_clean_visible_text(page)
    assert_no_horizontal_overflow(page)


def run_summary_runtime_only_reopen_flow(page):
    section = open_selected_summary_assistant(page)
    section.get_by_role("button", name="生成摘要与亮点").click()
    runtime_text = "页内助手使用一次完整正文请求生成合并结果 1。"
    expect(section.get_by_text(runtime_text)).to_be_visible()
    page.evaluate("window.__assistantMockDropSummaryCache()")
    cache_reads = message_count_for(page, "GET_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS_CACHE")
    page.get_by_role("button", name="收起").click()
    expand_assistant(page)
    page.wait_for_function(
        """(previous) => (window.__assistantMockMessages || []).filter(
            (message) => message.action === "GET_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS_CACHE"
        ).length > previous""",
        arg=cache_reads,
    )
    section = summary_section(page)
    expect(section.get_by_text(runtime_text)).to_be_visible()
    expect(section.get_by_text("可在这里手动生成摘要与亮点；打开面板不会自动发送正文。")).to_have_count(0)
    assert_clean_visible_text(page)
    assert_no_horizontal_overflow(page)


def main():
    build_player_monitor_bundle()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=os.environ.get("UX014_CHROME_EXECUTABLE"))
        try:
            summary_cases = [
                ("success-desktop", {"width": 1280, "height": 820}, False, lambda page: run_summary_highlights_success_flow(page, 4)),
                ("success-mobile", {"width": 390, "height": 760}, True, lambda page: run_summary_highlights_success_flow(page, 8)),
                ("cache-restore", {"width": 1280, "height": 820}, False, lambda page: run_summary_cache_restore_flow(page)),
                ("authorization-off-cache", {"width": 1280, "height": 820}, False, lambda page: run_summary_cache_restore_flow(page, authorization_off=True)),
                ("live-disable-cache", {"width": 1280, "height": 820}, False, run_summary_live_config_disable_flow),
                ("live-model-change", {"width": 1280, "height": 820}, False, run_summary_live_config_model_change_flow),
                ("live-model-ready-cache", {"width": 1280, "height": 820}, False, run_summary_live_config_model_change_after_ready_flow),
                ("cancel-source-change", {"width": 1280, "height": 820}, False, run_summary_cancel_after_source_change_flow),
                ("late-old-source-selection-change", {"width": 1280, "height": 820}, False, run_summary_late_old_source_response_after_selection_change_flow),
                ("preview-replacement", {"width": 1280, "height": 820}, False, run_summary_preview_replacement_race_flow),
                ("prior-invalid", {"width": 1280, "height": 820}, False, lambda page: run_summary_prior_refresh_failure_flow(page, "invalid")),
                ("prior-network-error", {"width": 1280, "height": 820}, False, lambda page: run_summary_prior_refresh_failure_flow(page, "network")),
                ("prior-cancel", {"width": 1280, "height": 820}, False, run_summary_prior_cancel_flow),
                ("prior-cancel-source-change", {"width": 1280, "height": 820}, False, run_summary_prior_cancel_after_source_selection_change_flow),
                ("runtime-only-reopen", {"width": 1280, "height": 820}, False, run_summary_runtime_only_reopen_flow),
            ]
            summary_cases.extend(
                (f"state-{state}", {"width": 1280, "height": 820}, False, lambda page, value=state: run_summary_terminal_state_flow(page, value))
                for state in ["disabled", "unconfigured", "no_text", "invalid", "error"]
            )
            for label, viewport, is_mobile, runner in summary_cases:
                summary_page, summary_errors = new_checked_page(browser, viewport=viewport, is_mobile=is_mobile)
                runner(summary_page)
                assert not summary_errors, f"{label}:\n" + "\n".join(summary_errors)
                summary_page.close()

            deferred_storage, deferred_storage_errors = new_checked_page(browser, viewport={"width": 1280, "height": 820})
            run_deferred_storage_flow(deferred_storage)
            assert not deferred_storage_errors, "\n".join(deferred_storage_errors)
            deferred_storage.close()

            single_v2, single_v2_errors = new_checked_page(browser, viewport={"width": 1280, "height": 820})
            run_single_v2_without_saved_selection_flow(single_v2)
            assert not single_v2_errors, "\n".join(single_v2_errors)
            single_v2.close()

            rejected_storage, rejected_storage_errors = new_checked_page(browser, viewport={"width": 1280, "height": 820})
            run_rejected_storage_single_v2_flow(rejected_storage)
            assert not rejected_storage_errors, "\n".join(rejected_storage_errors)
            rejected_storage.close()

            loaded_save_failure, loaded_save_failure_errors = new_checked_page(browser, viewport={"width": 1280, "height": 820})
            run_loaded_selection_save_failure_flow(loaded_save_failure)
            assert not loaded_save_failure_errors, "\n".join(loaded_save_failure_errors)
            loaded_save_failure.close()

            storage_change, storage_change_errors = new_checked_page(browser, viewport={"width": 1280, "height": 820})
            run_loaded_storage_change_invalidation_flow(storage_change)
            assert not storage_change_errors, "\n".join(storage_change_errors)
            storage_change.close()

            deferred_collect, deferred_collect_errors = new_checked_page(browser, viewport={"width": 1280, "height": 820})
            run_navigation_epoch_flow(deferred_collect, "collect")
            assert not deferred_collect_errors, "\n".join(deferred_collect_errors)
            deferred_collect.close()

            deferred_detect, deferred_detect_errors = new_checked_page(browser, viewport={"width": 1280, "height": 820})
            run_navigation_epoch_flow(deferred_detect, "detect")
            assert not deferred_detect_errors, "\n".join(deferred_detect_errors)
            deferred_detect.close()

            late_jump_part, late_jump_part_errors = new_checked_page(browser, viewport={"width": 1280, "height": 820})
            run_late_assistant_timestamp_flow(late_jump_part, "jump", "part")
            assert not late_jump_part_errors, "\n".join(late_jump_part_errors)
            late_jump_part.close()

            late_return_video, late_return_video_errors = new_checked_page(browser, viewport={"width": 1280, "height": 820})
            run_late_assistant_timestamp_flow(late_return_video, "return", "video")
            assert not late_return_video_errors, "\n".join(late_return_video_errors)
            late_return_video.close()

            late_jump_local, late_jump_local_errors = new_checked_page(browser, viewport={"width": 1280, "height": 820})
            run_late_assistant_timestamp_flow(late_jump_local, "jump", "localSettings")
            assert not late_jump_local_errors, "\n".join(late_jump_local_errors)
            late_jump_local.close()

            late_return_clear_all, late_return_clear_all_errors = new_checked_page(browser, viewport={"width": 1280, "height": 820})
            run_late_assistant_timestamp_flow(late_return_clear_all, "return", "clearAll")
            assert not late_return_clear_all_errors, "\n".join(late_return_clear_all_errors)
            late_return_clear_all.close()

            content_timestamp, content_timestamp_errors = new_checked_page(browser, viewport={"width": 1280, "height": 820})
            run_content_timestamp_operation_epoch_flow(content_timestamp)
            assert not content_timestamp_errors, "\n".join(content_timestamp_errors)
            content_timestamp.close()

            subtitle_return_toast, subtitle_return_toast_errors = new_checked_page(browser, viewport={"width": 1280, "height": 820})
            run_content_subtitle_return_toast_flow(subtitle_return_toast)
            assert not subtitle_return_toast_errors, "\n".join(subtitle_return_toast_errors)
            subtitle_return_toast.close()

            history_jump, history_jump_errors = new_checked_page(browser, viewport={"width": 1280, "height": 820})
            run_history_only_navigation_blocks_timestamp_jump(history_jump)
            assert not history_jump_errors, "\n".join(history_jump_errors)
            history_jump.close()

            history_return, history_return_errors = new_checked_page(browser, viewport={"width": 1280, "height": 820})
            run_history_only_navigation_blocks_timestamp_return(history_return)
            assert not history_return_errors, "\n".join(history_return_errors)
            history_return.close()

            content_return, content_return_errors = new_checked_page(browser, viewport={"width": 1280, "height": 820})
            run_content_timestamp_return_epoch_flow(content_return)
            assert not content_return_errors, "\n".join(content_return_errors)
            content_return.close()

            content_jump_part, content_jump_part_errors = new_checked_page(browser, viewport={"width": 1280, "height": 820})
            run_content_timestamp_navigation_epoch_flow(content_jump_part, "part")
            assert not content_jump_part_errors, "\n".join(content_jump_part_errors)
            content_jump_part.close()

            content_jump_video, content_jump_video_errors = new_checked_page(browser, viewport={"width": 1280, "height": 820})
            run_content_timestamp_navigation_epoch_flow(content_jump_video, "video")
            assert not content_jump_video_errors, "\n".join(content_jump_video_errors)
            content_jump_video.close()

            delayed_video_rebind, delayed_video_rebind_errors = new_checked_page(browser, viewport={"width": 1280, "height": 820})
            run_delayed_video_rebind_flow(delayed_video_rebind)
            assert not delayed_video_rebind_errors, "\n".join(delayed_video_rebind_errors)
            delayed_video_rebind.close()

            reused_video, reused_video_errors = new_checked_page(browser, viewport={"width": 1280, "height": 820})
            run_delayed_video_rebind_flow(reused_video, reuse_same_element=True)
            assert not reused_video_errors, "\n".join(reused_video_errors)
            reused_video.close()

            removed_video, removed_video_errors = new_checked_page(browser, viewport={"width": 1280, "height": 820})
            run_video_removed_without_replacement_flow(removed_video)
            assert not removed_video_errors, "\n".join(removed_video_errors)
            removed_video.close()

            missing_title, missing_title_errors = new_checked_page(browser, viewport={"width": 1280, "height": 820})
            run_missing_title_flow(missing_title)
            assert not missing_title_errors, "\n".join(missing_title_errors)
            missing_title.close()

            listener_errors, listener_errors_console = new_checked_page(browser, viewport={"width": 1280, "height": 820})
            run_content_listener_controlled_error_flow(listener_errors)
            assert not listener_errors_console, "\n".join(listener_errors_console)
            listener_errors.close()

            saving, saving_errors = new_checked_page(browser, viewport={"width": 1280, "height": 820})
            run_selection_save_blocks_operations_flow(saving)
            assert not saving_errors, "\n".join(saving_errors)
            saving.close()

            switched_success, switched_success_errors = new_checked_page(browser, viewport={"width": 1280, "height": 820})
            run_selection_save_context_switch_flow(switched_success, reject_save=False, switch_target="part")
            assert not switched_success_errors, "\n".join(switched_success_errors)
            switched_success.close()

            switched_failure, switched_failure_errors = new_checked_page(browser, viewport={"width": 1280, "height": 820})
            run_selection_save_context_switch_flow(switched_failure, reject_save=True, switch_target="part")
            assert not switched_failure_errors, "\n".join(switched_failure_errors)
            switched_failure.close()

            switched_video_success, switched_video_success_errors = new_checked_page(browser, viewport={"width": 1280, "height": 820})
            run_selection_save_context_switch_flow(switched_video_success, reject_save=False, switch_target="video")
            assert not switched_video_success_errors, "\n".join(switched_video_success_errors)
            switched_video_success.close()

            switched_video_failure, switched_video_failure_errors = new_checked_page(browser, viewport={"width": 1280, "height": 820})
            run_selection_save_context_switch_flow(switched_video_failure, reject_save=True, switch_target="video")
            assert not switched_video_failure_errors, "\n".join(switched_video_failure_errors)
            switched_video_failure.close()

            no_candidate, no_candidate_errors = new_checked_page(browser, viewport={"width": 1280, "height": 820})
            run_search_no_candidate_flow(no_candidate)
            assert not no_candidate_errors, "\n".join(no_candidate_errors)
            no_candidate.close()

            backend_failure, backend_failure_errors = new_checked_page(browser, viewport={"width": 1280, "height": 820})
            run_search_backend_failure_flow(backend_failure)
            assert not backend_failure_errors, "\n".join(backend_failure_errors)
            backend_failure.close()

            too_long, too_long_errors = new_checked_page(browser, viewport={"width": 1280, "height": 820})
            run_full_text_context_too_long_flow(too_long)
            assert not too_long_errors, "\n".join(too_long_errors)
            too_long.close()

            raw_identity, raw_identity_errors = new_checked_page(browser, viewport={"width": 1280, "height": 820})
            run_full_text_raw_identity_copy_flow(raw_identity)
            assert not raw_identity_errors, "\n".join(raw_identity_errors)
            raw_identity.close()

            parallel_sessions, parallel_sessions_errors = new_checked_page(browser, viewport={"width": 1280, "height": 820})
            run_full_text_parallel_sessions_flow(parallel_sessions)
            assert not parallel_sessions_errors, "\n".join(parallel_sessions_errors)
            parallel_sessions.close()

            parallel_session_failure, parallel_session_failure_errors = new_checked_page(browser, viewport={"width": 1280, "height": 820})
            run_full_text_parallel_session_failure_flow(parallel_session_failure)
            assert not parallel_session_failure_errors, "\n".join(parallel_session_failure_errors)
            parallel_session_failure.close()

            subtitle_desktop, subtitle_desktop_errors = new_checked_page(browser, viewport={"width": 1280, "height": 820})
            run_subtitle_single_source_flow(subtitle_desktop)
            assert not subtitle_desktop_errors, "\n".join(subtitle_desktop_errors)
            subtitle_desktop.close()

            subtitle_mobile, subtitle_mobile_errors = new_checked_page(browser, viewport={"width": 390, "height": 760}, is_mobile=True)
            run_subtitle_single_source_flow(subtitle_mobile)
            assert not subtitle_mobile_errors, "\n".join(subtitle_mobile_errors)
            subtitle_mobile.close()

            subtitle_dual, subtitle_dual_errors = new_checked_page(browser, viewport={"width": 1280, "height": 820})
            run_subtitle_dual_source_independence_flow(subtitle_dual)
            assert not subtitle_dual_errors, "\n".join(subtitle_dual_errors)
            subtitle_dual.close()

            subtitle_stale, subtitle_stale_errors = new_checked_page(browser, viewport={"width": 1280, "height": 820})
            run_subtitle_stale_source_flow(subtitle_stale)
            assert not subtitle_stale_errors, "\n".join(subtitle_stale_errors)
            subtitle_stale.close()

            subtitle_late, subtitle_late_errors = new_checked_page(browser, viewport={"width": 1280, "height": 820})
            run_subtitle_late_source_response_flow(subtitle_late)
            assert not subtitle_late_errors, "\n".join(subtitle_late_errors)
            subtitle_late.close()

            tabs_desktop, tabs_desktop_errors = new_checked_page(browser, viewport={"width": 1280, "height": 820})
            run_tab_isolation_flow(tabs_desktop)
            assert not tabs_desktop_errors, "\n".join(tabs_desktop_errors)
            tabs_desktop.close()

            tabs_mobile, tabs_mobile_errors = new_checked_page(browser, viewport={"width": 390, "height": 760}, is_mobile=True)
            run_tab_isolation_flow(tabs_mobile)
            assert not tabs_mobile_errors, "\n".join(tabs_mobile_errors)
            tabs_mobile.close()

            late_switch, late_switch_errors = new_checked_page(browser, viewport={"width": 1280, "height": 820})
            run_late_switch_flow(late_switch)
            assert not late_switch_errors, "\n".join(late_switch_errors)
            late_switch.close()

            missing_selection, missing_selection_errors = new_checked_page(browser, viewport={"width": 1280, "height": 820})
            run_missing_selection_flow(missing_selection)
            assert not missing_selection_errors, "\n".join(missing_selection_errors)
            missing_selection.close()

            desktop, desktop_errors = new_checked_page(browser, viewport={"width": 1280, "height": 820})
            run_flow(desktop)
            assert not desktop_errors, "\n".join(desktop_errors)
            desktop.close()

            mobile, mobile_errors = new_checked_page(browser, viewport={"width": 390, "height": 760}, is_mobile=True)
            run_flow(mobile)
            assert not mobile_errors, "\n".join(mobile_errors)
            mobile.close()

            print("current-video primary-text real UI QA passed: isolated summary/highlights/QA/subtitle tabs on desktop and mobile with keyboard focus and active-panel ARIA, subtitle B站/local source viewing/search/follow focus preservation/jump/export/stale and late-response races, subtitle-view toast return routing without primary selection, 4/8 highlights, cache-only restore, authorization-off/live-disabled prior result, live model-change cancellation and exact-model cache refresh, failed-refresh old-result preservation, runtime-only reopen preservation, disabled/unconfigured/no-text/generating-cancel/invalid/error states, summary source-change isolation, QA immutable-snapshot completion and parallel-session success/failure isolation, preview replacement rejection, preview/confirm/return, no legacy summary action, responsive no-overflow/no-console/raw-copy checks, plus existing primary-text and timestamp race coverage")
        finally:
            browser.close()


def new_checked_page(browser, **kwargs):
    page = browser.new_page(**kwargs)
    errors = []
    page.on("console", lambda message: errors.append(f"console {message.type}: {message.text}") if message.type == "error" else None)
    page.on("pageerror", lambda error: errors.append(f"pageerror: {error}"))
    return page, errors


if __name__ == "__main__":
    main()
