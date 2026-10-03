from __future__ import annotations

import mimetypes
import os
from pathlib import Path
import subprocess
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
SIDEBAR_BUNDLE = DIST / "content" / "sidebar-card.js"
QA_URL = "http://bilibili-home.mock/"
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
]


def main() -> None:
    ensure_sidebar_bundle()
    run_browser_qa()
    print("PASS sidebar-card.real-mock-qa: current feed placement, reinjection, and dashboard action")


def ensure_sidebar_bundle() -> None:
    if os.environ.get("BILI_BILL_REAL_MOCK_QA_SKIP_BUILD") == "1":
        if not SIDEBAR_BUNDLE.exists():
            raise AssertionError("dist/content/sidebar-card.js is missing. Run npm run build first.")
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
        timeout=180,
    )
    if result.returncode != 0:
        raise AssertionError("npm run build failed before sidebar QA:\n" + result.stdout[-8000:])


def run_browser_qa() -> None:
    console_errors: list[str] = []
    page_errors: list[str] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1280, "height": 900}, locale="zh-CN")
        page.on(
            "console",
            lambda message: console_errors.append(message.text) if message.type == "error" else None,
        )
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.add_init_script(chrome_mock_script())
        page.route("**/*", route_mock_home)

        page.goto(QA_URL, wait_until="networkidle")
        card = page.locator("#bdc-sidebar-card")
        expect(card).to_have_count(1, timeout=15_000)
        expect(card).to_be_visible()
        expect(card).to_have_class("bdc-card bdc-card--feed")
        assert_card_starts_after_carousel(page)
        assert_no_horizontal_overflow(page)
        assert_clean_visible_copy(page)

        page.get_by_text("查看完整面板 →", exact=True).click()
        opened_url = page.evaluate("globalThis.__sidebarQaOpenedUrl")
        if opened_url != "chrome-extension://sidebar-qa/dashboard/index.html#overview":
            raise AssertionError(f"Unexpected dashboard URL: {opened_url}")

        page.evaluate("document.querySelector('#bdc-sidebar-card').remove()")
        expect(page.locator("#bdc-sidebar-card")).to_have_count(1, timeout=5_000)
        send_count = page.evaluate("globalThis.__sidebarQaSendCount")
        if send_count != 1:
            raise AssertionError(f"Same-page reinjection reread quick stats: {send_count}")

        page.evaluate("document.body.appendChild(document.createElement('span'))")
        page.wait_for_timeout(800)
        expect(page.locator("#bdc-sidebar-card")).to_have_count(1)

        race_page = browser.new_page(viewport={"width": 1280, "height": 900})
        race_console_errors: list[str] = []
        race_page.on(
            "console",
            lambda message: race_console_errors.append(message.text)
            if message.type == "error"
            else None,
        )
        race_page.add_init_script(chrome_mock_script())
        race_page.route("**/*", route_mock_home)
        race_page.goto(f"{QA_URL}?mode=initialization-race", wait_until="networkidle")
        race_page.wait_for_function("typeof globalThis.__sidebarQaReleaseStats === 'function'", timeout=10_000)
        race_page.evaluate(
            """() => {
              const current = document.querySelector('.recommended-container_floor-aside > .container');
              current.replaceWith(current.cloneNode(true));
              globalThis.__sidebarQaReleaseStats();
            }"""
        )
        expect(race_page.locator("#bdc-sidebar-card")).to_have_count(1, timeout=5_000)
        if race_console_errors:
            raise AssertionError(f"Sidebar initialization-race console errors: {race_console_errors}")
        race_page.close()

        navigation_page = browser.new_page(viewport={"width": 1280, "height": 900})
        navigation_console_errors: list[str] = []
        navigation_page.on(
            "console",
            lambda message: navigation_console_errors.append(message.text)
            if message.type == "error"
            else None,
        )
        navigation_page.add_init_script(chrome_mock_script())
        navigation_page.route("**/*", route_mock_home)
        navigation_page.goto(f"{QA_URL}?mode=navigation-race", wait_until="networkidle")
        navigation_page.wait_for_function(
            "typeof globalThis.__sidebarQaReleaseStats === 'function'",
            timeout=10_000,
        )
        navigation_page.evaluate(
            """() => {
              history.pushState({}, '', '/away?mode=navigation-race');
              document.body.appendChild(document.createElement('span'));
            }"""
        )
        navigation_page.wait_for_timeout(100)
        navigation_page.evaluate(
            """() => {
              history.pushState({}, '', '/?mode=navigation-race');
              document.body.appendChild(document.createElement('span'));
            }"""
        )
        navigation_page.wait_for_timeout(100)
        navigation_page.evaluate("globalThis.__sidebarQaReleaseStats()")
        expect(navigation_page.locator("#bdc-sidebar-card")).to_have_count(1, timeout=7_000)
        expect(navigation_page.locator(".bdc-stat-value").first).to_have_text("2小时")
        navigation_send_count = navigation_page.evaluate("globalThis.__sidebarQaSendCount")
        if navigation_send_count != 2:
            raise AssertionError(
                f"Navigation did not discard and refresh the stale stats request: {navigation_send_count}"
            )
        if navigation_console_errors:
            raise AssertionError(
                f"Sidebar navigation-race console errors: {navigation_console_errors}"
            )
        navigation_page.close()

        if console_errors:
            raise AssertionError(f"Sidebar QA console errors: {console_errors}")
        if page_errors:
            raise AssertionError(f"Sidebar QA page errors: {page_errors}")

        browser.close()


def route_mock_home(route) -> None:
    parsed = urlparse(route.request.url)
    if parsed.path == "/":
        route.fulfill(status=200, content_type="text/html; charset=utf-8", body=mock_home_html())
        return

    local_path = DIST / parsed.path.lstrip("/")
    if local_path.exists() and local_path.is_file():
        content_type = mimetypes.guess_type(local_path.name)[0] or "application/octet-stream"
        route.fulfill(status=200, content_type=content_type, body=local_path.read_bytes())
        return

    route.fulfill(status=404, body="not found")


def assert_card_starts_after_carousel(page) -> None:
    positions = page.evaluate(
        """() => {
          const carousel = document.querySelector('.recommended-swipe').getBoundingClientRect();
          const card = document.querySelector('#bdc-sidebar-card').getBoundingClientRect();
          return { carouselBottom: carousel.bottom, cardTop: card.top };
        }"""
    )
    if positions["cardTop"] < positions["carouselBottom"] - 1:
        raise AssertionError(f"Sidebar card interrupted the featured carousel rows: {positions}")


def assert_no_horizontal_overflow(page) -> None:
    dimensions = page.evaluate(
        """() => ({
          clientWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
        })"""
    )
    if dimensions["scrollWidth"] > dimensions["clientWidth"] + 1:
        raise AssertionError(f"Sidebar card caused horizontal overflow: {dimensions}")


def assert_clean_visible_copy(page) -> None:
    visible = page.locator("body").inner_text()
    for term in FORBIDDEN_VISIBLE_TERMS:
        if term.lower() in visible.lower():
            raise AssertionError(f"Visible sidebar copy leaked forbidden term: {term}")


def chrome_mock_script() -> str:
    return """
      globalThis.__sidebarQaSendCount = 0;
      globalThis.__sidebarQaOpenedUrl = null;
      globalThis.chrome = {
        runtime: {
          sendMessage: async message => {
            if (message?.action !== 'GET_QUICK_STATS') {
              return { success: false };
            }
            globalThis.__sidebarQaSendCount += 1;
            const requestNumber = globalThis.__sidebarQaSendCount;
            if (
              location.search.includes('mode=initialization-race')
              || (location.search.includes('mode=navigation-race') && requestNumber === 1)
            ) {
              await new Promise(resolve => {
                globalThis.__sidebarQaReleaseStats = resolve;
              });
            }
            return {
              success: true,
              data: {
                todayWatchTime: location.search.includes('mode=navigation-race')
                  ? (requestNumber === 1 ? 60 : 7200)
                  : 3720,
                streakDays: 6,
                efficiencyScore: 82,
              },
            };
          },
          getURL: path => `chrome-extension://sidebar-qa/${path}`,
        },
      };
      window.open = url => {
        globalThis.__sidebarQaOpenedUrl = url;
        return null;
      };
    """


def mock_home_html() -> str:
    cards = "".join(f'<div class="feed-card">视频 {index}</div>' for index in range(1, 9))
    return f"""<!doctype html>
      <html lang="zh-CN">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            * {{ box-sizing: border-box; }}
            body {{ margin: 0; background: #f4f6f8; }}
            .recommended-container_floor-aside {{ padding: 32px; }}
            .container {{
              display: grid;
              grid-template-columns: repeat(4, minmax(0, 1fr));
              gap: 20px;
              max-width: 1120px;
              margin: 0 auto;
            }}
            .recommended-swipe {{
              grid-column: 1 / 3;
              grid-row: 1 / 3;
              min-height: 420px;
              background: #dbeafe;
            }}
            .feed-card {{ min-height: 200px; background: white; }}
          </style>
        </head>
        <body>
          <main class="bili-feed4-layout">
            <div class="feed2">
              <div class="recommended-container_floor-aside">
                <div class="container">
                  <div class="recommended-swipe">首页轮播</div>
                  {cards}
                </div>
              </div>
            </div>
          </main>
          <script src="/content/sidebar-card.js"></script>
        </body>
      </html>"""


if __name__ == "__main__":
    main()
