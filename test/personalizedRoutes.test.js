const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");

process.env.ENCRYPTION_KEY = "test-personalized-config-key-1234567890";
process.env.ENABLE_LOGGING = "false";
const express = require("express");
const { buildRouter } = require("../server");
const addon = require("../addon");
const logger = require("../utils/logger");

const likedUrl = "stremio://likes.stremio.com/addons/liked/movies-shows/user%3Dprivate-test-addon-key/manifest.json";
const realFetch = global.fetch;

test("HTTP integration: encrypted config, personal catalogs, privacy and existing features", async (t) => {
  const app = express();
  app.use(express.json());
  app.use(buildRouter());
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.close(); global.fetch = realFetch; });
  const aiPrompts = [];
  let failAi = false;
  const logEntries = [];
  const originalLogger = { ...logger };
  for (const name of ["info", "warn", "error", "debug", "query"]) logger[name] = (...args) => logEntries.push(args);
  t.after(() => Object.assign(logger, originalLogger));

  global.fetch = async (input, options) => {
    const url = new URL(input);
    if (url.origin === base) return realFetch(input, options);
    if (url.host === "likes.stremio.com") {
      assert.equal(options.redirect, "error");
      if (url.pathname.endsWith("manifest.json")) return Response.json({
        id: "stremio.org.liked", catalogs: ["movie", "series"].map((type) => ({ type, id: `stremio-liked-${type}`, extra: [{ name: "skip" }] })),
      });
      return Response.json({ metas: url.pathname.includes("skip=") ? [] :
        [{ id: url.pathname.includes("/movie/") ? "tt-rated-movie" : "tt-rated-series",
          type: url.pathname.includes("/movie/") ? "movie" : "series",
          name: url.pathname.includes("/movie/") ? "Rated Film" : "Rated Show", releaseInfo: "2020" }] });
    }
    if (url.host === "api.openai.com") {
      const prompt = JSON.parse(options.body).messages[0].content;
      aiPrompts.push(prompt);
      if (failAi) return new Response(`echo: ${prompt} private-test-addon-key test-ai-key-12345`, { status: 401 });
      return Response.json({ choices: [{ message: { content: prompt === "Test prompt" ? "OK" :
        prompt.includes("TV series for this user's taste") ? "series|Recommended Show|2023\nmovie|Wrong Type|2023" :
          "movie|Rated Film|2020\nmovie|Recommended Film|2023\nseries|Wrong Type|2023" } }] });
    }
    if (url.host === "api.themoviedb.org") {
      if (url.pathname.endsWith("/configuration")) return Response.json({ images: {} });
      const series = url.pathname.includes("/tv");
      if (url.pathname.includes("/search/")) return Response.json({ results: [{
        id: series ? 22 : 11, title: "Recommended Film", name: "Recommended Show",
        release_date: "2023-01-01", first_air_date: "2023-01-01", poster_path: "/poster.jpg", genre_ids: [],
      }] });
      return Response.json({ external_ids: { imdb_id: series ? "tt-recommended-series" : "tt-recommended-movie" } });
    }
    throw new Error(`Unexpected external request: ${url.host}`);
  };

  const post = async (path, body) => {
    const response = await realFetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const settings = { AiProvider: "openai-compat", OpenAICompatApiKey: "test-ai-key-12345",
    TmdbApiKey: "test-tmdb-key-12345", EnableRpdb: false, EnableHomepage: false, EnableSimilar: false,
    TmdbLanguage: "es-ES", NumResults: 5, EnableAiCache: false,
    EnablePersonalizedCatalogs: true, StremioLikedManifestUrl: likedUrl };
  let install;

  await t.test("server rejects malformed sources before paid validation and encryption", async () => {
    const invalid = { ...settings, StremioLikedManifestUrl: "https://evil.test/secret" };
    const checked = await post("/validate", invalid);
    assert.equal(checked.status, 400);
    assert.equal(aiPrompts.length, 0);
    const encrypted = await post("/encrypt", { configData: invalid });
    assert.equal(encrypted.status, 400);
    assert.doesNotMatch(JSON.stringify(encrypted.data), /evil.test|secret/);
  });

  await t.test("private URLs survive encrypt/edit round-trip and register just two personal rows", async () => {
    const result = await post("/encrypt", { configData: settings });
    assert.equal(result.status, 200);
    install = result.data.encryptedConfig;
    assert.ok(install);
    assert.ok(!install.includes("private-test-addon-key"));
    const existing = await realFetch(`${base}/api/getConfig/${install}`).then((r) => r.json());
    assert.equal(existing.StremioLikedManifestUrl, likedUrl.replace("stremio:", "https:"));
    const manifest = await realFetch(`${base}/${install}/manifest.json`).then((r) => r.json());
    assert.deepEqual(manifest.catalogs.filter((c) => !c.isSearch).map((c) => [c.id, c.name]), [
      ["aisearch.personal.movie", "Para ti — Películas"], ["aisearch.personal.series", "Para ti — Series"],
    ]);
  });

  await t.test("movie/series catalogs learn from both types, filter ratings and reuse personal cache", async () => {
    for (const type of ["movie", "series"]) {
      const endpoint = `${base}/${install}/catalog/${type}/aisearch.personal.${type}.json`;
      const result = await realFetch(endpoint).then((r) => r.json());
      assert.equal(result.cacheAge, 0);
      assert.equal(result.staleAge, 0);
      assert.equal(result.metas.length, 1);
      assert.equal(result.metas[0].type, type);
      assert.equal(result.metas[0].id, `tt-recommended-${type}`);
      assert.equal(result.metas[0].releaseInfo, "2023");
      await realFetch(endpoint).then((r) => r.json());
    }
    assert.equal(aiPrompts.length, 2);
    assert.ok(aiPrompts.every((prompt) => prompt.includes("Rated Film") && prompt.includes("Rated Show")));
    assert.ok(aiPrompts.every((prompt) => !prompt.includes("private-test-addon-key") && !prompt.includes("test-ai-key")));
    const logs = JSON.stringify(logEntries);
    assert.doesNotMatch(logs, /Rated Film|Rated Show|private-test-addon-key|test-ai-key/);
    assert.doesNotMatch(JSON.stringify(addon.serializeAllCaches()), /Rated Film|Rated Show|private-test-addon-key/);
  });

  await t.test("mismatched personal paths return empty without triggering a search", async () => {
    const result = await realFetch(`${base}/${install}/catalog/movie/aisearch.personal.series.json`).then((r) => r.json());
    assert.deepEqual(result.metas, []);
    assert.equal(aiPrompts.length, 2);
  });

  await t.test("old installs keep search/homepage catalogs and similar-content opt-out", async () => {
    const old = { ...settings, EnablePersonalizedCatalogs: false, StremioLikedManifestUrl: "", EnableHomepage: true };
    const result = await post("/encrypt", { configData: old });
    const oldInstall = result.data.encryptedConfig;
    const manifest = await realFetch(`${base}/${oldInstall}/manifest.json`).then((r) => r.json());
    assert.equal(manifest.catalogs.filter((c) => c.isSearch).length, 2);
    assert.ok(manifest.catalogs.some((c) => c.id.startsWith("aisearch.home.")));
    assert.ok(manifest.catalogs.every((c) => !c.id.startsWith("aisearch.personal.")));
    const streams = await realFetch(`${base}/${oldInstall}/stream/movie/tt-recommended-movie.json`).then((r) => r.json());
    assert.deepEqual(streams.streams, []);
    const search = await realFetch(`${base}/${oldInstall}/catalog/movie/aisearch.top/search=recommend%20movies.json`).then((r) => r.json());
    assert.ok(search.metas.length);
    const homepage = await realFetch(`${base}/${oldInstall}/catalog/movie/aisearch.home.0.movie.json`).then((r) => r.json());
    assert.ok(homepage.metas.length);
  });

  await t.test("a provider that echoes private input cannot leak it into retry logs or posters", async () => {
    const offset = logEntries.length;
    failAi = true;
    const failed = await post("/encrypt", { configData: { ...settings, OpenAICompatModel: "failure-test-model" } });
    const result = await realFetch(`${base}/${failed.data.encryptedConfig}/catalog/movie/aisearch.personal.movie.json`).then((r) => r.json());
    assert.equal(result.metas.length, 1);
    assert.match(result.metas[0].name, /Personalized/);
    assert.doesNotMatch(JSON.stringify(logEntries.slice(offset)), /Rated Film|Rated Show|private-test-addon-key|test-ai-key-12345/);
    assert.doesNotMatch(JSON.stringify(result), /Rated Film|Rated Show|private-test-addon-key|test-ai-key-12345/);
  });
});
