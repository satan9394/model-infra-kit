#!/usr/bin/env python3
"""EVO-G143 multi-viewport / dual-theme browser verification helper.

OpenCode 下 LCU（computer use）默认关闭，仓库内也没有 Node 侧 playwright/puppeteer，
因此本脚本用本机已有的 Python playwright + 已安装的 Chrome（channel="chrome"）做
真实浏览器多视口与明暗双主题核验。

用法：
    python apps/dashboard/scripts/verify-viewports.py selfcheck
        不需要任何服务：只验证「溢出探测器」能双向判定（非恒真）+ Chrome 可无头启动。
    python apps/dashboard/scripts/verify-viewports.py verify <baseUrl> <outDir> [--routes /,/trends,/models,/quotas,/webhooks,/connect,/logs,/providers]

    verify 需要先把看板跑起来（E2E / preview 流程会构建 .next 并起 next start）。
    它按 1440x900 与 390x844 两个视口、light 与 dark 两套主题逐页截图，并断言
    页面级横向不溢出（documentElement.scrollWidth <= innerWidth + 1），同时收集
    console error。

证据约定：退出码 0 = 全部通过；非 0 = 至少一项失败（失败项逐条打印）。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

VIEWPORTS = [("desktop-1440", 1440, 900), ("mobile-390", 390, 844)]
THEMES = ["light", "dark"]
# All 14 dashboard routes: the 10 console pages plus the 4 embeddable ones.
# /pricing, /traces and every /embed/* were missing here until 2026-10-15, so
# they had never been captured by this tool at all.
DEFAULT_ROUTES = [
    "/", "/trends", "/logs", "/traces", "/providers", "/models", "/pricing",
    "/quotas", "/webhooks", "/connect",
    "/embed/overview", "/embed/trends", "/embed/logs", "/embed/pricing",
]
OVERFLOW_TOLERANCE = 1  # px；滚动条取整误差


def _launch(playwright):
    # 复用本机已安装的 Chrome，避免下载 playwright 自带浏览器。
    return playwright.chromium.launch(channel="chrome", headless=True)


def selfcheck() -> int:
    """证明探测器双向可用：能判「不溢出」，也能判「溢出」。"""
    from playwright.sync_api import sync_playwright

    failing = 0
    with sync_playwright() as p:
        browser = _launch(p)
        page = browser.new_page(viewport={"width": 390, "height": 844})

        page.set_content(
            "<html><body style='margin:0'>"
            "<div style='width:300px'>ok</div>"
            "</body></html>"
        )
        ok_width = page.evaluate("document.documentElement.scrollWidth")
        no_overflow = ok_width <= 390 + OVERFLOW_TOLERANCE

        # 反例：一个不可断行的长串，必须被判定为溢出。
        page.set_content(
            "<html><body style='margin:0'>"
            "<div style='white-space:nowrap;width:900px'>" + "x" * 900 + "</div>"
            "</body></html>"
        )
        bad_width = page.evaluate("document.documentElement.scrollWidth")
        overflow_detected = bad_width > 390 + OVERFLOW_TOLERANCE

        print(json.dumps({
            "check": "selfcheck",
            "clean_scrollWidth": ok_width,
            "clean_judged_no_overflow": no_overflow,
            "overflow_scrollWidth": bad_width,
            "overflow_detected": overflow_detected,
            "chrome_channel": "chrome",
        }, ensure_ascii=False, indent=2))

        if not no_overflow:
            print("FAIL: clean page wrongly judged as overflowing", file=sys.stderr)
            failing += 1
        if not overflow_detected:
            print("FAIL: overflowing page not detected (detector is tautological)", file=sys.stderr)
            failing += 1
        browser.close()
    return failing


def verify(base_url: str, out_dir: str, routes: list[str]) -> int:
    from playwright.sync_api import sync_playwright

    base = base_url.rstrip("/")
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    failures: list[str] = []
    results: list[dict] = []

    with sync_playwright() as p:
        browser = _launch(p)
        for vp_name, width, height in VIEWPORTS:
            for theme in THEMES:
                context = browser.new_context(
                    viewport={"width": width, "height": height},
                    color_scheme=theme,
                    locale="zh-CN",
                )
                for route in routes:
                    page = context.new_page()
                    console_errors: list[str] = []
                    bad_responses: list[str] = []

                    def _is_icon_noise(text: str) -> bool:
                        lowered = text.lower()
                        return "favicon" in lowered or "apple-touch-icon" in lowered

                    def _on_console(msg) -> None:
                        if msg.type != "error":
                            return
                        # A missing favicon surfaces as a generic resource error
                        # (the URL lives in msg.location, not msg.text).
                        if "failed to load resource" in msg.text.lower():
                            return
                        console_errors.append(msg.text)

                    def _on_response(response) -> None:
                        if response.status < 400:
                            return
                        url = response.url
                        if _is_icon_noise(url):
                            return
                        bad_responses.append(f"{response.status} {url}")

                    page.on("console", _on_console)
                    page.on("response", _on_response)
                    page.on("pageerror", lambda exc: console_errors.append(f"pageerror: {exc}"))
                    url = f"{base}{route}"
                    entry: dict = {"viewport": vp_name, "theme": theme, "route": route}
                    try:
                        # The dashboard holds a persistent SSE stream open, so
                        # `networkidle` never settles: wait for `load`, then give
                        # hydration and the first data fetch a fixed settle window.
                        response = page.goto(url, wait_until="load", timeout=30_000)
                        entry["status"] = response.status if response else None
                        page.wait_for_timeout(1500)
                        metrics = page.evaluate(
                            "({sw: document.documentElement.scrollWidth, iw: window.innerWidth,"
                            " bh: document.body ? document.body.scrollHeight : 0})"
                        )
                        entry.update(metrics)
                        entry["horizontal_overflow"] = metrics["sw"] > metrics["iw"] + OVERFLOW_TOLERANCE
                        entry["title"] = page.title()
                        entry["body_text_len"] = page.evaluate("document.body ? document.body.innerText.length : 0")
                        entry["anchors"] = page.evaluate(
                            "Array.from(new Set(Array.from(document.querySelectorAll('[data-testid]'))"
                            ".map((node) => node.getAttribute('data-testid')))).sort()"
                        )
                        if entry["horizontal_overflow"]:
                            failures.append(f"{vp_name}/{theme}{route}: scrollWidth {metrics['sw']} > viewport {metrics['iw']}")
                        if response is None or response.status >= 400:
                            failures.append(f"{vp_name}/{theme}{route}: HTTP {entry['status']}")
                        if console_errors:
                            entry["console_errors"] = console_errors
                            failures.append(f"{vp_name}/{theme}{route}: console errors {console_errors[:3]}")
                        if bad_responses:
                            entry["bad_responses"] = bad_responses
                            failures.append(f"{vp_name}/{theme}{route}: HTTP failures {bad_responses[:3]}")
                        shot = out / f"{vp_name}-{theme}{route.replace('/', '_') or '_root'}.png"
                        page.screenshot(path=str(shot), full_page=True)
                        entry["screenshot"] = str(shot)
                    except Exception as exc:  # noqa: BLE001 - 逐页收集，最后统一报告
                        entry["error"] = str(exc)
                        failures.append(f"{vp_name}/{theme}{route}: {exc}")
                    finally:
                        page.close()
                    results.append(entry)
                context.close()
        browser.close()

    report = {"baseUrl": base, "viewports": VIEWPORTS, "themes": THEMES, "results": results, "failures": failures}
    (out / "viewports.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"checks": len(results), "failures": failures}, ensure_ascii=False, indent=2))
    return 1 if failures else 0


def main(argv: list[str]) -> int:
    if len(argv) >= 2 and argv[1] == "selfcheck":
        return selfcheck()
    if len(argv) >= 4 and argv[1] == "verify":
        routes = DEFAULT_ROUTES
        if "--routes" in argv:
            routes = argv[argv.index("--routes") + 1].split(",")
        return verify(argv[2], argv[3], routes)
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
