import test from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(scriptMatch, "index.html must contain an inline <script>");
const SCRIPT = scriptMatch[1];

function makeEl() {
  const el = {
    value: "",
    textContent: "",
    innerHTML: "",
    checked: false,
    dataset: {},
    style: new Proxy({}, { get: () => "", set: () => true }),
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    children: [],
  };
  return new Proxy(el, {
    get(t, p) {
      if (p in t) return t[p];
      if (p === Symbol.toPrimitive) return () => "";
      if (p === "addEventListener" || p === "removeEventListener") return () => {};
      if (p === "appendChild" || p === "insertBefore" || p === "removeChild" || p === "focus" || p === "scrollIntoView" || p === "blur" || p === "click" || p === "setAttribute" || p === "removeAttribute" || p === "stopPropagation") return () => {};
      if (p === "querySelector") return () => makeEl();
      if (p === "querySelectorAll" || p === "getElementsByClassName") return () => [];
      if (p === "matches") return () => false;
      if (p === "closest") return () => makeEl();
      if (p === "getContext") return () => ({});
      return () => {};
    },
    set(t, p, v) {
      t[p] = v;
      return true;
    },
  });
}

function buildSandbox() {
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
  const document = {
    getElementById: () => makeEl(),
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
    getElementsByClassName: () => [],
    createElement: () => makeEl(),
    addEventListener: () => {},
    removeEventListener: () => {},
    title: "",
    body: makeEl(),
    documentElement: { style: {} },
    execCommand: () => true,
    hidden: false,
  };
  return {
    document,
    window: {
      innerWidth: 1280,
      matchMedia: () => ({ matches: false, addEventListener: () => {} }),
      addEventListener: () => {},
      removeEventListener: () => {},
      history: { replaceState: () => {}, pushState: () => {} },
      open: () => null,
      confirm: () => true,
      alert: () => {},
    },
    localStorage,
    sessionStorage: localStorage,
    navigator: { userAgent: "test", language: "en", platform: "linux", vibrate: () => {} },
    location: { href: "https://example.com/index.html", origin: "https://example.com", pathname: "/index.html" },
    console,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    DOMParser: class { parseFromString(str) { return { body: { innerHTML: str } }; } },
    fetch: () => new Promise(() => {}),
    URL: { createObjectURL: () => "", revokeObjectURL: () => {} },
    Blob: function () {},
    FileReader: class { readAsDataURL() {} },
    crypto: { getRandomValues: (arr) => arr, subtle: { digest: async () => new ArrayBuffer(0) } },
    confirm: () => true,
    alert: () => {},
    JSON,
    Math,
    Date,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Promise,
  };
}

function evalSandbox() {
  const sandbox = buildSandbox();
  const ctx = createContext(sandbox);
  runInContext(SCRIPT, ctx);
  return {
    ctx,
    run: (code) => runInContext(code, ctx),
  };
}

const sandbox = evalSandbox();

function i18nTable() {
  return sandbox.run("I18N");
}

test("inline script parses and executes", () => {
  assert.ok(sandbox.run("typeof I18N === 'object'"));
});

test("i18n has en/zh/th with identical key sets", () => {
  const I18N = i18nTable();
  assert.ok(I18N.en && I18N.zh && I18N.th, "en/zh/th tables exist");
  const keys = (l) => Object.keys(I18N[l]).sort();
  const en = keys("en");
  assert.ok(en.length > 80, `en table has many keys (got ${en.length})`);
  assert.deepEqual(keys("zh"), en, "zh keys match en");
  assert.deepEqual(keys("th"), en, "th keys match en");
});

test("i18n contains the FTP and product-filter keys in every language", () => {
  const I18N = i18nTable();
  const newKeys = [
    "ftp_title", "ftp_host", "ftp_port", "ftp_user", "ftp_pass", "ftp_base", "ftp_root",
    "ftp_load", "ftp_save", "ftp_test", "ftp_hint", "ftp_worker_hint", "ftp_ok", "ftp_error",
    "ftp_testing", "ftp_saved", "ftp_loaded", "ftp_configured", "ftp_not_configured",
    "prod_search", "prod_category", "prod_color", "prod_carat", "prod_price", "prod_sort",
    "filter_any", "filter_clear", "upload_media", "media_uploading", "media_uploaded", "media_error",
  ];
  for (const lang of ["en", "zh", "th"]) {
    for (const key of newKeys) {
      assert.ok(I18N[lang][key] !== undefined, `key "${key}" missing in ${lang}`);
    }
  }
});

test("every data-i18n* attribute maps to an existing key", () => {
  const I18N = i18nTable();
  const re = /\bdata-i18n(?:-ph|-title)?="([^"]+)"/g;
  const seen = new Set();
  let m;
  while ((m = re.exec(html))) {
    const key = m[1];
    if (!key || key.includes(" ")) continue;
    seen.add(key);
    assert.ok(I18N.en[key] !== undefined, `data-i18n key missing in en: "${key}"`);
  }
  assert.ok(seen.size > 30, `found many data-i18n keys (got ${seen.size})`);
});

test("every static t(\"...\") call maps to an existing key", () => {
  const I18N = i18nTable();
  const re = /\bt\(\s*["']([A-Za-z0-9_]+)["']\s*\)/g;
  const seen = new Set();
  let m;
  while ((m = re.exec(SCRIPT))) {
    seen.add(m[1]);
    assert.ok(I18N.en[m[1]] !== undefined, `t() key missing in en: "${m[1]}"`);
  }
  assert.ok(seen.size > 70, `found many t() keys (got ${seen.size})`);
});

test("required HTML element ids exist", () => {
  const ids = [
    "top-nav", "lang-select", "view-messages", "sidebar", "search", "filter-tabs", "live-status",
    "contact-list", "chat-panel", "chat-empty", "chat-open", "back-btn", "ch-avatar", "ch-name",
    "ch-status", "chat-search-bar", "chat-search-input", "messages", "emoji-panel", "quick-replies",
    "attach-btn", "emoji-btn", "msg-input", "mic-btn", "send-btn", "drawer-backdrop",
    "customer-drawer", "drawer-head", "drawer-body", "view-customers", "customers-list",
    "view-products", "products-list", "view-orders", "orders-list", "view-settings", "settings-panel",
    "view-ai", "ai-status", "ai-settings", "ai-base", "ai-model", "ai-key", "ai-messages",
    "ai-quick", "ai-input", "ai-send-btn", "view-connector", "server-url", "server-api-key",
    "test-server-btn", "server-test-msg", "n8n-url", "n8n-api-key", "verify-token", "progress-fill",
    "progress-label", "platforms", "env-out", "msg", "tab-msg-badge", "toast-msg", "lightbox",
    "lightbox-img", "lock-screen", "lock-hint", "lock-fab", "lock-skip-btn", "file-input",
    "settings-lang", "reply-input",
    "pf-search", "pf-category", "pf-color", "pf-carat", "pf-price", "pf-sort",
    "ftp-host", "ftp-port", "ftp-user", "ftp-pass", "ftp-base", "ftp-root",
    "ftp-load-btn", "ftp-save-btn", "ftp-test-btn", "ftp-status", "ftp-status-txt",
    "ftp-msg", "ftp-worker-hint",
  ];
  for (const id of ids) {
    assert.ok(new RegExp(`id=["']${id}["']`).test(html), `missing element id: ${id}`);
  }
});

test("key functions are defined", () => {
  const required = [
    "t", "setLang", "applyI18n", "switchView", "setFilter", "toggleShowArchived", "openChat",
    "backToList", "renderTabBadge", "renderContacts", "renderChat", "renderChatWithSearch",
    "toggleChatSearch", "sendMsg", "showTyping", "hideTyping", "toggleEmoji",
    "insertEmoji", "toggleReplies", "insertReply", "addReply", "handleFiles", "openLightbox",
    "micTap", "togglePin", "toggleStar", "markUnread", "toggleArchive", "toggleBlock",
    "openDrawer", "closeDrawer", "renderDrawer", "saveCustomer", "addTag", "removeTag",
    "setAssignee", "setFollowUp", "clearFollowUp", "toggleTranslate", "renderProducts",
    "sendProduct", "renderCustomers", "renderOrders", "aiInit", "aiSend", "aiCallLLM",
    "aiHandleCommand", "renderSettingsPanel", "render", "renderProgress", "renderEnv",
    "pollEvents", "testServer", "setupTouchId", "removeTouchId", "verifyTouchId", "lockApp",
    "tryUnlock", "skipLock", "tryInstallApp", "aiRefreshStatus", "allOrders", "trackOrder", "setTracking", "trackingRowHtml",
    "productMedia", "productFilterValues", "caratInRange", "priceInRange", "sortProducts",
    "populateProductFilters", "clearProductFilters", "productCardHtml", "uploadProductFiles",
    "uploadProductMedia", "ftpFillForm", "ftpFormBody", "ftpLoad", "ftpSave", "ftpTest",
    "setFtpMsg", "setFtpStatus",
  ];
  for (const fn of required) {
    assert.ok(sandbox.run(`typeof ${fn} === 'function'`), `function missing: ${fn}`);
  }
});
