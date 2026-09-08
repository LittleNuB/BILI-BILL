from pathlib import Path
import mimetypes
import os
import subprocess
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
POPUP_HTML = ROOT / "dist" / "popup" / "index.html"
POPUP_BUNDLE = ROOT / "dist" / "popup.js"
MOCK_SCRIPT = ROOT / "tests" / "current-video-popup.mock.js"
POPUP_URL = "http://popup.mock/popup"
PROTECTED_ACTIONS = {
    "GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS",
    "GET_VIDEO_KNOWLEDGE",
    "ASK_CURRENT_VIDEO_FULL_TEXT",
    "CANCEL_CURRENT_VIDEO_FULL_TEXT_QA",
    "REQUEST_CURRENT_VIDEO_QA_CITATION_JUMP",
    "SEARCH_CURRENT_VIDEO_SEGMENTS",
    "REQUEST_CURRENT_VIDEO_SEGMENT_JUMP",
    "REQUEST_CURRENT_VIDEO_HIGHLIGHT_JUMP",
    "RETURN_CURRENT_VIDEO_SEGMENT_JUMP",
}
FORBIDDEN_VISIBLE_TERMS = [
    "未消费",
    "猜你喜欢",
    "BVID",
    "CID",
    "BV1PopupMock9",
    "9201",
    "BV1PopupNext7",
    "BV1RawLeak99",
    "9302",
    "fallback",
    "transcript",
    "confidence",
    "sourceHash",
    "segmentId",
    "subtitle_url",
    "document is not defined",
    "MOCK_POPUP_PRIMARY_TEXT_STORAGE_READ_FAILED",
    "PRIMARY_TEXT",
]


def build_popup_bundle():
    npm = "npm.cmd" if os.name == "nt" else "npm"
    result = subprocess.run(
        [npm, "run", "build"],
        cwd=ROOT,
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=180,
    )
    if result.returncode != 0:
        raise AssertionError(f"popup production build failed:\n{result.stdout}")
    if not POPUP_HTML.exists() or not POPUP_BUNDLE.exists():
        raise AssertionError("popup production artifact was not generated")


def route_popup(route):
    parsed = urlparse(route.request.url)
    if parsed.path == "/popup":
        html = POPUP_HTML.read_text(encoding="utf-8")
        mock = MOCK_SCRIPT.read_text(encoding="utf-8")
        html = html.replace("</head>", f"<script>{mock}</script></head>")
        route.fulfill(status=200, content_type="text/html; charset=utf-8", body=html)
        return

    local_path = ROOT / "dist" / parsed.path.lstrip("/")
    if local_path.exists() and local_path.is_file():
        content_type = mimetypes.guess_type(local_path.name)[0] or "application/octet-stream"
        route.fulfill(status=200, content_type=content_type, body=local_path.read_bytes())
        return

    route.fulfill(status=404, body="not found")


def messages_for(page, action):
    return page.evaluate(
        """(action) => (window.__popupMockMessages || []).filter(message => message.action === action)""",
        action,
    )


def last_message_for(page, action):
    messages = messages_for(page, action)
    return messages[-1] if messages else None


def assert_no_protected_actions(page):
    actions = page.evaluate("(window.__popupMockMessages || []).map(message => message.action)")
    assert not PROTECTED_ACTIONS.intersection(actions), f"popup sent protected actions automatically: {actions}"


def assert_clean_page(page):
    actions = page.evaluate("(window.__popupMockMessages || []).map(message => message.action)")
    assert "GET_CURRENT_VIDEO_SUMMARY" not in actions, "popup called the legacy bounded summary route"
    visible = page.locator("body").inner_text()
    for term in FORBIDDEN_VISIBLE_TERMS:
        assert term not in visible, f"popup leaked raw visible term: {term}"
    overflow = page.evaluate("document.documentElement.scrollWidth > window.innerWidth + 1")
    assert not overflow, "popup has horizontal overflow"


def assert_quick_stats_signal_render(page):
    completion_label = page.get_by_text("平均完播率", exact=True)
    expect(completion_label).to_be_visible()
    expect(completion_label.locator("..").get_by_text("50%", exact=True)).to_be_visible()


def qa_panel(page):
    return page.get_by_text("问这个视频", exact=True).locator("..")


def submit_qa(page, question):
    panel = qa_panel(page)
    panel.locator("textarea").fill(question)
    panel.get_by_role("button", name="提问", exact=True).click()
    return panel


def prepare_qa_preview(page, question):
    panel = submit_qa(page, question)
    expect(panel.get_by_text("回答", exact=True).last).to_be_visible()
    expect(panel.get_by_text("引用片段", exact=True).last).to_be_visible()
    panel.get_by_role("button", name="预览跳转", exact=True).last.click()
    expect(panel.get_by_text("确认跳转前预览", exact=True)).to_be_visible()
    return panel


def run_manual_exact_flow(page):
    page.route("**/*", route_popup)
    page.goto(POPUP_URL)
    assert_quick_stats_signal_render(page)
    expect(page.get_by_text("Popup 授权 Mock 视频").first).to_be_visible()
    assert_no_protected_actions(page)

    page.get_by_role("button", name="重新检测字幕").click()
    page.wait_for_function(
        "(window.__popupMockMessages || []).some(message => message.action === 'GET_CURRENT_VIDEO_TRANSCRIPT_EVIDENCE')"
    )
    assert_no_protected_actions(page)

    page.get_by_role("button", name="生成摘要与亮点").click()
    expect(page.get_by_text("手动生成已使用精确的当前正文来源。")).to_be_visible()
    expect(page.get_by_text("视频亮点")).to_be_visible()
    expect(page.get_by_text("等待时间和费用由你配置的 AI 服务决定。", exact=False)).to_be_visible()
    assert page.get_by_text("亮点 ").count() >= 4
    page.get_by_role("button", name="预览跳转").first.click()
    page.get_by_role("button", name="确认跳转").first.click()
    expect(page.get_by_text("已跳到亮点位置，可返回原位置。")).to_be_visible()
    page.get_by_role("button", name="返回原位置").first.click()
    expect(page.get_by_text("已返回原位置。").first).to_be_visible()

    page.get_by_role("button", name="刷新", exact=True).click()
    panel = prepare_qa_preview(page, "作者为什么认为这个方法更可靠？")
    expect(panel.get_by_text("回答：作者为什么认为这个方法更可靠？", exact=False)).to_be_visible()
    expect(panel.get_by_text("依据《Popup 授权 Mock 视频》 · P1 · B站字幕", exact=False)).to_be_visible()
    answer = panel.get_by_text("回答", exact=True).last
    citations = panel.get_by_text("引用片段", exact=True).last
    assert answer.evaluate("(answer, citations) => Boolean(answer.compareDocumentPosition(citations) & Node.DOCUMENT_POSITION_FOLLOWING)", citations.element_handle())
    panel.get_by_role("button", name="确认跳转", exact=True).click()
    expect(panel.get_by_role("button", name="返回原位置", exact=True)).to_be_visible()
    panel.get_by_role("button", name="返回原位置", exact=True).click()
    expect(panel.get_by_text("已返回原位置。", exact=True)).to_be_visible()

    expected = page.evaluate("window.__popupMockSourceV2")
    for action in {
        "GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS",
        "GET_VIDEO_KNOWLEDGE",
        "ASK_CURRENT_VIDEO_FULL_TEXT",
        "REQUEST_CURRENT_VIDEO_QA_CITATION_JUMP",
        "REQUEST_CURRENT_VIDEO_HIGHLIGHT_JUMP",
        "RETURN_CURRENT_VIDEO_SEGMENT_JUMP",
    }:
        message = last_message_for(page, action)
        assert message, f"manual popup flow did not send {action}"
        assert message["params"].get("primaryTextSelectionsReady") is True
        assert message["params"].get("selectedSourceIdentityKey") == expected

    assert_clean_page(page)


def run_stale_saved_source_flow(page):
    page.route("**/*", route_popup)
    page.goto(f"{POPUP_URL}?savedV1=1")
    expect(page.get_by_text("Popup 授权 Mock 视频").first).to_be_visible()
    assert_no_protected_actions(page)

    page.get_by_role("button", name="生成摘要与亮点").click()
    expect(page.get_by_text("此前保存的主要文本来源已不可用，请到视频页助手重新选择当前来源。").first).to_be_visible()
    page.get_by_role("button", name="刷新", exact=True).click()
    submit_qa(page, "失效来源")
    page.wait_for_timeout(50)
    expect(qa_panel(page).get_by_role("button", name="预览跳转")).to_have_count(0)
    assert_no_protected_actions(page)
    assert_clean_page(page)


def run_raw_unsuccessful_response_flow(page, query, action):
    page.route("**/*", route_popup)
    page.goto(f"{POPUP_URL}?{query}=1")
    expect(page.get_by_text("Popup 授权 Mock 视频").first).to_be_visible()
    panel = prepare_qa_preview(page, "受控失败")
    panel.get_by_role("button", name="确认跳转", exact=True).click()

    if action == "jump":
        expect(panel.get_by_text("引用结果或页面状态已变化，请重新提交问题后再试。")).to_be_visible()
    else:
        expect(panel.get_by_role("button", name="返回原位置", exact=True)).to_be_visible()
        panel.get_by_role("button", name="返回原位置", exact=True).click()
        expect(panel.get_by_text("未能返回原位置，请回到当前视频页确认页面和播放器状态后重试。")).to_be_visible()
    assert_clean_page(page)


def run_blocked_flow(page, query, expected_message):
    page.route("**/*", route_popup)
    page.goto(f"{POPUP_URL}?{query}")
    expect(page.get_by_text("Popup 授权 Mock 视频").first).to_be_visible()
    assert_no_protected_actions(page)

    page.get_by_role("button", name="生成摘要与亮点").click()
    expect(page.get_by_text(expected_message).first).to_be_visible()
    page.get_by_role("button", name="刷新", exact=True).click()
    submit_qa(page, "不应发送")
    assert_no_protected_actions(page)
    assert_clean_page(page)


def run_missing_title_flow(page):
    page.route("**/*", route_popup)
    page.goto(f"{POPUP_URL}?missingTitle=1")
    expect(page.get_by_text("当前视频", exact=True).first).to_be_visible()
    assert_no_protected_actions(page)
    assert_clean_page(page)


def run_summary_scope_races(page):
    page.route("**/*", route_popup)
    page.goto(POPUP_URL)
    expect(page.get_by_text("Popup 授权 Mock 视频").first).to_be_visible()

    page.evaluate("window.__popupMockDeferNextResponse('GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS')")
    page.get_by_role("button", name="生成摘要与亮点").click()
    page.wait_for_function("window.__popupMockPendingResponseCount('GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS') === 1")
    page.evaluate("window.__popupMockEmitSelectionChange('clear')")
    page.evaluate("window.__popupMockResolveResponses('GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS')")
    page.wait_for_timeout(50)
    expect(page.get_by_text("手动生成已使用精确的当前正文来源。")).to_have_count(0)

    page.evaluate("window.__popupMockDeferNextResponse('GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS')")
    page.get_by_role("button", name="生成摘要与亮点").click()
    page.wait_for_function("window.__popupMockPendingResponseCount('GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS') === 1")
    page.evaluate("window.__popupMockDeferNextResponse('GET_CURRENT_VIDEO_TRANSCRIPT_EVIDENCE')")
    page.get_by_role("button", name="重新检测字幕").click()
    page.wait_for_function("window.__popupMockPendingResponseCount('GET_CURRENT_VIDEO_TRANSCRIPT_EVIDENCE') === 1")
    page.evaluate("window.__popupMockSwitchContext()")
    page.evaluate("window.__popupMockResolveResponses('GET_CURRENT_VIDEO_TRANSCRIPT_EVIDENCE')")
    expect(page.get_by_text("切换后的 Popup 视频").first).to_be_visible()
    expect(page.get_by_text("检测期间当前视频已变化，请在新页面重新操作。")).to_be_visible()
    page.evaluate("window.__popupMockResolveResponses('GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS')")
    page.wait_for_timeout(50)
    expect(page.get_by_text("较新的手动生成结果 2")).to_have_count(0)
    assert_clean_page(page)


def run_summary_failure_states(page):
    page.route("**/*", route_popup)
    page.goto(f"{POPUP_URL}?summaryNoText=1")
    expect(page.get_by_text("Popup 授权 Mock 视频").first).to_be_visible()
    page.get_by_role("button", name="生成摘要与亮点").click()
    expect(page.get_by_text("当前没有可用的主要正文，无法生成摘要与亮点。")).to_be_visible()
    assert_clean_page(page)

    page.goto(f"{POPUP_URL}?summaryDisabled=1")
    expect(page.get_by_text("当前视频 AI 助手未开启，本次没有发送正文。")).to_be_visible()
    expect(page.get_by_role("button", name="前往设置")).to_be_visible()
    expect(page.get_by_role("button", name="暂不可生成")).to_be_disabled()
    assert len(messages_for(page, "GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS")) == 0
    assert_clean_page(page)

    page.goto(f"{POPUP_URL}?summaryUnconfigured=1")
    expect(page.get_by_text("AI 服务尚未配置完整，本次没有发送正文。")).to_be_visible()
    expect(page.get_by_role("button", name="前往设置")).to_be_visible()
    expect(page.get_by_role("button", name="暂不可生成")).to_be_disabled()
    assert len(messages_for(page, "GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS")) == 0
    assert_clean_page(page)

    page.goto(f"{POPUP_URL}?summaryInvalid=1")
    page.get_by_role("button", name="生成摘要与亮点").click()
    expect(page.get_by_text("模型返回内容无法完整引用当前正文，旧结果不会被替换。")).to_be_visible()
    expect(page.get_by_text("请重新生成；系统只采用能核对到当前视频正文的内容。")).to_be_visible()
    assert_clean_page(page)

    page.goto(f"{POPUP_URL}?summaryError=1")
    page.get_by_role("button", name="生成摘要与亮点").click()
    expect(page.get_by_text("摘要与亮点生成失败，旧结果不会被替换。")).to_be_visible()
    assert_clean_page(page)


def run_generating_cancel_flow(page):
    page.route("**/*", route_popup)
    page.goto(POPUP_URL)
    expect(page.get_by_text("Popup 授权 Mock 视频").first).to_be_visible()
    page.evaluate("window.__popupMockDeferNextResponse('GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS')")
    page.get_by_role("button", name="生成摘要与亮点").click()
    page.wait_for_function("window.__popupMockPendingResponseCount('GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS') === 1")
    generation_message = last_message_for(page, "GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS")
    page.evaluate("window.__popupMockEmitSelectionChange('clear')")
    expect(page.get_by_role("button", name="取消")).to_be_visible()
    page.get_by_role("button", name="取消").click()
    page.wait_for_function("(window.__popupMockMessages || []).some(message => message.action === 'CANCEL_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS')")
    cancel_message = last_message_for(page, "CANCEL_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS")
    assert cancel_message["params"]["requestId"] == generation_message["params"]["requestId"]
    assert cancel_message["params"]["selectedSourceIdentityKey"] == generation_message["params"]["selectedSourceIdentityKey"]
    page.evaluate("window.__popupMockResolveResponses('GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS')")
    page.wait_for_timeout(50)
    expect(page.get_by_text("手动生成已使用精确的当前正文来源。")).to_have_count(0)
    expect(page.get_by_text("未生成", exact=False)).to_be_visible()
    assert page.evaluate("window.__popupMockSummaryCache()") is None
    assert_clean_page(page)


def run_cache_restore_and_refresh(page):
    page.route("**/*", route_popup)
    page.goto(f"{POPUP_URL}?cachedSummary=1")
    expect(page.get_by_text("已读取本地缓存的摘要与亮点。")).to_be_visible()
    assert len(messages_for(page, "GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS")) == 0
    page.get_by_role("button", name="重新生成摘要与亮点").click()
    expect(page.get_by_text("手动生成已使用精确的当前正文来源。")).to_be_visible()
    assert len(messages_for(page, "GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS")) == 1
    assert_clean_page(page)


def run_authorization_off_cache_restore(page):
    page.route("**/*", route_popup)
    page.goto(f"{POPUP_URL}?cachedSummary=1&summaryDisabled=1")
    expect(page.get_by_text("此前生成", exact=True)).to_be_visible()
    expect(page.get_by_text("关闭授权后仍可查看，但不能重新生成。", exact=False)).to_be_visible()
    expect(page.get_by_role("button", name="暂不可生成")).to_be_disabled()
    assert len(messages_for(page, "GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS")) == 0
    assert_clean_page(page)


def run_live_config_disable_after_ready(page):
    page.route("**/*", route_popup)
    page.goto(f"{POPUP_URL}?cachedSummary=1")
    expect(page.get_by_text("已读取本地缓存的摘要与亮点。")).to_be_visible()
    page.evaluate("window.__popupMockEmitUserConfigChange('disable')")
    expect(page.get_by_text("此前生成", exact=True)).to_be_visible()
    expect(page.get_by_role("button", name="暂不可生成")).to_be_disabled()
    assert len(messages_for(page, "GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS")) == 0
    assert_clean_page(page)


def run_live_config_model_change_during_generation(page):
    page.route("**/*", route_popup)
    page.goto(POPUP_URL)
    expect(page.get_by_text("Popup 授权 Mock 视频").first).to_be_visible()
    page.evaluate("window.__popupMockDeferNextResponse('GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS')")
    page.get_by_role("button", name="生成摘要与亮点").click()
    page.wait_for_function("window.__popupMockPendingResponseCount('GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS') === 1")
    generation_message = last_message_for(page, "GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS")
    page.evaluate("window.__popupMockEmitUserConfigChange('model')")
    page.wait_for_function("(window.__popupMockMessages || []).some(message => message.action === 'CANCEL_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS')")
    cancel_message = last_message_for(page, "CANCEL_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS")
    assert cancel_message["params"]["requestId"] == generation_message["params"]["requestId"]
    assert cancel_message["params"]["selectedSourceIdentityKey"] == generation_message["params"]["selectedSourceIdentityKey"]
    page.evaluate("window.__popupMockResolveResponses('GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS')")
    page.wait_for_timeout(50)
    expect(page.get_by_text("手动生成已使用精确的当前正文来源。")).to_have_count(0)
    assert page.evaluate("window.__popupMockSummaryCache()") is None

    page.get_by_role("button", name="生成摘要与亮点").click()
    expect(page.get_by_text("较新的手动生成结果 2", exact=False)).to_be_visible()
    assert page.evaluate("window.__popupMockSummaryCache().model") == "mock-model-v2"
    assert len(messages_for(page, "GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS")) == 2
    assert_clean_page(page)


def run_live_config_model_change_after_ready(page):
    page.route("**/*", route_popup)
    page.goto(f"{POPUP_URL}?cachedSummary=1")
    old_text = "手动生成已使用精确的当前正文来源。"
    expect(page.get_by_text(old_text)).to_be_visible()
    page.evaluate("window.__popupMockEmitUserConfigChange('model')")
    expect(page.get_by_text("此前生成", exact=True)).to_be_visible()
    expect(page.get_by_text(old_text)).to_be_visible()
    page.get_by_role("button", name="重新生成摘要与亮点").click()
    page.wait_for_function("window.__popupMockSummaryCache()?.model === 'mock-model-v2'")
    expect(page.get_by_text(old_text)).to_be_visible()
    assert_clean_page(page)


def run_highlight_preview_replacement_race(page):
    page.route("**/*", route_popup)
    page.goto(f"{POPUP_URL}?cachedSummary=1")
    expect(page.get_by_text("已读取本地缓存的摘要与亮点。")).to_be_visible()
    page.get_by_role("button", name="预览跳转").first.click()
    expect(page.get_by_text("确认跳转前预览")).to_be_visible()
    page.evaluate("window.__popupMockReplaceSummaryGeneration()")
    page.get_by_role("button", name="确认跳转").click()
    expect(page.get_by_text("亮点结果或页面状态已变化，请重新预览后再试。")).to_be_visible()
    expect(page.get_by_role("button", name="返回原位置")).to_have_count(0)
    jump_message = last_message_for(page, "REQUEST_CURRENT_VIDEO_HIGHLIGHT_JUMP")
    current_cache = page.evaluate("window.__popupMockSummaryCache()")
    assert jump_message["params"]["requestId"] != current_cache["requestId"]
    assert_clean_page(page)


def run_prior_refresh_terminal_flow(page, terminal):
    query = {
        "invalid": "cachedSummary=1&summaryInvalid=1",
        "network": "cachedSummary=1&summaryReject=1",
    }[terminal]
    expected = (
        "模型返回内容无法完整引用当前正文，旧结果不会被替换。"
        if terminal == "invalid"
        else "摘要与亮点生成失败，请确认当前 B 站视频页仍然打开后重试。"
    )
    page.route("**/*", route_popup)
    page.goto(f"{POPUP_URL}?{query}")
    old_text = "手动生成已使用精确的当前正文来源。"
    expect(page.get_by_text(old_text)).to_be_visible()
    page.get_by_role("button", name="重新生成摘要与亮点").click()
    expect(page.get_by_text(expected)).to_be_visible()
    expect(page.get_by_text(old_text)).to_be_visible()
    expect(page.get_by_text("此前生成", exact=True)).to_be_visible()
    assert_clean_page(page)


def run_prior_cancel_flow(page):
    page.route("**/*", route_popup)
    page.goto(f"{POPUP_URL}?cachedSummary=1")
    old_text = "手动生成已使用精确的当前正文来源。"
    expect(page.get_by_text(old_text)).to_be_visible()
    page.evaluate("window.__popupMockDeferNextResponse('GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS')")
    page.get_by_role("button", name="重新生成摘要与亮点").click()
    expect(page.get_by_text("正在生成新的摘要与亮点，此前结果会保留到新结果通过校验。")).to_be_visible()
    expect(page.get_by_text(old_text)).to_be_visible()
    expect(page.get_by_text("此前生成", exact=True)).to_be_visible()
    page.get_by_role("button", name="取消").click()
    expect(page.get_by_text("本次生成已取消，此前结果保持不变。")).to_be_visible()
    expect(page.get_by_text(old_text)).to_be_visible()
    page.evaluate("window.__popupMockResolveResponses('GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS')")
    expect(page.get_by_text(old_text)).to_be_visible()
    assert_clean_page(page)


def run_prior_cancel_after_source_selection_change_flow(page):
    page.route("**/*", route_popup)
    page.goto(f"{POPUP_URL}?cachedSummary=1")
    old_text = "手动生成已使用精确的当前正文来源。"
    b_text = "较新的手动生成结果 7 已采用当前正文。"
    expect(page.get_by_text(old_text)).to_be_visible()

    page.evaluate("window.__popupMockDeferNextResponse('GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS')")
    page.get_by_role("button", name="重新生成摘要与亮点").click()
    page.wait_for_function("window.__popupMockPendingResponseCount('GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS') === 1")
    generation_message = last_message_for(page, "GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS")
    old_request_id = generation_message["params"]["requestId"]
    old_source = generation_message["params"]["selectedSourceIdentityKey"]
    assert old_source == page.evaluate("window.__popupMockSourceV2")

    context_reads_before = len(messages_for(page, "GET_CURRENT_VIDEO_CONTEXT"))
    page.evaluate("window.__popupMockEmitSelectionChange('other')")
    page.wait_for_function(
        """(before) => {
            const messages = window.__popupMockMessages || [];
            const contextReads = messages.filter(message => message.action === "GET_CURRENT_VIDEO_CONTEXT");
            return contextReads.length > before
              && contextReads.some(message => message.params && message.params.forceContextRefresh === true);
        }""",
        arg=context_reads_before,
    )
    expect(page.get_by_text(old_text)).to_have_count(0)
    expect(page.get_by_text(b_text)).to_be_visible()
    page.get_by_role("button", name="取消").click()
    page.wait_for_function("(window.__popupMockMessages || []).some(message => message.action === 'CANCEL_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS')")
    cancel_message = last_message_for(page, "CANCEL_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS")
    assert cancel_message["params"]["requestId"] == old_request_id
    assert cancel_message["params"]["selectedSourceIdentityKey"] == old_source
    assert len(messages_for(page, "GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS")) == 1

    page.evaluate("window.__popupMockResolveResponses('GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS')")
    page.wait_for_timeout(50)
    assert page.evaluate("window.__popupMockSummaryCacheSourceIdentityKey()") == page.evaluate("window.__popupMockSourceB")
    assert page.evaluate("window.__popupMockSummaryCache().requestId") != old_request_id
    expect(page.get_by_text(old_text)).to_have_count(0)
    expect(page.get_by_text(b_text)).to_be_visible()
    assert len(messages_for(page, "GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS")) == 1
    assert_clean_page(page)


def run_eight_highlight_layout(page):
    page.route("**/*", route_popup)
    page.goto(f"{POPUP_URL}?highlightCount=8")
    expect(page.get_by_text("Popup 授权 Mock 视频").first).to_be_visible()
    page.get_by_role("button", name="生成摘要与亮点").click()
    expect(page.get_by_text("已生成 3 条摘要、3 个要点和 8 个亮点。")).to_be_visible()
    assert page.get_by_text("亮点 ").count() >= 8
    assert_clean_page(page)


def run_knowledge_newer_wins(page):
    page.route("**/*", route_popup)
    page.goto(POPUP_URL)
    expect(page.get_by_text("Popup 授权 Mock 视频").first).to_be_visible()
    page.evaluate("window.__popupMockDeferNextResponse('GET_VIDEO_KNOWLEDGE')")
    page.get_by_role("button", name="刷新", exact=True).click()
    page.wait_for_function("window.__popupMockPendingResponseCount('GET_VIDEO_KNOWLEDGE') === 1")
    page.evaluate("window.__popupMockEmitSelectionChange('same')")
    page.get_by_role("button", name="刷新", exact=True).click()
    expect(page.get_by_text("知识节点响应 2")).to_be_visible()
    page.evaluate("window.__popupMockResolveResponses('GET_VIDEO_KNOWLEDGE')")
    page.wait_for_timeout(50)
    expect(page.get_by_text("知识节点响应 2")).to_be_visible()
    expect(page.get_by_text("知识节点响应 1")).to_have_count(0)
    assert_clean_page(page)


def run_fail_closed_knowledge_copy(page):
    page.route("**/*", route_popup)
    page.goto(f"{POPUP_URL}?knowledgeNoEvidence=1")
    expect(page.get_by_text("Popup 授权 Mock 视频").first).to_be_visible()
    page.get_by_role("button", name="刷新", exact=True).click()
    expect(page.get_by_text("当前没有可引用字幕正文，知识节点暂不可用。")).to_be_visible()
    visible = page.locator("body").inner_text()
    assert "节点只使用元数据、简介" not in visible
    assert "已回退到元数据" not in visible
    assert_clean_page(page)


def run_full_text_qa_revision_race(page):
    page.route("**/*", route_popup)
    page.goto(POPUP_URL)
    expect(page.get_by_text("Popup 授权 Mock 视频").first).to_be_visible()
    page.evaluate("window.__popupMockDeferNextResponse('ASK_CURRENT_VIDEO_FULL_TEXT')")
    submit_qa(page, "旧问题")
    page.wait_for_function("window.__popupMockPendingResponseCount('ASK_CURRENT_VIDEO_FULL_TEXT') === 1")
    page.evaluate("window.__popupMockEmitSelectionChange('same')")
    expect(qa_panel(page).get_by_role("button", name="回答中...", exact=True)).to_be_visible()
    page.get_by_role("button", name="新建会话", exact=True).click()
    submit_qa(page, "新问题")
    expect(qa_panel(page).get_by_text("回答：新问题。", exact=False)).to_be_visible()
    page.evaluate("window.__popupMockResolveResponses('ASK_CURRENT_VIDEO_FULL_TEXT')")
    page.wait_for_timeout(50)
    expect(qa_panel(page).get_by_text("回答：新问题。", exact=False)).to_be_visible()
    expect(qa_panel(page).get_by_text("回答：旧问题。", exact=False)).to_have_count(0)
    assert len(messages_for(page, "CANCEL_CURRENT_VIDEO_FULL_TEXT_QA")) == 0

    page.get_by_role("button", name="新建会话", exact=True).click()
    expect(qa_panel(page).get_by_text("提交第一个问题后会创建本地会话。", exact=True)).to_be_visible()
    expect(qa_panel(page).get_by_text("回答：新问题。", exact=False)).to_have_count(0)
    assert_clean_page(page)


def run_full_text_qa_cross_session_failure_isolation(page):
    page.route("**/*", route_popup)
    page.goto(POPUP_URL)
    expect(page.get_by_text("Popup 授权 Mock 视频").first).to_be_visible()
    page.evaluate("window.__popupMockDeferNextResponse('ASK_CURRENT_VIDEO_FULL_TEXT')")
    submit_qa(page, "会话 A 延迟失败")
    page.wait_for_function("window.__popupMockPendingResponseCount('ASK_CURRENT_VIDEO_FULL_TEXT') === 1")

    page.get_by_role("button", name="新建会话", exact=True).click()
    submit_qa(page, "会话 B 正常回答")
    panel = qa_panel(page)
    expect(panel.get_by_text("回答：会话 B 正常回答。", exact=False)).to_be_visible()

    page.evaluate("window.__popupMockRejectResponses('ASK_CURRENT_VIDEO_FULL_TEXT')")
    page.wait_for_timeout(50)
    expect(panel.get_by_text("回答：会话 B 正常回答。", exact=False)).to_be_visible()
    expect(panel.get_by_text("回答失败，问题已保留", exact=False)).to_have_count(0)
    assert_clean_page(page)


def run_pre_render_selection_scope_race(page):
    page.route("**/*", route_popup)
    page.goto(POPUP_URL)
    expect(page.get_by_text("Popup 授权 Mock 视频").first).to_be_visible()
    page.evaluate("window.__popupMockDeferNextResponse('ASK_CURRENT_VIDEO_FULL_TEXT')")
    submit_qa(page, "渲染前旧问题")
    page.wait_for_function("window.__popupMockPendingResponseCount('ASK_CURRENT_VIDEO_FULL_TEXT') === 1")
    page.evaluate(
        """() => {
          window.__popupMockResolveResponses('ASK_CURRENT_VIDEO_FULL_TEXT');
          window.__popupMockEmitSelectionChange('same');
        }"""
    )
    page.wait_for_timeout(50)
    expect(qa_panel(page).get_by_text("回答：渲染前旧问题。", exact=False)).to_be_visible()
    assert_clean_page(page)


def run_timestamp_races_and_double_click(page):
    page.route("**/*", route_popup)
    page.goto(POPUP_URL)
    expect(page.get_by_text("Popup 授权 Mock 视频").first).to_be_visible()
    panel = prepare_qa_preview(page, "第一次跳转")
    page.evaluate("window.__popupMockDeferNextResponse('REQUEST_CURRENT_VIDEO_QA_CITATION_JUMP')")
    panel.get_by_role("button", name="确认跳转", exact=True).evaluate("button => { button.click(); button.click(); }")
    page.wait_for_function("window.__popupMockPendingResponseCount('REQUEST_CURRENT_VIDEO_QA_CITATION_JUMP') === 1")
    assert len(messages_for(page, "REQUEST_CURRENT_VIDEO_QA_CITATION_JUMP")) == 1

    page.evaluate("window.__popupMockEmitSelectionChange('same')")
    panel = prepare_qa_preview(page, "较新跳转")
    panel.get_by_role("button", name="确认跳转", exact=True).last.click()
    expect(panel.get_by_text("已跳到引用位置，可返回原位置。").last).to_be_visible()
    page.evaluate("window.__popupMockResolveResponses('REQUEST_CURRENT_VIDEO_QA_CITATION_JUMP')")
    page.wait_for_timeout(50)
    expect(panel.get_by_text("已跳到引用位置，可返回原位置。").last).to_be_visible()

    page.evaluate("window.__popupMockDeferNextResponse('RETURN_CURRENT_VIDEO_SEGMENT_JUMP')")
    panel.get_by_role("button", name="返回原位置", exact=True).last.evaluate("button => { button.click(); button.click(); }")
    page.wait_for_function("window.__popupMockPendingResponseCount('RETURN_CURRENT_VIDEO_SEGMENT_JUMP') === 1")
    assert len(messages_for(page, "RETURN_CURRENT_VIDEO_SEGMENT_JUMP")) == 1

    page.evaluate("window.__popupMockEmitSelectionChange('same')")
    panel = prepare_qa_preview(page, "返回前的新跳转")
    panel.get_by_role("button", name="确认跳转", exact=True).last.click()
    expect(panel.get_by_role("button", name="返回原位置", exact=True).last).to_be_visible()
    panel.get_by_role("button", name="返回原位置", exact=True).last.click()
    expect(panel.get_by_text("已返回原位置。", exact=True).last).to_be_visible()
    page.evaluate("window.__popupMockResolveResponses('RETURN_CURRENT_VIDEO_SEGMENT_JUMP')")
    page.wait_for_timeout(50)
    expect(panel.get_by_text("已返回原位置。", exact=True).last).to_be_visible()
    assert len(messages_for(page, "RETURN_CURRENT_VIDEO_SEGMENT_JUMP")) == 2
    assert_clean_page(page)


def run_success_raw_response_flow(page):
    page.route("**/*", route_popup)
    page.goto(f"{POPUP_URL}?rawJumpSuccess=1&rawReturnSuccess=1&qaRawVisibleCopy=1")
    expect(page.get_by_text("Popup 授权 Mock 视频").first).to_be_visible()
    panel = prepare_qa_preview(page, "成功响应文案")
    panel.get_by_role("button", name="确认跳转", exact=True).last.click()
    expect(panel.get_by_text("已跳到引用位置，可返回原位置。").last).to_be_visible()
    panel.get_by_role("button", name="返回原位置", exact=True).last.click()
    expect(panel.get_by_text("已返回原位置。", exact=True).last).to_be_visible()
    assert_clean_page(page)


def run_full_text_qa_terminal_states(page):
    page.route("**/*", route_popup)

    page.goto(f"{POPUP_URL}?qaUnsupported=1")
    panel = submit_qa(page, "视频没有讲到的问题")
    expect(panel.get_by_text("当前视频文本没有足够内容回答这个问题。", exact=True)).to_be_visible()
    expect(panel.get_by_text("引用片段", exact=True)).to_have_count(0)
    assert_clean_page(page)

    page.goto(f"{POPUP_URL}?qaContextTooLong=1")
    panel = submit_qa(page, "请概括完整论证")
    expect(panel.get_by_text("正文超出所选模型限制", exact=True)).to_be_visible()
    expect(panel.get_by_text("系统不会截断或分段发送", exact=False)).to_be_visible()
    expect(panel.locator("textarea")).to_have_value("请概括完整论证")
    expect(panel.get_by_role("button", name="重试本题", exact=True)).to_be_visible()
    first_ask = last_message_for(page, "ASK_CURRENT_VIDEO_FULL_TEXT")
    panel.locator("textarea").fill("这是编辑后的新问题")
    panel.get_by_role("button", name="重试本题", exact=True).click()
    expect(panel.get_by_text("正文超出所选模型限制", exact=True)).to_be_visible()
    retry_ask = last_message_for(page, "ASK_CURRENT_VIDEO_FULL_TEXT")
    assert retry_ask["params"]["requestId"] != first_ask["params"]["requestId"]
    assert retry_ask["params"]["turnId"] == first_ask["params"]["turnId"]
    assert retry_ask["params"]["question"] == "请概括完整论证"
    expect(panel.locator("textarea")).to_have_value("请概括完整论证")
    assert_clean_page(page)

    page.goto(f"{POPUP_URL}?qaReject=1")
    panel = submit_qa(page, "保留这个问题")
    expect(panel.get_by_text("回答失败，问题已保留", exact=False)).to_be_visible()
    expect(panel.locator("textarea")).to_have_value("保留这个问题")
    assert_clean_page(page)


def run_full_text_qa_cancel_and_context_change(page):
    page.route("**/*", route_popup)
    page.goto(POPUP_URL)
    expect(page.get_by_text("Popup 授权 Mock 视频").first).to_be_visible()

    page.evaluate("window.__popupMockDeferNextResponse('ASK_CURRENT_VIDEO_FULL_TEXT')")
    panel = submit_qa(page, "取消后仍要保留的问题")
    page.wait_for_function("window.__popupMockPendingResponseCount('ASK_CURRENT_VIDEO_FULL_TEXT') === 1")
    ask_message = last_message_for(page, "ASK_CURRENT_VIDEO_FULL_TEXT")
    panel.get_by_role("button", name="取消", exact=True).click()
    expect(panel.get_by_text("本次回答已取消，问题已保留。", exact=True)).to_be_visible()
    expect(panel.locator("textarea")).to_have_value("取消后仍要保留的问题")
    cancel_message = last_message_for(page, "CANCEL_CURRENT_VIDEO_FULL_TEXT_QA")
    assert cancel_message["params"]["requestId"] == ask_message["params"]["requestId"]
    assert cancel_message["params"]["turnId"] == ask_message["params"]["turnId"]
    page.evaluate("window.__popupMockResolveResponses('ASK_CURRENT_VIDEO_FULL_TEXT')")
    page.wait_for_timeout(50)
    expect(panel.get_by_text("回答：取消后仍要保留的问题。", exact=False)).to_have_count(0)

    page.evaluate("window.__popupMockDeferNextResponse('ASK_CURRENT_VIDEO_FULL_TEXT')")
    submit_qa(page, "切换视频前的问题")
    page.wait_for_function("window.__popupMockPendingResponseCount('ASK_CURRENT_VIDEO_FULL_TEXT') === 1")
    page.evaluate("window.__popupMockDeferNextResponse('GET_CURRENT_VIDEO_TRANSCRIPT_EVIDENCE')")
    page.get_by_role("button", name="重新检测字幕").click()
    page.wait_for_function("window.__popupMockPendingResponseCount('GET_CURRENT_VIDEO_TRANSCRIPT_EVIDENCE') === 1")
    page.evaluate("window.__popupMockSwitchContext()")
    page.evaluate("window.__popupMockResolveResponses('GET_CURRENT_VIDEO_TRANSCRIPT_EVIDENCE')")
    expect(page.get_by_text("切换后的 Popup 视频").first).to_be_visible()
    page.evaluate("window.__popupMockResolveResponses('ASK_CURRENT_VIDEO_FULL_TEXT')")
    page.wait_for_timeout(50)
    expect(page.get_by_text("回答：切换视频前的问题。", exact=False)).to_be_visible()
    expect(page.get_by_text("基于此前视频文本", exact=False)).to_be_visible()
    assert len(messages_for(page, "CANCEL_CURRENT_VIDEO_FULL_TEXT_QA")) >= 1
    assert_clean_page(page)


def run_layout_smoke(page):
    page.route("**/*", route_popup)
    page.goto(POPUP_URL)
    expect(page.get_by_text("Popup 授权 Mock 视频").first).to_be_visible()
    assert_no_protected_actions(page)
    assert_clean_page(page)


def new_checked_page(browser, viewport=None):
    page = browser.new_page(viewport=viewport or {"width": 390, "height": 760})
    # This suite exercises the expanded assistant; compact interactions have their own UI suite.
    page.add_init_script("""(() => {
      const opened = new WeakSet();
      new MutationObserver(() => {
        document.querySelectorAll('.popup-assistant-details').forEach(element => {
          if (!opened.has(element)) { opened.add(element); element.open = true; }
        });
      }).observe(document, {childList: true, subtree: true});
    })();""")
    errors = []
    page.on("console", lambda message: errors.append(f"console {message.type}: {message.text}") if message.type == "error" else None)
    page.on("pageerror", lambda error: errors.append(f"pageerror: {error}"))
    return page, errors


def main():
    build_popup_bundle()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            manual, manual_errors = new_checked_page(browser)
            run_manual_exact_flow(manual)
            assert not manual_errors, "\n".join(manual_errors)
            manual.close()

            stale, stale_errors = new_checked_page(browser)
            run_stale_saved_source_flow(stale)
            assert not stale_errors, "\n".join(stale_errors)
            stale.close()

            raw_jump, raw_jump_errors = new_checked_page(browser)
            run_raw_unsuccessful_response_flow(raw_jump, "rawJumpFailure", "jump")
            assert not raw_jump_errors, "\n".join(raw_jump_errors)
            raw_jump.close()

            raw_return, raw_return_errors = new_checked_page(browser)
            run_raw_unsuccessful_response_flow(raw_return, "rawReturnFailure", "return")
            assert not raw_return_errors, "\n".join(raw_return_errors)
            raw_return.close()

            rejected, rejected_errors = new_checked_page(browser)
            run_blocked_flow(rejected, "rejectStorage=1", "保存的主要文本来源选择读取失败")
            assert not rejected_errors, "\n".join(rejected_errors)
            rejected.close()

            missing, missing_errors = new_checked_page(browser)
            run_blocked_flow(missing, "missingIdentity=1", "当前视频分 P 身份信息不完整")
            assert not missing_errors, "\n".join(missing_errors)
            missing.close()

            missing_title, missing_title_errors = new_checked_page(browser)
            run_missing_title_flow(missing_title)
            assert not missing_title_errors, "\n".join(missing_title_errors)
            missing_title.close()

            summary_races, summary_races_errors = new_checked_page(browser)
            run_summary_scope_races(summary_races)
            assert not summary_races_errors, "\n".join(summary_races_errors)
            summary_races.close()

            summary_states, summary_states_errors = new_checked_page(browser)
            run_summary_failure_states(summary_states)
            assert not summary_states_errors, "\n".join(summary_states_errors)
            summary_states.close()

            summary_cancel, summary_cancel_errors = new_checked_page(browser)
            run_generating_cancel_flow(summary_cancel)
            assert not summary_cancel_errors, "\n".join(summary_cancel_errors)
            summary_cancel.close()

            cached_summary, cached_summary_errors = new_checked_page(browser)
            run_cache_restore_and_refresh(cached_summary)
            assert not cached_summary_errors, "\n".join(cached_summary_errors)
            cached_summary.close()

            authorization_off_cache, authorization_off_cache_errors = new_checked_page(browser)
            run_authorization_off_cache_restore(authorization_off_cache)
            assert not authorization_off_cache_errors, "\n".join(authorization_off_cache_errors)
            authorization_off_cache.close()

            live_disable, live_disable_errors = new_checked_page(browser)
            run_live_config_disable_after_ready(live_disable)
            assert not live_disable_errors, "\n".join(live_disable_errors)
            live_disable.close()

            live_model, live_model_errors = new_checked_page(browser)
            run_live_config_model_change_during_generation(live_model)
            assert not live_model_errors, "\n".join(live_model_errors)
            live_model.close()

            live_model_ready, live_model_ready_errors = new_checked_page(browser)
            run_live_config_model_change_after_ready(live_model_ready)
            assert not live_model_ready_errors, "\n".join(live_model_ready_errors)
            live_model_ready.close()

            highlight_replacement, highlight_replacement_errors = new_checked_page(browser)
            run_highlight_preview_replacement_race(highlight_replacement)
            assert not highlight_replacement_errors, "\n".join(highlight_replacement_errors)
            highlight_replacement.close()

            prior_invalid, prior_invalid_errors = new_checked_page(browser)
            run_prior_refresh_terminal_flow(prior_invalid, "invalid")
            assert not prior_invalid_errors, "\n".join(prior_invalid_errors)
            prior_invalid.close()

            prior_network, prior_network_errors = new_checked_page(browser)
            run_prior_refresh_terminal_flow(prior_network, "network")
            assert not prior_network_errors, "\n".join(prior_network_errors)
            prior_network.close()

            prior_cancel, prior_cancel_errors = new_checked_page(browser)
            run_prior_cancel_flow(prior_cancel)
            assert not prior_cancel_errors, "\n".join(prior_cancel_errors)
            prior_cancel.close()

            prior_cancel_source, prior_cancel_source_errors = new_checked_page(browser)
            run_prior_cancel_after_source_selection_change_flow(prior_cancel_source)
            assert not prior_cancel_source_errors, "\n".join(prior_cancel_source_errors)
            prior_cancel_source.close()

            eight_highlights, eight_highlights_errors = new_checked_page(browser)
            run_eight_highlight_layout(eight_highlights)
            assert not eight_highlights_errors, "\n".join(eight_highlights_errors)
            eight_highlights.close()

            knowledge_race, knowledge_race_errors = new_checked_page(browser)
            run_knowledge_newer_wins(knowledge_race)
            assert not knowledge_race_errors, "\n".join(knowledge_race_errors)
            knowledge_race.close()

            knowledge_blocked, knowledge_blocked_errors = new_checked_page(browser)
            run_fail_closed_knowledge_copy(knowledge_blocked)
            assert not knowledge_blocked_errors, "\n".join(knowledge_blocked_errors)
            knowledge_blocked.close()

            search_race, search_race_errors = new_checked_page(browser)
            run_full_text_qa_revision_race(search_race)
            assert not search_race_errors, "\n".join(search_race_errors)
            search_race.close()

            qa_failure_isolation, qa_failure_isolation_errors = new_checked_page(browser)
            run_full_text_qa_cross_session_failure_isolation(qa_failure_isolation)
            assert not qa_failure_isolation_errors, "\n".join(qa_failure_isolation_errors)
            qa_failure_isolation.close()

            pre_render_race, pre_render_race_errors = new_checked_page(browser)
            run_pre_render_selection_scope_race(pre_render_race)
            assert not pre_render_race_errors, "\n".join(pre_render_race_errors)
            pre_render_race.close()

            timestamp_races, timestamp_races_errors = new_checked_page(browser)
            run_timestamp_races_and_double_click(timestamp_races)
            assert not timestamp_races_errors, "\n".join(timestamp_races_errors)
            timestamp_races.close()

            raw_success, raw_success_errors = new_checked_page(browser)
            run_success_raw_response_flow(raw_success)
            assert not raw_success_errors, "\n".join(raw_success_errors)
            raw_success.close()

            qa_states, qa_states_errors = new_checked_page(browser)
            run_full_text_qa_terminal_states(qa_states)
            assert not qa_states_errors, "\n".join(qa_states_errors)
            qa_states.close()

            qa_cancel, qa_cancel_errors = new_checked_page(browser)
            run_full_text_qa_cancel_and_context_change(qa_cancel)
            assert not qa_cancel_errors, "\n".join(qa_cancel_errors)
            qa_cancel.close()

            desktop, desktop_errors = new_checked_page(browser, {"width": 1024, "height": 820})
            run_layout_smoke(desktop)
            assert not desktop_errors, "\n".join(desktop_errors)
            desktop.close()

            print("current-video popup real UI QA passed: combined summary/key-points/highlights, explicit full-text Q&A with answer-before-citations, unsupported/context-too-long/cancel and late-response rejection, session-scoped success/failure isolation and immutable snapshot completion across source/video changes, preview/confirm/return, responsive no-overflow/no-console/raw-copy checks")
        finally:
            browser.close()


if __name__ == "__main__":
    main()
