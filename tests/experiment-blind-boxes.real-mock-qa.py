from __future__ import annotations

import json
import mimetypes
import os
from pathlib import Path
import subprocess
from urllib.parse import unquote, urlparse

from playwright.sync_api import Page, Route, expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
DASHBOARD_INDEX = DIST / "dashboard" / "index.html"
QA_URL = "http://bili-bill-blind-box-real-mock.test/dashboard/index.html#experiments"
BOX_IDS = ["random_explore", "cross_region", "hidden_favorite", "creator_archive"]
BOX_TITLES = ["随机探索", "跨区漫游", "冷门收藏", "UP 主考古"]
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
    "ReferenceError",
    "BVID",
    "CID",
]


def main() -> None:
    ensure_dashboard_bundle()
    run_browser_qa()
    print("PASS experiment-blind-boxes.real-mock-qa: dist/dashboard.js ready/failure flows")


def ensure_dashboard_bundle() -> None:
    if os.environ.get("BILI_BILL_REAL_MOCK_QA_SKIP_BUILD") == "1":
        if not DASHBOARD_INDEX.exists():
            raise AssertionError("dist/dashboard/index.html is missing. Run npm run build first.")
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
        raise AssertionError("npm run build failed before blind-box QA:\n" + result.stdout[-8000:])
    if not DASHBOARD_INDEX.exists():
        raise AssertionError("npm run build completed but dist/dashboard/index.html was not created.")


def run_browser_qa() -> None:
    requested_paths: list[str] = []
    console_errors: list[str] = []
    page_errors: list[str] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1280, "height": 820})
        page.on(
            "console",
            lambda message: console_errors.append(message.text) if message.type == "error" else None,
        )
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.add_init_script(chrome_mock_script())
        page.route("**/*", lambda route: route_dist_asset(route, requested_paths))

        try:
            page.goto(QA_URL, wait_until="networkidle")
            assert_production_bundle_loaded(page, requested_paths)
            assert_ready_mode(page)

            page.evaluate("window.__BiliBillBlindBoxRealMockQa.setMode('failure')")
            page.reload(wait_until="networkidle")
            assert_failure_mode(page)

            if console_errors:
                raise AssertionError("Blind-box production console errors:\n" + "\n".join(console_errors))
            if page_errors:
                raise AssertionError("Blind-box production page errors:\n" + "\n".join(page_errors))
        finally:
            browser.close()


def assert_production_bundle_loaded(page: Page, requested_paths: list[str]) -> None:
    expect(page.locator('script[src="/dashboard.js"]')).to_have_count(1)
    if "/dashboard.js" not in requested_paths:
        raise AssertionError(f"Production dashboard bundle was not requested: {requested_paths}")
    source_module_requests = [
        path for path in requested_paths
        if path.endswith((".ts", ".tsx")) or "/dashboard/modules/" in path
    ]
    if source_module_requests:
        raise AssertionError(f"Production QA loaded source modules: {source_module_requests}")


def assert_ready_mode(page: Page) -> None:
    wait_for_boxes(page)
    assert_fixed_order(page)
    for box_id in BOX_IDS:
        card = box(page, box_id)
        expect(card.get_by_text("候选来源：", exact=False)).to_be_visible()
        expect(card.get_by_text("真实 B 站候选：", exact=False)).to_be_visible()
        card.locator('[data-action="reveal"]').click()

    expect(page.locator('[data-action="open-video"]')).to_have_count(4)
    for link in page.locator('[data-action="open-video"]').all():
        href = link.get_attribute("href") or ""
        if not href.startswith("https://www.bilibili.com/video/"):
            raise AssertionError(f"Unexpected blind-box video URL: {href}")

    expect(box(page, "random_explore")).to_contain_text("已使用真实 B 站候选")
    expect(box(page, "cross_region")).to_contain_text("已使用真实 B 站候选")
    expect(box(page, "creator_archive")).to_contain_text("已使用真实 B 站候选")
    expect(box(page, "hidden_favorite")).to_contain_text("本卡不使用；固定从本地收藏回访")
    expect(box(page, "hidden_favorite")).to_contain_text("它不是外部探索")
    assert_clean_visible_copy(page)
    assert_no_horizontal_overflow(page, "ready desktop")

    page.set_viewport_size({"width": 320, "height": 760})
    assert_no_horizontal_overflow(page, "ready mobile")


def assert_failure_mode(page: Page) -> None:
    page.set_viewport_size({"width": 1280, "height": 820})
    wait_for_boxes(page)
    assert_fixed_order(page)
    for box_id in BOX_IDS:
        card = box(page, box_id)
        expect(card.get_by_text("候选来源：", exact=False)).to_be_visible()
        expect(card.get_by_text("真实 B 站候选：", exact=False)).to_be_visible()
        card.locator('[data-action="explain"]').click()

    expect(page.locator('[data-action="open-video"]')).to_have_count(0)
    expect(page.get_by_text("当前没有可用于探索的近期视频", exact=True)).to_be_visible()
    expect(page.get_by_text("这次没有取得真实分区候选", exact=True)).to_be_visible()
    expect(page.get_by_text("本地收藏暂时打不开", exact=True)).to_be_visible()
    expect(page.get_by_text("暂时无法取得 UP 公开投稿", exact=True)).to_be_visible()
    expect(page.get_by_role("button", name="重新生成这一页")).to_have_count(4)

    before_retry = page.evaluate("window.__BiliBillBlindBoxRealMockQa.state().requestCount")
    page.get_by_role("button", name="重新生成这一页").first.click()
    page.wait_for_function(
        "before => window.__BiliBillBlindBoxRealMockQa.state().requestCount > before",
        arg=before_retry,
    )
    expect(page.locator('[data-action="explain"]')).to_have_count(4)
    expect(page.locator('[data-action="open-video"]')).to_have_count(0)
    assert_clean_visible_copy(page)
    assert_no_horizontal_overflow(page, "failure desktop")

    page.set_viewport_size({"width": 320, "height": 760})
    assert_no_horizontal_overflow(page, "failure mobile")


def wait_for_boxes(page: Page) -> None:
    expect(page.get_by_role("main").get_by_role("heading", name="视频盲盒", exact=True)).to_be_visible(timeout=20_000)
    expect(page.locator("[data-box-id]")).to_have_count(4, timeout=20_000)


def assert_fixed_order(page: Page) -> None:
    ids = page.locator("[data-box-id]").evaluate_all(
        "elements => elements.map(element => element.dataset.boxId)"
    )
    if ids != BOX_IDS:
        raise AssertionError(f"Unexpected blind-box order: {ids}")
    for box_id, title in zip(BOX_IDS, BOX_TITLES, strict=True):
        expect(box(page, box_id)).to_contain_text(title)


def box(page: Page, box_id: str):
    return page.locator(f'[data-box-id="{box_id}"]')


def assert_clean_visible_copy(page: Page) -> None:
    visible = page.locator("body").inner_text()
    for term in FORBIDDEN_VISIBLE_TERMS:
        if term.lower() in visible.lower():
            raise AssertionError(f"Visible blind-box copy leaked forbidden term: {term}")


def assert_no_horizontal_overflow(page: Page, label: str) -> None:
    dimensions = page.evaluate(
        """() => ({
            bodyClient: document.body.clientWidth,
            bodyScroll: document.body.scrollWidth,
            rootClient: document.documentElement.clientWidth,
            rootScroll: document.documentElement.scrollWidth,
        })"""
    )
    if dimensions["bodyScroll"] > dimensions["bodyClient"] + 1:
        raise AssertionError(f"{label}: body overflow {dimensions}")
    if dimensions["rootScroll"] > dimensions["rootClient"] + 1:
        raise AssertionError(f"{label}: root overflow {dimensions}")


def route_dist_asset(route: Route, requested_paths: list[str]) -> None:
    parsed = urlparse(route.request.url)
    if parsed.hostname != "bili-bill-blind-box-real-mock.test":
        route.abort()
        return
    path = unquote(parsed.path)
    if path in ("", "/"):
        path = "/dashboard/index.html"
    requested_paths.append(path)
    if path == "/favicon.ico":
        route.fulfill(status=204, body="")
        return

    target = safe_dist_path(path)
    if not target.exists() or not target.is_file():
        route.fulfill(status=404, body=f"Missing QA asset: {path}")
        return
    if target == DASHBOARD_INDEX:
        route.fulfill(
            status=200,
            body=target.read_text(encoding="utf-8"),
            content_type="text/html; charset=utf-8",
        )
        return
    route.fulfill(status=200, path=str(target), content_type=content_type_for(target))


def safe_dist_path(url_path: str) -> Path:
    relative = Path(*[part for part in url_path.lstrip("/").split("/") if part])
    target = (DIST / relative).resolve()
    dist_root = DIST.resolve()
    if os.path.commonpath([str(dist_root), str(target)]) != str(dist_root):
        raise AssertionError(f"Refusing to serve path outside dist: {url_path}")
    return target


def content_type_for(path: Path) -> str:
    guessed, _ = mimetypes.guess_type(path.name)
    if path.suffix == ".js":
        return "application/javascript; charset=utf-8"
    if path.suffix == ".css":
        return "text/css; charset=utf-8"
    return guessed or "application/octet-stream"


def chrome_mock_script() -> str:
    fixtures = json.dumps(
        {"ready": ready_fixture(), "failure": failure_fixture()},
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return f"""
(() => {{
  const MODE_KEY = 'bili-bill-blind-box-real-mock-mode';
  const fixtures = {fixtures};
  let requestCount = 0;
  const selected = () => localStorage.getItem(MODE_KEY) === 'failure' ? 'failure' : 'ready';
  window.chrome = {{
    runtime: {{
      async sendMessage(message) {{
        if (message?.action === 'GET_SYNC_STATUS') {{
          return {{ success: true, data: {{ lastSyncTime: 0, totalRecords: 0 }} }};
        }}
        if (message?.action === 'GET_EXPERIMENT_DATA') {{
          requestCount += 1;
          return {{ success: true, data: structuredClone(fixtures[selected()]) }};
        }}
        return {{ success: false, error: 'QA mock does not implement action: ' + message?.action }};
      }},
      getURL(path) {{ return path; }},
    }},
  }};
  window.__BiliBillBlindBoxRealMockQa = {{
    setMode(mode) {{ localStorage.setItem(MODE_KEY, mode); }},
    state() {{ return {{ mode: selected(), requestCount }}; }},
  }};
}})();
"""


def ready_fixture() -> dict:
    return {
        "generatedAt": 1782454571000,
        "blindBoxes": [
            ready_box(
                "random_explore",
                "随机探索",
                "B 站公开视频的相关视频候选池",
                "相关视频候选 / 种子视频《本地种子视频》",
                "真实相关候选视频",
                "公开候选 UP",
                "BV1REALRND01",
                ["候选来自 B 站公开相关视频池。", "不会从本地历史或收藏库存补位。"],
            ),
            ready_box(
                "cross_region",
                "跨区漫游",
                "B 站公开分区新视频候选池",
                "B 站分区新视频 / 知识",
                "真实分区新视频",
                "公开知识 UP",
                "BV1REAL139A",
                ["本轮选择公开知识分区。", "不会改用本地历史或收藏补位。"],
            ),
            {
                **ready_box(
                    "hidden_favorite",
                    "冷门收藏",
                    "本地收藏",
                    "本地收藏 / 收藏夹「默认收藏夹」",
                    "压箱底收藏视频",
                    "游戏收藏 UP",
                    "BVFAVHID01",
                    ["这条视频来自本地已同步收藏。", "它不是外部探索，也不会冒充真实 B 站候选。"],
                ),
                "usesRealBilibiliCandidates": False,
                "realCandidateLabel": "本卡不使用；固定从本地收藏回访。",
            },
            ready_box(
                "creator_archive",
                "UP 主考古",
                "已关注 UP 的公开较早投稿",
                "UP 公开较早投稿 / 考古 UP",
                "公开较早投稿",
                "考古 UP",
                "BV1ARCOLD1",
                ["只请求少量已关注 UP 的公开投稿。", "已排除最近 7 天新投稿。"],
            ),
        ],
    }


def failure_fixture() -> dict:
    return {
        "generatedAt": 1782454800000,
        "blindBoxes": [
            empty_box(
                "random_explore",
                "随机探索",
                "B 站公开视频的相关视频候选池",
                "未使用真实 B 站候选：缺少可请求的本地近期视频。",
                "相关视频候选",
                "没有可用种子",
                "当前没有可用于探索的近期视频",
                "当前没有合格种子，因此没有发出相关候选请求。",
            ),
            empty_box(
                "cross_region",
                "跨区漫游",
                "B 站公开分区新视频候选池",
                "未使用真实 B 站候选：本轮公开分区没有返回真实候选。",
                "B 站分区新视频",
                "没有真实候选",
                "这次没有取得真实分区候选",
                "本轮公开分区没有返回真实视频候选，不会切换来源。",
            ),
            {
                **empty_box(
                    "hidden_favorite",
                    "冷门收藏",
                    "本地收藏",
                    "本卡不使用；固定从本地收藏回访。",
                    "本地收藏",
                    "候选打不开",
                    "本地收藏暂时打不开",
                    "这批本地收藏缺少可打开的视频身份。",
                ),
                "usesRealBilibiliCandidates": False,
            },
            empty_box(
                "creator_archive",
                "UP 主考古",
                "已关注 UP 的公开较早投稿",
                "未使用真实 B 站候选：公开候选接口暂时不可用。",
                "UP 公开较早投稿",
                "接口暂时失败",
                "暂时无法取得 UP 公开投稿",
                "公开投稿候选暂时失败，不会改用其他来源。",
            ),
        ],
    }


def ready_box(
    box_id: str,
    title: str,
    candidate_source: str,
    source: str,
    video_title: str,
    author_name: str,
    bvid: str,
    evidence: list[str],
) -> dict:
    return {
        "id": box_id,
        "title": title,
        "teaser": "揭晓后显示具体候选和来源边界。",
        "state": "ready",
        "statusLabel": "真实候选",
        "candidateSource": candidate_source,
        "usesRealBilibiliCandidates": True,
        "realCandidateLabel": "已使用真实 B 站候选",
        "source": source,
        "reason": "候选符合本盲盒固定来源，不会使用其他来源补位。",
        "evidence": evidence,
        "video": {
            "bvid": bvid,
            "title": video_title,
            "authorName": author_name,
            "sourceKind": "qa_fixture",
            "url": f"https://www.bilibili.com/video/{bvid}",
        },
    }


def empty_box(
    box_id: str,
    title: str,
    candidate_source: str,
    real_candidate_label: str,
    source: str,
    status_label: str,
    empty_title: str,
    empty_description: str,
) -> dict:
    return {
        "id": box_id,
        "title": title,
        "teaser": "当前只保留本盲盒固定来源。",
        "state": "empty",
        "statusLabel": status_label,
        "candidateSource": candidate_source,
        "usesRealBilibiliCandidates": True,
        "realCandidateLabel": real_candidate_label,
        "source": source,
        "reason": empty_description,
        "evidence": ["不会使用其他来源补位。", "刷新后可以重新请求这一页。"],
        "emptyTitle": empty_title,
        "emptyDescription": empty_description,
    }


if __name__ == "__main__":
    main()
