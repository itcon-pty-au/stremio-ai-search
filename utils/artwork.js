const logger = require("./logger");
const { withRetry } = require("./apiRetry");
const { SimpleLRUCache } = require("./cache");

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_RPDB_KEY = process.env.RPDB_API_KEY;
const DEFAULT_FANART_KEY = process.env.FANART_API_KEY;

const rpdbCache = new SimpleLRUCache({ max: 25000, ttl: WEEK_MS });
const fanartCache = new SimpleLRUCache({ max: 5000, ttl: WEEK_MS });

/** RPDB keys look like "t0-...", "t1-..."; returns the tier or -1. */
function getRpdbTierFromApiKey(apiKey) {
  const match = typeof apiKey === "string" && apiKey.match(/^t(\d+)-/);
  return match ? parseInt(match[1], 10) : -1;
}

/**
 * Resolves the RPDB settings for a user config. Only tier 0 keys (and the
 * shared default key) may have their poster URLs cached: higher tiers can
 * change the poster style per request.
 */
function getRpdbSettings(config) {
  const enabled = config?.EnableRpdb === true;
  const userKey = config?.RpdbApiKey;
  const apiKey = userKey || DEFAULT_RPDB_KEY;
  return {
    enabled: enabled && !!apiKey,
    apiKey,
    posterType: config?.RpdbPosterType || "poster-default",
    cacheable: userKey ? getRpdbTierFromApiKey(userKey) === 0 : !!DEFAULT_RPDB_KEY,
  };
}

async function fetchRpdbPoster(imdbId, { apiKey, posterType, cacheable }) {
  if (!imdbId || !apiKey) return null;

  // The API key is part of the cache key so different tier 0 keys (which bake
  // the poster style into the key itself) never share cached poster URLs.
  const cacheKey = `rpdb_${apiKey}_${imdbId}_${posterType}`;
  if (cacheable) {
    const cached = rpdbCache.get(cacheKey);
    if (cached) return cached.data;
  }

  const url = `https://api.ratingposterdb.com/${apiKey}/imdb/${posterType}/${imdbId}.jpg`;
  try {
    const posterUrl = await withRetry(
      async () => {
        const response = await fetch(url);
        if (response.status === 404) return null;
        if (!response.ok) {
          const error = new Error(`RPDB API error: ${response.status}`);
          error.status = response.status;
          throw error;
        }
        return url;
      },
      {
        maxRetries: 2,
        initialDelay: 1000,
        maxDelay: 5000,
        operationName: "RPDB poster API call",
      }
    );
    if (cacheable) {
      rpdbCache.set(cacheKey, { timestamp: Date.now(), data: posterUrl });
    }
    return posterUrl;
  } catch (error) {
    logger.error("RPDB API Error:", { error: error.message, imdbId, posterType });
    return null;
  }
}

/**
 * Best landscape movie thumbnail from Fanart.tv for the "Similar" page, or
 * null. Misses are cached as well, so a title without artwork is asked for
 * once a week, not on every page view.
 */
async function fetchFanartThumbnail(imdbId, fanartApiKey) {
  const apiKey = fanartApiKey || DEFAULT_FANART_KEY;
  if (!imdbId || !apiKey) return null;

  const cacheKey = `fanart_thumb_${imdbId}`;
  const cached = fanartCache.get(cacheKey);
  if (cached) return cached.data;

  let thumbnail = null;
  try {
    const response = await fetch(
      `https://webservice.fanart.tv/v3/movies/${encodeURIComponent(imdbId)}?api_key=${encodeURIComponent(apiKey)}`
    );
    if (response.ok) {
      const data = await response.json();
      thumbnail =
        (data?.moviethumb || [])
          .filter((t) => !t.lang || t.lang.trim() === "" || t.lang === "en")
          .sort((a, b) => Number(b.likes || 0) - Number(a.likes || 0))[0]?.url || null;
    } else if (response.status !== 404) {
      logger.debug("Fanart.tv API error", { imdbId, status: response.status });
    }
  } catch (error) {
    logger.debug("Fanart.tv API error", { imdbId, error: error.message });
  }

  fanartCache.set(cacheKey, { timestamp: Date.now(), data: thumbnail });
  return thumbnail;
}

/**
 * Landscape thumbnail for a "Similar" entry: Fanart.tv artwork when a key is
 * available, else the TMDB backdrop, else the portrait poster.
 */
async function getLandscapeThumbnail(tmdbData, fanartApiKey) {
  const fanartThumb = await fetchFanartThumbnail(tmdbData.imdb_id, fanartApiKey);
  if (fanartThumb) return fanartThumb;
  if (tmdbData.backdrop) return tmdbData.backdrop.replace("/original", "/w780");
  return tmdbData.poster;
}

module.exports = {
  DEFAULT_RPDB_KEY,
  rpdbCache,
  fanartCache,
  getRpdbSettings,
  fetchRpdbPoster,
  getLandscapeThumbnail,
};
