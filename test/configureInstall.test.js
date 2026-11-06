const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Execute the actual configure-page script, with DOM and API boundaries mocked.
// This catches URL/protocol mistakes without validating real API keys or
// launching the user's native Stremio application.
const html = fs.readFileSync(path.join(__dirname, "../public/configure.html"), "utf8");
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];

function configurePage(href) {
  const fields = new Map();
  const defaults = {
    openaiCompatApiKey: "test-ai-key-12345", openaiCompatModel: "test-model",
    tmdbKey: "test-tmdb-key-12345", aiTemperature: "0.2", numResults: "20",
    tmdbLanguage: "en-US",
  };
  const field = (id) => {
    if (!fields.has(id)) fields.set(id, { value: defaults[id] || "", checked: false, style: {} });
    return fields.get(id);
  };
  let copied;
  const context = vm.createContext({
    window: { location: new URL(href) },
    document: { getElementById: field, addEventListener() {} },
    navigator: { clipboard: { writeText: async (text) => { copied = text; } } },
    setTimeout() {},
    fetch: async (url) => ({ ok: true, json: async () => url.endsWith("/validate") ?
      { ai: true, tmdb: true, fanart: true } : { encryptedConfig: "test-encrypted-config" } }),
  });
  // In a browser, window is the global object (window.getAddonUrl is also
  // accessible as getAddonUrl inside event handlers).
  context.location = context.window.location;
  context.window = context;
  vm.runInContext(script, context);
  return { context, field, copied: () => copied };
}

test("local HTTP installation keeps protocol and :7000, with no native deep link", async () => {
  const page = configurePage("http://127.0.0.1:7000/aisearch/configure");
  const urls = await page.context.window.getAddonUrl();
  const expected = "http://127.0.0.1:7000/aisearch/test-encrypted-config/manifest.json";
  assert.equal(urls.https, expected);
  assert.equal(urls.canDeepLink, false);
  await vm.runInContext("generateUrl()", page.context);
  assert.equal(page.context.window.location.href, "http://127.0.0.1:7000/aisearch/configure");
  assert.equal(page.copied(), expected);
  assert.ok(page.field("manual-url").textContent.includes(expected));
  assert.ok(page.field("manual-url").textContent.includes("Addons > Add addon"));
  assert.equal(page.field("manual-url").style.display, "block");
});

test("manual URLs preserve root installs, localhost, IPv6 and nonstandard HTTPS ports", async () => {
  for (const href of [
    "http://localhost:7000/configure", "http://[::1]:7000/aisearch/configure",
    "http://192.168.1.10:7000/aisearch/configure", "https://example.test:8443/aisearch/configure",
  ]) {
    const page = configurePage(href);
    const urls = await page.context.window.getAddonUrl();
    const base = new URL(href);
    const prefix = base.pathname.startsWith("/aisearch") ? "/aisearch" : "";
    assert.equal(urls.https, `${base.origin}${prefix}/test-encrypted-config/manifest.json`);
    assert.equal(urls.canDeepLink, false);
  }
});

test("standard HTTPS hosting retains one-click installation and the copy button", async () => {
  const page = configurePage("https://example.test/aisearch/configure");
  const urls = await page.context.window.getAddonUrl();
  assert.equal(urls.canDeepLink, true);
  assert.equal(urls.stremio, "stremio://example.test/aisearch/test-encrypted-config/manifest.json");
  await vm.runInContext("copyUrl()", page.context);
  assert.equal(page.copied(), "https://example.test/aisearch/test-encrypted-config/manifest.json");
  await vm.runInContext("generateUrl()", page.context);
  assert.equal(page.context.window.location.href, urls.stremio);
});
