---
name: browser-navigation
version: 1.0.0
description: |
  Control the live DROIDEX browser pane through the session-scoped DROIDEX browser MCP tools.
  Use when the user asks to open, navigate, inspect, click, type, scroll, screenshot, annotate, or control a web page.
---

# Browser Navigation In Droid Control

Use the DROIDEX browser MCP tools. They open the browser pane the user can see and control.

Do not use `Read`, `FetchUrl`, `curl`, or `agent-browser` for browser interaction. Reading a URL is not opening the browser.
If the user names a site or domain, do not ask what URL to open. Call `browser_open` with that site directly.

## Workflow

1. Call `droidex-browser___browser_open` with the target `url`. Bare domains like `skeina.tech` are accepted.
2. Call `droidex-browser___browser_snapshot` to get DOM refs.
3. Interact with `droidex-browser___browser_click`, `droidex-browser___browser_type`, `droidex-browser___browser_keypress`, or `droidex-browser___browser_scroll`.
4. Use `droidex-browser___browser_reload` when the user asks to reload the visible page.
5. Call `droidex-browser___browser_snapshot` again after navigation, scroll, or layout changes.
6. Use `droidex-browser___browser_screenshot` only when visual inspection is needed.

## Design Mode

When the user selects an element, sketches a region, annotates, or asks for design feedback on a visible page, use `droidex-browser___design-mode`.

Design Mode context is scoped to the active chat. Do not reuse selections from another chat.
