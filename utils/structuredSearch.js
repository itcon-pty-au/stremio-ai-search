/**
 * Structured "retrieve-then-rank" search.
 *
 * WHY THIS EXISTS
 * ---------------
 * The default flow is generation-first: the LLM emits `type|name|year` from its
 * own memory and each title is then resolved against TMDB by name. That has two
 * failure modes which are structural, not tuning problems:
 *
 *   1. Recency. The model cannot know titles released after its training cutoff,
 *      so "latest <language> movies" returns whatever it remembers.
 *   2. Title collisions. The model returns a short title ("Identity", "Turbo",
 *      "ARM") and TMDB's `year` parameter is a *soft ranking signal*, not a hard
 *      filter — so a wrong year lets a popular English film win. A real observed
 *      case: query "latest malayalam movies" surfaced "The Bourne Identity",
 *      because the model answered "Identity|2026" and TMDB ranked the 2002 film
 *      first for that title+year.
 *
 * This module inverts the order. The LLM never produces an identifier; it only
 * (a) translates the query into structured TMDB filters and (b) ranks candidates
 * that TMDB actually returned. Recency and existence therefore come from the API,
 * and hallucinated titles are impossible by construction.
 *
 *      EXTRACT  -> LLM: query -> {people, genres, keywords, years, language, gist}
 *      RESOLVE  -> names -> ids via /search/person, /search/keyword  (deterministic)
 *      RETRIEVE -> /discover -> grounded candidate set (widened if too small)
 *      RERANK   -> LLM ranks ONLY those candidates against the free-text gist
 *
 * Opt-in. Any failure returns null so the caller falls back to the original path.
 */

const TMDB = "https://api.themoviedb.org/3";

/** Discover filters are useless without at least one real constraint. */
function hasUsableFilters(intent) {
  return Boolean(
    (intent.people && intent.people.length) ||
      (intent.keywords && intent.keywords.length) ||
      (intent.genres && intent.genres.length) ||
      intent.language ||
      intent.yearFrom ||
      intent.yearTo
  );
}

async function getJson(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Step 1 — natural language to a structured intent object. */
async function extractIntent(query, type, aiClient, currentYear) {
  const prompt = [
    "Translate the user's media query into STRICT JSON for the TMDB Discover API.",
    "Return ONLY the JSON object, no prose, no code fences.",
    "",
    "Schema:",
    "{",
    '  "people":   [string],  // actor/director names mentioned, [] if none',
    '  "genres":   [string],  // TMDB genre names e.g. "Action", "Comedy"',
    '  "keywords": [string],  // short plot concepts e.g. "time loop", "heist"',
    '  "yearFrom": number|null,',
    '  "yearTo":   number|null,',
    '  "language": string|null, // ISO-639-1 of the ORIGINAL language if the user',
    '                           // names one, e.g. malayalam -> "ml", hindi -> "hi"',
    '  "gist":     string       // the plot/vibe in a few words, "" if none',
    "}",
    "",
    `Current year is ${currentYear}.`,
    `"latest"/"new" => yearFrom ${currentYear - 1}, yearTo ${currentYear}.`,
    `"recent" => yearFrom ${currentYear - 3}, yearTo ${currentYear}.`,
    'A decade like "90s" => yearFrom 1990, yearTo 1999.',
    "If the user gives an approximate year (\"around 2021\"), widen by one year each side.",
    "Do NOT invent constraints that are not implied by the query.",
    "",
    `QUERY: "${query}"`,
  ].join("\n");

  const raw = await aiClient.generateText(prompt);
  const cleaned = String(raw || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("intent JSON not found");
  const intent = JSON.parse(cleaned.slice(start, end + 1));

  return {
    people: Array.isArray(intent.people) ? intent.people.slice(0, 3) : [],
    genres: Array.isArray(intent.genres) ? intent.genres.slice(0, 4) : [],
    keywords: Array.isArray(intent.keywords) ? intent.keywords.slice(0, 4) : [],
    yearFrom: Number.isFinite(intent.yearFrom) ? intent.yearFrom : null,
    yearTo: Number.isFinite(intent.yearTo) ? intent.yearTo : null,
    language:
      typeof intent.language === "string" && /^[a-z]{2}$/i.test(intent.language)
        ? intent.language.toLowerCase()
        : null,
    gist: typeof intent.gist === "string" ? intent.gist : "",
  };
}

/** Step 2 — names to TMDB ids. Deterministic; no model involvement. */
async function resolveIds(intent, type, tmdbKey) {
  const searchType = type === "movie" ? "movie" : "tv";

  const genreList = await getJson(
    `${TMDB}/genre/${searchType}/list?api_key=${tmdbKey}&language=en-US`
  );
  const genreMap = new Map(
    ((genreList && genreList.genres) || []).map((g) => [
      g.name.toLowerCase(),
      g.id,
    ])
  );

  const people = [];
  for (const name of intent.people) {
    const r = await getJson(
      `${TMDB}/search/person?api_key=${tmdbKey}&query=${encodeURIComponent(name)}`
    );
    const hit = r && r.results && r.results[0];
    if (hit) people.push({ name, id: hit.id });
  }

  const keywords = [];
  for (const kw of intent.keywords) {
    const r = await getJson(
      `${TMDB}/search/keyword?api_key=${tmdbKey}&query=${encodeURIComponent(kw)}`
    );
    const hit = r && r.results && r.results[0];
    if (hit) keywords.push({ name: kw, id: hit.id });
  }

  const genres = intent.genres
    .map((g) => ({ name: g, id: genreMap.get(String(g).toLowerCase()) }))
    .filter((g) => g.id);

  return { people, keywords, genres };
}

function buildDiscoverUrl(type, tmdbKey, ids, intent, opts) {
  const searchType = type === "movie" ? "movie" : "tv";
  const p = new URLSearchParams({
    api_key: tmdbKey,
    sort_by: "popularity.desc",
    include_adult: "false",
    page: "1",
  });
  if (ids.people.length && !opts.dropPeople)
    p.set(
      searchType === "movie" ? "with_cast" : "with_people",
      ids.people.map((x) => x.id).join(",")
    );
  if (ids.genres.length && !opts.dropGenres)
    p.set("with_genres", ids.genres.map((x) => x.id).join(","));
  if (ids.keywords.length && !opts.dropKeywords)
    p.set("with_keywords", ids.keywords.map((x) => x.id).join("|"));
  if (intent.language) p.set("with_original_language", intent.language);

  const pad = opts.yearPad || 0;
  const dateKey =
    searchType === "movie" ? "primary_release_date" : "first_air_date";
  if (intent.yearFrom) p.set(`${dateKey}.gte`, `${intent.yearFrom - pad}-01-01`);
  if (intent.yearTo) p.set(`${dateKey}.lte`, `${intent.yearTo + pad}-12-31`);

  return `${TMDB}/discover/${searchType}?${p.toString()}`;
}

/**
 * Step 3 — retrieve. Progressively relaxes constraints until we have enough
 * candidates. Order matters: keywords are the least reliable signal (TMDB's
 * keyword tagging is sparse), then genres, then the year window. People and
 * original language are never dropped — they are the user's hard intent.
 */
async function retrieveCandidates(type, tmdbKey, ids, intent, minWanted, logger) {
  // A query naming a specific person AND a year window is a *precision* request
  // ("that Mohanlal film around 2021"). Widening it to fill a quota actively
  // hurts: it drags in cameos and out-of-window titles that then outrank the
  // correct answer on popularity. Two right answers beat twenty padded ones.
  const isSpecific = Boolean(
    ids.people.length > 0 && (intent.yearFrom || intent.yearTo)
  );
  const target = isSpecific ? Math.min(minWanted, 8) : minWanted;

  const passes = [
    { label: "strict", yearPad: 0 },
    { label: "drop-keywords", yearPad: 0, dropKeywords: true },
    // On a specific request the year window is the user's intent, so it is never
    // padded — a single year of slack is enough to pull in a neighbouring-year
    // blockbuster that then outranks the correct answer on popularity.
    {
      label: "drop-genres",
      yearPad: isSpecific ? 0 : 1,
      dropKeywords: true,
      dropGenres: true,
    },
    ...(isSpecific
      ? []
      : [{ label: "widen-years", yearPad: 3, dropKeywords: true, dropGenres: true }]),
  ];

  const seen = new Map();
  for (const pass of passes) {
    const url = buildDiscoverUrl(type, tmdbKey, ids, intent, pass);
    const data = await getJson(url, 20000);
    const results = (data && data.results) || [];
    for (const m of results) if (!seen.has(m.id)) seen.set(m.id, m);
    if (logger)
      logger.info("[structured] discover pass", {
        pass: pass.label,
        got: results.length,
        total: seen.size,
        specific: isSpecific,
      });
    if (seen.size >= target) break;
  }
  return [...seen.values()];
}

/** Step 4 — rank the retrieved candidates. The model chooses, never invents. */
async function rerank(query, gist, candidates, aiClient, numResults, type) {
  const lines = candidates.slice(0, 60).map((m, i) => {
    const title = m.title || m.name;
    const date = m.release_date || m.first_air_date || "";
    return `${i + 1}. ${title} (${date.slice(0, 4)}) [${m.original_language}] — ${String(
      m.overview || ""
    ).slice(0, 200)}`;
  });

  const prompt = [
    "Rank these candidates by how well they match the user's request.",
    `USER QUERY: "${query}"`,
    gist ? `PLOT/VIBE THE USER DESCRIBED: "${gist}"` : "",
    "",
    "CANDIDATES:",
    ...lines,
    "",
    `Return at most ${numResults} lines, best first, format: index|title|year`,
    "Use ONLY the numeric indexes above. Do not invent titles.",
    "Drop candidates that clearly do not match. Fewer good results beat padding.",
  ]
    .filter(Boolean)
    .join("\n");

  const raw = await aiClient.generateText(prompt);
  const picked = [];
  for (const line of String(raw || "").split("\n")) {
    const m = line.trim().match(/^(\d+)\s*\|/);
    if (!m) continue;
    const cand = candidates[parseInt(m[1], 10) - 1];
    if (cand && !picked.includes(cand)) picked.push(cand);
  }
  // Model returned nothing parseable -> fall back to TMDB's own ordering
  return (picked.length ? picked : candidates).slice(0, numResults);
}

/**
 * Entry point. Returns an array shaped like the addon's internal recommendation
 * items, plus `tmdbId` so callers can skip the lossy title->TMDB lookup entirely.
 * Returns null when the pipeline is not applicable or fails — caller falls back.
 */
async function structuredSearch({
  query,
  type,
  aiClient,
  tmdbKey,
  numResults = 20,
  logger = null,
  currentYear = new Date().getFullYear(),
}) {
  if (!query || !tmdbKey || !aiClient) return null;
  try {
    const intent = await extractIntent(query, type, aiClient, currentYear);
    if (logger) logger.info("[structured] intent", intent);

    if (!hasUsableFilters(intent)) {
      if (logger)
        logger.info("[structured] no usable filters, deferring to default flow");
      return null;
    }

    const ids = await resolveIds(intent, type, tmdbKey);
    if (logger)
      logger.info("[structured] resolved", {
        people: ids.people.map((p) => `${p.name}=${p.id}`),
        genres: ids.genres.map((g) => g.name),
        keywords: ids.keywords.map((k) => k.name),
        language: intent.language,
      });

    const candidates = await retrieveCandidates(
      type,
      tmdbKey,
      ids,
      intent,
      Math.max(numResults, 20),
      logger
    );
    if (!candidates.length) {
      if (logger) logger.info("[structured] zero candidates, deferring");
      return null;
    }

    const ranked = await rerank(
      query,
      intent.gist,
      candidates,
      aiClient,
      numResults,
      type
    );

    return ranked.map((m) => {
      const title = m.title || m.name;
      const date = m.release_date || m.first_air_date || "";
      return {
        name: title,
        year: parseInt(date.slice(0, 4), 10) || null,
        type,
        tmdbId: m.id,
        overview: m.overview,
        id: `ai_${type}_${String(title).toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
      };
    });
  } catch (e) {
    if (logger)
      logger.error("[structured] pipeline failed, deferring to default flow", {
        error: e && e.message,
      });
    return null;
  }
}

module.exports = {
  structuredSearch,
  // exported for tests
  extractIntent,
  resolveIds,
  retrieveCandidates,
  rerank,
  hasUsableFilters,
};
