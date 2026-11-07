const test = require("node:test");
const assert = require("node:assert/strict");
const {
  SOURCE_TTL_MS, RECOMMENDATION_TTL_MS, FAILURE_RETRY_MS,
  normalizeManifestUrl, normalizePersonalizationConfig, buildPersonalizedCatalogs,
  mergeRatings, selectTasteContext, excludeRated, buildPersonalizedPrompt,
  createPersonalizationService,
  parsePersonalizedResponse, generationError,
} = require("../utils/personalization");

const url = (status = "liked", key = "test-key") =>
  `https://likes.stremio.com/addons/${status}/movies-shows/user%3D${key}/manifest.json`;
const config = (key = "test-key") => ({ EnablePersonalizedCatalogs: true, StremioLikedManifestUrl: url("liked", key) });
const rating = (id, type = "movie", status = "liked", name = id) => ({ id, type, rating: status, name, year: 2020 });
const recommendation = (id = "tt-new", type = "movie") => ({ id, type, name: id, year: 2023 });
const json = (value) => new Response(JSON.stringify(value), { status: 200 });

// Real Response streams exercise timeout/size/JSON handling, not just a stubbed json().
function fixture({ clock = { value: 0 }, pages, failure } = {}) {
  const calls = [];
  const state = { items: [rating("tt-seed")], pages, failure };
  const service = createPersonalizationService({
    now: () => clock.value,
    fetchImpl: async (input, options) => {
      const request = new URL(input);
      calls.push({ url: input, options });
      if (state.failure) throw new Error(`secret source URL: ${input}`);
      const status = request.pathname.split("/")[2];
      if (request.pathname.endsWith("manifest.json")) return json({
        id: `stremio.org.${status}`,
        catalogs: ["movie", "series"].map((type) => ({ id: `stremio-${status}-${type}`, type, extra: [{ name: "skip" }] })),
      });
      const type = request.pathname.split("/catalog/")[1].split("/")[0];
      const skip = Number(request.pathname.match(/skip=(\d+)/)?.[1] || 0);
      return json({ metas: state.pages ? state.pages({ status, type, skip }) :
        skip ? [] : state.items.filter((item) => item.type === type) });
    },
  });
  let generations = 0;
  const request = (overrides = {}) => service.get({
    config: config(), type: "movie", settings: { model: "test", language: "en-US" },
    generate: async () => { generations++; return [recommendation()]; }, ...overrides,
  });
  return { service, state, calls, clock, request, generations: () => generations };
}

test("old configs stay disabled; personal catalogs are independent of EnableHomepage", () => {
  assert.deepEqual(buildPersonalizedCatalogs({}), []);
  assert.deepEqual(normalizePersonalizationConfig({ EnableHomepage: true }), { EnableHomepage: true });
  assert.deepEqual(buildPersonalizedCatalogs({ ...config(), EnableHomepage: false }).map((c) => c.id),
    ["aisearch.personal.movie", "aisearch.personal.series"]);
  assert.deepEqual(buildPersonalizedCatalogs({ EnablePersonalizedCatalogs: true }), []);
});

test("disabling skips link validation and removes private links from the config", () => {
  const disabled = { EnablePersonalizedCatalogs: false, EnableHomepage: true,
    StremioLikedManifestUrl: "https://evil.test/secret", StremioLovedManifestUrl: url("loved") };
  assert.deepEqual(normalizePersonalizationConfig(disabled), { EnablePersonalizedCatalogs: false, EnableHomepage: true });
  assert.deepEqual(buildPersonalizedCatalogs(disabled), []);
});

test("large profiles keep both content types and sample every rating over time", () => {
  const many = (count, type, status) => Array.from({ length: count }, (_, i) => rating(`${status}-${type}-${i}`, type, status));
  const selected = selectTasteContext([...many(100, "movie", "loved"), ...many(50, "series", "loved"), ...many(20, "movie", "liked")]);
  assert.equal(selected.length, 60);
  assert.equal(selected.filter((item) => item.rating === "loved" && item.type === "series").length, 20);
  assert.equal(selected.filter((item) => item.rating === "loved" && item.type === "movie").length, 20);
  assert.equal(selected.filter((item) => item.rating === "liked").length, 20);

  const movies = many(50, "movie", "loved");
  assert.notDeepEqual(selectTasteContext(movies, 0), selectTasteContext(movies, 1));
  assert.deepEqual(selectTasteContext(movies, 7), selectTasteContext(movies, 7));
  const seen = new Set();
  for (let day = 0; day < movies.length; day++) {
    for (const item of selectTasteContext(movies, day)) seen.add(item.id);
  }
  assert.equal(seen.size, movies.length);
});

test("a provider failure can show a fixed explanation", async () => {
  const f = fixture();
  const publicMessage = "Your AI provider account is out of credits.";
  const result = await f.request({ generate: async () => { throw Object.assign(new Error("raw provider text"), { publicMessage }); } });
  assert.equal(result.error, publicMessage);
});

test("URLs normalize stremio links and enforce host, status and addon-key routes", () => {
  assert.equal(normalizeManifestUrl(url().replace("https:", "stremio:"), "liked"), url());
  assert.equal(normalizeManifestUrl(url().replace("user%3D", "user="), "liked"), url());
  for (const invalid of [
    url().replace("https:", "http:"), url().replace("likes.stremio.com", "evil.test"),
    url().replace("likes.stremio.com", "likes.stremio.com.evil.test"),
    url().replace("likes.stremio.com", "secret@likes.stremio.com"),
    url().replace("liked", "loved"), `${url()}?key=secret`, `${url()}#secret`,
    url().replace("user%3Dtest-key", "raw-session-key"),
    url().replace("user%3Dtest-key", "user%3Dfoo%2Fbar"),
    url().replace("user%3Dtest-key", "%E0%A4%A"),
  ]) assert.throws(() => normalizeManifestUrl(invalid, "liked"), /official Stremio/);
  assert.throws(() => normalizePersonalizationConfig({ EnablePersonalizedCatalogs: true }), /at least one/);
  const lovedOnly = { EnablePersonalizedCatalogs: true, StremioLovedManifestUrl: url("loved") };
  assert.equal(buildPersonalizedCatalogs(lovedOnly).length, 2);
});

test("Love wins per type/id; taste context uses 40 Loves, 20 Likes and redistributes capacity", () => {
  const merged = mergeRatings([rating("tt-a"), rating("tt-a", "movie", "loved"), rating("tt-a", "series")]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].rating, "loved");
  const many = (count, status) => Array.from({ length: count }, (_, i) => rating(`${status}${i}`, "movie", status));
  const selected = selectTasteContext([...many(80, "loved"), ...many(50, "liked")]);
  assert.equal(selected.length, 60);
  assert.equal(selected.filter((item) => item.rating === "loved").length, 40);
  assert.equal(selectTasteContext([...many(80, "loved"), ...many(3, "liked")]).length, 60);
  assert.equal(selectTasteContext(many(70, "liked")).length, 60);
});

test("prompt combines movies/series and sends only allowed taste fields, never private URLs", () => {
  const items = [rating("tt-movie"), { ...rating("tt-show", "series", "loved"), privateUrl: url() }];
  const prompt = buildPersonalizedPrompt(items, "movie", { numResults: 10, language: "es-ES", includeAdult: false, rotation: 5 });
  assert.match(prompt, /"type":"movie"/);
  assert.match(prompt, /"type":"series"/);
  assert.match(prompt, /twice the weight/);
  assert.match(prompt, /es-ES/);
  assert.match(prompt, /Adult content: excluded/);
  assert.doesNotMatch(prompt, /likes\.stremio|privateUrl|"id":/);
});

test("exclude rated by exact ID or normalized title/year without removing remakes or other types", () => {
  const ratings = [rating("tt-original", "movie", "liked", "Amélie!")];
  assert.deepEqual(excludeRated([
    { ...recommendation("tt-original"), name: "Other title" },
    { ...recommendation("tmdb:1"), name: "amelie", year: 2020 },
    { ...recommendation("tt-remake"), name: "Amelie", year: 2024 },
    { ...recommendation("tt-series", "series"), name: "Amelie", year: 2020 },
  ], ratings).map((m) => m.id), ["tt-remake", "tt-series"]);
});

test("personal responses accept numbered/bulleted titles, Markdown tables, fences and pipe formats", () => {
  for (const response of [
    "movie|Example Film|2020", "1. movie|Example Film|2020", "- movie|Example Film|2020",
    "| type | title | year |\n|---|---|---|\n| movie | Example Film | 2020 |",
    "```\nmovie|Example Film|2020\n```", "1. Example Film (2020)",
    "- **Example Film (2020)**", "movie|Example Film (2020)", "Example Film — 2020",
    "movie|Example Film|(2020)", "Example Film|2020", "1. Example Film | 2020",
  ]) {
    const items = parsePersonalizedResponse(response, "movie");
    assert.equal(items.length, 1, response);
    assert.equal(items[0].name, "Example Film");
    assert.equal(items[0].year, 2020);
  }
});

test("structured personal responses require a title/year and filter the requested type", () => {
  const response = '```json\n{"recommendations":[{"type":"movie","title":"Example Film","year":2020},{"type":"series","name":"Wrong type","year":2021},{"title":"Missing year"}]}\n```';
  assert.equal(parsePersonalizedResponse(response, "movie").length, 1);
  assert.deepEqual(parsePersonalizedResponse("I could not provide recommendations.", "movie"), []);
  assert.deepEqual(parsePersonalizedResponse("movie|Example Film|unknown", "movie"), []);
  assert.equal(parsePersonalizedResponse("Example Show|2021", "series")[0].type, "series");
});

test("known failure reasons survive backoff without exposing arbitrary provider errors", async () => {
  const f = fixture();
  const result = await f.request({ generate: async () => { throw generationError("AI_RESPONSE_FORMAT"); } });
  assert.match(result.error, /no recognizable titles/);
  const cached = await f.request();
  assert.equal(cached.error, result.error);
  assert.equal(f.generations(), 0);
});

test("reads both official sources, paginates using returned length and combines types", async () => {
  const f = fixture({ pages: ({ type, skip }) =>
    type === "movie" ? skip === 0 ? [rating("tt-first")] : skip === 1 ? [rating("tt-second")] : [] :
      skip ? [] : [rating("tt-show", "series")] });
  let received;
  await f.request({ config: { ...config(), StremioLovedManifestUrl: url("loved") }, generate: async (items) => {
    received = items; return [recommendation()];
  } });
  assert.equal(received.length, 3);
  assert.ok(received.every((item) => item.rating === "loved"));
  assert.ok(received.some((item) => item.type === "series"));
  assert.ok(f.calls.some((call) => call.url.includes("skip=2")));
  assert.ok(f.calls.every((call) => call.options.redirect === "error" && call.options.signal));
});

test("a single source works and disabled requests perform no network or generation", async () => {
  const f = fixture();
  await f.request({ config: {} });
  assert.equal(f.calls.length, 0);
  assert.equal(f.generations(), 0);
  await f.request();
  assert.equal(f.generations(), 1);
  assert.ok(f.calls.every((c) => c.url.includes("/liked/")));
});

test("ratings are checked daily and recommendations last 24 hours", async () => {
  assert.equal(SOURCE_TTL_MS, 24 * 60 * 60 * 1000);
  assert.equal(FAILURE_RETRY_MS, 15 * 60 * 1000);
  const f = fixture();
  await f.request();
  const firstCalls = f.calls.length;
  f.clock.value = SOURCE_TTL_MS - 1;
  await f.request();
  assert.equal(f.calls.length, firstCalls);
  assert.equal(f.generations(), 1);
  f.clock.value = SOURCE_TTL_MS;
  await f.request();
  assert.ok(f.calls.length > firstCalls);
  assert.equal(f.generations(), 2);
});

test("an empty list is checked again after 15 minutes, so a first rating counts soon", async () => {
  const f = fixture();
  f.state.items = [];
  const empty = await f.request();
  assert.deepEqual(empty, { metas: [] });
  const calls = f.calls.length;
  f.state.items = [rating("tt-seed")];
  f.clock.value = FAILURE_RETRY_MS - 1;
  await f.request();
  assert.equal(f.calls.length, calls);
  assert.equal(f.generations(), 0);
  f.clock.value = FAILURE_RETRY_MS;
  const result = await f.request();
  assert.equal(result.metas[0].id, "tt-new");
  assert.equal(f.generations(), 1);
});

test("Like-to-Love and removal change the profile; source order does not", async () => {
  const f = fixture();
  const both = { ...config(), StremioLovedManifestUrl: url("loved") };
  let loved = false;
  let removed = false;
  let reverse = false;
  f.state.pages = ({ status, type, skip }) => {
    if (skip || type !== "movie") return [];
    const items = status === "loved" ? (loved && !removed ? [rating("tt-b")] : []) :
      [rating("tt-seed"), ...(!loved && !removed ? [rating("tt-b")] : [])];
    return reverse ? items.reverse() : items;
  };
  // Read the sources first and generate later, so the recommendation is still
  // fresh at the next source check and only a profile change can replace it.
  await f.request({ config: both, type: "series", generate: async () => [recommendation("tt-show-new", "series")] });
  f.clock.value += SOURCE_TTL_MS / 2;
  await f.request({ config: both });
  f.clock.value += SOURCE_TTL_MS / 2;
  reverse = true;
  await f.request({ config: both });
  assert.equal(f.generations(), 1);
  f.clock.value += SOURCE_TTL_MS;
  loved = true;
  await f.request({ config: both });
  assert.equal(f.generations(), 2);
  f.clock.value += SOURCE_TTL_MS;
  loved = false;
  await f.request({ config: both });
  assert.equal(f.generations(), 3);
  f.clock.value += SOURCE_TTL_MS;
  removed = true;
  await f.request({ config: both });
  assert.equal(f.generations(), 4);
});

test("empty sources never call AI or keep obsolete personal recommendations", async () => {
  const f = fixture();
  await f.request();
  f.clock.value += SOURCE_TTL_MS;
  f.state.items = [];
  const result = await f.request();
  assert.deepEqual(result, { metas: [] });
  assert.equal(f.generations(), 1);
});

test("concurrent calls share reads and generation; movies/series share the taste snapshot", async () => {
  const f = fixture();
  await Promise.all(Array.from({ length: 8 }, () => f.request()));
  assert.equal(f.generations(), 1);
  const calls = f.calls.length;
  const series = await f.request({ type: "series", generate: async () => [recommendation("tt-show-new", "series"), recommendation()] });
  assert.equal(f.calls.length, calls);
  assert.ok(series.metas.every((m) => m.type === "series"));
});

test("private sources and generation settings isolate cached results", async () => {
  const f = fixture();
  await f.request();
  await f.request({ config: config("another-user") });
  for (const settings of [{ model: "other" }, { language: "es-ES" }, { includeAdult: true }, { apiKey: "other-account" }]) {
    await f.request({ settings });
  }
  assert.equal(f.generations(), 6);
});

test("network failures keep previous results, redact errors and back off 15 minutes", async () => {
  const f = fixture();
  await f.request();
  f.clock.value += SOURCE_TTL_MS;
  f.state.failure = true;
  const result = await f.request();
  assert.equal(result.stale, true);
  assert.equal(result.metas[0].id, "tt-new");
  assert.doesNotMatch(result.error, /test-key|https:/);
  const calls = f.calls.length;
  await f.request();
  assert.equal(f.calls.length, calls);
  f.clock.value += FAILURE_RETRY_MS - 1;
  await f.request();
  assert.equal(f.calls.length, calls);
  f.clock.value += 1;
  await f.request();
  assert.ok(f.calls.length > calls);
});

test("provider failures retain usable old results and exclude newly rated recommendations", async () => {
  const f = fixture();
  await f.request();
  f.clock.value += SOURCE_TTL_MS;
  f.state.items.push(rating("tt-new"));
  const generate = async () => { throw new Error(`provider echoed prompt and ${url()}`); };
  const result = await f.request({ generate });
  assert.deepEqual(result.metas, []);
  assert.doesNotMatch(result.error, /test-key|https:/);
  const retry = await f.request({ generate: async () => { assert.fail("must back off"); } });
  assert.deepEqual(retry.metas, []);
  const before = f.generations();
  f.clock.value += FAILURE_RETRY_MS;
  await f.request();
  assert.equal(f.generations(), before + 1);
});

test("no successful cache + failed source gives a clear error without an AI call", async () => {
  const f = fixture({ failure: true });
  const result = await f.request();
  assert.deepEqual(result.metas, []);
  assert.match(result.error, /Could not read/);
  assert.equal(f.generations(), 0);
});

test("a repeated pagination page fails instead of silently truncating the profile", async () => {
  const f = fixture({ pages: () => [rating("tt-repeated")] });
  const result = await f.request();
  assert.match(result.error, /pagination/);
  assert.equal(f.generations(), 0);
  assert.ok(f.calls.length < 10);
});

test("one failed source never overwrites the last complete combined taste snapshot", async () => {
  let failLoved = false;
  const f = fixture({ pages: ({ status, type, skip }) => {
    if (status === "loved" && failLoved) throw new Error("private failure");
    return skip || type !== "movie" ? [] : [rating(status === "loved" ? "tt-loved" : "tt-liked")];
  } });
  const both = { ...config(), StremioLovedManifestUrl: url("loved") };
  await f.request({ config: both, type: "series", generate: async () => [recommendation("tt-show-new", "series")] });
  f.clock.value += SOURCE_TTL_MS / 2;
  await f.request({ config: both });
  failLoved = true;
  f.clock.value += SOURCE_TTL_MS / 2;
  const result = await f.request({ config: both });
  assert.equal(result.stale, true);
  assert.equal(f.generations(), 1);
  failLoved = false;
  f.clock.value += FAILURE_RETRY_MS;
  await f.request({ config: both });
  assert.equal(f.generations(), 1);
});

test("untrusted manifest IDs, invalid JSON and oversized responses are rejected", async () => {
  for (const body of [JSON.stringify({ id: "other", catalogs: [] }), "{bad", "x".repeat(5 * 1024 * 1024 + 1)]) {
    const service = createPersonalizationService({ fetchImpl: async () => new Response(body) });
    const result = await service.get({ config: config(), type: "movie", settings: {}, generate: () => assert.fail("must not generate") });
    assert.deepEqual(result.metas, []);
    assert.ok(result.error);
  }
});
