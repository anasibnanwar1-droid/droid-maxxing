---
name: browser-navigation
version: 1.0.0
description: |
  Control the live Droid Control browser pane through the session-scoped DroidMaxx browser MCP tools.
  Use when the user asks to open, navigate, inspect, click, type, scroll, screenshot, annotate, or control a web page.
---

# Browser Navigation In Droid Control

Use the DroidMaxx browser MCP tools. They open the browser pane the user can see and control.

Do not use `Read`, `FetchUrl`, `curl`, or `agent-browser` for browser interaction. Reading a URL is not opening the browser.

## Workflow

1. Call `droidmaxx-browser___browser_open` with the target `url`.
2. Call `droidmaxx-browser___browser_snapshot` to get DOM refs.
3. Interact with `droidmaxx-browser___browser_click`, `droidmaxx-browser___browser_type`, `droidmaxx-browser___browser_keypress`, or `droidmaxx-browser___browser_scroll`.
4. Call `droidmaxx-browser___browser_snapshot` again after navigation, scroll, or layout changes.
5. Use `droidmaxx-browser___browser_screenshot` only when visual inspection is needed.

## Design Mode

When the user selects an element, sketches a region, annotates, or asks for design feedback on a visible page, use `droidmaxx-browser___design-mode`.

Design Mode context is scoped to the active chat. Do not reuse selections from another chat.
