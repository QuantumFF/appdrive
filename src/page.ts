// Scripts run inside the app's webview through WebDriver. They are plain
// function bodies: WebDriver passes `arguments` and serializes returned DOM
// elements as references the daemon can click.
//
// Selectors:
//   css (default)   button.primary, [aria-label="Close"]
//   text=Library    innermost element whose text, aria-label, title or
//                   placeholder is exactly this (whitespace collapsed)
//   text~=libr      the same, case-insensitive substring
//   xpath=//nav/a   XPath
//   a >> b          b searched inside each match of a (itself included)
// Visible matches sort first.

const PRELUDE = String.raw`
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const visible = (e) => {
  const r = e.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  const cs = getComputedStyle(e);
  return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) !== 0;
};
const labels = (e) => [
  e.getAttribute("aria-label"), e.getAttribute("title"), e.getAttribute("placeholder"),
  e.tagName === "INPUT" && /^(button|submit|reset)$/.test(e.type) ? e.value : null,
].filter(Boolean);
// One selector step, searched inside scope (itself included) or the document.
const findPart = (sel, scope) => {
  let found = [];
  if (sel.startsWith("xpath=")) {
    const r = document.evaluate(sel.slice(6), scope || document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    for (let i = 0; i < r.snapshotLength; i++) {
      const n = r.snapshotItem(i);
      if (n.nodeType === 1) found.push(n);
    }
  } else if (sel.startsWith("text=") || sel.startsWith("text~=")) {
    const loose = sel.startsWith("text~=");
    const want = norm(sel.slice(loose ? 6 : 5));
    const wantL = want.toLowerCase();
    const match = (s) => { s = norm(s); return loose ? s.toLowerCase().includes(wantL) : s === want; };
    const all = scope ? [scope, ...scope.querySelectorAll("*")] : document.body ? document.body.querySelectorAll("*") : [];
    const hits = [];
    for (const e of all) {
      if (e.tagName === "SCRIPT" || e.tagName === "STYLE" || e.tagName === "NOSCRIPT") continue;
      // textContent glues "Back to Library" and a <kbd>Esc</kbd> together; innerText spaces them.
      if (match(e.textContent) || match(e.innerText) || labels(e).some(match)) hits.push(e);
    }
    const set = new Set(hits);
    found = hits.filter((e) => {
      for (const o of set) if (o !== e && e.contains(o)) return false;
      return true;
    });
  } else if (scope) {
    found = (scope.matches(sel) ? [scope] : []).concat([...scope.querySelectorAll(sel)]);
  } else {
    found = [...document.querySelectorAll(sel)];
  }
  return found;
};
// "a >> b": b searched inside each match of a.
const find = (sel) => {
  let scopes = [null];
  for (const part of sel.split(/\s+>>\s+/)) {
    const next = [];
    for (const sc of scopes) for (const e of findPart(part.trim(), sc)) if (!next.includes(e)) next.push(e);
    scopes = next;
  }
  const vis = scopes.filter(visible);
  return vis.concat(scopes.filter((e) => !vis.includes(e)));
};
const describe = (e) => {
  const r = e.getBoundingClientRect();
  const attrs = {};
  for (const a of e.attributes) {
    if (a.name === "style") continue;
    attrs[a.name] = a.value.length > 160 ? a.value.slice(0, 160) + "…" : a.value;
  }
  const out = {
    tag: e.tagName.toLowerCase(),
    text: norm(e.innerText ?? e.textContent).slice(0, 300),
    visible: visible(e),
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
  };
  if (Object.keys(attrs).length) out.attrs = attrs;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName)) out.value = e.value;
  if (e.type === "checkbox" || e.type === "radio") out.checked = e.checked;
  if ("disabled" in e && e.disabled) out.disabled = true;
  if (document.activeElement === e) out.focused = true;
  if (e.isContentEditable) out.editable = true;
  return out;
};
const brief = (e) => {
  const name = labels(e)[0] || norm(e.innerText ?? e.textContent).slice(0, 60);
  return e.tagName.toLowerCase() + (name ? ' "' + name + '"' : "");
};
`;

/** args: [selector] → element references, visible first. */
export const FIND = `${PRELUDE}\nreturn find(arguments[0]);`;

/** args: [selector, all] → { count, items } */
export const QUERY = `${PRELUDE}
const els = find(arguments[0]);
const items = (arguments[1] ? els.slice(0, 50) : els.slice(0, 1)).map((e, i) => ({ index: i, ...describe(e) }));
return { count: els.length, items };`;

/** args: [element] → short label like 'button "Save"' */
export const BRIEF = `${PRELUDE}\nreturn brief(arguments[0]);`;

/** args: [element] → describe() */
export const DESCRIBE = `${PRELUDE}\nreturn describe(arguments[0]);`;

/**
 * The page as an agent would want to read it: headings, dialogs and every
 * visible control, each with a selector that finds it uniquely.
 */
export const OUTLINE = `${PRELUDE}
const CONTROL = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=checkbox],[role=switch],[role=radio],[role=option],[role=combobox],[role=slider],[role=textbox],[role=searchbox],[contenteditable=""],[contenteditable=true],[tabindex]:not([tabindex="-1"])';
const CONTAINER = '[role=radiogroup],[role=tablist],[role=listbox],[role=menu],[role=menubar],[role=toolbar],[role=group],[role=tree],[role=grid]';
const CONTEXT = 'h1,h2,h3,[role=dialog],[role=alertdialog],dialog[open],[role=alert],[role=status]';
const seen = new Set();
const lines = [];
const esc = (s) => s.replace(/"/g, '\\\\"');
const unique = (sel) => { try { return find(sel).filter(visible).length === 1; } catch { return false; } };
const selectorFor = (e) => {
  if (e.id && unique("#" + CSS.escape(e.id))) return "#" + CSS.escape(e.id);
  for (const a of ["data-testid", "data-test", "name", "aria-label"]) {
    const v = e.getAttribute(a);
    if (v) { const s = e.tagName.toLowerCase() + "[" + a + '="' + esc(v) + '"]'; if (unique(s)) return s; }
  }
  const t = labels(e)[0] || norm(e.innerText ?? e.textContent);
  if (t && t.length <= 60) {
    const scopeCss = e.getAttribute("role") ? '[role="' + e.getAttribute("role") + '"]' : e.tagName.toLowerCase();
    const candidates = ["text=" + t, scopeCss + " >> text=" + t];
    for (const s of candidates) {
      const hits = find(s).filter(visible);
      if (hits.length === 1 && (hits[0] === e || e.contains(hits[0]))) return s;
    }
    // Repeated labels ("Browse" per folder): the scoped selector plus --nth.
    const s = candidates[1];
    const i = find(s).findIndex((h) => h === e || e.contains(h));
    if (i >= 0) return s + "  --nth " + i;
  }
  const path = [];
  let n = e;
  while (n && n.nodeType === 1 && n !== document.body) {
    if (n.id) { path.unshift("#" + CSS.escape(n.id)); break; }
    const same = [...(n.parentElement?.children ?? [])].filter((c) => c.tagName === n.tagName);
    path.unshift(n.tagName.toLowerCase() + (same.length > 1 ? ":nth-of-type(" + (same.indexOf(n) + 1) + ")" : ""));
    n = n.parentElement;
  }
  return path.join(" > ");
};
const state = (e) => {
  const s = [];
  if ("disabled" in e && e.disabled || e.getAttribute("aria-disabled") === "true") s.push("disabled");
  if (e.checked || e.getAttribute("aria-checked") === "true") s.push("checked");
  for (const a of ["aria-selected", "aria-pressed", "aria-expanded", "aria-current"]) {
    const v = e.getAttribute(a);
    if (v && v !== "false") s.push(a.slice(5) + (v === "true" ? "" : "=" + v));
  }
  if (document.activeElement === e) s.push("focused");
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName) && e.value) s.push('value="' + String(e.value).slice(0, 40) + '"');
  const r = e.getBoundingClientRect();
  if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) s.push("offscreen");
  return s.length ? " (" + s.join(", ") + ")" : "";
};
const role = (e) => e.getAttribute("role") || (e.tagName === "INPUT" ? "input[" + (e.type || "text") + "]" : e.tagName.toLowerCase());
const all = document.body ? [...document.body.querySelectorAll(CONTROL + "," + CONTEXT)] : [];
for (const e of all) {
  if (seen.has(e) || !visible(e)) continue;
  // A control inside a control (a span[tabindex] in a button) is noise, but the
  // items of a container (a radio in a radiogroup, a tab in a tablist) are the point.
  const outer = e.parentElement?.closest(CONTROL);
  if (outer && !outer.matches(CONTAINER) && e.matches(CONTROL) && !e.matches(CONTEXT)) continue;
  seen.add(e);
  let name = labels(e)[0] || norm(e.innerText ?? e.textContent);
  if (name.length > 70) name = name.slice(0, 69) + "…";
  const isContext = e.matches(CONTEXT);
  lines.push((isContext ? "## " : "- ") + role(e) + (name ? ' "' + name + '"' : "") + state(e) + (isContext ? "" : "  →  " + selectorFor(e)));
  if (lines.length >= 200) { lines.push("… (truncated at 200)"); break; }
}
const active = document.activeElement && document.activeElement !== document.body ? brief(document.activeElement) : "none";
return { title: document.title, url: location.href, viewport: innerWidth + "x" + innerHeight, focused: active, lines };`;

/** Resolves after two frames and a beat, so a screenshot shows the result of an action. */
export const SETTLE = `const done = arguments[arguments.length - 1];
requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 60)));`;

/**
 * args: [code, done]. An expression, or a function body when the code has a
 * top-level `return`. Async-aware; the result is JSON-cloned.
 */
export function evalScript(code: string): string {
  const body = /(^|[;{}\n]\s*)return\b/.test(code) ? code : `return (${code});`;
  return `const __done = arguments[arguments.length - 1];
Promise.resolve().then(async () => { ${body}\n}).then(
  (v) => { try { __done({ ok: true, value: v === undefined ? null : JSON.parse(JSON.stringify(v)) }); } catch (e) { __done({ ok: true, value: String(v) }); } },
  (e) => __done({ ok: false, error: String(e && e.stack || e) }),
);`;
}
