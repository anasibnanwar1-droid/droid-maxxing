use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Rect, State, Webview,
    WebviewBuilder, WebviewUrl,
};

const WEBVIEW_LABEL: &str = "droidmaxx-browser";
const DESIGN_EVENT_PREFIX: &str = "__DROIDMAXX_DESIGN__:";
const AGENT_EVENT_PREFIX: &str = "__DROIDMAXX_AGENT__:";

#[derive(Default)]
pub struct NativeBrowserState {
    inner: Mutex<NativeBrowserInner>,
}

#[derive(Default)]
struct NativeBrowserInner {
    is_open: bool,
    design_mode: bool,
    sketch_mode: bool,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeBrowserBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeBrowserSelection {
    id: String,
    kind: String,
    url: String,
    title: String,
    selector: Option<String>,
    tag_name: Option<String>,
    role: Option<String>,
    name: Option<String>,
    text: Option<String>,
    #[serde(rename = "box")]
    box_: NativeBrowserBox,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeBrowserBox {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeBrowserAgentAction {
    request_id: String,
    action: String,
    url: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
    text: Option<String>,
    key: Option<String>,
    direction: Option<String>,
    pixels: Option<f64>,
}

#[tauri::command]
pub fn native_browser_open(
    app: AppHandle,
    state: State<NativeBrowserState>,
    url: String,
    bounds: NativeBrowserBounds,
) -> Result<(), String> {
    validate_url(&url)?;
    let webview = ensure_webview(&app, &url, bounds)?;
    webview
        .set_bounds(bounds.into_rect())
        .map_err(|err| err.to_string())?;
    webview.show().map_err(|err| err.to_string())?;
    webview.set_focus().map_err(|err| err.to_string())?;
    webview
        .eval(format!("window.location.assign({});", json_string(&url)?))
        .map_err(|err| err.to_string())?;
    let (design_mode, sketch_mode) = state.with_inner(|inner| {
        inner.is_open = true;
        (inner.design_mode, inner.sketch_mode)
    })?;
    apply_design_state(&webview, design_mode, sketch_mode)?;
    Ok(())
}

#[tauri::command]
pub fn native_browser_set_bounds(
    app: AppHandle,
    bounds: NativeBrowserBounds,
) -> Result<(), String> {
    let Some(webview) = app.get_webview(WEBVIEW_LABEL) else {
        return Ok(());
    };
    webview
        .set_bounds(bounds.into_rect())
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn native_browser_close(
    app: AppHandle,
    state: State<NativeBrowserState>,
) -> Result<(), String> {
    state.with_inner(|inner| {
        inner.is_open = false;
        inner.design_mode = false;
        inner.sketch_mode = false;
    })?;
    if let Some(webview) = app.get_webview(WEBVIEW_LABEL) {
        webview.close().map_err(|err| err.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn native_browser_set_design_mode(
    app: AppHandle,
    state: State<NativeBrowserState>,
    active: bool,
) -> Result<(), String> {
    let sketch_mode = state.with_inner(|inner| {
        inner.design_mode = active;
        if !active {
            inner.sketch_mode = false;
        }
        inner.sketch_mode
    })?;
    if let Some(webview) = app.get_webview(WEBVIEW_LABEL) {
        apply_design_state(&webview, active, sketch_mode)?;
    }
    Ok(())
}

#[tauri::command]
pub fn native_browser_set_sketch_mode(
    app: AppHandle,
    state: State<NativeBrowserState>,
    active: bool,
) -> Result<(), String> {
    let design_mode = state.with_inner(|inner| {
        inner.sketch_mode = active;
        inner.design_mode
    })?;
    if let Some(webview) = app.get_webview(WEBVIEW_LABEL) {
        apply_design_state(&webview, design_mode, active)?;
    }
    Ok(())
}

#[tauri::command]
pub fn native_browser_reload(app: AppHandle) -> Result<(), String> {
    if let Some(webview) = app.get_webview(WEBVIEW_LABEL) {
        webview
            .eval("window.location.reload();")
            .map_err(|err| err.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn native_browser_agent_action(
    app: AppHandle,
    request: NativeBrowserAgentAction,
) -> Result<(), String> {
    let Some(webview) = app.get_webview(WEBVIEW_LABEL) else {
        return Err("DroidMaxx browser is not open.".to_string());
    };
    webview
        .eval(format!(
            "window.__DROIDMAXX_AGENT_ACTION?.({});",
            serde_json::to_string(&request).map_err(|err| err.to_string())?
        ))
        .map_err(|err| err.to_string())
}

impl NativeBrowserState {
    fn with_inner<T>(&self, f: impl FnOnce(&mut NativeBrowserInner) -> T) -> Result<T, String> {
        let mut inner = self.inner.lock().map_err(|_| "native browser state lock poisoned")?;
        Ok(f(&mut inner))
    }

    fn design_state(&self) -> Result<(bool, bool), String> {
        self.with_inner(|inner| (inner.design_mode, inner.sketch_mode))
    }
}

impl NativeBrowserBounds {
    fn into_rect(self) -> Rect {
        Rect {
            position: LogicalPosition::new(self.x, self.y).into(),
            size: LogicalSize::new(self.width.max(1.0), self.height.max(1.0)).into(),
        }
    }
}

fn ensure_webview(
    app: &AppHandle,
    url: &str,
    bounds: NativeBrowserBounds,
) -> Result<Webview<tauri::Wry>, String> {
    if let Some(webview) = app.get_webview(WEBVIEW_LABEL) {
        return Ok(webview);
    }
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window is not available".to_string())?;
    let app_for_title = app.clone();
    let app_for_load = app.clone();
    let parsed_url = url
        .parse()
        .map_err(|_| format!("Invalid browser URL: {url}"))?;
    let builder = WebviewBuilder::new(WEBVIEW_LABEL, WebviewUrl::External(parsed_url))
        .initialization_script(DESIGN_MODE_SCRIPT)
        .on_document_title_changed(move |_webview, title| {
            if let Some(selection) = parse_design_event(&title) {
                let _ = app_for_title.emit("native-browser-selection", selection);
            } else if let Some(result) = parse_agent_event(&title) {
                let _ = app_for_title.emit("native-browser-agent-result", result);
            }
        })
        .on_page_load(move |webview, payload| {
            let _ = app_for_load.emit(
                "native-browser-loaded",
                NativeBrowserLoaded {
                    url: payload.url().to_string(),
                },
            );
            let state = app_for_load.state::<NativeBrowserState>();
            if let Ok((design_mode, sketch_mode)) = state.design_state() {
                let _ = apply_design_state(&webview, design_mode, sketch_mode);
            }
        });
    window
        .add_child(builder, LogicalPosition::new(bounds.x, bounds.y), LogicalSize::new(bounds.width, bounds.height))
        .map_err(|err| err.to_string())
}

#[derive(Clone, Serialize)]
struct NativeBrowserLoaded {
    url: String,
}

fn validate_url(url: &str) -> Result<(), String> {
    let parsed = url
        .parse::<tauri::Url>()
        .map_err(|_| format!("Invalid browser URL: {url}"))?;
    match parsed.scheme() {
        "http" | "https" | "file" | "about" => Ok(()),
        scheme => Err(format!("Unsupported browser URL scheme: {scheme}")),
    }
}

fn apply_design_state(
    webview: &Webview<tauri::Wry>,
    design_mode: bool,
    sketch_mode: bool,
) -> Result<(), String> {
    webview
        .eval(format!(
            "window.__DROIDMAXX_SET_DESIGN_MODE?.({design_mode});window.__DROIDMAXX_SET_SKETCH_MODE?.({sketch_mode});"
        ))
        .map_err(|err| err.to_string())
}

fn parse_design_event(title: &str) -> Option<NativeBrowserSelection> {
    let payload = title.strip_prefix(DESIGN_EVENT_PREFIX)?;
    serde_json::from_str(payload).ok()
}

fn parse_agent_event(title: &str) -> Option<serde_json::Value> {
    let payload = title.strip_prefix(AGENT_EVENT_PREFIX)?;
    serde_json::from_str(payload).ok()
}

fn json_string(value: &str) -> Result<String, String> {
    serde_json::to_string(value).map_err(|err| err.to_string())
}

const DESIGN_MODE_SCRIPT: &str = r##"
(() => {
  if (window.__DROIDMAXX_DESIGN_INSTALLED) return;
  window.__DROIDMAXX_DESIGN_INSTALLED = true;

  let designMode = false;
  let sketchMode = false;
  let dragStart = null;
  const prefix = "__DROIDMAXX_DESIGN__:";
  const agentPrefix = "__DROIDMAXX_AGENT__:";
  const interactiveTags = new Set(["A", "BUTTON", "INPUT", "TEXTAREA", "SELECT", "SUMMARY"]);
  const interactiveRoles = new Set(["button", "checkbox", "combobox", "link", "menuitem", "option", "radio", "searchbox", "switch", "tab", "textbox"]);
  const textTags = new Set(["BLOCKQUOTE", "CODE", "EM", "FIGCAPTION", "H1", "H2", "H3", "H4", "H5", "H6", "LABEL", "LI", "P", "PRE", "SMALL", "SPAN", "STRONG", "TD", "TH"]);

  const overlay = document.createElement("div");
  overlay.id = "__droidmaxx_design_overlay";
  overlay.style.cssText = [
    "position:fixed",
    "z-index:2147483647",
    "left:0",
    "top:0",
    "width:0",
    "height:0",
    "pointer-events:none",
    "border:2px solid #2997ff",
    "box-shadow:0 0 0 1px rgba(0,0,0,.45),0 0 0 99999px rgba(0,0,0,.08)",
    "border-radius:4px",
    "display:none"
  ].join(";");

  const label = document.createElement("div");
  label.style.cssText = [
    "position:fixed",
    "z-index:2147483647",
    "pointer-events:none",
    "max-width:360px",
    "padding:6px 8px",
    "border-radius:7px",
    "background:#1f8fff",
    "color:white",
    "font:12px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
    "box-shadow:0 10px 28px rgba(0,0,0,.28)",
    "display:none"
  ].join(";");

  const region = document.createElement("div");
  region.id = "__droidmaxx_design_region";
  region.style.cssText = [
    "position:fixed",
    "z-index:2147483647",
    "pointer-events:none",
    "border:3px solid #7c4dff",
    "border-radius:999px",
    "background:rgba(124,77,255,.08)",
    "display:none"
  ].join(";");

  const mount = () => {
    if (!document.documentElement) return;
    if (!overlay.isConnected) document.documentElement.appendChild(overlay);
    if (!label.isConnected) document.documentElement.appendChild(label);
    if (!region.isConnected) document.documentElement.appendChild(region);
  };

  const cleanText = (value) => (value || "").replace(/\s+/g, " ").trim().slice(0, 180);
  const directText = (el) => cleanText(Array.from(el.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent || "").join(" "));
  const cssEscape = (value) => window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, "\\$&");
  const selectorFor = (el) => {
    if (el.id) return "#" + cssEscape(el.id);
    const testId = el.getAttribute("data-testid");
    if (testId) return `[data-testid="${cssEscape(testId)}"]`;
    const aria = el.getAttribute("aria-label");
    if (aria) return `${el.tagName.toLowerCase()}[aria-label="${cssEscape(aria)}"]`;
    const parts = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement && parts.length < 5) {
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  };
  const roleFor = (el) => el.getAttribute("role") || ({ A: "link", BUTTON: "button", INPUT: "textbox", TEXTAREA: "textbox", SELECT: "combobox" })[el.tagName] || "";
  const isCandidate = (el) => {
    if (!el || el === document.body || el === document.documentElement) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return false;
    const area = rect.width * rect.height;
    const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
    if (area > viewportArea * 0.72) return false;
    const role = roleFor(el).toLowerCase();
    if (interactiveTags.has(el.tagName) || interactiveRoles.has(role) || el.onclick || el.tabIndex >= 0) return true;
    if (textTags.has(el.tagName) && cleanText(el.innerText || el.textContent)) return true;
    if (el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("data-testid")) return true;
    return Boolean(directText(el)) && area < viewportArea * 0.35;
  };
  const pickTarget = (start) => {
    let best = null;
    let node = start;
    while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement) {
      if (isCandidate(node)) best = best || node;
      node = node.parentElement;
    }
    return best;
  };
  const payloadFor = (el) => {
    const rect = el.getBoundingClientRect();
    const text = cleanText(el.innerText || el.textContent);
    const name = cleanText(el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") || directText(el) || text);
    return {
      id: "@live-" + Date.now().toString(36),
      kind: "element",
      url: location.href,
      title: document.title,
      selector: selectorFor(el),
      tagName: el.tagName.toLowerCase(),
      role: roleFor(el) || undefined,
      name: name || undefined,
      text: text || undefined,
      box: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
    };
  };
  const labelFor = (el) => {
    const tag = el.tagName.toLowerCase();
    const label = cleanText(el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") || directText(el) || el.getAttribute("data-testid") || el.id || tag).slice(0, 48);
    return `${label || tag} · ${tag}`;
  };
  const send = (payload) => {
    const previous = document.title;
    document.title = prefix + JSON.stringify(payload);
    window.setTimeout(() => {
      if (document.title.startsWith(prefix)) document.title = previous;
    }, 0);
  };
  const showBox = (rect, text, color = "#2997ff") => {
    mount();
    overlay.style.display = "block";
    overlay.style.borderColor = color;
    overlay.style.left = `${Math.round(rect.x)}px`;
    overlay.style.top = `${Math.round(rect.y)}px`;
    overlay.style.width = `${Math.round(rect.width)}px`;
    overlay.style.height = `${Math.round(rect.height)}px`;
    label.style.display = "block";
    label.textContent = text;
    label.style.left = `${Math.min(window.innerWidth - 16, Math.max(8, Math.round(rect.x)))}px`;
    label.style.top = `${Math.min(window.innerHeight - 36, Math.max(8, Math.round(rect.y - 38)))}px`;
  };
  const hideBox = () => {
    overlay.style.display = "none";
    label.style.display = "none";
  };
  const drawRegion = (start, end) => {
    mount();
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    const width = Math.abs(start.x - end.x);
    const height = Math.abs(start.y - end.y);
    region.style.display = "block";
    region.style.left = `${Math.round(x)}px`;
    region.style.top = `${Math.round(y)}px`;
    region.style.width = `${Math.round(width)}px`;
    region.style.height = `${Math.round(height)}px`;
    return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
  };
  const attrsFor = (el) => {
    const out = {};
    ["id", "class", "data-testid", "aria-label", "title", "placeholder", "type", "href", "name", "value"].forEach((name) => {
      const value = el.getAttribute?.(name);
      if (value) out[name] = String(value).slice(0, 160);
    });
    return out;
  };
  const stylesFor = (el) => {
    const style = getComputedStyle(el);
    return {
      color: style.color,
      backgroundColor: style.backgroundColor,
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      display: style.display
    };
  };
  const refFor = (el, index) => {
    const rect = el.getBoundingClientRect();
    const text = cleanText(el.innerText || el.textContent);
    const name = cleanText(el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") || directText(el) || text);
    return {
      ref: "@b" + index,
      selector: selectorFor(el),
      tagName: el.tagName.toLowerCase(),
      role: roleFor(el) || undefined,
      name: name || undefined,
      text: text || undefined,
      attributes: attrsFor(el),
      className: el.className && typeof el.className === "string" ? el.className.slice(0, 160) : undefined,
      box: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      computedStyles: stylesFor(el)
    };
  };
  const collectRefs = () => {
    const refs = [];
    const root = document.body || document.documentElement;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node = root;
    while (node && refs.length < 80) {
      if (isCandidate(node)) refs.push(refFor(node, refs.length + 1));
      node = walker.nextNode();
    }
    return refs;
  };
  const pageSnapshot = () => ({
    url: location.href,
    title: document.title.startsWith(prefix) || document.title.startsWith(agentPrefix) ? "" : document.title,
    scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
    refs: collectRefs()
  });
  const sendAgent = (payload) => {
    const previous = document.title;
    document.title = agentPrefix + JSON.stringify(payload);
    window.setTimeout(() => {
      if (document.title.startsWith(agentPrefix)) document.title = previous;
    }, 0);
  };
  const settle = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const targetAt = (x, y) => {
    const target = document.elementFromPoint(Number(x), Number(y));
    if (!target) throw new Error(`No element at ${x},${y}`);
    return target;
  };
  const typeIntoFocused = (text) => {
    const el = document.activeElement;
    if (!el) throw new Error("No focused element for typing.");
    const value = String(text || "");
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      el.setRangeText(value, start, end, "end");
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    if (el.isContentEditable) {
      document.execCommand("insertText", false, value);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      return;
    }
    throw new Error("Focused element is not text-editable.");
  };
  const pressKey = (key) => {
    const el = document.activeElement || document.body;
    const value = String(key || "");
    el.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
    if (value === "Enter" && el instanceof HTMLInputElement && el.form) {
      el.form.requestSubmit?.();
    }
    el.dispatchEvent(new KeyboardEvent("keyup", { key: value, bubbles: true, cancelable: true }));
  };
  window.__DROIDMAXX_AGENT_ACTION = async (request) => {
    try {
      const action = request?.action;
      if (action === "click") {
        const target = targetAt(request.x, request.y);
        target.focus?.();
        target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: request.x, clientY: request.y, button: 0 }));
        target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: request.x, clientY: request.y, button: 0 }));
        target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: request.x, clientY: request.y, button: 0 }));
      } else if (action === "type") {
        typeIntoFocused(request.text);
      } else if (action === "keypress") {
        pressKey(request.key);
      } else if (action === "scroll") {
        const pixels = Number(request.pixels || 500);
        const direction = String(request.direction || "down");
        const dx = direction === "left" ? -pixels : direction === "right" ? pixels : 0;
        const dy = direction === "up" ? -pixels : direction === "down" ? pixels : 0;
        window.scrollBy({ left: dx, top: dy, behavior: "auto" });
      } else if (action !== "snapshot") {
        throw new Error(`Unsupported browser action: ${action}`);
      }
      await settle();
      sendAgent({ requestId: request.requestId, ok: true, snapshot: pageSnapshot() });
    } catch (error) {
      sendAgent({ requestId: request?.requestId, ok: false, error: error?.message || String(error), snapshot: pageSnapshot() });
    }
  };

  window.__DROIDMAXX_SET_DESIGN_MODE = (active) => {
    designMode = Boolean(active);
    if (!designMode) {
      sketchMode = false;
      dragStart = null;
      hideBox();
      region.style.display = "none";
    }
  };
  window.__DROIDMAXX_SET_SKETCH_MODE = (active) => {
    sketchMode = Boolean(active);
    hideBox();
    if (!sketchMode) region.style.display = "none";
  };

  document.addEventListener("mousemove", (event) => {
    if (!designMode || sketchMode || dragStart) return;
    const target = pickTarget(document.elementFromPoint(event.clientX, event.clientY));
    if (!target) {
      hideBox();
      return;
    }
    const rect = target.getBoundingClientRect();
    showBox(rect, labelFor(target));
  }, true);

  document.addEventListener("mouseleave", () => {
    if (!dragStart) hideBox();
  }, true);

  document.addEventListener("pointerdown", (event) => {
    if (!designMode || !sketchMode) return;
    event.preventDefault();
    event.stopPropagation();
    dragStart = { x: event.clientX, y: event.clientY };
    drawRegion(dragStart, dragStart);
  }, true);

  document.addEventListener("pointermove", (event) => {
    if (!dragStart) return;
    event.preventDefault();
    event.stopPropagation();
    drawRegion(dragStart, { x: event.clientX, y: event.clientY });
  }, true);

  document.addEventListener("pointerup", (event) => {
    if (!dragStart) return;
    event.preventDefault();
    event.stopPropagation();
    const box = drawRegion(dragStart, { x: event.clientX, y: event.clientY });
    dragStart = null;
    if (box.width >= 8 && box.height >= 8) {
      send({ id: "@region-" + Date.now().toString(36), kind: "region", url: location.href, title: document.title, box });
    }
  }, true);

  document.addEventListener("click", (event) => {
    if (!designMode || sketchMode) return;
    const target = pickTarget(document.elementFromPoint(event.clientX, event.clientY));
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    showBox(target.getBoundingClientRect(), labelFor(target), "#ff8a2a");
    send(payloadFor(target));
  }, true);
})();
"##;
