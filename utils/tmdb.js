const logger = require("./logger");
const { withRetry } = require("./apiRetry");
const { SimpleLRUCache } = require("./cache");

const TMDB_API_BASE = "https://api.themoviedb.org/3";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const KEY_VALIDATION_TTL_MS = 6 * 60 * 60 * 1000;

// Cache keys below are persisted to cache_data/ between restarts; changing a
// key format turns every saved entry into a miss.
const tmdbCache = new SimpleLRUCache({ max: 25000, ttl: WEEK_MS });
const tmdbDetailsCache = new SimpleLRUCache({ max: 25000, ttl: WEEK_MS });
const tmdbDiscoverCache = new SimpleLRUCache({ max: 1000, ttl: WEEK_MS });

const TMDB_GENRES = {
  28: "Action",
  12: "Adventure",
  16: "Animation",
  35: "Comedy",
  80: "Crime",
  99: "Documentary",
  18: "Drama",
  10751: "Family",
  14: "Fantasy",
  36: "History",
  27: "Horror",
  10402: "Music",
  9648: "Mystery",
  10749: "Romance",
  878: "Science Fiction",
  10770: "TV Movie",
  53: "Thriller",
  10752: "War",
  37: "Western",
};

const TMDB_TV_GENRES = {
  10759: "Action & Adventure",
  16: "Animation",
  35: "Comedy",
  80: "Crime",
  99: "Documentary",
  18: "Drama",
  10751: "Family",
  10762: "Kids",
  9648: "Mystery",
  10763: "News",
  10764: "Reality",
  10765: "Sci-Fi & Fantasy",
  10766: "Soap",
  10767: "Talk",
  10768: "War & Politics",
  37: "Western",
};

function genreNames(genreIds, type) {
  const names = type === "series" ? TMDB_TV_GENRES : TMDB_GENRES;
  return (genreIds || []).map((id) => names[id]).filter(Boolean);
}

function toSearchType(type) {
  return type === "movie" ? "movie" : "tv";
}

function maskKey(url, tmdbKey) {
  return tmdbKey ? url.replace(tmdbKey, "***") : url;
}

/**
 * GETs a TMDB endpoint with retry. Invalid keys (401) fail immediately; rate
 * limits (429) and server errors are retried with backoff.
 */
function tmdbFetchJson(path, params, operationName) {
  const url = `${TMDB_API_BASE}${path}?${new URLSearchParams(params)}`;
  logger.debug(`TMDB request: ${operationName}`, {
    url: maskKey(url, params.api_key),
  });
  return withRetry(
    async () => {
      const response = await fetch(url);
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        const message =
          response.status === 401
            ? "Invalid TMDB API key"
            : response.status === 429
            ? "TMDB API rate limit exceeded"
            : `TMDB API error: ${response.status} ${body?.status_message || ""}`;
        const error = new Error(message);
        error.status = response.status;
        throw error;
      }
      return response.json();
    },
    {
      maxRetries: 3,
      initialDelay: 1000,
      maxDelay: 8000,
      operationName,
      shouldRetry: (error) =>
        !error.status || error.status >= 500 || error.status === 429,
    }
  );
}

// Successful validations are remembered so a catalog request does not pay an
// extra TMDB round trip just to re-check a key that worked minutes ago.
const validatedTmdbKeys = new Map();

async function validateTmdbKey(tmdbKey) {
  const validUntil = validatedTmdbKeys.get(tmdbKey);
  if (validUntil && validUntil > Date.now()) return { ok: true };

  const response = await fetch(
    `${TMDB_API_BASE}/configuration?api_key=${encodeURIComponent(tmdbKey)}`
  );
  if (!response.ok) return { ok: false, status: response.status };

  if (validatedTmdbKeys.size > 10000) validatedTmdbKeys.clear();
  validatedTmdbKeys.set(tmdbKey, Date.now() + KEY_VALIDATION_TTL_MS);
  return { ok: true };
}

/** Lowercase, strip punctuation/diacritic noise so titles compare cleanly. */
function normalizeTitleForMatch(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Picks the best TMDB search result for an AI-emitted title|year instead of
 * blindly trusting results[0] (which is popularity-ordered, so a short title
 * like "Identity" would resolve to "The Bourne Identity"). Scores each
 * candidate on exact-title match, year proximity, and — when the user's query
 * named a language — original_language. Results arrive popularity-ordered and
 * ties keep the earlier (more popular) candidate.
 */
function pickBestTmdbResult(results, title, yearNum, queryLang) {
  if (!Array.isArray(results) || results.length === 0) return null;
  const target = normalizeTitleForMatch(title);
  let best = null;

  for (const r of results) {
    const rTitle = normalizeTitleForMatch(r.title || r.name);
    const rOriginal = normalizeTitleForMatch(r.original_title || r.original_name);
    const exactTitle = rTitle === target || rOriginal === target;

    let score = 0;
    if (exactTitle) score += 4;
    else if (rTitle.includes(target) || target.includes(rTitle)) score += 1;

    const rYear = parseInt(
      String(r.release_date || r.first_air_date || "").slice(0, 4),
      10
    );
    let yearMatch = false;
    if (Number.isFinite(yearNum) && Number.isFinite(rYear)) {
      yearMatch = Math.abs(rYear - yearNum) <= 1;
      score += yearMatch ? 2 : -1;
    }

    const langMatch = Boolean(queryLang && r.original_language === queryLang);
    if (langMatch) score += 3;

    if (!best || score > best.score) {
      best = { result: r, score, exactTitle, langMatch, yearMatch };
    }
  }
  return best;
}

async function getImdbIdForTmdbResult(searchType, tmdbId, tmdbKey, language) {
  const detailsCacheKey = `details_${searchType}_${tmdbId}_${language}`;
  let details = tmdbDetailsCache.get(detailsCacheKey)?.data;
  if (!details) {
    details = await tmdbFetchJson(
      `/${searchType}/${tmdbId}`,
      { api_key: tmdbKey, append_to_response: "external_ids", language },
      "TMDB details API call"
    );
    tmdbDetailsCache.set(detailsCacheKey, { timestamp: Date.now(), data: details });
  }
  return details?.imdb_id || details?.external_ids?.imdb_id;
}

/**
 * Resolves an AI-emitted title + year to TMDB data (poster, overview, IMDb id).
 * Returns null when nothing convincing is found; that miss is cached too.
 */
async function searchTMDB(
  title,
  type,
  year,
  tmdbKey,
  language = "en-US",
  includeAdult = false,
  queryLang = null
) {
  const cacheKey = `${title}-${type}-${year}-${language}-adult:${includeAdult}-qlang:${queryLang || "none"}`;
  const cached = tmdbCache.get(cacheKey);
  if (cached) return cached.data;

  try {
    const searchType = toSearchType(type);
    const yearNum = parseInt(year, 10);

    const searchPage = (withYear) => {
      const params = {
        api_key: tmdbKey,
        query: title,
        include_adult: includeAdult,
        language,
      };
      // Use TMDB's strict year params: on /search/movie the generic `year`
      // matches ANY release date (regional re-releases included) and
      // /search/tv ignores `year` entirely.
      if (withYear && Number.isFinite(yearNum)) {
        params[
          searchType === "movie" ? "primary_release_year" : "first_air_date_year"
        ] = String(yearNum);
      }
      return tmdbFetchJson(`/search/${searchType}`, params, "TMDB search API call");
    };

    const responseData = await searchPage(true);
    let pick = pickBestTmdbResult(responseData?.results, title, yearNum, queryLang);

    // The AI's year can be wrong, and the strict year filter then either
    // excludes the right title or leaves only lookalikes. Retry once without
    // the year when the filtered page produced no exact-title match (or missed
    // the requested original language) and keep whichever pick scores higher.
    const filteredPageUnconvincing =
      Number.isFinite(yearNum) &&
      (!pick || !pick.exactTitle || (queryLang && !pick.langMatch));
    if (filteredPageUnconvincing) {
      const retryData = await searchPage(false);
      const retryPick = pickBestTmdbResult(retryData?.results, title, yearNum, queryLang);
      if (retryPick && (!pick || retryPick.score > pick.score)) {
        pick = retryPick;
      }
    }

    let tmdbData = null;
    if (pick) {
      const result = pick.result;
      logger.debug("TMDB result selected", {
        title,
        year: yearNum,
        queryLang,
        selected: result.title || result.name,
        score: pick.score,
      });

      tmdbData = {
        poster: result.poster_path
          ? `https://image.tmdb.org/t/p/w500${result.poster_path}`
          : null,
        backdrop: result.backdrop_path
          ? `https://image.tmdb.org/t/p/original${result.backdrop_path}`
          : null,
        tmdbRating: result.vote_average,
        genres: result.genre_ids,
        overview: result.overview || "",
        tmdb_id: result.id,
        title: result.title || result.name,
        release_date: result.release_date || result.first_air_date,
        imdb_id: await getImdbIdForTmdbResult(searchType, result.id, tmdbKey, language),
      };
    }

    tmdbCache.set(cacheKey, { timestamp: Date.now(), data: tmdbData });
    return tmdbData;
  } catch (error) {
    logger.error("TMDB Search Error:", {
      error: error.message,
      status: error.status,
      params: { title, type, year },
    });
    return null;
  }
}

/** Raw TMDB title search, used as context for the AI prompt. */
async function searchTmdbTitles(title, type, tmdbKey, language = "en-US", includeAdult = false) {
  const cacheKey = `tmdb_search_${title}-${type}-${language}-adult:${includeAdult}`;
  const cached = tmdbCache.get(cacheKey);
  if (cached) return cached.data || [];

  try {
    const data = await tmdbFetchJson(
      `/search/${toSearchType(type)}`,
      { api_key: tmdbKey, query: title, include_adult: includeAdult, language },
      "TMDB search API call"
    );
    const results = data?.results || [];
    tmdbCache.set(cacheKey, { timestamp: Date.now(), data: results });
    return results;
  } catch (error) {
    logger.error("TMDB Search Error:", { error: error.message, params: { title, type } });
    return [];
  }
}

async function getTmdbDetailsByImdbId(imdbId, type, tmdbKey, language = "en-US") {
  const cacheKey = `details_imdb_${imdbId}_${type}_${language}`;
  const cached = tmdbDetailsCache.get(cacheKey);
  if (cached) return cached.data;

  try {
    const data = await tmdbFetchJson(
      `/find/${imdbId}`,
      { api_key: tmdbKey, language, external_source: "imdb_id" },
      "TMDB find API call"
    );
    const details = (type === "movie" ? data.movie_results : data.tv_results)?.[0];
    if (!details) return null;
    tmdbDetailsCache.set(cacheKey, { timestamp: Date.now(), data: details });
    return details;
  } catch (error) {
    logger.error("Error fetching TMDB details by IMDB ID", { imdbId, error: error.message });
    return null;
  }
}

/**
 * Fetches recently released titles from TMDB Discover to inject into the AI
 * prompt as context on recency queries — the AI still authors every
 * recommendation, this just tells it what exists past its training cutoff.
 * Language-aware when the query named one ("latest malayalam movies").
 */
async function fetchRecentReleases(type, tmdbKey, queryLang = null, includeAdult = false) {
  const searchType = toSearchType(type);
  const dateKey = searchType === "movie" ? "primary_release_date" : "first_air_date";

  const now = new Date();
  const toDate = now.toISOString().slice(0, 10);
  const from = new Date(now);
  from.setMonth(from.getMonth() - 12);
  const fromDate = from.toISOString().slice(0, 10);

  // toDate in the key rotates the cache daily
  const cacheKey = `recent_${searchType}_${queryLang || "any"}_${toDate}_adult:${includeAdult}`;
  const cached = tmdbDiscoverCache.get(cacheKey);
  if (cached) return cached.data || [];

  const params = {
    api_key: tmdbKey,
    sort_by: "popularity.desc",
    include_adult: String(includeAdult),
    page: "1",
    [`${dateKey}.gte`]: fromDate,
    [`${dateKey}.lte`]: toDate,
  };
  if (queryLang) params.with_original_language = queryLang;

  try {
    const data = await tmdbFetchJson(
      `/discover/${searchType}`,
      params,
      "TMDB discover API call"
    );
    const results = (data.results || []).slice(0, 20);
    tmdbDiscoverCache.set(cacheKey, { timestamp: Date.now(), data: results });
    return results;
  } catch (error) {
    logger.error("Recent releases fetch error", {
      error: error.message,
      type: searchType,
      queryLang,
    });
    return [];
  }
}

module.exports = {
  tmdbCache,
  tmdbDetailsCache,
  tmdbDiscoverCache,
  validateTmdbKey,
  searchTMDB,
  searchTmdbTitles,
  getTmdbDetailsByImdbId,
  fetchRecentReleases,
  pickBestTmdbResult,
  genreNames,
};
