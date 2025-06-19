const { addonBuilder } = require("stremio-addon-sdk");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fetch = require("node-fetch").default;
const logger = require("./utils/logger");
const path = require("path");
const { decryptConfig } = require("./utils/crypto");
const { withRetry } = require("./utils/apiRetry");
const TMDB_API_BASE = "https://api.themoviedb.org/3";
const TMDB_CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 day cache for TMDB
const TMDB_DISCOVER_CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 day cache for TMDB discover (was 12 hours)
const AI_CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 day cache for AI
const RPDB_CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 day cache for RPDB
const DEFAULT_RPDB_KEY = process.env.RPDB_API_KEY;
const ENABLE_LOGGING = process.env.ENABLE_LOGGING === "true" || false;
const TRAKT_API_BASE = "https://api.trakt.tv";
const TRAKT_CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours
const TRAKT_RAW_DATA_CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_TRAKT_CLIENT_ID = process.env.TRAKT_CLIENT_ID;
const MAX_AI_RECOMMENDATIONS = 30;

// Stats counter for tracking total queries
let queryCounter = 0;

class SimpleLRUCache {
  constructor(options = {}) {
    this.max = options.max || 1000;
    this.ttl = options.ttl || Infinity;
    this.cache = new Map();
    this.timestamps = new Map();
    this.expirations = new Map();
  }

  set(key, value) {
    if (this.cache.size >= this.max) {
      const oldestKey = this.timestamps.keys().next().value;
      this.delete(oldestKey);
    }

    this.cache.set(key, value);
    this.timestamps.set(key, Date.now());

    if (this.ttl !== Infinity) {
      const expiration = Date.now() + this.ttl;
      this.expirations.set(key, expiration);
    }

    return this;
  }

  get(key) {
    if (!this.cache.has(key)) {
      return undefined;
    }

    const expiration = this.expirations.get(key);
    if (expiration && Date.now() > expiration) {
      this.delete(key);
      return undefined;
    }

    this.timestamps.delete(key);
    this.timestamps.set(key, Date.now());

    return this.cache.get(key);
  }

  has(key) {
    if (!this.cache.has(key)) {
      return false;
    }

    const expiration = this.expirations.get(key);
    if (expiration && Date.now() > expiration) {
      this.delete(key);
      return false;
    }

    return true;
  }

  delete(key) {
    this.cache.delete(key);
    this.timestamps.delete(key);
    this.expirations.delete(key);
    return true;
  }

  clear() {
    this.cache.clear();
    this.timestamps.clear();
    this.expirations.clear();
    return true;
  }

  get size() {
    return this.cache.size;
  }

  keys() {
    return Array.from(this.cache.keys());
  }

  // Serialize cache data to a JSON-friendly format
  serialize() {
    const entries = [];
    for (const [key, value] of this.cache.entries()) {
      const timestamp = this.timestamps.get(key);
      const expiration = this.expirations.get(key);
      entries.push({
        key,
        value,
        timestamp,
        expiration,
      });
    }

    return {
      max: this.max,
      ttl: this.ttl,
      entries,
    };
  }

  // Load data from serialized format
  deserialize(data) {
    if (!data || !data.entries) {
      return false;
    }

    this.max = data.max || this.max;
    this.ttl = data.ttl || this.ttl;

    // Clear existing data
    this.clear();

    // Load entries
    for (const entry of data.entries) {
      // Skip expired entries
      if (entry.expiration && Date.now() > entry.expiration) {
        continue;
      }

      this.cache.set(entry.key, entry.value);
      this.timestamps.set(entry.key, entry.timestamp);
      if (entry.expiration) {
        this.expirations.set(entry.key, entry.expiration);
      }
    }

    return true;
  }
}

const tmdbCache = new SimpleLRUCache({
  max: 25000,
  ttl: TMDB_CACHE_DURATION,
});

// Add a separate cache for TMDB details to avoid redundant API calls
const tmdbDetailsCache = new SimpleLRUCache({
  max: 25000,
  ttl: TMDB_CACHE_DURATION,
});

const aiRecommendationsCache = new SimpleLRUCache({
  max: 25000,
  ttl: AI_CACHE_DURATION,
});

const rpdbCache = new SimpleLRUCache({
  max: 25000,
  ttl: RPDB_CACHE_DURATION,
});

const HOST = process.env.HOST
  ? `https://${process.env.HOST}`
  : "https://stremio.itcon.au";
const PORT = 7000;
const BASE_PATH = "/aisearch";

setInterval(() => {
  const tmdbStats = {
    size: tmdbCache.size,
    maxSize: tmdbCache.max,
    usagePercentage: ((tmdbCache.size / tmdbCache.max) * 100).toFixed(2) + "%",
    itemCount: tmdbCache.size,
  };

  const tmdbDetailsStats = {
    size: tmdbDetailsCache.size,
    maxSize: tmdbDetailsCache.max,
    usagePercentage:
      ((tmdbDetailsCache.size / tmdbDetailsCache.max) * 100).toFixed(2) + "%",
    itemCount: tmdbDetailsCache.size,
  };

  const tmdbDiscoverStats = {
    size: tmdbDiscoverCache.size,
    maxSize: tmdbDiscoverCache.max,
    usagePercentage:
      ((tmdbDiscoverCache.size / tmdbDiscoverCache.max) * 100).toFixed(2) + "%",
    itemCount: tmdbDiscoverCache.size,
  };

  const aiStats = {
    size: aiRecommendationsCache.size,
    maxSize: aiRecommendationsCache.max,
    usagePercentage:
      (
        (aiRecommendationsCache.size / aiRecommendationsCache.max) *
        100
      ).toFixed(2) + "%",
    itemCount: aiRecommendationsCache.size,
  };

  const rpdbStats = {
    size: rpdbCache.size,
    maxSize: rpdbCache.max,
    usagePercentage: ((rpdbCache.size / rpdbCache.max) * 100).toFixed(2) + "%",
    itemCount: rpdbCache.size,
  };

  logger.info("Cache statistics", {
    tmdbCache: tmdbStats,
    tmdbDetailsCache: tmdbDetailsStats,
    tmdbDiscoverCache: tmdbDiscoverStats,
    aiCache: aiStats,
    rpdbCache: rpdbStats,
  });
}, 60 * 60 * 1000);

const DEFAULT_GEMINI_MODEL = "gemini-2.0-flash-lite";

// Add separate caches for raw and processed Trakt data
const traktRawDataCache = new SimpleLRUCache({
  max: 1000,
  ttl: TRAKT_RAW_DATA_CACHE_DURATION,
});

const traktCache = new SimpleLRUCache({
  max: 1000,
  ttl: TRAKT_CACHE_DURATION,
});

// Cache for TMDB discover API results
const tmdbDiscoverCache = new SimpleLRUCache({
  max: 1000,
  ttl: TMDB_DISCOVER_CACHE_DURATION,
});

// Cache for query analysis results
const queryAnalysisCache = new SimpleLRUCache({
  max: 1000,
  ttl: AI_CACHE_DURATION, // Use the same TTL as other AI caches
});

// Helper function to merge and deduplicate Trakt items
function mergeAndDeduplicate(newItems, existingItems) {
  // Create a map of existing items by ID for quick lookup
  const existingMap = new Map();
  existingItems.forEach((item) => {
    const media = item.movie || item.show;
    const id = item.id || media?.ids?.trakt;
    if (id) {
      existingMap.set(id, item);
    }
  });

  // Add new items, replacing existing ones if newer
  newItems.forEach((item) => {
    const media = item.movie || item.show;
    const id = item.id || media?.ids?.trakt;
    if (id) {
      // If item exists, keep the newer one based on last_activity or just replace
      if (
        !existingMap.has(id) ||
        (item.last_activity &&
          existingMap.get(id).last_activity &&
          new Date(item.last_activity) >
            new Date(existingMap.get(id).last_activity))
      ) {
        existingMap.set(id, item);
      }
    }
  });

  // Convert map back to array
  return Array.from(existingMap.values());
}

async function refreshTraktToken(refreshToken, clientId, clientSecret) {
  try {
    const response = await fetch("https://api.trakt.tv/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: `${HOST}/aisearch/oauth/callback`,
        grant_type: "refresh_token",
      }),
    });

    if (!response.ok) throw new Error("Token refresh failed");
    return await response.json();
  } catch (error) {
    logger.error("Token refresh error:", { error: error.message });
    return null;
  }
}

// Modular functions for processing different aspects of Trakt data
function processGenres(watchedItems, ratedItems) {
  const genres = new Map();

  // Process watched items
  watchedItems?.forEach((item) => {
    const media = item.movie || item.show;
    media.genres?.forEach((genre) => {
      genres.set(genre, (genres.get(genre) || 0) + 1);
    });
  });

  // Process rated items with weights
  ratedItems?.forEach((item) => {
    const media = item.movie || item.show;
    const weight = item.rating / 5; // normalize rating to 0-1
    media.genres?.forEach((genre) => {
      genres.set(genre, (genres.get(genre) || 0) + weight);
    });
  });

  // Convert to sorted array
  return Array.from(genres.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([genre, count]) => ({ genre, count }));
}

function processActors(watchedItems, ratedItems) {
  const actors = new Map();

  // Process watched items
  watchedItems?.forEach((item) => {
    const media = item.movie || item.show;
    media.cast?.forEach((actor) => {
      actors.set(actor.name, (actors.get(actor.name) || 0) + 1);
    });
  });

  // Process rated items with weights
  ratedItems?.forEach((item) => {
    const media = item.movie || item.show;
    const weight = item.rating / 5; // normalize rating to 0-1
    media.cast?.forEach((actor) => {
      actors.set(actor.name, (actors.get(actor.name) || 0) + weight);
    });
  });

  // Convert to sorted array
  return Array.from(actors.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([actor, count]) => ({ actor, count }));
}

function processDirectors(watchedItems, ratedItems) {
  const directors = new Map();

  // Process watched items
  watchedItems?.forEach((item) => {
    const media = item.movie || item.show;
    media.crew?.forEach((person) => {
      if (person.job === "Director") {
        directors.set(person.name, (directors.get(person.name) || 0) + 1);
      }
    });
  });

  // Process rated items with weights
  ratedItems?.forEach((item) => {
    const media = item.movie || item.show;
    const weight = item.rating / 5; // normalize rating to 0-1
    media.crew?.forEach((person) => {
      if (person.job === "Director") {
        directors.set(person.name, (directors.get(person.name) || 0) + weight);
      }
    });
  });

  // Convert to sorted array
  return Array.from(directors.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([director, count]) => ({ director, count }));
}

function processYears(watchedItems, ratedItems) {
  const years = new Map();

  // Process watched items
  watchedItems?.forEach((item) => {
    const media = item.movie || item.show;
    const year = parseInt(media.year);
    if (year) {
      years.set(year, (years.get(year) || 0) + 1);
    }
  });

  // Process rated items with weights
  ratedItems?.forEach((item) => {
    const media = item.movie || item.show;
    const year = parseInt(media.year);
    const weight = item.rating / 5; // normalize rating to 0-1
    if (year) {
      years.set(year, (years.get(year) || 0) + weight);
    }
  });

  // If no years data, return null
  if (years.size === 0) {
    return null;
  }

  // Create year range object
  return {
    start: Math.min(...years.keys()),
    end: Math.max(...years.keys()),
    preferred: Array.from(years.entries()).sort((a, b) => b[1] - a[1])[0]?.[0],
  };
}

function processRatings(ratedItems) {
  const ratings = new Map();

  // Process ratings distribution
  ratedItems?.forEach((item) => {
    ratings.set(item.rating, (ratings.get(item.rating) || 0) + 1);
  });

  // Convert to sorted array
  return Array.from(ratings.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([rating, count]) => ({ rating, count }));
}

// Process all preferences in parallel
async function processPreferencesInParallel(watched, rated, history) {
  const processingStart = Date.now();

  // Run all processing functions in parallel
  const [genres, actors, directors, yearRange, ratings] = await Promise.all([
    Promise.resolve(processGenres(watched, rated)),
    Promise.resolve(processActors(watched, rated)),
    Promise.resolve(processDirectors(watched, rated)),
    Promise.resolve(processYears(watched, rated)),
    Promise.resolve(processRatings(rated)),
  ]);

  const processingTime = Date.now() - processingStart;
  logger.debug("Trakt preference processing completed", {
    processingTimeMs: processingTime,
    genresCount: genres.length,
    actorsCount: actors.length,
    directorsCount: directors.length,
    hasYearRange: !!yearRange,
    ratingsCount: ratings.length,
  });

  return {
    genres,
    actors,
    directors,
    yearRange,
    ratings,
  };
}

// Function to fetch incremental Trakt data
async function fetchTraktIncrementalData(
  clientId,
  accessToken,
  type,
  lastUpdate
) {
  // Format date for Trakt API (ISO string without milliseconds)
  const startDate = new Date(lastUpdate).toISOString().split(".")[0] + "Z";

  const endpoints = [
    `${TRAKT_API_BASE}/users/me/watched/${type}?extended=full&start_at=${startDate}`,
    `${TRAKT_API_BASE}/users/me/ratings/${type}?extended=full&start_at=${startDate}`,
    `${TRAKT_API_BASE}/users/me/history/${type}?extended=full&start_at=${startDate}`,
  ];

  const headers = {
    "Content-Type": "application/json",
    "trakt-api-version": "2",
    "trakt-api-key": clientId,
    Authorization: `Bearer ${accessToken}`,
  };

  // Fetch all data in parallel
  const responses = await Promise.all(
    endpoints.map((endpoint) =>
      makeApiCall(endpoint, headers)
        .then((res) => res.json())
        .catch((err) => {
          logger.error("Trakt API Error:", { endpoint, error: err.message });
          return [];
        })
    )
  );

  return {
    watched: responses[0] || [],
    rated: responses[1] || [],
    history: responses[2] || [],
  };
}

// Main function to fetch Trakt data with optimizations
async function fetchTraktWatchedAndRated(
  clientId,
  accessToken,
  type = "movies",
  config = null
) {
  logger.info("fetchTraktWatchedAndRated called", {
    hasClientId: !!clientId,
    clientIdLength: clientId?.length,
    hasAccessToken: !!accessToken,
    accessTokenLength: accessToken?.length,
    type,
  });

  if (!clientId || !accessToken) {
    logger.error("Missing Trakt credentials", {
      hasClientId: !!clientId,
      hasAccessToken: !!accessToken,
    });
    return null;
  }

  const makeApiCall = async (url, headers) => {
    const response = await fetch(url, { headers });

    if (response.status === 401 && config?.TraktRefreshToken) {
      logger.info("Trakt token expired, attempting refresh");

      const newTokens = await refreshTraktToken(
        config.TraktRefreshToken,
        clientId,
        process.env.TRAKT_CLIENT_SECRET
      );

      if (newTokens?.access_token) {
        logger.info("Token refresh successful");
        config.TraktAccessToken = newTokens.access_token;
        if (newTokens.refresh_token) {
          config.TraktRefreshToken = newTokens.refresh_token;
        }

        const newHeaders = {
          ...headers,
          Authorization: `Bearer ${newTokens.access_token}`,
        };
        return await fetch(url, { headers: newHeaders });
      }
    }

    return response;
  };

  const rawCacheKey = `trakt_raw_${accessToken}_${type}`;
  const processedCacheKey = `trakt_${accessToken}_${type}`;

  // Check if we have processed data in cache
  if (traktCache.has(processedCacheKey)) {
    const cached = traktCache.get(processedCacheKey);
    logger.info("Trakt processed cache hit", {
      cacheKey: processedCacheKey,
      type,
      cachedAt: new Date(cached.timestamp).toISOString(),
      age: `${Math.round((Date.now() - cached.timestamp) / 1000)}s`,
    });
    return cached.data;
  }

  // Check if we have raw data that needs updating
  let rawData;
  let isIncremental = false;

  if (traktRawDataCache.has(rawCacheKey)) {
    const cachedRaw = traktRawDataCache.get(rawCacheKey);
    const lastUpdate = cachedRaw.lastUpdate || cachedRaw.timestamp;

    // Always do incremental updates when cache exists, regardless of age
    logger.info("Performing incremental Trakt update", {
      cacheKey: rawCacheKey,
      lastUpdate: new Date(lastUpdate).toISOString(),
      age: `${Math.round((Date.now() - lastUpdate) / 1000)}s`,
    });

    try {
      // Fetch only new data since last update
      const newData = await fetchTraktIncrementalData(
        clientId,
        accessToken,
        type,
        lastUpdate
      );

      // Merge with existing data
      rawData = {
        watched: mergeAndDeduplicate(newData.watched, cachedRaw.data.watched),
        rated: mergeAndDeduplicate(newData.rated, cachedRaw.data.rated),
        history: mergeAndDeduplicate(newData.history, cachedRaw.data.history),
        lastUpdate: Date.now(),
      };

      isIncremental = true;

      // Update raw data cache
      traktRawDataCache.set(rawCacheKey, {
        timestamp: Date.now(),
        lastUpdate: Date.now(),
        data: rawData,
      });

      logger.info("Incremental Trakt update completed", {
        newWatchedCount: newData.watched.length,
        newRatedCount: newData.rated.length,
        newHistoryCount: newData.history.length,
        totalWatchedCount: rawData.watched.length,
        totalRatedCount: rawData.rated.length,
        totalHistoryCount: rawData.history.length,
      });
    } catch (error) {
      logger.error(
        "Incremental Trakt update failed, falling back to full refresh",
        {
          error: error.message,
        }
      );
      isIncremental = false;
    }
  }

  // If we don't have raw data or incremental update failed, do a full refresh
  if (!rawData) {
    logger.info("Performing full Trakt data refresh", { type });

    try {
      const fetchStart = Date.now();
      // Use the original fetch logic for a full refresh but without limits
      const endpoints = [
        `${TRAKT_API_BASE}/users/me/watched/${type}?extended=full`,
        `${TRAKT_API_BASE}/users/me/ratings/${type}?extended=full`,
        `${TRAKT_API_BASE}/users/me/history/${type}?extended=full`,
      ];

      const headers = {
        "Content-Type": "application/json",
        "trakt-api-version": "2",
        "trakt-api-key": clientId,
        Authorization: `Bearer ${accessToken}`,
      };

      const responses = await Promise.all(
        endpoints.map((endpoint) =>
          makeApiCall(endpoint, headers)
            .then((res) => res.json())
            .catch((err) => {
              logger.error("Trakt API Error:", {
                endpoint,
                error: err.message,
              });
              return [];
            })
        )
      );

      const fetchTime = Date.now() - fetchStart;
      const [watched, rated, history] = responses;

      rawData = {
        watched: watched || [],
        rated: rated || [],
        history: history || [],
        lastUpdate: Date.now(),
      };

      // Update raw data cache
      traktRawDataCache.set(rawCacheKey, {
        timestamp: Date.now(),
        lastUpdate: Date.now(),
        data: rawData,
      });

      logger.info("Full Trakt refresh completed", {
        fetchTimeMs: fetchTime,
        watchedCount: rawData.watched.length,
        ratedCount: rawData.rated.length,
        historyCount: rawData.history.length,
      });
    } catch (error) {
      logger.error("Trakt API Error:", {
        error: error.message,
        stack: error.stack,
      });
      return null;
    }
  }

  // Process the data (raw or incrementally updated) in parallel
  const processingStart = Date.now();
  const preferences = await processPreferencesInParallel(
    rawData.watched,
    rawData.rated,
    rawData.history
  );
  const processingTime = Date.now() - processingStart;

  // Create the final result
  const result = {
    watched: rawData.watched,
    rated: rawData.rated,
    history: rawData.history,
    preferences,
    lastUpdate: rawData.lastUpdate,
    isIncrementalUpdate: isIncremental,
  };

  // Cache the processed result
  traktCache.set(processedCacheKey, {
    timestamp: Date.now(),
    data: result,
  });

  logger.info("Trakt data processing and caching completed", {
    processingTimeMs: processingTime,
    isIncremental: isIncremental,
    cacheKey: processedCacheKey,
  });

  return result;
}

async function searchTMDB(title, type, year, tmdbKey, language = "en-US") {
  const startTime = Date.now();
  logger.debug("Starting TMDB search", { title, type, year });
  const cacheKey = `${title}-${type}-${year}-${language}`;

  if (tmdbCache.has(cacheKey)) {
    const cached = tmdbCache.get(cacheKey);
    logger.info("TMDB cache hit", {
      cacheKey,
      cachedAt: new Date(cached.timestamp).toISOString(),
      age: `${Math.round((Date.now() - cached.timestamp) / 1000)}s`,
      responseTime: `${Date.now() - startTime}ms`,
      title,
      type,
      year,
      language,
      hasImdbId: !!cached.data?.imdb_id,
      tmdbId: cached.data?.tmdb_id,
    });
    return cached.data;
  }

  logger.info("TMDB cache miss", { cacheKey, title, type, year, language });

  try {
    const searchType = type === "movie" ? "movie" : "tv";
    const searchParams = new URLSearchParams({
      api_key: tmdbKey,
      query: title,
      year: year,
      include_adult: false,
      language: language,
    });

    const searchUrl = `${TMDB_API_BASE}/search/${searchType}?${searchParams.toString()}`;

    logger.info("Making TMDB API call", {
      url: searchUrl.replace(tmdbKey, "***"),
      params: {
        type: searchType,
        query: title,
        year,
        language,
      },
    });

    // Use withRetry for the search API call
    const responseData = await withRetry(
      async () => {
        const searchResponse = await fetch(searchUrl);
        if (!searchResponse.ok) {
          const errorData = await searchResponse.json().catch(() => ({}));
          let errorMessage;

          // Handle specific error cases
          if (searchResponse.status === 401) {
            errorMessage = "Invalid TMDB API key";
          } else if (searchResponse.status === 429) {
            errorMessage = "TMDB API rate limit exceeded";
          } else {
            errorMessage = `TMDB API error: ${searchResponse.status} ${
              errorData?.status_message || ""
            }`;
          }

          const error = new Error(errorMessage);
          error.status = searchResponse.status;
          error.isRateLimit = searchResponse.status === 429;
          error.isInvalidKey = searchResponse.status === 401;
          throw error;
        }
        return searchResponse.json();
      },
      {
        maxRetries: 3,
        initialDelay: 1000,
        maxDelay: 8000,
        operationName: "TMDB search API call",
        // Don't retry on invalid API key errors
        shouldRetry: (error) =>
          !error.isInvalidKey &&
          (!error.status || error.status >= 500 || error.isRateLimit),
      }
    );

    // Log response with error status if applicable
    if (responseData.status_code) {
      logger.error("TMDB API error response", {
        duration: `${Date.now() - startTime}ms`,
        status_code: responseData.status_code,
        status_message: responseData.status_message,
        query: title,
        year: year,
      });
    } else {
      // Log successful response (even if no results found)
      logger.info("TMDB API response", {
        duration: `${Date.now() - startTime}ms`,
        resultCount: responseData?.results?.length,
        status: "success",
        query: title,
        year: year,
        firstResult: responseData?.results?.[0]
          ? {
              id: responseData.results[0].id,
              title:
                responseData.results[0].title || responseData.results[0].name,
              year:
                responseData.results[0].release_date ||
                responseData.results[0].first_air_date,
              hasExternalIds: !!responseData.results[0].external_ids,
            }
          : null,
      });
    }

    if (responseData?.results?.[0]) {
      const result = responseData.results[0];

      const tmdbData = {
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
      };

      // Only fetch details if we don't have an IMDB ID
      if (!tmdbData.imdb_id) {
        const detailsCacheKey = `details_${searchType}_${result.id}_${language}`;
        let detailsData;

        // Check if details are in cache
        if (tmdbDetailsCache.has(detailsCacheKey)) {
          const cachedDetails = tmdbDetailsCache.get(detailsCacheKey);
          logger.info("TMDB details cache hit", {
            cacheKey: detailsCacheKey,
            tmdbId: result.id,
            cachedAt: new Date(cachedDetails.timestamp).toISOString(),
            age: `${Math.round(
              (Date.now() - cachedDetails.timestamp) / 1000
            )}s`,
            hasImdbId: !!(
              cachedDetails.data?.imdb_id ||
              cachedDetails.data?.external_ids?.imdb_id
            ),
          });
          detailsData = cachedDetails.data;
        } else {
          // Not in cache, need to make API call
          const detailsUrl = `${TMDB_API_BASE}/${searchType}/${result.id}?api_key=${tmdbKey}&append_to_response=external_ids&language=${language}`;

          logger.info("TMDB details cache miss", {
            cacheKey: detailsCacheKey,
            tmdbId: result.id,
          });

          logger.info("Making TMDB details API call", {
            url: detailsUrl.replace(tmdbKey, "***"),
            movieId: result.id,
            type: searchType,
          });

          // Use withRetry for the details API call
          detailsData = await withRetry(
            async () => {
              const detailsResponse = await fetch(detailsUrl);
              if (!detailsResponse.ok) {
                const errorData = await detailsResponse
                  .json()
                  .catch(() => ({}));
                const error = new Error(
                  `TMDB details API error: ${detailsResponse.status} ${
                    errorData?.status_message || ""
                  }`
                );
                error.status = detailsResponse.status;
                throw error;
              }
              return detailsResponse.json();
            },
            {
              maxRetries: 3,
              initialDelay: 1000,
              maxDelay: 8000,
              operationName: "TMDB details API call",
            }
          );

          logger.info("TMDB details response", {
            duration: `${Date.now() - startTime}ms`,
            hasImdbId: !!(
              detailsData?.imdb_id || detailsData?.external_ids?.imdb_id
            ),
            tmdbId: detailsData?.id,
            type: searchType,
          });

          // Cache the details response
          tmdbDetailsCache.set(detailsCacheKey, {
            timestamp: Date.now(),
            data: detailsData,
          });

          logger.debug("TMDB details result cached", {
            cacheKey: detailsCacheKey,
            tmdbId: result.id,
            hasImdbId: !!(
              detailsData?.imdb_id || detailsData?.external_ids?.imdb_id
            ),
          });
        }

        // Extract IMDb ID from details data
        if (detailsData) {
          tmdbData.imdb_id =
            detailsData.imdb_id || detailsData.external_ids?.imdb_id;

          logger.debug("IMDB ID extraction result", {
            title,
            type,
            tmdbId: result.id,
            hasImdbId: !!tmdbData.imdb_id,
            imdbId: tmdbData.imdb_id || "not_found",
          });
        }
      }

      tmdbCache.set(cacheKey, {
        timestamp: Date.now(),
        data: tmdbData,
      });

      logger.debug("TMDB result cached", {
        cacheKey,
        duration: Date.now() - startTime,
        hasData: !!tmdbData,
        hasImdbId: !!tmdbData.imdb_id,
        title,
        type,
        tmdbId: tmdbData.tmdb_id,
      });
      return tmdbData;
    }

    logger.debug("No TMDB results found", {
      title,
      type,
      year,
      duration: Date.now() - startTime,
    });

    tmdbCache.set(cacheKey, {
      timestamp: Date.now(),
      data: null,
    });
    return null;
  } catch (error) {
    logger.error("TMDB Search Error:", {
      error: error.message,
      stack: error.stack,
      errorType: error.isRateLimit
        ? "rate_limit"
        : error.isInvalidKey
        ? "invalid_key"
        : error.status
        ? `http_${error.status}`
        : "unknown",
      params: { title, type, year, tmdbKeyLength: tmdbKey?.length },
      retryAttempts: error.retryCount || 0,
    });
    return null;
  }
}

async function searchTMDBExactMatch(title, type, tmdbKey, language = "en-US") {
  const startTime = Date.now();
  logger.debug("Starting TMDB exact match search", { title, type });
  const cacheKey = `exact_${title}-${type}-${language}`;
  if (tmdbCache.has(cacheKey)) {
    const cached = tmdbCache.get(cacheKey);
    logger.info("TMDB exact match cache hit", {
      cacheKey,
      cachedAt: new Date(cached.timestamp).toISOString(),
      age: `${Math.round((Date.now() - cached.timestamp) / 1000)}s`,
      responseTime: `${Date.now() - startTime}ms`,
      title,
      type,
      language,
    });
    return cached.data;
  }
  logger.info("TMDB exact match cache miss", {
    cacheKey,
    title,
    type,
    language,
  });
  try {
    const searchType = type === "movie" ? "movie" : "tv";
    const searchParams = new URLSearchParams({
      api_key: tmdbKey,
      query: title,
      include_adult: false,
      language: language,
    });
    const searchUrl = `${TMDB_API_BASE}/search/${searchType}?${searchParams.toString()}`;
    logger.info("Making TMDB exact match API call", {
      url: searchUrl.replace(tmdbKey, "***"),
      params: { type: searchType, query: title, language },
    });
    const responseData = await withRetry(
      async () => {
        const searchResponse = await fetch(searchUrl);
        if (!searchResponse.ok) {
          const errorData = await searchResponse.json().catch(() => ({}));
          let errorMessage;
          if (searchResponse.status === 401) {
            errorMessage = "Invalid TMDB API key";
          } else if (searchResponse.status === 429) {
            errorMessage = "TMDB API rate limit exceeded";
          } else {
            errorMessage = `TMDB API error: ${searchResponse.status} ${
              errorData?.status_message || ""
            }`;
          }
          const error = new Error(errorMessage);
          error.status = searchResponse.status;
          error.isRateLimit = searchResponse.status === 429;
          error.isInvalidKey = searchResponse.status === 401;
          throw error;
        }
        return searchResponse.json();
      },
      {
        maxRetries: 3,
        initialDelay: 1000,
        maxDelay: 8000,
        operationName: "TMDB exact match search API call",
        shouldRetry: (error) =>
          !error.isInvalidKey &&
          (!error.status || error.status >= 500 || error.isRateLimit),
      }
    );
    if (responseData?.results?.length > 0) {
      const normalizedTitle = title.toLowerCase().trim();
      const exactMatch = responseData.results.find((result) => {
        const resultTitle = (result.title || result.name || "")
          .toLowerCase()
          .trim();
        return resultTitle === normalizedTitle;
      });
      if (exactMatch) {
        const tmdbData = {
          poster: exactMatch.poster_path
            ? `https://image.tmdb.org/t/p/w500${exactMatch.poster_path}`
            : null,
          backdrop: exactMatch.backdrop_path
            ? `https://image.tmdb.org/t/p/original${exactMatch.backdrop_path}`
            : null,
          tmdbRating: exactMatch.vote_average,
          genres: exactMatch.genre_ids,
          overview: exactMatch.overview || "",
          tmdb_id: exactMatch.id,
          title: exactMatch.title || exactMatch.name,
          release_date: exactMatch.release_date || exactMatch.first_air_date,
        };
        const detailsCacheKey = `details_${searchType}_${exactMatch.id}_${language}`;
        let detailsData;
        if (tmdbDetailsCache.has(detailsCacheKey)) {
          const cachedDetails = tmdbDetailsCache.get(detailsCacheKey);
          logger.info("TMDB exact match details cache hit", {
            cacheKey: detailsCacheKey,
            tmdbId: exactMatch.id,
            cachedAt: new Date(cachedDetails.timestamp).toISOString(),
            age: `${Math.round(
              (Date.now() - cachedDetails.timestamp) / 1000
            )}s`,
          });
          detailsData = cachedDetails.data;
        } else {
          const detailsUrl = `${TMDB_API_BASE}/${searchType}/${exactMatch.id}?api_key=${tmdbKey}&append_to_response=external_ids&language=${language}`;
          logger.info("Making TMDB exact match details API call", {
            url: detailsUrl.replace(tmdbKey, "***"),
            movieId: exactMatch.id,
            type: searchType,
          });
          detailsData = await withRetry(
            async () => {
              const detailsResponse = await fetch(detailsUrl);
              if (!detailsResponse.ok) {
                const errorData = await detailsResponse
                  .json()
                  .catch(() => ({}));
                const error = new Error(
                  `TMDB details API error: ${detailsResponse.status} ${
                    errorData?.status_message || ""
                  }`
                );
                error.status = detailsResponse.status;
                throw error;
              }
              return detailsResponse.json();
            },
            {
              maxRetries: 3,
              initialDelay: 1000,
              maxDelay: 8000,
              operationName: "TMDB exact match details API call",
            }
          );
          tmdbDetailsCache.set(detailsCacheKey, {
            timestamp: Date.now(),
            data: detailsData,
          });
        }
        if (detailsData) {
          tmdbData.imdb_id =
            detailsData.imdb_id || detailsData.external_ids?.imdb_id;
        }
        tmdbCache.set(cacheKey, {
          timestamp: Date.now(),
          data: tmdbData,
        });
        logger.info("TMDB exact match found", {
          title,
          type,
          exactMatchTitle: tmdbData.title,
          tmdbId: tmdbData.tmdb_id,
          hasImdbId: !!tmdbData.imdb_id,
          duration: Date.now() - startTime,
        });
        return tmdbData;
      }
    }
    logger.debug("No TMDB exact match found", {
      title,
      type,
      duration: Date.now() - startTime,
      totalResults: responseData?.results?.length || 0,
    });
    tmdbCache.set(cacheKey, {
      timestamp: Date.now(),
      data: null,
    });
    return null;
  } catch (error) {
    logger.error("TMDB Exact Match Search Error:", {
      error: error.message,
      stack: error.stack,
      errorType: error.isRateLimit
        ? "rate_limit"
        : error.isInvalidKey
        ? "invalid_key"
        : error.status
        ? `http_${error.status}`
        : "unknown",
      params: { title, type, tmdbKeyLength: tmdbKey?.length },
      retryAttempts: error.retryCount || 0,
    });
    return null;
  }
}

const manifest = {
  id: "au.itcon.aisearch",
  version: "1.0.0",
  name: "AI Search",
  description: "AI-powered movie and series recommendations",
  resources: ["catalog", "meta"],
  types: ["movie", "series"],
  catalogs: [
    {
      type: "movie",
      id: "top",
      name: "AI Movie Search",
      extra: [{ name: "search", isRequired: true }],
      isSearch: true,
    },
    {
      type: "series",
      id: "top",
      name: "AI Series Search",
      extra: [{ name: "search", isRequired: true }],
      isSearch: true,
    },
  ],
  behaviorHints: {
    configurable: true,
    configurationRequired: true,
    searchable: true,
  },
  logo: `${HOST}${BASE_PATH}/logo.png`,
  background: `${HOST}${BASE_PATH}/bg.jpg`,
  contactEmail: "hi@itcon.au",
};

const builder = new addonBuilder(manifest);

/**
 * Determines the intent of a search query based on keywords
 * @param {string} query
 * @returns {"movie"|"series"|"ambiguous"}
 */
function determineIntentFromKeywords(query) {
  if (!query) return "ambiguous";

  const normalizedQuery = query.toLowerCase().trim();

  const movieKeywords = {
    strong: [
      /\bmovie(s)?\b/,
      /\bfilm(s)?\b/,
      /\bcinema\b/,
      /\bfeature\b/,
      /\bmotion picture\b/,
    ],
    medium: [
      /\bdirector\b/,
      /\bscreenplay\b/,
      /\bboxoffice\b/,
      /\btheater\b/,
      /\btheatre\b/,
      /\bcinematic\b/,
    ],
    weak: [
      /\bwatch\b/,
      /\bactor\b/,
      /\bactress\b/,
      /\bscreenwriter\b/,
      /\bproducer\b/,
    ],
  };

  const seriesKeywords = {
    strong: [
      /\bseries\b/,
      /\btv show(s)?\b/,
      /\btelevision\b/,
      /\bshow(s)?\b/,
      /\bepisode(s)?\b/,
      /\bseason(s)?\b/,
      /\bdocumentary?\b/,
      /\bdocumentaries?\b/,
    ],
    medium: [
      /\bnetflix\b/,
      /\bhbo\b/,
      /\bhulu\b/,
      /\bamazon prime\b/,
      /\bdisney\+\b/,
      /\bapple tv\+\b/,
      /\bpilot\b/,
      /\bfinale\b/,
    ],
    weak: [
      /\bcharacter\b/,
      /\bcast\b/,
      /\bplot\b/,
      /\bstoryline\b/,
      /\bnarrative\b/,
    ],
  };

  let movieScore = 0;
  let seriesScore = 0;

  for (const pattern of movieKeywords.strong) {
    if (pattern.test(normalizedQuery)) movieScore += 3;
  }

  for (const pattern of movieKeywords.medium) {
    if (pattern.test(normalizedQuery)) movieScore += 2;
  }

  for (const pattern of movieKeywords.weak) {
    if (pattern.test(normalizedQuery)) movieScore += 1;
  }

  for (const pattern of seriesKeywords.strong) {
    if (pattern.test(normalizedQuery)) seriesScore += 3;
  }

  for (const pattern of seriesKeywords.medium) {
    if (pattern.test(normalizedQuery)) seriesScore += 2;
  }

  for (const pattern of seriesKeywords.weak) {
    if (pattern.test(normalizedQuery)) seriesScore += 1;
  }

  if (/\b(netflix|hulu|hbo|disney\+|apple tv\+)\b/.test(normalizedQuery)) {
    seriesScore += 1;
  }

  if (/\b(cinema|theatrical|box office|imax)\b/.test(normalizedQuery)) {
    movieScore += 1;
  }

  if (/\b\d{4}-\d{4}\b/.test(normalizedQuery)) {
    seriesScore += 1;
  }

  logger.debug("Intent detection scores", {
    query: normalizedQuery,
    movieScore,
    seriesScore,
    difference: Math.abs(movieScore - seriesScore),
  });

  const scoreDifference = Math.abs(movieScore - seriesScore);
  const scoreThreshold = 2;

  if (scoreDifference < scoreThreshold) {
    return "ambiguous";
  } else if (movieScore > seriesScore) {
    return "movie";
  } else {
    return "series";
  }
}

function extractGenreCriteria(query) {
  const q = query.toLowerCase();

  const basicGenres = {
    action: /\b(action)\b/i,
    comedy: /\b(comedy|comedies|funny)\b/i,
    drama: /\b(drama|dramas|dramatic)\b/i,
    horror: /\b(horror|scary|frightening)\b/i,
    thriller: /\b(thriller|thrillers|suspense)\b/i,
    romance: /\b(romance|romantic|love)\b/i,
    scifi: /\b(sci-?fi|science\s*fiction)\b/i,
    fantasy: /\b(fantasy|magical)\b/i,
    documentary: /\b(documentary|documentaries)\b/i,
    animation: /\b(animation|animations|animated|anime)\b/i,
    adventure: /\b(adventure|adventures)\b/i,
    crime: /\b(crime|criminal|detective|detectives)\b/i,
    mystery: /\b(mystery|mysteries|detective|detectives)\b/i,
    family: /\b(family|kid-friendly|children|childrens)\b/i,
    biography: /\b(biography|biopic|biographical|biopics)\b/i,
    history: /\b(history|historical)\b/i,
    gore: /\b(gore|gory|bloody)\b/i,
    // TV specific genres
    reality: /\b(reality|realty)\s*(tv|show|series)?\b/i,
    "talk show": /\b(talk\s*show|talk\s*series)\b/i,
    soap: /\b(soap\s*opera?|soap\s*series|soap)\b/i,
    news: /\b(news|newscast|news\s*program)\b/i,
    kids: /\b(kids?|children|childrens|youth)\b/i,
  };

  const subGenres = {
    cyberpunk: /\b(cyberpunk|cyber\s*punk)\b/i,
    noir: /\b(noir|neo-noir)\b/i,
    psychological: /\b(psychological)\b/i,
    superhero: /\b(superhero|comic\s*book|marvel|dc)\b/i,
    musical: /\b(musical|music)\b/i,
    war: /\b(war|military)\b/i,
    western: /\b(western|cowboy)\b/i,
    sports: /\b(sports?|athletic)\b/i,
  };

  const moods = {
    feelGood: /\b(feel-?good|uplifting|heartwarming)\b/i,
    dark: /\b(dark|gritty|disturbing)\b/i,
    thoughtProvoking: /\b(thought-?provoking|philosophical|deep)\b/i,
    intense: /\b(intense|gripping|edge.*seat)\b/i,
    lighthearted: /\b(light-?hearted|fun|cheerful)\b/i,
  };

  // Create a set of all supported genres for quick lookup
  const supportedGenres = new Set([
    ...Object.keys(basicGenres),
    ...Object.keys(subGenres),
  ]);

  // Add common genre aliases that might appear in exclusions
  const genreAliases = {
    "sci-fi": "scifi",
    "science fiction": "scifi",
    "rom-com": "comedy",
    "romantic comedy": "comedy",
    "rom com": "comedy",
    "super hero": "superhero",
    "super-hero": "superhero",
  };

  // Add aliases to supported genres
  Object.keys(genreAliases).forEach((alias) => {
    supportedGenres.add(alias);
  });

  const combinedPattern =
    /(?:action[- ]comedy|romantic[- ]comedy|sci-?fi[- ]horror|dark[- ]comedy|romantic[- ]thriller)/i;

  // First, find all negated genres
  const notPattern = /\b(?:not|no|except|excluding)\s+(\w+(?:\s+\w+)?)/gi;
  const excludedGenres = new Set();
  let match;
  while ((match = notPattern.exec(q)) !== null) {
    const negatedTerm = match[1].toLowerCase().trim();
    // Check if it's a direct genre or has an alias
    if (supportedGenres.has(negatedTerm)) {
      excludedGenres.add(genreAliases[negatedTerm] || negatedTerm);
    } else {
      // Check against genre patterns
      for (const [genre, pattern] of Object.entries(basicGenres)) {
        if (pattern.test(negatedTerm)) {
          excludedGenres.add(genre);
          break;
        }
      }
      for (const [genre, pattern] of Object.entries(subGenres)) {
        if (pattern.test(negatedTerm)) {
          excludedGenres.add(genre);
          break;
        }
      }
    }
  }

  const genres = {
    include: [],
    exclude: Array.from(excludedGenres),
    mood: [],
    style: [],
  };

  // Handle combined genres
  const combinedMatch = q.match(combinedPattern);
  if (combinedMatch) {
    genres.include.push(combinedMatch[0].toLowerCase().replace(/\s+/g, "-"));
  }

  // After processing exclusions, check for genres to include
  // but make sure they're not in the excluded set
  for (const [genre, pattern] of Object.entries(basicGenres)) {
    if (pattern.test(q) && !excludedGenres.has(genre)) {
      // Don't include if it appears in a negation context
      const genreIndex = q.search(pattern);
      const beforeGenre = q.substring(0, genreIndex);
      if (!beforeGenre.match(/\b(not|no|except|excluding)\s+$/)) {
        genres.include.push(genre);
      }
    }
  }

  for (const [subgenre, pattern] of Object.entries(subGenres)) {
    if (pattern.test(q) && !excludedGenres.has(subgenre)) {
      // Don't include if it appears in a negation context
      const genreIndex = q.search(pattern);
      const beforeGenre = q.substring(0, genreIndex);
      if (!beforeGenre.match(/\b(not|no|except|excluding)\s+$/)) {
        genres.include.push(subgenre);
      }
    }
  }

  for (const [mood, pattern] of Object.entries(moods)) {
    if (pattern.test(q)) {
      genres.mood.push(mood);
    }
  }

  return Object.values(genres).some((arr) => arr.length > 0) ? genres : null;
}

// Add this function to better detect recommendation queries
function isRecommendationQuery(query) {
  return query.toLowerCase().trim().startsWith("recommend");
}

/**
 * Checks if an item is in the user's watch history or rated items
 * @param {Object} item - The item to check
 * @param {Array} watchHistory - The user's watch history from Trakt
 * @param {Array} ratedItems - The user's rated items from Trakt
 * @returns {boolean} - True if the item is in the watch history or rated items
 */
function isItemWatchedOrRated(item, watchHistory, ratedItems) {
  if (!item) {
    return false;
  }

  // Normalize the item name for comparison
  const normalizedName = item.name.toLowerCase().trim();
  const itemYear = parseInt(item.year);

  // Debug logging for specific items (uncomment for troubleshooting)
  // if (normalizedName.includes("specific movie title")) {
  //   logger.debug("Checking specific item", {
  //     item: { name: item.name, year: item.year },
  //     watchHistoryCount: watchHistory?.length || 0,
  //     ratedItemsCount: ratedItems?.length || 0
  //   });
  // }

  // Check if the item exists in watch history
  const isWatched =
    watchHistory &&
    watchHistory.length > 0 &&
    watchHistory.some((historyItem) => {
      const media = historyItem.movie || historyItem.show;
      if (!media) return false;

      const historyName = media.title.toLowerCase().trim();
      const historyYear = parseInt(media.year);

      const isMatch =
        normalizedName === historyName &&
        (!itemYear || !historyYear || itemYear === historyYear);

      // Debug logging for specific items (uncomment for troubleshooting)
      // if (normalizedName.includes("specific movie title") && isMatch) {
      //   logger.debug("Found match in watch history", {
      //     recommendation: { name: item.name, year: item.year },
      //     watchedItem: { title: media.title, year: media.year }
      //   });
      // }

      return isMatch;
    });

  // Check if the item exists in rated items
  const isRated =
    ratedItems &&
    ratedItems.length > 0 &&
    ratedItems.some((ratedItem) => {
      const media = ratedItem.movie || ratedItem.show;
      if (!media) return false;

      const ratedName = media.title.toLowerCase().trim();
      const ratedYear = parseInt(media.year);

      const isMatch =
        normalizedName === ratedName &&
        (!itemYear || !ratedYear || itemYear === ratedYear);

      // Debug logging for specific items (uncomment for troubleshooting)
      // if (normalizedName.includes("specific movie title") && isMatch) {
      //   logger.debug("Found match in rated items", {
      //     recommendation: { name: item.name, year: item.year },
      //     ratedItem: { title: media.title, year: media.year, rating: ratedItem.rating }
      //   });
      // }

      return isMatch;
    });

  return isWatched || isRated;
}

async function getAIRecommendations(query, type, geminiKey, config) {
  const startTime = Date.now();
  const currentYear = new Date().getFullYear();
  // Limit numResults to a maximum of 25
  let numResults = config?.numResults || 20;
  if (numResults > 25) {
    numResults = MAX_AI_RECOMMENDATIONS;
  }
  const enableAiCache =
    config?.EnableAiCache !== undefined ? config.EnableAiCache : true;
  const geminiModel = config?.GeminiModel || DEFAULT_GEMINI_MODEL;
  const language = config?.TmdbLanguage || "en-US";
  const traktClientId = DEFAULT_TRAKT_CLIENT_ID;
  const traktAccessToken = config?.TraktAccessToken;

  logger.debug("Starting AI recommendations", {
    query,
    type,
    requestedResults: numResults,
    cacheEnabled: enableAiCache,
    model: geminiModel,
    hasTraktConfig: !!(traktClientId && traktAccessToken),
  });

  // Check if it's a recommendation query
  const isRecommendation = isRecommendationQuery(query);
  let traktData = null;
  let discoveredType = type;
  let discoveredGenres = [];
  let filteredTraktData = null;

  // For recommendation queries, use the new workflow with type and genre discovery
  if (isRecommendation) {
    // First, make the genre and type discovery API call
    const discoveryResult = await discoverTypeAndGenres(
      query,
      geminiKey,
      geminiModel
    );
    discoveredType = discoveryResult.type;
    discoveredGenres = discoveryResult.genres;

    logger.info("Genre and type discovery results", {
      query,
      discoveredType,
      discoveredGenres,
      originalType: type,
    });

    // If the discovered type is specific (not ambiguous) and doesn't match the requested type,
    // return empty results, similar to how regular searches handle intent mismatches
    if (discoveredType !== "ambiguous" && discoveredType !== type) {
      logger.debug("Recommendation intent mismatch - returning empty results", {
        discoveredType,
        requestedType: type,
        query,
        message: `This recommendation appears to be for ${discoveredType}, not ${type}`,
      });
      return {
        recommendations: {
          movies: type === "movie" ? [] : undefined,
          series: type === "series" ? [] : undefined,
        },
        fromCache: false,
      };
    }

    // If Trakt is configured, get user data ONLY for recommendation queries
    if (traktClientId && traktAccessToken) {
      logger.info("Fetching Trakt data for recommendation query", {
        hasTraktClientId: !!traktClientId,
        traktClientIdLength: traktClientId?.length,
        hasTraktAccessToken: !!traktAccessToken,
        traktAccessTokenLength: traktAccessToken?.length,
        isRecommendation: isRecommendation,
        query: query,
      });

      traktData = await fetchTraktWatchedAndRated(
        traktClientId,
        traktAccessToken,
        type === "movie" ? "movies" : "shows",
        config
      );

      // Filter Trakt data based on discovered genres
      if (traktData && discoveredGenres.length > 0) {
        filteredTraktData = filterTraktDataByGenres(
          traktData,
          discoveredGenres
        );

        logger.info("Filtered Trakt data by genres", {
          genres: discoveredGenres,
          recentlyWatchedCount: filteredTraktData.recentlyWatched.length,
          highlyRatedCount: filteredTraktData.highlyRated.length,
          lowRatedCount: filteredTraktData.lowRated.length,
        });
      } else {
        // If no specific genres are discovered, use all Trakt data
        filteredTraktData = traktData;
        logger.info(
          "Using all Trakt data as no specific genres are discovered"
        );
      }
    }
  }

  const cacheKey = `${query}_${type}_${traktData ? "trakt" : "no_trakt"}`;

  // Only check cache if there's no Trakt data or if it's not a recommendation query
  if (enableAiCache && !traktData && aiRecommendationsCache.has(cacheKey)) {
    const cached = aiRecommendationsCache.get(cacheKey);

    logger.info("AI recommendations cache hit", {
      cacheKey,
      query,
      type,
      model: geminiModel,
      cachedAt: new Date(cached.timestamp).toISOString(),
      age: `${Math.round((Date.now() - cached.timestamp) / 1000)}s`,
      responseTime: `${Date.now() - startTime}ms`,
      cachedConfigNumResults: cached.configNumResults,
      requestedResults: numResults,
      hasMovies: !!cached.data?.recommendations?.movies?.length,
      hasSeries: !!cached.data?.recommendations?.series?.length,
    });

    if (cached.configNumResults && numResults > cached.configNumResults) {
      logger.info("NumResults increased, invalidating cache", {
        oldValue: cached.configNumResults,
        newValue: numResults,
      });
      aiRecommendationsCache.delete(cacheKey);
    } else if (
      !cached.data?.recommendations ||
      (type === "movie" && !cached.data.recommendations.movies) ||
      (type === "series" && !cached.data.recommendations.series)
    ) {
      logger.error("Invalid cached data structure, forcing refresh", {
        type,
        cachedData: cached.data,
      });
      aiRecommendationsCache.delete(cacheKey);
    } else {
      return cached.data;
    }
  }

  if (!enableAiCache) {
    logger.info("AI cache bypassed (disabled in config)", {
      cacheKey,
      query,
      type,
    });
  } else if (traktData) {
    logger.info("AI cache bypassed (using Trakt personalization)", {
      cacheKey,
      query,
      type,
      hasTraktData: true,
    });
  } else {
    logger.info("AI recommendations cache miss", { cacheKey, query, type });
  }

  try {
    const genAI = new GoogleGenerativeAI(geminiKey);
    const model = genAI.getGenerativeModel({ model: geminiModel });
    const genreCriteria = extractGenreCriteria(query);

    let promptText = [
      `You are a ${type} recommendation expert. Analyze this query: "${query}"`,
      "",
      "QUERY ANALYSIS:",
    ];

    // Add query analysis section
    if (isRecommendation && discoveredGenres.length > 0) {
      promptText.push(`Discovered genres: ${discoveredGenres.join(", ")}`);
    } else if (genreCriteria?.include?.length > 0) {
      promptText.push(`Requested genres: ${genreCriteria.include.join(", ")}`);
    }
    if (genreCriteria?.mood?.length > 0) {
      promptText.push(`Mood/Style: ${genreCriteria.mood.join(", ")}`);
    }
    promptText.push("");

    if (traktData) {
      const { preferences } = traktData;

      // For recommendation queries, use the filtered Trakt data
      if (isRecommendation) {
        // If we have filtered Trakt data (specific genres), use it
        // Otherwise, use all Trakt data (when no specific genres are discovered)
        const { recentlyWatched, highlyRated, lowRated } =
          filteredTraktData || {
            recentlyWatched: traktData.watched?.slice(0, 25) || [],
            highlyRated: (traktData.rated || [])
              .filter((item) => item.rating >= 4)
              .slice(0, 25),
            lowRated: (traktData.rated || [])
              .filter((item) => item.rating <= 2)
              .slice(0, 15),
          };

        // Calculate genre overlap if we have discovered genres
        let genreRecommendationStrategy = "";
        if (discoveredGenres.length > 0) {
          const queryGenres = new Set(
            discoveredGenres.map((g) => g.toLowerCase())
          );
          const userGenres = new Set(
            preferences.genres.map((g) => g.genre.toLowerCase())
          );
          const overlap = [...queryGenres].filter((g) => userGenres.has(g));

          // Check if user has watched many movies in the requested genres
          const genreWatchCount = recentlyWatched.filter((item) => {
            const media = item.movie || item.show;
            return (
              media.genres &&
              media.genres.some((g) => queryGenres.has(g.toLowerCase()))
            );
          }).length;

          const hasWatchedManyInGenre = genreWatchCount > 10;

          if (overlap.length > 0) {
            if (hasWatchedManyInGenre) {
              genreRecommendationStrategy =
                "The user has watched many movies in the requested genres and these genres match their preferences. " +
                "Focus on finding less obvious, unique, or newer titles in these genres that they might have missed. " +
                "Consider acclaimed international films, indie gems, or cult classics that fit the genre requirements.";
            } else {
              genreRecommendationStrategy =
                "Since the requested genres match some of the user's preferred genres, " +
                "prioritize recommendations that combine these interests while maintaining the specific genre requirements.";
            }
          } else {
            genreRecommendationStrategy =
              "Although the requested genres differ from the user's usual preferences, " +
              "try to find high-quality recommendations that might bridge their interests with the requested genres.";
          }
        }

        promptText.push(
          "USER'S WATCH HISTORY AND PREFERENCES (FILTERED BY RELEVANT GENRES):",
          ""
        );

        if (recentlyWatched.length > 0) {
          promptText.push(
            "Recently watched in these genres:",
            recentlyWatched
              .slice(0, 25)
              .map((item) => {
                const media = item.movie || item.show;
                return `- ${media.title} (${media.year}) - ${
                  media.genres?.join(", ") || "N/A"
                }`;
              })
              .join("\n")
          );
          promptText.push("");
        }

        if (highlyRated.length > 0) {
          promptText.push(
            "Highly rated (4-5 stars) in these genres:",
            highlyRated
              .slice(0, 25)
              .map((item) => {
                const media = item.movie || item.show;
                return `- ${media.title} (${item.rating}/5) - ${
                  media.genres?.join(", ") || "N/A"
                }`;
              })
              .join("\n")
          );
          promptText.push("");
        }

        if (lowRated.length > 0) {
          promptText.push(
            "Low rated (1-2 stars) in these genres:",
            lowRated
              .slice(0, 15)
              .map((item) => {
                const media = item.movie || item.show;
                return `- ${media.title} (${item.rating}/5) - ${
                  media.genres?.join(", ") || "N/A"
                }`;
              })
              .join("\n")
          );
          promptText.push("");
        }

        // Only include top genres if the user isn't already searching for specific genres
        if (discoveredGenres.length === 0) {
          promptText.push(
            "Top genres:",
            preferences.genres
              .map((g) => `- ${g.genre} (Score: ${g.count.toFixed(2)})`)
              .join("\n"),
            ""
          );
        }

        promptText.push(
          "Favorite actors:",
          preferences.actors
            .map((a) => `- ${a.actor} (Score: ${a.count.toFixed(2)})`)
            .join("\n"),
          "",
          "Preferred directors:",
          preferences.directors
            .map((d) => `- ${d.director} (Score: ${d.count.toFixed(2)})`)
            .join("\n"),
          "",
          preferences.yearRange
            ? `User tends to watch content from ${preferences.yearRange.start} to ${preferences.yearRange.end}, with a preference for ${preferences.yearRange.preferred}`
            : "",
          "",
          "RECOMMENDATION STRATEGY:",
          genreRecommendationStrategy ||
            "Balance user preferences with query requirements",
          "1. Focus on the specific requirements from the query (genres, time period, mood)",
          "2. Use user's preferences to refine choices within those requirements",
          "3. Consider their rating patterns to gauge quality preferences",
          "4. Prioritize movies with preferred actors/directors when relevant",
          "5. Include some variety while staying within the requested criteria",
          "6. For genre-specific queries, prioritize acclaimed or popular movies in that genre that the user hasn't seen",
          "7. Include a mix of well-known classics and hidden gems in the requested genre",
          "8. If the user has watched many movies in the requested genre, look for similar but less obvious choices",
          ""
        );
      }
    }

    promptText = promptText.concat([
      "IMPORTANT INSTRUCTIONS:",
      `- Current year is ${currentYear}. For time-based queries:`,
      `  * 'past year' means movies from ${currentYear - 1} to ${currentYear}`,
      `  * 'recent' means within the last 2-3 years (${
        currentYear - 2
      } to ${currentYear})`,
      `  * 'new' or 'latest' means released in ${currentYear}`,
      "- If this query appears to be for a specific movie (like 'The Matrix', 'Inception'), return only that exact movie and its sequels/prequels if they exist in chronological order.",
      "- If this query is for movies from a specific franchise (like 'Mission Impossible movies, James Bond movies'), list the official entries in that franchise in chronological order.",
      "- If this query is for an actor's filmography (like 'Tom Cruise movies'), list diverse notable films featuring that actor.",
      "- For all other queries, provide diverse recommendations that best match the query.",
      "- Order your recommendations in the most appropriate way for the query (by relevance, popularity, quality, or other criteria that makes sense).",
      "",
      "CRITICAL REQUIREMENTS:",
      `- DO NOT recommend any movies that appear in the user's watch history or ratings above.`,
      `- Recommend movies that are SIMILAR to the user's highly rated movies but NOT THE SAME ones.`,
      `- You MUST return exactly ${numResults} ${type} recommendations. If you can't find enough perfect matches, broaden your criteria while staying within the genre/theme requirements.`,
      `- Prioritize quality over exact matching - it's better to recommend a great movie that's somewhat related than a mediocre movie that perfectly matches all criteria.`,
      `- If the user has watched many movies in the requested genre, consider recommending lesser-known gems, international films, or recent releases they might have missed.`,
      "",
      "FORMAT:",
      "type|name|year",
      "OR",
      "type|name (year)",
      "",
      "EXAMPLES:",
      `${type}|The Matrix|1999`,
      `${type}|The Matrix (1999)`,
      "",
      "RULES:",
      "- Use | separator",
      "- Year: YYYY format (either as separate field or in parentheses)",
      `- Type: Hardcode to "${type}"`,
      "- Only best matches that strictly match ALL query requirements",
      "- If specific genres/time periods are requested, ALL recommendations must match those criteria",
    ]);

    if (genreCriteria) {
      if (genreCriteria.include.length > 0) {
        promptText.push(
          `- Must match genres: ${genreCriteria.include.join(", ")}`
        );
      }
      if (genreCriteria.exclude.length > 0) {
        promptText.push(
          `- Exclude genres: ${genreCriteria.exclude.join(", ")}`
        );
      }
      if (genreCriteria.mood.length > 0) {
        promptText.push(`- Match mood/style: ${genreCriteria.mood.join(", ")}`);
      }
    }

    promptText = promptText.join("\n");

    logger.info("Making Gemini API call", {
      model: geminiModel,
      query,
      type,
      prompt: promptText,
      genreCriteria,
      numResults,
    });

    // Use withRetry for the Gemini API call
    const text = await withRetry(
      async () => {
        try {
          const aiResult = await model.generateContent(promptText);
          const response = await aiResult.response;
          const responseText = response.text().trim();

          // Log successful response
          logger.info("Gemini API response", {
            duration: `${Date.now() - startTime}ms`,
            promptTokens: aiResult.promptFeedback?.tokenCount,
            candidates: aiResult.candidates?.length,
            safetyRatings: aiResult.candidates?.[0]?.safetyRatings,
            responseTextLength: responseText.length,
            responseTextSample:
              responseText.substring(0, 100) +
              (responseText.length > 100 ? "..." : ""),
          });

          return responseText;
        } catch (error) {
          // Enhance error with status for retry logic
          logger.error("Gemini API call failed", {
            error: error.message,
            status: error.httpStatus || 500,
            stack: error.stack,
          });
          error.status = error.httpStatus || 500;
          throw error;
        }
      },
      {
        maxRetries: 3,
        initialDelay: 2000,
        maxDelay: 10000,
        // Don't retry 400 errors (bad requests)
        shouldRetry: (error) => !error.status || error.status !== 400,
        operationName: "Gemini API call",
      }
    );

    // Process the response text
    const lines = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("type|"));

    logger.debug("Parsed recommendation lines", {
      totalLines: text.split("\n").length,
      validLines: lines.length,
    });

    const recommendations = {
      movies: type === "movie" ? [] : undefined,
      series: type === "series" ? [] : undefined,
    };

    let validRecommendations = 0;
    let invalidLines = 0;

    for (const line of lines) {
      try {
        const parts = line.split("|");

        let lineType, name, year;

        if (parts.length === 3) {
          [lineType, name, year] = parts.map((s) => s.trim());
        } else if (parts.length === 2) {
          lineType = parts[0].trim();
          const nameWithYear = parts[1].trim();

          const yearMatch = nameWithYear.match(/\((\d{4})\)$/);
          if (yearMatch) {
            year = yearMatch[1];
            name = nameWithYear
              .substring(0, nameWithYear.lastIndexOf("("))
              .trim();
          } else {
            const anyYearMatch = nameWithYear.match(/\b(19\d{2}|20\d{2})\b/);
            if (anyYearMatch) {
              year = anyYearMatch[1];
              name = nameWithYear.replace(anyYearMatch[0], "").trim();
            } else {
              logger.debug("Missing year in recommendation", { nameWithYear });
              invalidLines++;
              continue;
            }
          }
        } else {
          logger.debug("Invalid recommendation format", { line });
          invalidLines++;
          continue;
        }

        const yearNum = parseInt(year);

        if (!lineType || !name || isNaN(yearNum)) {
          logger.debug("Invalid recommendation data", {
            lineType,
            name,
            year,
            isValidYear: !isNaN(yearNum),
          });
          invalidLines++;
          continue;
        }

        if (lineType === type && name && yearNum) {
          const item = {
            name,
            year: yearNum,
            type,
            id: `ai_${type}_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
          };

          if (type === "movie") recommendations.movies.push(item);
          else if (type === "series") recommendations.series.push(item);

          validRecommendations++;
        }
      } catch (error) {
        logger.error("Error processing recommendation line", {
          line,
          error: error.message,
        });
        invalidLines++;
      }
    }

    logger.info("Recommendation processing complete", {
      validRecommendations,
      invalidLines,
      totalProcessed: lines.length,
    });

    const finalResult = {
      recommendations,
      fromCache: false,
    };

    // Filter out watched items if we have Trakt data and this is a recommendation query
    if (traktData && isRecommendation) {
      const watchHistory = traktData.watched.concat(traktData.history || []);

      // Log a summary of the user's watched and rated items for validation
      const watchedSummary = watchHistory.slice(0, 20).map((item) => {
        const media = item.movie || item.show;
        return {
          title: media.title,
          year: media.year,
          type: item.movie ? "movie" : "show",
        };
      });

      const ratedSummary = traktData.rated.slice(0, 20).map((item) => {
        const media = item.movie || item.show;
        return {
          title: media.title,
          year: media.year,
          rating: item.rating,
          type: item.movie ? "movie" : "show",
        };
      });

      logger.info("User's watch history and ratings (for validation)", {
        totalWatched: watchHistory.length,
        totalRated: traktData.rated.length,
        watchedSample: watchedSummary,
        ratedSample: ratedSummary,
      });

      // Filter out watched and rated items from recommendations
      if (finalResult.recommendations.movies) {
        // Get the list of movies before filtering
        const allMovies = [...finalResult.recommendations.movies];

        const unwatchedMovies = finalResult.recommendations.movies.filter(
          (movie) => !isItemWatchedOrRated(movie, watchHistory, traktData.rated)
        );

        // Find which movies were filtered out
        const filteredMovies = allMovies.filter(
          (movie) =>
            !unwatchedMovies.some(
              (unwatched) =>
                unwatched.name === movie.name && unwatched.year === movie.year
            )
        );

        logger.info(
          "Filtered out watched and rated movies from recommendations",
          {
            totalRecommendations: finalResult.recommendations.movies.length,
            unwatchedCount: unwatchedMovies.length,
            filteredCount:
              finalResult.recommendations.movies.length -
              unwatchedMovies.length,
            filteredMovies: filteredMovies.map((movie) => ({
              title: movie.name,
              year: movie.year,
            })),
          }
        );

        finalResult.recommendations.movies = unwatchedMovies;
      }

      if (finalResult.recommendations.series) {
        // Get the list of series before filtering
        const allSeries = [...finalResult.recommendations.series];

        const unwatchedSeries = finalResult.recommendations.series.filter(
          (series) =>
            !isItemWatchedOrRated(series, watchHistory, traktData.rated)
        );

        // Find which series were filtered out
        const filteredSeries = allSeries.filter(
          (series) =>
            !unwatchedSeries.some(
              (unwatched) =>
                unwatched.name === series.name && unwatched.year === series.year
            )
        );

        logger.info(
          "Filtered out watched and rated series from recommendations",
          {
            totalRecommendations: finalResult.recommendations.series.length,
            unwatchedCount: unwatchedSeries.length,
            filteredCount:
              finalResult.recommendations.series.length -
              unwatchedSeries.length,
            filteredSeries: filteredSeries.map((series) => ({
              title: series.name,
              year: series.year,
            })),
          }
        );

        finalResult.recommendations.series = unwatchedSeries;
      }
    }

    // Only cache if there's no Trakt data (not user-specific)
    if (!traktData) {
      aiRecommendationsCache.set(cacheKey, {
        timestamp: Date.now(),
        data: finalResult,
        configNumResults: numResults,
      });

      if (enableAiCache) {
        logger.debug("AI recommendations result cached and used", {
          cacheKey,
          duration: Date.now() - startTime,
          query,
          type,
          numResults,
        });
      } else {
        logger.debug(
          "AI recommendations result cached but not used (caching disabled for this user)",
          {
            cacheKey,
            duration: Date.now() - startTime,
            query,
            type,
            numResults,
          }
        );
      }
    } else {
      logger.debug(
        "AI recommendations with Trakt data not cached (user-specific)",
        {
          duration: Date.now() - startTime,
          query,
          type,
          numResults,
          hasTraktData: true,
        }
      );
    }

    return finalResult;
  } catch (error) {
    logger.error("Gemini API Error:", {
      error: error.message,
      stack: error.stack,
      params: { query, type, geminiKeyLength: geminiKey?.length },
    });
    return {
      recommendations: {
        movies: type === "movie" ? [] : undefined,
        series: type === "series" ? [] : undefined,
      },
    };
  }
}

async function fetchRpdbPoster(
  imdbId,
  rpdbKey,
  posterType = "poster-default",
  isTier0User = false
) {
  if (!imdbId || !rpdbKey) {
    return null;
  }

  const cacheKey = `rpdb_${imdbId}_${posterType}`;
  const userTier = getRpdbTierFromApiKey(rpdbKey);
  const isDefaultKey = rpdbKey === DEFAULT_RPDB_KEY;
  const keyType = isDefaultKey ? "default" : "user";

  if (isTier0User && rpdbCache.has(cacheKey)) {
    const cached = rpdbCache.get(cacheKey);
    logger.info("RPDB poster cache hit", {
      cacheKey,
      imdbId,
      posterType,
      cachedAt: new Date(cached.timestamp).toISOString(),
      age: `${Math.round((Date.now() - cached.timestamp) / 1000)}s`,
      userTier: isDefaultKey
        ? "default-key"
        : userTier === 0
        ? "tier0"
        : `tier${userTier}`,
      keyType: keyType,
      cacheAccess: "enabled",
    });
    return cached.data;
  }

  if (!isTier0User) {
    logger.info("RPDB poster cache skipped (non-tier 0 user)", {
      imdbId,
      posterType,
      userTier: isDefaultKey
        ? "default-key"
        : userTier === 0
        ? "tier0"
        : `tier${userTier}`,
      keyType: keyType,
      cacheAccess: "disabled",
      apiKeyPrefix: rpdbKey.substring(0, 4) + "...",
    });
  } else {
    logger.info("RPDB poster cache miss", {
      cacheKey,
      imdbId,
      posterType,
      userTier: isDefaultKey ? "default-key" : "tier0",
      keyType: keyType,
      cacheAccess: "enabled",
      apiKeyPrefix: rpdbKey.substring(0, 4) + "...",
    });
  }

  try {
    const url = `https://api.ratingposterdb.com/${rpdbKey}/imdb/${posterType}/${imdbId}.jpg`;

    logger.info("Making RPDB API call", {
      imdbId,
      posterType,
      url: url.replace(rpdbKey, "***"),
      userTier: isDefaultKey
        ? "default-key"
        : userTier === 0
        ? "tier0"
        : `tier${userTier}`,
      keyType: keyType,
      cacheAccess: isTier0User ? "enabled" : "disabled",
    });
    const posterUrl = await withRetry(
      async () => {
        const response = await fetch(url);
        if (response.status === 404) {
          if (isTier0User) {
            rpdbCache.set(cacheKey, {
              timestamp: Date.now(),
              data: null,
            });
          }
          return null;
        }

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
        shouldRetry: (error) =>
          error.status !== 404 && (!error.status || error.status >= 500),
        operationName: "RPDB poster API call",
      }
    );
    if (isTier0User) {
      rpdbCache.set(cacheKey, {
        timestamp: Date.now(),
        data: posterUrl,
      });
      logger.debug("RPDB poster result cached", {
        cacheKey,
        imdbId,
        posterType,
        found: !!posterUrl,
        userTier: "tier0",
      });
    }

    return posterUrl;
  } catch (error) {
    logger.error("RPDB API Error:", {
      error: error.message,
      stack: error.stack,
      imdbId,
      posterType,
    });
    return null;
  }
}

async function toStremioMeta(
  item,
  platform = "unknown",
  tmdbKey,
  rpdbKey,
  rpdbPosterType = "poster-default",
  language = "en-US",
  config,
  apiFailures = null
) {
  if (!item.id || !item.name) {
    return null;
  }

  const type = item.type || (item.id.includes("movie") ? "movie" : "series");

  const enableRpdb =
    config?.EnableRpdb !== undefined ? config.EnableRpdb : false;
  const userRpdbKey = config?.RpdbApiKey;
  const usingUserKey = !!userRpdbKey;
  const usingDefaultKey = !userRpdbKey && !!DEFAULT_RPDB_KEY;
  const userTier = usingUserKey ? getRpdbTierFromApiKey(userRpdbKey) : -1;
  const isTier0User = (usingUserKey && userTier === 0) || usingDefaultKey;

  const tmdbData = await searchTMDB(
    item.name,
    type,
    item.year,
    tmdbKey,
    language
  );

  if (!tmdbData || !tmdbData.imdb_id) {
    return null;
  }

  // Start with TMDB poster as the default
  let poster = tmdbData.poster;
  let posterSource = "tmdb";

  // Only try RPDB if RPDB is enabled AND (a user key is provided OR a default key exists)
  const effectiveRpdbKey = userRpdbKey || DEFAULT_RPDB_KEY;
  if (enableRpdb && effectiveRpdbKey && tmdbData.imdb_id) {
    try {
      const rpdbPoster = await fetchRpdbPoster(
        tmdbData.imdb_id,
        effectiveRpdbKey,
        rpdbPosterType,
        isTier0User
      );
      if (rpdbPoster) {
        poster = rpdbPoster;
        posterSource = "rpdb";
        logger.debug("Using RPDB poster", {
          imdbId: tmdbData.imdb_id,
          posterType: rpdbPosterType,
          poster: rpdbPoster,
          userTier: usingUserKey
            ? userTier === 0
              ? "tier0"
              : `tier${userTier}`
            : "default-key",
          isTier0User: isTier0User,
          keyType: usingUserKey ? "user" : "default",
        });
      } else {
        logger.debug("No RPDB poster available, using TMDB poster", {
          imdbId: tmdbData.imdb_id,
          tmdbPoster: poster ? "available" : "unavailable",
          userTier: usingUserKey
            ? userTier === 0
              ? "tier0"
              : `tier${userTier}`
            : "default-key",
          isTier0User: isTier0User,
          keyType: usingUserKey ? "user" : "default",
        });
      }
    } catch (error) {
      // Track RPDB failure for warning if RPDB was enabled and expected to work
      if (apiFailures && enableRpdb && effectiveRpdbKey && userRpdbKey) {
        // Only track failures for user-provided keys, not default keys
        const existingRpdbFailure = apiFailures.find(
          (f) => f.service === "RPDB"
        );
        if (!existingRpdbFailure) {
          apiFailures.push({
            service: "RPDB",
            message:
              "RPDB high-quality posters failed to load. Check your RPDB API key. Using standard TMDB posters instead.",
            fallback: "TMDB posters",
          });
        }
      }

      logger.debug("RPDB poster fetch failed, using TMDB poster", {
        imdbId: tmdbData.imdb_id,
        error: error.message,
        tmdbPoster: poster ? "available" : "unavailable",
        userTier: usingUserKey
          ? userTier === 0
            ? "tier0"
            : `tier${userTier}`
          : "default-key",
        isTier0User: isTier0User,
        keyType: usingUserKey ? "user" : "default",
      });
    }
  }

  if (!poster) {
    logger.debug("No poster available from either source", {
      title: item.name,
      year: item.year,
      imdbId: tmdbData.imdb_id,
    });
    return null;
  }

  const meta = {
    id: tmdbData.imdb_id,
    type: type,
    name: tmdbData.title || tmdbData.name,
    description:
      platform === "android-tv"
        ? (tmdbData.overview || "").slice(0, 200)
        : tmdbData.overview || "",
    year: parseInt(item.year) || 0,
    poster:
      platform === "android-tv" && poster.includes("/w500/")
        ? poster.replace("/w500/", "/w342/")
        : poster,
    background: tmdbData.backdrop,
    posterShape: "regular",
    posterSource,
  };

  if (tmdbData.genres && tmdbData.genres.length > 0) {
    meta.genres = tmdbData.genres
      .map((id) => (type === "series" ? TMDB_TV_GENRES[id] : TMDB_GENRES[id]))
      .filter(Boolean);
  }

  return meta;
}

function detectPlatform(extra = {}) {
  if (extra.headers?.["stremio-platform"]) {
    return extra.headers["stremio-platform"];
  }

  const userAgent = (
    extra.userAgent ||
    extra.headers?.["stremio-user-agent"] ||
    ""
  ).toLowerCase();

  if (
    userAgent.includes("android tv") ||
    userAgent.includes("chromecast") ||
    userAgent.includes("androidtv")
  ) {
    return "android-tv";
  }

  if (
    userAgent.includes("android") ||
    userAgent.includes("mobile") ||
    userAgent.includes("phone")
  ) {
    return "mobile";
  }

  if (
    userAgent.includes("windows") ||
    userAgent.includes("macintosh") ||
    userAgent.includes("linux")
  ) {
    return "desktop";
  }

  return "unknown";
}

function createDynamicErrorPoster(message, type) {
  // Helper function to wrap text within a specified width
  function wrapText(text, maxLength) {
    const words = text.split(" ");
    const lines = [];
    let currentLine = "";

    for (const word of words) {
      if ((currentLine + word).length <= maxLength) {
        currentLine += (currentLine ? " " : "") + word;
      } else {
        if (currentLine) lines.push(currentLine);
        currentLine = word;
      }
    }
    if (currentLine) lines.push(currentLine);
    return lines;
  }

  // Determine colors and icon based on type
  let primaryColor, iconColor, iconSymbol, title;
  if (type === "error") {
    primaryColor = "#ff4444";
    iconColor = "#ff6666";
    iconSymbol = "⚠";
    title = "ERROR";
  } else if (type === "warning") {
    primaryColor = "#ff8800";
    iconColor = "#ffaa33";
    iconSymbol = "⚠";
    title = "WARNING";
  } else {
    primaryColor = "#888888";
    iconColor = "#aaaaaa";
    iconSymbol = "🔍";
    title = "NO RESULTS";
  }

  // Wrap the message text to fit the poster
  const wrappedLines = wrapText(message, 28); // Adjust character limit as needed
  const maxLines = 8; // Limit to prevent overflow
  const displayLines = wrappedLines.slice(0, maxLines);
  if (wrappedLines.length > maxLines) {
    displayLines[maxLines - 1] += "...";
  }

  // Calculate text positioning
  const lineHeight = 32;
  const startY = 280;

  return `<svg width="500" height="750" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bgGradient" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" style="stop-color:#2a2a2a;stop-opacity:1" />
        <stop offset="100%" style="stop-color:#1a1a1a;stop-opacity:1" />
      </linearGradient>
      <filter id="glow">
        <feGaussianBlur stdDeviation="3" result="coloredBlur"/>
        <feMerge> 
          <feMergeNode in="coloredBlur"/>
          <feMergeNode in="SourceGraphic"/>
        </feMerge>
      </filter>
    </defs>
    
    <!-- Background -->
    <rect width="500" height="750" fill="url(#bgGradient)" stroke="#444" stroke-width="2"/>
    
    <!-- Icon Background Circle -->
    <circle cx="250" cy="120" r="45" fill="${primaryColor}" opacity="0.15"/>
    
    <!-- Icon -->
    <text x="250" y="140" font-family="Arial, sans-serif" font-size="48" font-weight="bold" 
          fill="${iconColor}" text-anchor="middle" filter="url(#glow)">${iconSymbol}</text>
    
    <!-- Title -->
    <text x="250" y="190" font-family="Arial, sans-serif" font-size="24" font-weight="bold" 
          fill="${primaryColor}" text-anchor="middle">${title}</text>
    
    <!-- Main Error Message -->
    ${displayLines
      .map(
        (line, index) =>
          `<text x="250" y="${
            startY + index * lineHeight
          }" font-family="Arial, sans-serif" font-size="20" 
             font-weight="500" fill="#ffffff" text-anchor="middle">${line}</text>`
      )
      .join("")}
    
    <!-- Click for Details Text -->
    <text x="250" y="${
      startY + displayLines.length * lineHeight + 50
    }" font-family="Arial, sans-serif" 
          font-size="14" fill="#cccccc" text-anchor="middle">Click here for details</text>
    
    <!-- Decorative Bottom Line -->
    <line x1="50" y1="680" x2="450" y2="680" stroke="${primaryColor}" stroke-width="2" opacity="0.5"/>
  </svg>`;
}

// Utility functions for error and no-results catalog entries
function createErrorCatalogEntry(
  errorMessage,
  platform = "unknown",
  type = "movie"
) {
  // Create a custom SVG poster with the error message
  const posterSvg = createDynamicErrorPoster(errorMessage, "error");
  const posterDataUrl = `data:image/svg+xml;base64,${Buffer.from(
    posterSvg
  ).toString("base64")}`;

  // Encode the error message in the ID so we can retrieve it later
  const encodedMessage = Buffer.from(errorMessage).toString("base64");
  const timestamp = Date.now();

  return {
    id: `error_${timestamp}_${encodedMessage}`,
    type: type,
    name: "⚠️ Error",
    description: errorMessage,
    poster: posterDataUrl,
    posterShape: "regular",
    background: posterDataUrl,
    releaseInfo: "",
    genres: [],
    imdbRating: "",
    year: new Date().getFullYear(),
    trailers: [],
    runtime: "",
    cast: [],
    director: [],
    writer: [],
    language: "",
    country: "",
    awards: "",
    website: "",
    behaviorHints: {
      defaultVideoId: null,
      hasScheduledVideos: false,
    },
  };
}

function createNoResultsCatalogEntry(
  searchQuery,
  platform = "unknown",
  type = "movie"
) {
  // Create a custom SVG poster with the search query
  const message = `No content found matching "${searchQuery}". Try different keywords or adjust your search.`;
  const posterSvg = createDynamicErrorPoster(message, "no_results");
  const posterDataUrl = `data:image/svg+xml;base64,${Buffer.from(
    posterSvg
  ).toString("base64")}`;

  // Encode the search query in the ID so we can retrieve it later
  const encodedQuery = Buffer.from(searchQuery).toString("base64");
  const timestamp = Date.now();

  return {
    id: `no_results_${timestamp}_${encodedQuery}`,
    type: type,
    name: "🔍 No Results Found",
    description: `No content found matching "${searchQuery}". Try different keywords or adjust your search.`,
    poster: posterDataUrl,
    posterShape: "regular",
    background: posterDataUrl,
    releaseInfo: "",
    genres: [],
    imdbRating: "",
    year: new Date().getFullYear(),
    trailers: [],
    runtime: "",
    cast: [],
    director: [],
    writer: [],
    language: "",
    country: "",
    awards: "",
    website: "",
    behaviorHints: {
      defaultVideoId: null,
      hasScheduledVideos: false,
    },
  };
}

function createWarningCatalogEntry(
  warningMessage,
  platform = "unknown",
  type = "movie"
) {
  // Create a custom SVG poster with the warning message
  const posterSvg = createDynamicErrorPoster(warningMessage, "warning");
  const posterDataUrl = `data:image/svg+xml;base64,${Buffer.from(
    posterSvg
  ).toString("base64")}`;

  // Encode the warning message in the ID so we can retrieve it later
  const encodedMessage = Buffer.from(warningMessage).toString("base64");
  const timestamp = Date.now();

  return {
    id: `warning_${timestamp}_${encodedMessage}`,
    type: type,
    name: "⚠️ Service Warning",
    description: warningMessage,
    poster: posterDataUrl,
    posterShape: "regular",
    background: posterDataUrl,
    releaseInfo: "",
    genres: [],
    imdbRating: "",
    year: new Date().getFullYear(),
    trailers: [],
    runtime: "",
    cast: [],
    director: [],
    writer: [],
    language: "",
    country: "",
    awards: "",
    website: "",
    behaviorHints: {
      defaultVideoId: null,
      hasScheduledVideos: false,
    },
  };
}

const catalogHandler = async function (args, req) {
  const startTime = Date.now();
  const { type, extra } = args;

  // Track API failures for fallback warning entries
  const apiFailures = [];

  try {
    const encryptedConfig = req.stremioConfig;

    if (!encryptedConfig) {
      logger.error("Missing configuration - Please configure the addon first");
      logger.emptyCatalog("Missing configuration", { type, extra });
      const platform = detectPlatform(extra);
      return {
        metas: [
          createErrorCatalogEntry(
            "Please configure the addon with valid API keys first",
            platform,
            type
          ),
        ],
        error: "Please configure the addon with valid API keys first",
      };
    }

    const decryptedConfigStr = decryptConfig(encryptedConfig);
    if (!decryptedConfigStr) {
      logger.error("Invalid configuration - Please reconfigure the addon");
      logger.emptyCatalog("Invalid configuration", { type, extra });
      const platform = detectPlatform(extra);
      return {
        metas: [
          createErrorCatalogEntry(
            "Invalid configuration detected. Please reconfigure the addon.",
            platform,
            type
          ),
        ],
        error: "Invalid configuration detected. Please reconfigure the addon.",
      };
    }

    const configData = JSON.parse(decryptedConfigStr);

    // Log the Trakt configuration
    logger.info("Trakt configuration", {
      hasTraktClientId: !!DEFAULT_TRAKT_CLIENT_ID,
      traktClientIdLength: DEFAULT_TRAKT_CLIENT_ID?.length || 0,
      hasTraktAccessToken: !!configData.TraktAccessToken,
      traktAccessTokenLength: configData.TraktAccessToken?.length || 0,
    });

    const geminiKey = configData.GeminiApiKey;
    const tmdbKey = configData.TmdbApiKey;
    const geminiModel = configData.GeminiModel || DEFAULT_GEMINI_MODEL;
    const language = configData.TmdbLanguage || "en-US";

    if (!geminiKey || geminiKey.length < 10) {
      logger.error("Invalid or missing Gemini API key");
      return {
        metas: [],
        error:
          "Invalid Gemini API key. Please reconfigure the addon with a valid key.",
      };
    }

    if (!tmdbKey || tmdbKey.length < 10) {
      logger.error("Invalid or missing TMDB API key");
      return {
        metas: [],
        error:
          "Invalid TMDB API key. Please reconfigure the addon with a valid key.",
      };
    }

    const rpdbKey = configData.RpdbApiKey || DEFAULT_RPDB_KEY;
    const rpdbPosterType = configData.RpdbPosterType || "poster-default";
    let numResults = parseInt(configData.NumResults) || 20;
    // Limit numResults to a maximum of 25
    if (numResults > 25) {
      numResults = MAX_AI_RECOMMENDATIONS;
    }
    const enableAiCache =
      configData.EnableAiCache !== undefined ? configData.EnableAiCache : true;
    // NEW: Read the EnableRpdb flag
    const enableRpdb =
      configData.EnableRpdb !== undefined ? configData.EnableRpdb : false;

    if (ENABLE_LOGGING) {
      logger.debug("Catalog handler config", {
        numResults,
        rawNumResults: configData.NumResults,
        type,
        hasGeminiKey: !!geminiKey,
        hasTmdbKey: !!tmdbKey,
        hasRpdbKey: !!rpdbKey,
        isDefaultRpdbKey: rpdbKey === DEFAULT_RPDB_KEY,
        rpdbPosterType: rpdbPosterType,
        enableAiCache: enableAiCache,
        enableRpdb: enableRpdb, // Log the new flag
        geminiModel: geminiModel,
        language: language,
        hasTraktClientId: !!DEFAULT_TRAKT_CLIENT_ID,
        hasTraktAccessToken: !!configData.TraktAccessToken,
      });
    }

    if (!geminiKey || !tmdbKey) {
      logger.error("Missing API keys in catalog handler");
      logger.emptyCatalog("Missing API keys", { type, extra });
      const platform = detectPlatform(extra);
      return {
        metas: [
          createErrorCatalogEntry(
            "Missing API keys. Please configure the addon properly.",
            platform,
            type
          ),
        ],
      };
    }

    const platform = detectPlatform(extra);
    logger.debug("Platform detected", { platform, extra });

    let searchQuery = "";
    if (typeof extra === "string" && extra.includes("search=")) {
      searchQuery = decodeURIComponent(extra.split("search=")[1]);
    } else if (extra?.search) {
      searchQuery = extra.search;
    }

    if (!searchQuery) {
      logger.error("No search query provided");
      logger.emptyCatalog("No search query provided", { type, extra });
      const platform = detectPlatform(extra);
      return {
        metas: [
          createErrorCatalogEntry(
            "No search query provided. Please enter a search term.",
            platform,
            type
          ),
        ],
      };
    }

    // Only increment the counter and log for initial search queries, not for clicks on individual items
    const isSearchRequest =
      (typeof extra === "string" && extra.includes("search=")) ||
      !!extra?.search;
    if (isSearchRequest) {
      logger.query(searchQuery);
      logger.info("Processing search query", { searchQuery, type });
    }

    // First, determine the intent for ALL queries
    const intent = determineIntentFromKeywords(searchQuery);

    // If the intent is specific (not ambiguous) and doesn't match the requested type,
    // return empty results regardless of whether it's a recommendation or search
    if (intent !== "ambiguous" && intent !== type) {
      logger.debug("Intent mismatch - returning empty results", {
        intent,
        type,
        searchQuery,
        message: `This ${
          isRecommendationQuery(searchQuery) ? "recommendation" : "search"
        } appears to be for ${intent}, not ${type}`,
      });
      const platform = detectPlatform(extra);
      return {
        metas: [createNoResultsCatalogEntry(searchQuery, platform, type)],
      };
    }

    let exactMatchMeta = null;
    if (
      !isRecommendationQuery(searchQuery) &&
      !isNewContentQuery(searchQuery)
    ) {
      logger.info("Checking for TMDB exact match", {
        searchQuery,
        type,
      });
      const exactMatchData = await searchTMDBExactMatch(
        searchQuery,
        type,
        tmdbKey,
        language
      );
      if (exactMatchData && exactMatchData.imdb_id) {
        const exactMatchItem = {
          id: `exact_${exactMatchData.tmdb_id}`,
          name: exactMatchData.title,
          year: exactMatchData.release_date
            ? new Date(exactMatchData.release_date).getFullYear()
            : 0,
          type: type,
        };
        exactMatchMeta = await toStremioMeta(
          exactMatchItem,
          platform,
          tmdbKey,
          rpdbKey,
          rpdbPosterType,
          language,
          configData,
          apiFailures
        );
        if (exactMatchMeta) {
          logger.info("TMDB exact match found and converted to meta", {
            searchQuery,
            exactMatchTitle: exactMatchData.title,
            tmdbId: exactMatchData.tmdb_id,
            imdbId: exactMatchData.imdb_id,
          });
        }
      }
    }

    // Check if this is a new/latest content query that we can handle directly with TMDB discover
    if (!isRecommendationQuery(searchQuery) && isNewContentQuery(searchQuery)) {
      logger.info("Using TMDB discover for new/latest content query", {
        searchQuery,
        type,
      });

      // Get discover parameters
      const discoverParams = await analyzeQueryForDiscover(
        searchQuery,
        type,
        geminiKey,
        geminiModel
      );

      if (discoverParams) {
        // Fetch results from TMDB discover
        const results = await fetchTmdbDiscover(
          discoverParams,
          type,
          tmdbKey,
          language,
          numResults
        );

        if (results && results.length > 0) {
          logger.debug("Converting TMDB discover results to meta objects", {
            resultsCount: results.length,
            type,
            originalQuery: searchQuery,
          });

          const metaPromises = results.map((item) =>
            toStremioMeta(
              item,
              platform,
              tmdbKey,
              rpdbKey,
              rpdbPosterType,
              language,
              configData, // Pass the whole config down
              apiFailures
            )
          );

          const metas = (await Promise.all(metaPromises)).filter(Boolean);

          if (metas.length > 0) {
            // Add API failure warning entries at the beginning of discover results
            let finalMetas = metas;
            if (apiFailures.length > 0) {
              const platform = detectPlatform(extra);
              const warningEntries = apiFailures.map((failure) =>
                createWarningCatalogEntry(failure.message, platform, type)
              );
              finalMetas = [...warningEntries, ...metas];

              logger.info("Added API failure warnings to discover results", {
                searchQuery,
                warningCount: warningEntries.length,
                failures: apiFailures.map((f) => f.service),
                totalResults: finalMetas.length,
              });
            }

            logger.debug("Returning results from TMDB discover", {
              metasCount: finalMetas.length,
              firstMeta: finalMetas[0],
            });
            return { metas: finalMetas };
          }
        }
      }

      logger.info(
        "TMDB discover returned no results, falling back to AI recommendations",
        {
          searchQuery,
          type,
        }
      );
    }

    // Now check if it's a recommendation query
    const isRecommendation = isRecommendationQuery(searchQuery);
    let discoveredType = type;
    let discoveredGenres = [];
    let traktData = null;
    let filteredTraktData = null;

    // For recommendation queries, use the new workflow with genre discovery
    if (isRecommendation) {
      // Check if this is also a new/latest content query
      if (isNewContentQuery(searchQuery)) {
        logger.info(
          "Recommendation query also contains new/latest content criteria",
          {
            searchQuery,
            type,
          }
        );

        // Use analyzeQueryForDiscover to get the full set of parameters
        // This ensures we use the AI for all parameter extraction
        const discoverParams = await analyzeQueryForDiscover(
          searchQuery,
          type,
          geminiKey,
          geminiModel
        );

        logger.info("Using discovered parameters for TMDB discover", {
          discoverParams,
          method: discoverParams?._method || "unknown", // This will show if it was direct extraction or AI
        });

        if (discoverParams) {
          // Extract genres from the discover parameters for Trakt filtering
          let discoveredGenreIds = [];
          if (discoverParams.with_genres) {
            discoveredGenreIds = discoverParams.with_genres.split(",");
          }

          // If Trakt is configured, get user data
          if (DEFAULT_TRAKT_CLIENT_ID && configData.TraktAccessToken) {
            logger.info("Trakt credentials found, fetching user data", {
              hasTraktClientId: !!DEFAULT_TRAKT_CLIENT_ID,
              hasTraktAccessToken: !!configData.TraktAccessToken,
              clientIdLength: DEFAULT_TRAKT_CLIENT_ID?.length,
              accessTokenLength: configData.TraktAccessToken?.length,
            });

            traktData = await fetchTraktWatchedAndRated(
              DEFAULT_TRAKT_CLIENT_ID,
              configData.TraktAccessToken,
              type === "movie" ? "movies" : "shows",
              configData
            );

            // Track Trakt failure for warning if credentials were provided but data is null
            if (!traktData && configData.TraktAccessToken) {
              apiFailures.push({
                service: "Trakt",
                message:
                  "Trakt.tv personalization failed. Check your authentication or try re-connecting your Trakt account. Showing generic recommendations instead.",
                fallback: "generic recommendations",
              });
            }

            logger.info("Trakt data fetched", {
              hasTraktData: !!traktData,
              watchedCount: traktData?.watched?.length || 0,
              ratedCount: traktData?.rated?.length || 0,
              historyCount: traktData?.history?.length || 0,
            });

            // Filter Trakt data based on discovered genres if available
            if (traktData && discoveredGenreIds.length > 0) {
              // Create a mapping function to match TMDB genre IDs with Trakt genres
              const matchGenreById = (item) => {
                const media = item.movie || item.show;
                if (!media || !media.genres || media.genres.length === 0)
                  return false;

                // For each Trakt item, check if any of its genres match our target genres
                const genreMap = {
                  // Movie genres
                  28: ["action"],
                  12: ["adventure"],
                  16: ["animation"],
                  35: ["comedy"],
                  80: ["crime"],
                  99: ["documentary"],
                  18: ["drama"],
                  10751: ["family"],
                  14: ["fantasy"],
                  36: ["history"],
                  27: ["horror"],
                  10402: ["music"],
                  9648: ["mystery"],
                  10749: ["romance"],
                  878: ["science fiction", "sci-fi", "scifi"],
                  10770: ["tv movie"],
                  53: ["thriller"],
                  10752: ["war"],
                  37: ["western"],
                  // TV specific genres
                  10759: ["action & adventure", "action", "adventure"],
                  16: ["animation"],
                  35: ["comedy"],
                  80: ["crime"],
                  99: ["documentary"],
                  18: ["drama"],
                  10751: ["family"],
                  10762: ["kids", "children"],
                  9648: ["mystery"],
                  10763: ["news"],
                  10764: ["reality", "reality tv"],
                  10765: ["sci-fi & fantasy", "sci-fi", "scifi", "fantasy"],
                  10766: ["soap", "soap opera"],
                  10767: ["talk", "talk show"],
                  10768: ["war & politics", "war", "politics"],
                  37: ["western"],
                };

                // Check if any of the item's genres match our target genres
                return discoveredGenreIds.some((genreId) => {
                  const matchingGenres = genreMap[genreId] || [];
                  return matchingGenres.some((g) =>
                    media.genres.some(
                      (itemGenre) => itemGenre.toLowerCase() === g.toLowerCase()
                    )
                  );
                });
              };

              // Filter watched items
              const recentlyWatched = (traktData.watched || [])
                .filter(matchGenreById)
                .slice(0, 25);

              // Filter highly rated items (4-5 stars)
              const highlyRated = (traktData.rated || [])
                .filter((item) => item.rating >= 4)
                .filter(matchGenreById)
                .slice(0, 25);

              // Filter low rated items (1-2 stars)
              const lowRated = (traktData.rated || [])
                .filter((item) => item.rating <= 2)
                .filter(matchGenreById)
                .slice(0, 15);

              filteredTraktData = {
                recentlyWatched,
                highlyRated,
                lowRated,
              };

              logger.info("Filtered Trakt data by discovered genre IDs", {
                discoveredGenreIds,
                recentlyWatchedCount: filteredTraktData.recentlyWatched.length,
                highlyRatedCount: filteredTraktData.highlyRated.length,
                lowRatedCount: filteredTraktData.lowRated.length,
              });
            }
          }

          // Fetch results from TMDB discover
          const results = await fetchTmdbDiscover(
            discoverParams,
            type,
            tmdbKey,
            language,
            numResults
          );

          if (results && results.length > 0) {
            // Continue with recommendation processing but use the TMDB discover results
            // as the source for recommendations instead of generating them from scratch
            logger.info(
              "Using TMDB discover results as source for recommendations",
              {
                resultsCount: results.length,
                type,
              }
            );

            // Filter out watched items if we have Trakt data
            let filteredResults = results;
            if (traktData) {
              const watchHistory = traktData.watched.concat(
                traktData.history || []
              );
              filteredResults = results.filter(
                (item) =>
                  !isItemWatchedOrRated(item, watchHistory, traktData.rated)
              );

              logger.info("Filtered out watched/rated items", {
                originalCount: results.length,
                filteredCount: filteredResults.length,
                removedCount: results.length - filteredResults.length,
              });
            }

            // If we have enough results after filtering, use those
            if (filteredResults.length > 0) {
              // Randomly select 25 items from filtered results for diversity
              const shuffled = [...filteredResults].sort(
                () => 0.5 - Math.random()
              );
              const selectedResults = shuffled.slice(0, 25);

              // Build AI prompt
              let promptText = [
                `You are a ${type} recommendation expert. Analyze this query: "${searchQuery}"`,
                "",
                "Available content to choose from:",
              ];

              // Add selected content details
              selectedResults.forEach((item, index) => {
                promptText.push(`${index + 1}. "${item.name}" (${item.year})`);
                if (item.overview) {
                  promptText.push(`   Description: ${item.overview}`);
                }
                promptText.push("");
              });

              // Add user history if available
              if (filteredTraktData) {
                promptText.push("USER WATCH HISTORY:");
                if (filteredTraktData.recentlyWatched.length > 0) {
                  promptText.push("Recently watched similar content:");
                  filteredTraktData.recentlyWatched
                    .slice(0, 5)
                    .forEach((item) => {
                      const media = item.movie || item.show;
                      promptText.push(`- ${media.title} (${media.year})`);
                    });
                  promptText.push("");
                }

                if (filteredTraktData.highlyRated.length > 0) {
                  promptText.push("Highly rated similar content:");
                  filteredTraktData.highlyRated.slice(0, 5).forEach((item) => {
                    const media = item.movie || item.show;
                    promptText.push(
                      `- ${media.title} (${media.year}) - ${item.rating}/5`
                    );
                  });
                  promptText.push("");
                }

                if (filteredTraktData.lowRated.length > 0) {
                  promptText.push("Low rated similar content:");
                  filteredTraktData.lowRated.slice(0, 5).forEach((item) => {
                    const media = item.movie || item.show;
                    promptText.push(
                      `- ${media.title} (${media.year}) - ${item.rating}/5`
                    );
                  });
                  promptText.push("");
                }
              } else if (traktData) {
                promptText.push("USER WATCH HISTORY:");
                if (traktData.watched && traktData.watched.length > 0) {
                  promptText.push("Recently watched:");
                  traktData.watched.slice(0, 5).forEach((item) => {
                    const media = item.movie || item.show;
                    promptText.push(`- ${media.title} (${media.year})`);
                  });
                  promptText.push("");
                }

                if (traktData.rated) {
                  const highlyRated = traktData.rated.filter(
                    (item) => item.rating >= 4
                  );
                  const lowRated = traktData.rated.filter(
                    (item) => item.rating <= 2
                  );

                  if (highlyRated.length > 0) {
                    promptText.push("Highly rated:");
                    highlyRated.slice(0, 5).forEach((item) => {
                      const media = item.movie || item.show;
                      promptText.push(
                        `- ${media.title} (${media.year}) - ${item.rating}/5`
                      );
                    });
                    promptText.push("");
                  }

                  if (lowRated.length > 0) {
                    promptText.push("Low rated:");
                    lowRated.slice(0, 5).forEach((item) => {
                      const media = item.movie || item.show;
                      promptText.push(
                        `- ${media.title} (${media.year}) - ${item.rating}/5`
                      );
                    });
                    promptText.push("");
                  }
                }
              }

              promptText.push(
                "TASK:",
                "1. Analyze the available content and user preferences",
                "2. Select the most relevant items that match the query and user taste",
                "3. Return ONLY the numbers (1-25) of the selected items, comma-separated",
                "",
                "RESPONSE FORMAT:",
                "1,4,7,12,15",
                ""
              );

              try {
                const genAI = new GoogleGenerativeAI(geminiKey);
                const model = genAI.getGenerativeModel({ model: geminiModel });

                const aiResult = await model.generateContent(
                  promptText.join("\n")
                );
                const response = await aiResult.response;
                const selectedIndices = response
                  .text()
                  .trim()
                  .split(",")
                  .map((num) => parseInt(num.trim()) - 1)
                  .filter(
                    (index) => index >= 0 && index < selectedResults.length
                  );

                // Get the AI-selected items
                const aiSelectedResults = selectedIndices.map(
                  (index) => selectedResults[index]
                );

                logger.debug("AI filtered results", {
                  originalCount: results.length,
                  selectedForAI: selectedResults.length,
                  aiSelectedCount: aiSelectedResults.length,
                });

                // Convert to meta objects
                const metaPromises = aiSelectedResults.map((item) =>
                  toStremioMeta(
                    item,
                    platform,
                    tmdbKey,
                    rpdbKey,
                    rpdbPosterType,
                    language,
                    configData, // Pass the whole config down
                    apiFailures
                  )
                );

                const metas = (await Promise.all(metaPromises)).filter(Boolean);

                if (metas.length > 0) {
                  // Add API failure warning entries at the beginning of AI-filtered results
                  let finalMetas = metas;
                  if (apiFailures.length > 0) {
                    const platform = detectPlatform(extra);
                    const warningEntries = apiFailures.map((failure) =>
                      createWarningCatalogEntry(failure.message, platform, type)
                    );
                    finalMetas = [...warningEntries, ...metas];

                    logger.info(
                      "Added API failure warnings to AI-filtered results",
                      {
                        searchQuery,
                        warningCount: warningEntries.length,
                        failures: apiFailures.map((f) => f.service),
                        totalResults: finalMetas.length,
                      }
                    );
                  }
                  return { metas: finalMetas };
                }
              } catch (error) {
                logger.error(
                  "AI filtering error, falling back to direct results",
                  {
                    error: error.message,
                  }
                );
              }
            }

            // If we get here, either there's no Trakt data or AI filtering failed
            // Convert results to meta objects and return them directly
            logger.debug("Converting TMDB discover results to meta objects", {
              resultsCount: results.length,
              type,
              originalQuery: searchQuery,
            });

            const metaPromises = results.slice(0, 20).map((item) =>
              toStremioMeta(
                item,
                platform,
                tmdbKey,
                rpdbKey,
                rpdbPosterType,
                language,
                configData, // Pass the whole config down
                apiFailures
              )
            );

            const metas = (await Promise.all(metaPromises)).filter(Boolean);

            if (metas.length > 0) {
              // Add API failure warning entries at the beginning of discover recommendation results
              let finalMetas = metas;
              if (apiFailures.length > 0) {
                const platform = detectPlatform(extra);
                const warningEntries = apiFailures.map((failure) =>
                  createWarningCatalogEntry(failure.message, platform, type)
                );
                finalMetas = [...warningEntries, ...metas];

                logger.info(
                  "Added API failure warnings to discover recommendation results",
                  {
                    searchQuery,
                    warningCount: warningEntries.length,
                    failures: apiFailures.map((f) => f.service),
                    totalResults: finalMetas.length,
                  }
                );
              }

              logger.debug(
                "Returning results from TMDB discover for recommendation",
                {
                  metasCount: finalMetas.length,
                  firstMeta: finalMetas[0],
                }
              );
              return { metas: finalMetas };
            }
          }
        }

        logger.info(
          "TMDB discover returned no results for recommendation query, falling back to standard AI recommendations",
          {
            searchQuery,
            type,
          }
        );
      }

      // Make the genre discovery API call
      const discoveryResult = await discoverTypeAndGenres(
        searchQuery,
        geminiKey,
        geminiModel
      );
      discoveredGenres = discoveryResult.genres;

      // Log if we couldn't discover any genres for a recommendation query
      if (discoveredGenres.length === 0) {
        logger.emptyCatalog("No genres discovered for recommendation query", {
          type,
          searchQuery,
          isRecommendation: true,
        });
      }

      logger.info("Genre discovery results", {
        query: searchQuery,
        discoveredGenres,
        originalType: type,
      });

      // If Trakt is configured, get user data ONLY for recommendation queries
      if (DEFAULT_TRAKT_CLIENT_ID && configData.TraktAccessToken) {
        logger.info("Fetching Trakt data for recommendation query", {
          hasTraktClientId: !!DEFAULT_TRAKT_CLIENT_ID,
          traktClientIdLength: DEFAULT_TRAKT_CLIENT_ID?.length,
          hasTraktAccessToken: !!configData.TraktAccessToken,
          traktAccessTokenLength: configData.TraktAccessToken?.length,
          isRecommendation: isRecommendation,
          query: searchQuery,
        });

        traktData = await fetchTraktWatchedAndRated(
          DEFAULT_TRAKT_CLIENT_ID,
          configData.TraktAccessToken,
          type === "movie" ? "movies" : "shows",
          configData
        );

        // Track Trakt failure for warning if credentials were provided but data is null
        if (!traktData && configData.TraktAccessToken) {
          apiFailures.push({
            service: "Trakt",
            message:
              "Trakt.tv personalization failed. Check your authentication or try re-connecting your Trakt account. Showing generic recommendations instead.",
            fallback: "generic recommendations",
          });
        }

        // Filter Trakt data based on discovered genres if we have any
        if (traktData) {
          if (discoveredGenres.length > 0) {
            filteredTraktData = filterTraktDataByGenres(
              traktData,
              discoveredGenres
            );

            logger.info("Filtered Trakt data by genres", {
              genres: discoveredGenres,
              recentlyWatchedCount: filteredTraktData.recentlyWatched.length,
              highlyRatedCount: filteredTraktData.highlyRated.length,
              lowRatedCount: filteredTraktData.lowRated.length,
            });

            // Log if filtering by genres eliminated all Trakt data
            if (
              filteredTraktData.recentlyWatched.length === 0 &&
              filteredTraktData.highlyRated.length === 0 &&
              filteredTraktData.lowRated.length === 0
            ) {
              logger.emptyCatalog("No Trakt data matches discovered genres", {
                type,
                searchQuery,
                discoveredGenres,
                totalWatched: traktData.watched.length,
                totalRated: traktData.rated.length,
              });
            }
          } else {
            // When no genres are discovered, use all Trakt data
            filteredTraktData = {
              recentlyWatched: traktData.watched?.slice(0, 25) || [],
              highlyRated: (traktData.rated || [])
                .filter((item) => item.rating >= 4)
                .slice(0, 25),
              lowRated: (traktData.rated || [])
                .filter((item) => item.rating <= 2)
                .slice(0, 15),
            };

            logger.info(
              "Using all Trakt data (no specific genres discovered)",
              {
                totalWatched: traktData.watched?.length || 0,
                totalRated: traktData.rated?.length || 0,
                recentlyWatchedCount: filteredTraktData.recentlyWatched.length,
                highlyRatedCount: filteredTraktData.highlyRated.length,
                lowRatedCount: filteredTraktData.lowRated.length,
              }
            );
          }
        }
      }
    }

    const cacheKey = `${searchQuery}_${type}_${
      traktData ? "trakt" : "no_trakt"
    }`;

    // Only check cache if there's no Trakt data or if it's not a recommendation query
    if (enableAiCache && !traktData && aiRecommendationsCache.has(cacheKey)) {
      const cached = aiRecommendationsCache.get(cacheKey);

      logger.info("AI recommendations cache hit", {
        cacheKey,
        query: searchQuery,
        type,
        model: geminiModel,
        cachedAt: new Date(cached.timestamp).toISOString(),
        age: `${Math.round((Date.now() - cached.timestamp) / 1000)}s`,
        responseTime: `${Date.now() - startTime}ms`,
        cachedConfigNumResults: cached.configNumResults,
        requestedResults: numResults,
        hasMovies: !!cached.data?.recommendations?.movies?.length,
        hasSeries: !!cached.data?.recommendations?.series?.length,
      });

      if (cached.configNumResults && numResults > cached.configNumResults) {
        logger.info("NumResults increased, invalidating cache", {
          oldValue: cached.configNumResults,
          newValue: numResults,
        });
        aiRecommendationsCache.delete(cacheKey);
      } else if (
        !cached.data?.recommendations ||
        (type === "movie" && !cached.data.recommendations.movies) ||
        (type === "series" && !cached.data.recommendations.series)
      ) {
        logger.error("Invalid cached data structure, forcing refresh", {
          type,
          cachedData: cached.data,
        });
        aiRecommendationsCache.delete(cacheKey);
      } else {
        // Convert cached recommendations to Stremio meta objects
        const selectedRecommendations =
          type === "movie"
            ? cached.data.recommendations.movies || []
            : cached.data.recommendations.series || [];

        logger.debug("Converting cached recommendations to meta objects", {
          recommendationsCount: selectedRecommendations.length,
          type,
        });

        const metaPromises = selectedRecommendations.map((item) =>
          toStremioMeta(
            item,
            platform,
            tmdbKey,
            rpdbKey,
            rpdbPosterType,
            language,
            configData, // Pass the whole config down
            apiFailures
          )
        );

        const metas = (await Promise.all(metaPromises)).filter(Boolean);

        logger.debug("Catalog handler response from cache", {
          metasCount: metas.length,
          firstMeta: metas[0],
        });

        let finalMetas = metas;
        if (exactMatchMeta) {
          finalMetas = [
            exactMatchMeta,
            ...metas.filter((meta) => meta.id !== exactMatchMeta.id),
          ];
          logger.info("Added exact match as first result (from cache)", {
            searchQuery,
            exactMatchTitle: exactMatchMeta.name,
            totalResults: finalMetas.length,
            exactMatchId: exactMatchMeta.id,
          });
        }

        // Increment counter for successful cached results
        if (finalMetas.length > 0 && isSearchRequest) {
          incrementQueryCounter();
          logger.info(
            "Query counter incremented for successful cached search",
            {
              searchQuery,
              resultCount: finalMetas.length,
            }
          );
        }

        // Handle empty cached results - show no-results entry
        if (finalMetas.length === 0) {
          logger.info("No cached results found for search query", {
            searchQuery,
            type,
          });
          const platform = detectPlatform(extra);
          return {
            metas: [createNoResultsCatalogEntry(searchQuery, platform, type)],
          };
        }

        // Add API failure warning entries at the beginning of cached results
        if (apiFailures.length > 0) {
          const platform = detectPlatform(extra);
          const warningEntries = apiFailures.map((failure) =>
            createWarningCatalogEntry(failure.message, platform, type)
          );
          finalMetas = [...warningEntries, ...finalMetas];

          logger.info("Added API failure warnings to cached results", {
            searchQuery,
            warningCount: warningEntries.length,
            failures: apiFailures.map((f) => f.service),
            totalResults: finalMetas.length,
          });
        }

        return { metas: finalMetas };
      }
    }

    if (!enableAiCache) {
      logger.info("AI cache bypassed (disabled in config)", {
        cacheKey,
        query: searchQuery,
        type,
      });
    } else if (traktData) {
      logger.info("AI cache bypassed (using Trakt personalization)", {
        cacheKey,
        query: searchQuery,
        type,
        hasTraktData: true,
      });
    } else {
      logger.info("AI recommendations cache miss", {
        cacheKey,
        query: searchQuery,
        type,
      });
    }

    try {
      const genAI = new GoogleGenerativeAI(geminiKey);
      const model = genAI.getGenerativeModel({ model: geminiModel });
      const genreCriteria = extractGenreCriteria(searchQuery);
      const currentYear = new Date().getFullYear();

      let promptText = [
        `You are a ${type} recommendation expert. Analyze this query: "${searchQuery}"`,
        "",
        "QUERY ANALYSIS:",
      ];

      // Add query analysis section
      if (isRecommendation && discoveredGenres.length > 0) {
        promptText.push(`Discovered genres: ${discoveredGenres.join(", ")}`);
      } else if (genreCriteria?.include?.length > 0) {
        promptText.push(
          `Requested genres: ${genreCriteria.include.join(", ")}`
        );
      }
      if (genreCriteria?.mood?.length > 0) {
        promptText.push(`Mood/Style: ${genreCriteria.mood.join(", ")}`);
      }
      promptText.push("");

      if (traktData) {
        const { preferences } = traktData;

        // For recommendation queries, use the filtered Trakt data if available,
        // otherwise use all Trakt data when no specific genres are discovered
        if (isRecommendation) {
          // If we have filtered Trakt data (specific genres), use it
          // Otherwise, use all Trakt data (when no specific genres are discovered)
          const { recentlyWatched, highlyRated, lowRated } =
            filteredTraktData || {
              recentlyWatched: traktData.watched?.slice(0, 25) || [],
              highlyRated: (traktData.rated || [])
                .filter((item) => item.rating >= 4)
                .slice(0, 25),
              lowRated: (traktData.rated || [])
                .filter((item) => item.rating <= 2)
                .slice(0, 15),
            };

          // Calculate genre overlap if we have discovered genres
          let genreRecommendationStrategy = "";
          if (discoveredGenres.length > 0) {
            const queryGenres = new Set(
              discoveredGenres.map((g) => g.toLowerCase())
            );
            const userGenres = new Set(
              preferences.genres.map((g) => g.genre.toLowerCase())
            );
            const overlap = [...queryGenres].filter((g) => userGenres.has(g));

            // Check if user has watched many movies in the requested genres
            const genreWatchCount = recentlyWatched.filter((item) => {
              const media = item.movie || item.show;
              return (
                media.genres &&
                media.genres.some((g) => queryGenres.has(g.toLowerCase()))
              );
            }).length;

            const hasWatchedManyInGenre = genreWatchCount > 10;

            if (overlap.length > 0) {
              if (hasWatchedManyInGenre) {
                genreRecommendationStrategy =
                  "The user has watched many movies in the requested genres and these genres match their preferences. " +
                  "Focus on finding less obvious, unique, or newer titles in these genres that they might have missed. " +
                  "Consider acclaimed international films, indie gems, or cult classics that fit the genre requirements.";
              } else {
                genreRecommendationStrategy =
                  "Since the requested genres match some of the user's preferred genres, " +
                  "prioritize recommendations that combine these interests while maintaining the specific genre requirements.";
              }
            } else {
              genreRecommendationStrategy =
                "Although the requested genres differ from the user's usual preferences, " +
                "try to find high-quality recommendations that might bridge their interests with the requested genres.";
            }
          }

          promptText.push(
            "USER'S WATCH HISTORY AND PREFERENCES (FILTERED BY RELEVANT GENRES):",
            ""
          );

          if (recentlyWatched.length > 0) {
            promptText.push(
              "Recently watched in these genres:",
              recentlyWatched
                .slice(0, 25)
                .map((item) => {
                  const media = item.movie || item.show;
                  return `- ${media.title} (${media.year}) - ${
                    media.genres?.join(", ") || "N/A"
                  }`;
                })
                .join("\n")
            );
            promptText.push("");
          }

          if (highlyRated.length > 0) {
            promptText.push(
              "Highly rated (4-5 stars) in these genres:",
              highlyRated
                .slice(0, 25)
                .map((item) => {
                  const media = item.movie || item.show;
                  return `- ${media.title} (${item.rating}/5) - ${
                    media.genres?.join(", ") || "N/A"
                  }`;
                })
                .join("\n")
            );
            promptText.push("");
          }

          if (lowRated.length > 0) {
            promptText.push(
              "Low rated (1-2 stars) in these genres:",
              lowRated
                .slice(0, 15)
                .map((item) => {
                  const media = item.movie || item.show;
                  return `- ${media.title} (${item.rating}/5) - ${
                    media.genres?.join(", ") || "N/A"
                  }`;
                })
                .join("\n")
            );
            promptText.push("");
          }

          // Only include top genres if the user isn't already searching for specific genres
          if (discoveredGenres.length === 0) {
            promptText.push(
              "Top genres:",
              preferences.genres
                .map((g) => `- ${g.genre} (Score: ${g.count.toFixed(2)})`)
                .join("\n"),
              ""
            );
          }

          promptText.push(
            "Favorite actors:",
            preferences.actors
              .map((a) => `- ${a.actor} (Score: ${a.count.toFixed(2)})`)
              .join("\n"),
            "",
            "Preferred directors:",
            preferences.directors
              .map((d) => `- ${d.director} (Score: ${d.count.toFixed(2)})`)
              .join("\n"),
            "",
            preferences.yearRange
              ? `User tends to watch content from ${preferences.yearRange.start} to ${preferences.yearRange.end}, with a preference for ${preferences.yearRange.preferred}`
              : "",
            "",
            "RECOMMENDATION STRATEGY:",
            genreRecommendationStrategy ||
              "Balance user preferences with query requirements",
            "1. Focus on the specific requirements from the query (genres, time period, mood)",
            "2. Use user's preferences to refine choices within those requirements",
            "3. Consider their rating patterns to gauge quality preferences",
            "4. Prioritize movies with preferred actors/directors when relevant",
            "5. Include some variety while staying within the requested criteria",
            "6. For genre-specific queries, prioritize acclaimed or popular movies in that genre that the user hasn't seen",
            "7. Include a mix of well-known classics and hidden gems in the requested genre",
            "8. If the user has watched many movies in the requested genre, look for similar but less obvious choices",
            ""
          );
        }
      }

      promptText = promptText.concat([
        "IMPORTANT INSTRUCTIONS:",
        `- Current year is ${currentYear}. For time-based queries:`,
        `  * 'past year' means movies from ${
          currentYear - 1
        } to ${currentYear}`,
        `  * 'recent' means within the last 2-3 years (${
          currentYear - 2
        } to ${currentYear})`,
        `  * 'new' or 'latest' means released in ${currentYear}`,
        "- If this query appears to be for a specific movie (like 'The Matrix', 'Inception'), return only that exact movie and its sequels/prequels if they exist in chronological order.",
        "- If this query is for movies from a specific franchise (like 'Mission Impossible movies, James Bond movies'), list the official entries in that franchise in chronological order.",
        "- If this query is for an actor's filmography (like 'Tom Cruise movies'), list diverse notable films featuring that actor.",
        "- For all other queries, provide diverse recommendations that best match the query.",
        "- Order your recommendations in the most appropriate way for the query (by relevance, popularity, quality, or other criteria that makes sense).",
        "",
        "CRITICAL REQUIREMENTS:",
        `- DO NOT recommend any movies that appear in the user's watch history or ratings above.`,
        `- Recommend movies that are SIMILAR to the user's highly rated movies but NOT THE SAME ones.`,
        `- You MUST return exactly ${numResults} ${type} recommendations. If you can't find enough perfect matches, broaden your criteria while staying within the genre/theme requirements.`,
        `- Prioritize quality over exact matching - it's better to recommend a great movie that's somewhat related than a mediocre movie that perfectly matches all criteria.`,
        `- If the user has watched many movies in the requested genre, consider recommending lesser-known gems, international films, or recent releases they might have missed.`,
        "",
        "FORMAT:",
        "type|name|year",
        "OR",
        "type|name (year)",
        "",
        "EXAMPLES:",
        `${type}|The Matrix|1999`,
        `${type}|The Matrix (1999)`,
        "",
        "RULES:",
        "- Use | separator",
        "- Year: YYYY format (either as separate field or in parentheses)",
        `- Type: Hardcode to "${type}"`,
        "- Only best matches that strictly match ALL query requirements",
        "- If specific genres/time periods are requested, ALL recommendations must match those criteria",
      ]);

      if (genreCriteria) {
        if (genreCriteria.include.length > 0) {
          promptText.push(
            `- Must match genres: ${genreCriteria.include.join(", ")}`
          );
        }
        if (genreCriteria.exclude.length > 0) {
          promptText.push(
            `- Exclude genres: ${genreCriteria.exclude.join(", ")}`
          );
        }
        if (genreCriteria.mood.length > 0) {
          promptText.push(
            `- Match mood/style: ${genreCriteria.mood.join(", ")}`
          );
        }
      }

      promptText = promptText.join("\n");

      logger.info("Making Gemini API call", {
        model: geminiModel,
        query: searchQuery,
        type,
        prompt: promptText,
        genreCriteria,
        numResults,
      });

      // Use withRetry for the Gemini API call
      const text = await withRetry(
        async () => {
          try {
            const aiResult = await model.generateContent(promptText);
            const response = await aiResult.response;
            const responseText = response.text().trim();

            logger.info("Gemini API response", {
              duration: `${Date.now() - startTime}ms`,
              promptTokens: aiResult.promptFeedback?.tokenCount,
              candidates: aiResult.candidates?.length,
              safetyRatings: aiResult.candidates?.[0]?.safetyRatings,
              responseTextLength: responseText.length,
              responseTextSample:
                responseText.substring(0, 100) +
                (responseText.length > 100 ? "..." : ""),
            });

            return responseText;
          } catch (error) {
            logger.error("Gemini API call failed", {
              error: error.message,
              status: error.httpStatus || 500,
              stack: error.stack,
            });
            error.status = error.httpStatus || 500;
            throw error;
          }
        },
        {
          maxRetries: 3,
          initialDelay: 2000,
          maxDelay: 10000,
          // Don't retry 400 errors (bad requests)
          shouldRetry: (error) => !error.status || error.status !== 400,
          operationName: "Gemini API call",
        }
      );

      // Process the response text
      const lines = text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("type|"));

      logger.debug("Parsed recommendation lines", {
        totalLines: text.split("\n").length,
        validLines: lines.length,
      });

      const recommendations = {
        movies: type === "movie" ? [] : undefined,
        series: type === "series" ? [] : undefined,
      };

      let validRecommendations = 0;
      let invalidLines = 0;

      for (const line of lines) {
        try {
          const parts = line.split("|");

          let lineType, name, year;

          if (parts.length === 3) {
            [lineType, name, year] = parts.map((s) => s.trim());
          } else if (parts.length === 2) {
            lineType = parts[0].trim();
            const nameWithYear = parts[1].trim();

            const yearMatch = nameWithYear.match(/\((\d{4})\)$/);
            if (yearMatch) {
              year = yearMatch[1];
              name = nameWithYear
                .substring(0, nameWithYear.lastIndexOf("("))
                .trim();
            } else {
              const anyYearMatch = nameWithYear.match(/\b(19\d{2}|20\d{2})\b/);
              if (anyYearMatch) {
                year = anyYearMatch[0];
                name = nameWithYear.replace(anyYearMatch[0], "").trim();
              } else {
                logger.debug("Missing year in recommendation", {
                  nameWithYear,
                });
                invalidLines++;
                continue;
              }
            }
          } else {
            logger.debug("Invalid recommendation format", { line });
            invalidLines++;
            continue;
          }

          const yearNum = parseInt(year);

          if (!lineType || !name || isNaN(yearNum)) {
            logger.debug("Invalid recommendation data", {
              lineType,
              name,
              year,
              isValidYear: !isNaN(yearNum),
            });
            invalidLines++;
            continue;
          }

          if (lineType === type && name && yearNum) {
            const item = {
              name,
              year: yearNum,
              type,
              id: `ai_${type}_${name
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "_")}`,
            };

            if (type === "movie") recommendations.movies.push(item);
            else if (type === "series") recommendations.series.push(item);

            validRecommendations++;
          }
        } catch (error) {
          logger.error("Error processing recommendation line", {
            line,
            error: error.message,
          });
          invalidLines++;
        }
      }

      logger.info("Recommendation processing complete", {
        validRecommendations,
        invalidLines,
        totalProcessed: lines.length,
      });

      const finalResult = {
        recommendations,
        fromCache: false,
      };

      // Filter out watched items if we have Trakt data and this is a recommendation query
      if (traktData && isRecommendation) {
        const watchHistory = traktData.watched.concat(traktData.history || []);

        // Log a summary of the user's watched and rated items for validation
        const watchedSummary = watchHistory.slice(0, 20).map((item) => {
          const media = item.movie || item.show;
          return {
            title: media.title,
            year: media.year,
            type: item.movie ? "movie" : "show",
          };
        });

        const ratedSummary = traktData.rated.slice(0, 20).map((item) => {
          const media = item.movie || item.show;
          return {
            title: media.title,
            year: media.year,
            rating: item.rating,
            type: item.movie ? "movie" : "show",
          };
        });

        logger.info("User's watch history and ratings (for validation)", {
          totalWatched: watchHistory.length,
          totalRated: traktData.rated.length,
          watchedSample: watchedSummary,
          ratedSample: ratedSummary,
        });

        // Filter out watched and rated items from recommendations
        if (finalResult.recommendations.movies) {
          // Get the list of movies before filtering
          const allMovies = [...finalResult.recommendations.movies];

          const unwatchedMovies = finalResult.recommendations.movies.filter(
            (movie) =>
              !isItemWatchedOrRated(movie, watchHistory, traktData.rated)
          );

          // Find which movies were filtered out
          const filteredMovies = allMovies.filter(
            (movie) =>
              !unwatchedMovies.some(
                (unwatched) =>
                  unwatched.name === movie.name && unwatched.year === movie.year
              )
          );

          logger.info(
            "Filtered out watched and rated movies from recommendations",
            {
              totalRecommendations: finalResult.recommendations.movies.length,
              unwatchedCount: unwatchedMovies.length,
              filteredCount:
                finalResult.recommendations.movies.length -
                unwatchedMovies.length,
              filteredMovies: filteredMovies.map((movie) => ({
                title: movie.name,
                year: movie.year,
              })),
            }
          );

          finalResult.recommendations.movies = unwatchedMovies;
        }

        if (finalResult.recommendations.series) {
          // Get the list of series before filtering
          const allSeries = [...finalResult.recommendations.series];

          const unwatchedSeries = finalResult.recommendations.series.filter(
            (series) =>
              !isItemWatchedOrRated(series, watchHistory, traktData.rated)
          );

          // Find which series were filtered out
          const filteredSeries = allSeries.filter(
            (series) =>
              !unwatchedSeries.some(
                (unwatched) =>
                  unwatched.name === series.name &&
                  unwatched.year === series.year
              )
          );

          logger.info(
            "Filtered out watched and rated series from recommendations",
            {
              totalRecommendations: finalResult.recommendations.series.length,
              unwatchedCount: unwatchedSeries.length,
              filteredCount:
                finalResult.recommendations.series.length -
                unwatchedSeries.length,
              filteredSeries: filteredSeries.map((series) => ({
                title: series.name,
                year: series.year,
              })),
            }
          );

          finalResult.recommendations.series = unwatchedSeries;
        }
      }

      // Only cache if there's no Trakt data (not user-specific)
      if (!traktData) {
        aiRecommendationsCache.set(cacheKey, {
          timestamp: Date.now(),
          data: finalResult,
          configNumResults: numResults,
        });

        if (enableAiCache) {
          logger.debug("AI recommendations result cached and used", {
            cacheKey,
            duration: Date.now() - startTime,
            query: searchQuery,
            type,
            numResults,
          });
        } else {
          logger.debug(
            "AI recommendations result cached but not used (caching disabled for this user)",
            {
              cacheKey,
              duration: Date.now() - startTime,
              query: searchQuery,
              type,
              numResults,
            }
          );
        }
      } else {
        logger.debug(
          "AI recommendations with Trakt data not cached (user-specific)",
          {
            duration: Date.now() - startTime,
            query: searchQuery,
            type,
            numResults,
            hasTraktData: true,
          }
        );
      }

      // Convert recommendations to Stremio meta objects
      const selectedRecommendations =
        type === "movie"
          ? finalResult.recommendations.movies || []
          : finalResult.recommendations.series || [];

      logger.debug("Converting recommendations to meta objects", {
        recommendationsCount: selectedRecommendations.length,
        type,
        originalQuery: searchQuery,
        recommendations: selectedRecommendations.map((r) => ({
          name: r.name,
          year: r.year,
          type: r.type,
          id: r.id,
        })),
      });

      const metaPromises = selectedRecommendations.map((item) =>
        toStremioMeta(
          item,
          platform,
          tmdbKey,
          rpdbKey,
          rpdbPosterType,
          language,
          configData, // Pass the whole config down
          apiFailures
        )
      );

      const metas = (await Promise.all(metaPromises)).filter(Boolean);

      // Log detailed results
      logger.debug("Meta conversion results", {
        originalQuery: searchQuery,
        type,
        totalRecommendations: selectedRecommendations.length,
        successfulConversions: metas.length,
        failedConversions: selectedRecommendations.length - metas.length,
        recommendations: selectedRecommendations.map((r) => ({
          name: r.name,
          year: r.year,
          type: r.type,
        })),
        convertedMetas: metas.map((m) => ({
          id: m.id,
          name: m.name,
          year: m.year,
          type: m.type,
        })),
      });

      logger.debug("Catalog handler response", {
        metasCount: metas.length,
        firstMeta: metas[0],
        originalQuery: searchQuery,
        type,
        platform,
      });

      let finalMetas = metas;
      if (exactMatchMeta) {
        finalMetas = [
          exactMatchMeta,
          ...metas.filter((meta) => meta.id !== exactMatchMeta.id),
        ];
        logger.info("Added exact match as first result", {
          searchQuery,
          exactMatchTitle: exactMatchMeta.name,
          totalResults: finalMetas.length,
          exactMatchId: exactMatchMeta.id,
        });
      }

      // Only increment the counter if we're returning non-empty results
      if (finalMetas.length > 0 && isSearchRequest) {
        incrementQueryCounter();
        logger.info("Query counter incremented for successful search", {
          searchQuery,
          resultCount: finalMetas.length,
        });
      }

      // Handle empty results - show no-results entry
      if (finalMetas.length === 0) {
        logger.info("No results found for search query", {
          searchQuery,
          type,
        });
        const platform = detectPlatform(extra);
        return {
          metas: [createNoResultsCatalogEntry(searchQuery, platform, type)],
        };
      }

      // Add API failure warning entries at the beginning of results
      if (apiFailures.length > 0) {
        const platform = detectPlatform(extra);
        const warningEntries = apiFailures.map((failure) =>
          createWarningCatalogEntry(failure.message, platform, type)
        );
        finalMetas = [...warningEntries, ...finalMetas];

        logger.info("Added API failure warnings to results", {
          searchQuery,
          warningCount: warningEntries.length,
          failures: apiFailures.map((f) => f.service),
          totalResults: finalMetas.length,
        });
      }

      return { metas: finalMetas };
    } catch (error) {
      logger.error("Gemini API Error:", {
        error: error.message,
        stack: error.stack,
        params: {
          query: searchQuery,
          type,
          geminiKeyLength: geminiKey?.length,
        },
      });
      logger.emptyCatalog("Gemini API Error", {
        type,
        searchQuery,
        error: error.message,
      });
      const platform = detectPlatform(extra);
      return {
        metas: [
          createErrorCatalogEntry(
            `Gemini API Error: ${error.message}`,
            platform,
            type
          ),
        ],
      };
    }
  } catch (error) {
    logger.error("Catalog processing error", {
      error: error.message,
      stack: error.stack,
    });
    logger.emptyCatalog("Catalog processing error", {
      type,
      error: error.message,
    });
    const platform = detectPlatform(extra);
    return {
      metas: [
        createErrorCatalogEntry(
          `Processing Error: ${error.message}`,
          platform,
          type
        ),
      ],
    };
  }
};

builder.defineCatalogHandler(catalogHandler);

builder.defineMetaHandler(async function (args) {
  const { type, id, config } = args;

  try {
    // Handle error, warning, and no-results catalog items
    if (
      id.startsWith("error_") ||
      id.startsWith("warning_") ||
      id.startsWith("no_results_")
    ) {
      const parts = id.split("_");
      const itemType = parts[0];
      const timestamp = parts[1];
      const encodedMessage = parts[2];

      let name, description, poster, troubleshooting;

      try {
        // Decode the original message from the ID
        const originalMessage = encodedMessage
          ? Buffer.from(encodedMessage, "base64").toString()
          : "";

        if (itemType === "error") {
          name = "⚠️ Service Error";
          description =
            originalMessage ||
            "A critical error occurred that prevented the addon from functioning properly.";
          const posterSvg = createDynamicErrorPoster(description, "error");
          poster = `data:image/svg+xml;base64,${Buffer.from(posterSvg).toString(
            "base64"
          )}`;
          troubleshooting = [
            "1. Check your addon configuration",
            "2. Verify all API keys are valid and correctly entered",
            "3. Ensure your internet connection is stable",
            "4. Try reconfiguring the addon if the problem persists",
            "5. Check addon logs for detailed error information",
          ];
        } else if (itemType === "warning") {
          name = "⚠️ Service Warning";
          description =
            originalMessage ||
            "One or more configured services failed to work properly, but fallback results were provided.";
          const posterSvg = createDynamicErrorPoster(description, "warning");
          poster = `data:image/svg+xml;base64,${Buffer.from(posterSvg).toString(
            "base64"
          )}`;
          troubleshooting = [
            "1. Check your service configurations (API keys, authentication)",
            "2. For Trakt issues: Try re-connecting your Trakt account",
            "3. For RPDB issues: Verify your RPDB API key is valid",
            "4. Services may be temporarily unavailable - try again later",
            "5. Fallback results are still available and functional",
          ];
        } else if (itemType === "no_results") {
          name = "🔍 No Results Found";
          const searchQuery = originalMessage || "your search";
          description = `No content found matching "${searchQuery}".`;
          const posterSvg = createDynamicErrorPoster(description, "no_results");
          poster = `data:image/svg+xml;base64,${Buffer.from(posterSvg).toString(
            "base64"
          )}`;
          troubleshooting = [
            "1. Try using different or more specific keywords",
            "2. Check your spelling and try alternative spellings",
            "3. Use broader search terms or remove filters",
            "4. Search for specific movie/series titles instead of generic terms",
            "5. Try searching in both movie and series catalogs",
          ];
        }
      } catch (error) {
        // Fallback if decoding fails
        name =
          itemType === "error"
            ? "⚠️ Service Error"
            : itemType === "warning"
            ? "⚠️ Service Warning"
            : "🔍 No Results Found";
        description =
          "An issue occurred with the addon. Please check your configuration.";
        const posterSvg = createDynamicErrorPoster(
          description,
          itemType === "warning" ? "warning" : "error"
        );
        poster = `data:image/svg+xml;base64,${Buffer.from(posterSvg).toString(
          "base64"
        )}`;
        troubleshooting = ["1. Please reconfigure the addon and try again"];
      }

      return {
        meta: {
          id: id,
          type: type,
          name: name,
          description: `${description}\n\nTROUBLESHOOTING STEPS:\n${troubleshooting.join(
            "\n"
          )}`,
          poster: poster,
          background: poster,
          year: new Date().getFullYear(),
          genres: ["Information"],
          imdbRating: "",
          releaseInfo: `Generated at ${new Date(
            parseInt(timestamp)
          ).toLocaleString()}`,
          runtime: "",
          cast: [],
          director: [],
          writer: [],
          trailers: [],
          posterShape: "regular",
          behaviorHints: {
            defaultVideoId: null,
            hasScheduledVideos: false,
          },
        },
      };
    }

    const decryptedConfigStr = decryptConfig(config);
    if (!decryptedConfigStr) {
      throw new Error("Failed to decrypt config data");
    }

    const configData = JSON.parse(decryptedConfigStr);

    const tmdbKey = configData.TmdbApiKey;
    const rpdbKey = configData.RpdbApiKey || DEFAULT_RPDB_KEY;
    const rpdbPosterType = configData.RpdbPosterType || "poster-default";
    const language = configData.TmdbLanguage || "en-US";
    const usingUserKey = !!configData.RpdbApiKey;
    const usingDefaultKey = !configData.RpdbApiKey && !!DEFAULT_RPDB_KEY;
    const userTier = usingUserKey
      ? getRpdbTierFromApiKey(configData.RpdbApiKey)
      : -1;
    const isTier0User = (usingUserKey && userTier === 0) || usingDefaultKey;

    if (!tmdbKey) {
      throw new Error("Missing TMDB API key in config");
    }

    const tmdbData = await searchTMDB(id, type, null, tmdbKey, language);
    if (tmdbData) {
      let poster = tmdbData.poster;
      if (rpdbKey && tmdbData.imdb_id) {
        const rpdbPoster = await fetchRpdbPoster(
          tmdbData.imdb_id,
          rpdbKey,
          rpdbPosterType,
          isTier0User
        );
        if (rpdbPoster) {
          poster = rpdbPoster;
        }
      }

      const meta = {
        id: tmdbData.imdb_id,
        type: type,
        name: tmdbData.title || tmdbData.name,
        description: tmdbData.overview,
        year: parseInt(tmdbData.release_date || tmdbData.first_air_date) || 0,
        poster: poster,
        background: tmdbData.backdrop,
        posterShape: "regular",
      };

      if (tmdbData.genres && tmdbData.genres.length > 0) {
        meta.genres = tmdbData.genres
          .map((id) =>
            type === "series" ? TMDB_TV_GENRES[id] : TMDB_GENRES[id]
          )
          .filter(Boolean);
      }

      return { meta };
    }
  } catch (error) {
    logger.error("Meta Error:", error);
  }

  return { meta: null };
});

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

// TV specific genres
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

const addonInterface = builder.getInterface();

function clearTmdbCache() {
  const size = tmdbCache.size;
  tmdbCache.clear();
  logger.info("TMDB cache cleared", { previousSize: size });
  return { cleared: true, previousSize: size };
}

function clearTmdbDetailsCache() {
  const size = tmdbDetailsCache.size;
  tmdbDetailsCache.clear();
  logger.info("TMDB details cache cleared", { previousSize: size });
  return { cleared: true, previousSize: size };
}

function clearTmdbDiscoverCache() {
  const size = tmdbDiscoverCache.size;
  tmdbDiscoverCache.clear();
  logger.info("TMDB discover cache cleared", { previousSize: size });
  return { cleared: true, previousSize: size };
}

/**
 * Removes a specific item from the TMDB discover cache
 * @param {string} cacheKey - The cache key to remove
 * @returns {Object} - Result of the operation
 */
function removeTmdbDiscoverCacheItem(cacheKey) {
  if (!cacheKey) {
    return {
      success: false,
      message: "No cache key provided",
    };
  }

  if (!tmdbDiscoverCache.has(cacheKey)) {
    return {
      success: false,
      message: "Cache key not found",
      key: cacheKey,
    };
  }

  tmdbDiscoverCache.delete(cacheKey);
  logger.info("TMDB discover cache item removed", { cacheKey });

  return {
    success: true,
    message: "Cache item removed successfully",
    key: cacheKey,
  };
}

/**
 * Lists all keys in the TMDB discover cache
 * @returns {Object} - Object containing all cache keys
 */
function listTmdbDiscoverCacheKeys() {
  const keys = Array.from(tmdbDiscoverCache.cache.keys());
  logger.info("TMDB discover cache keys listed", { count: keys.length });

  return {
    success: true,
    count: keys.length,
    keys: keys,
  };
}

function clearAiCache() {
  const size = aiRecommendationsCache.size;
  aiRecommendationsCache.clear();
  logger.info("AI recommendations cache cleared", { previousSize: size });
  return { cleared: true, previousSize: size };
}

function removeAiCacheByKeywords(keywords) {
  try {
    if (!keywords || typeof keywords !== "string") {
      throw new Error("Invalid keywords parameter");
    }

    const searchPhrase = keywords.toLowerCase().trim();
    const removedEntries = [];
    let totalRemoved = 0;

    // Get all cache keys
    const cacheKeys = aiRecommendationsCache.keys();

    // Iterate through all cache entries
    for (const key of cacheKeys) {
      // Extract the query part (everything before _movie_ or _series_)
      const query = key.split("_")[0].toLowerCase();

      // Only match if the search phrase is contained within the query
      if (query.includes(searchPhrase)) {
        const entry = aiRecommendationsCache.get(key);
        if (entry) {
          removedEntries.push({
            key,
            timestamp: new Date(entry.timestamp).toISOString(),
            query: key.split("_")[0], // The query is the first part of the cache key
          });
          aiRecommendationsCache.delete(key);
          totalRemoved++;
        }
      }
    }

    logger.info("AI recommendations cache entries removed by keywords", {
      keywords: searchPhrase,
      totalRemoved,
      removedEntries,
    });

    return {
      removed: totalRemoved,
      entries: removedEntries,
    };
  } catch (error) {
    logger.error("Error in removeAiCacheByKeywords:", {
      error: error.message,
      stack: error.stack,
      keywords,
    });
    throw error;
  }
}

function clearRpdbCache() {
  const size = rpdbCache.size;
  rpdbCache.clear();
  logger.info("RPDB cache cleared", { previousSize: size });
  return { cleared: true, previousSize: size };
}

function clearTraktCache() {
  const size = traktCache.size;
  traktCache.clear();
  logger.info("Trakt cache cleared", { previousSize: size });
  return { cleared: true, previousSize: size };
}

function clearTraktRawDataCache() {
  const size = traktRawDataCache.size;
  traktRawDataCache.clear();
  logger.info("Trakt raw data cache cleared", { previousSize: size });
  return { cleared: true, previousSize: size };
}

function clearQueryAnalysisCache() {
  const size = queryAnalysisCache.size;
  queryAnalysisCache.clear();
  logger.info("Query analysis cache cleared", { previousSize: size });
  return { cleared: true, previousSize: size };
}

function getCacheStats() {
  return {
    tmdbCache: {
      size: tmdbCache.size,
      maxSize: tmdbCache.max,
      usagePercentage:
        ((tmdbCache.size / tmdbCache.max) * 100).toFixed(2) + "%",
    },
    tmdbDetailsCache: {
      size: tmdbDetailsCache.size,
      maxSize: tmdbDetailsCache.max,
      usagePercentage:
        ((tmdbDetailsCache.size / tmdbDetailsCache.max) * 100).toFixed(2) + "%",
    },
    tmdbDiscoverCache: {
      size: tmdbDiscoverCache.size,
      maxSize: tmdbDiscoverCache.max,
      usagePercentage:
        ((tmdbDiscoverCache.size / tmdbDiscoverCache.max) * 100).toFixed(2) +
        "%",
    },
    aiCache: {
      size: aiRecommendationsCache.size,
      maxSize: aiRecommendationsCache.max,
      usagePercentage:
        (
          (aiRecommendationsCache.size / aiRecommendationsCache.max) *
          100
        ).toFixed(2) + "%",
    },
    rpdbCache: {
      size: rpdbCache.size,
      maxSize: rpdbCache.max,
      usagePercentage:
        ((rpdbCache.size / rpdbCache.max) * 100).toFixed(2) + "%",
    },
    traktCache: {
      size: traktCache.size,
      maxSize: traktCache.max,
      usagePercentage:
        ((traktCache.size / traktCache.max) * 100).toFixed(2) + "%",
    },
    traktRawDataCache: {
      size: traktRawDataCache.size,
      maxSize: traktRawDataCache.max,
      usagePercentage:
        ((traktRawDataCache.size / traktRawDataCache.max) * 100).toFixed(2) +
        "%",
    },
    queryAnalysisCache: {
      size: queryAnalysisCache.size,
      maxSize: queryAnalysisCache.max,
      usagePercentage:
        ((queryAnalysisCache.size / queryAnalysisCache.max) * 100).toFixed(2) +
        "%",
    },
  };
}

// Function to serialize all caches
function serializeAllCaches() {
  return {
    tmdbCache: tmdbCache.serialize(),
    tmdbDetailsCache: tmdbDetailsCache.serialize(),
    tmdbDiscoverCache: tmdbDiscoverCache.serialize(),
    aiRecommendationsCache: aiRecommendationsCache.serialize(),
    rpdbCache: rpdbCache.serialize(),
    traktCache: traktCache.serialize(),
    traktRawDataCache: traktRawDataCache.serialize(),
    queryAnalysisCache: queryAnalysisCache.serialize(),
    stats: {
      queryCounter: queryCounter,
    },
  };
}

// Function to load data into all caches
function deserializeAllCaches(data) {
  const results = {};

  if (data.tmdbCache) {
    results.tmdbCache = tmdbCache.deserialize(data.tmdbCache);
  }

  if (data.tmdbDetailsCache) {
    results.tmdbDetailsCache = tmdbDetailsCache.deserialize(
      data.tmdbDetailsCache
    );
  }

  if (data.tmdbDiscoverCache) {
    results.tmdbDiscoverCache = tmdbDiscoverCache.deserialize(
      data.tmdbDiscoverCache
    );
  }

  // Handle both aiCache and aiRecommendationsCache for backward compatibility
  if (data.aiRecommendationsCache) {
    results.aiRecommendationsCache = aiRecommendationsCache.deserialize(
      data.aiRecommendationsCache
    );
  } else if (data.aiCache) {
    results.aiRecommendationsCache = aiRecommendationsCache.deserialize(
      data.aiCache
    );
  }

  if (data.rpdbCache) {
    results.rpdbCache = rpdbCache.deserialize(data.rpdbCache);
  }

  if (data.traktCache) {
    results.traktCache = traktCache.deserialize(data.traktCache);
  }

  if (data.traktRawDataCache) {
    results.traktRawDataCache = traktRawDataCache.deserialize(
      data.traktRawDataCache
    );
  }

  if (data.queryAnalysisCache) {
    results.queryAnalysisCache = queryAnalysisCache.deserialize(
      data.queryAnalysisCache
    );
  }

  // Restore the query counter if available
  if (data.stats && typeof data.stats.queryCounter === "number") {
    queryCounter = data.stats.queryCounter;
    logger.info("Query counter restored from cache", {
      totalQueries: queryCounter,
    });
  }

  return results;
}

/**
 * Makes an AI call to determine the content type and genres for a recommendation query
 * @param {string} query - The user's search query
 * @param {string} geminiKey - The Gemini API key
 * @param {string} geminiModel - The Gemini model to use
 * @returns {Promise<{type: string, genres: string[]}>} - The discovered type and genres
 */
async function discoverTypeAndGenres(query, geminiKey, geminiModel) {
  const genAI = new GoogleGenerativeAI(geminiKey);
  const model = genAI.getGenerativeModel({ model: geminiModel });

  const promptText = `
Analyze this recommendation query: "${query}"

Determine:
1. What type of content is being requested (movie, series, or ambiguous)
2. What genres are relevant to this query (be specific and use standard genre names)

Respond in a single line with pipe-separated format:
type|genre1,genre2,genre3

Where:
- type is one of: movie, series, ambiguous
- genres are comma-separated without spaces or all if no specific genres are discovered in the query

Examples:
movie|action,thriller,sci-fi
series|comedy,drama
ambiguous|romance,comedy
movie|all
series|all
ambiguous|all

Do not include any explanatory text before or after your response. Just the single line.
`;

  try {
    logger.info("Making genre discovery API call", {
      query,
      model: geminiModel,
    });

    // Use withRetry for the Gemini API call
    const text = await withRetry(
      async () => {
        try {
          const aiResult = await model.generateContent(promptText);
          const response = await aiResult.response;
          const responseText = response.text().trim();

          // Log successful response with more details
          logger.info("Genre discovery API response", {
            promptTokens: aiResult.promptFeedback?.tokenCount,
            candidates: aiResult.candidates?.length,
            safetyRatings: aiResult.candidates?.[0]?.safetyRatings,
            responseTextLength: responseText.length,
            responseTextSample: responseText,
          });

          return responseText;
        } catch (error) {
          // Enhance error with status for retry logic
          logger.error("Genre discovery API call failed", {
            error: error.message,
            status: error.httpStatus || 500,
            stack: error.stack,
          });
          error.status = error.httpStatus || 500;
          throw error;
        }
      },
      {
        maxRetries: 3,
        initialDelay: 2000,
        maxDelay: 10000,
        // Don't retry 400 errors (bad requests)
        shouldRetry: (error) => !error.status || error.status !== 400,
        operationName: "Genre discovery API call",
      }
    );

    // Extract the first line in case there's multiple lines
    const firstLine = text.split("\n")[0].trim();

    // Try to parse the pipe-separated format
    try {
      // Split by pipe to get type and genres
      const parts = firstLine.split("|");

      if (parts.length !== 2) {
        logger.error("Invalid format in genre discovery response", {
          text: firstLine,
          parts: parts.length,
        });
        return { type: "ambiguous", genres: [] };
      }

      // Get type and normalize it
      let type = parts[0].trim().toLowerCase();
      if (type !== "movie" && type !== "series") {
        type = "ambiguous";
      }

      // Get genres
      const genres = parts[1]
        .split(",")
        .map((g) => g.trim())
        .filter((g) => g.length > 0 && g.toLowerCase() !== "ambiguous");

      // If the only genre is "all", clear the genres array to use all genres
      if (genres.length === 1 && genres[0].toLowerCase() === "all") {
        logger.info(
          "'All' genres specified, will use all genres for recommendations",
          {
            query,
            type,
          }
        );
        return {
          type: type,
          genres: [],
        };
      }

      logger.info("Successfully parsed genre discovery response", {
        type: type,
        genresCount: genres.length,
        genres: genres,
      });

      return {
        type: type,
        genres: genres,
      };
    } catch (error) {
      logger.error("Failed to parse genre discovery response", {
        error: error.message,
        text: firstLine,
        fullResponse: text,
      });
      return { type: "ambiguous", genres: [] };
    }
  } catch (error) {
    logger.error("Genre discovery API error", {
      error: error.message,
      stack: error.stack,
    });
    return { type: "ambiguous", genres: [] };
  }
}

/**
 * Filters Trakt data based on specified genres
 * @param {Object} traktData - The complete Trakt data
 * @param {string[]} genres - The genres to filter by
 * @returns {Object} - The filtered Trakt data
 */
function filterTraktDataByGenres(traktData, genres) {
  if (!traktData || !genres || genres.length === 0) {
    return {
      recentlyWatched: [],
      highlyRated: [],
      lowRated: [],
    };
  }

  const { watched, rated } = traktData;
  const genreSet = new Set(genres.map((g) => g.toLowerCase()));

  // Helper function to check if an item has any of the specified genres
  const hasMatchingGenre = (item) => {
    const media = item.movie || item.show;
    if (!media || !media.genres || media.genres.length === 0) return false;

    return media.genres.some((g) => genreSet.has(g.toLowerCase()));
  };

  // Filter watched items by genre
  const recentlyWatched = (watched || []).filter(hasMatchingGenre).slice(0, 25); // Last 25 watched in these genres

  // Filter highly rated items (4-5 stars)
  const highlyRated = (rated || [])
    .filter((item) => item.rating >= 4)
    .filter(hasMatchingGenre)
    .slice(0, 25); // Top 25 highly rated

  // Filter low rated items (1-2 stars)
  const lowRated = (rated || [])
    .filter((item) => item.rating <= 2)
    .filter(hasMatchingGenre)
    .slice(0, 15); // Top 15 low rated

  return {
    recentlyWatched,
    highlyRated,
    lowRated,
  };
}

// Function to increment and get the query counter
function incrementQueryCounter() {
  queryCounter++;
  logger.info("Query counter incremented", { totalQueries: queryCounter });
  return queryCounter;
}

// Function to get the current query count
function getQueryCount() {
  return queryCounter;
}

// Function to set the query counter to a specific value
function setQueryCount(newCount) {
  if (typeof newCount !== "number" || newCount < 0) {
    throw new Error("Query count must be a non-negative number");
  }
  const oldCount = queryCounter;
  queryCounter = newCount;
  logger.info("Query counter manually set", {
    oldCount,
    newCount: queryCounter,
  });
  return queryCounter;
}

/**
 * Checks if a query is asking for new/latest content
 * @param {string} query - The search query
 * @returns {boolean}
 */
function isNewContentQuery(query) {
  const q = query.toLowerCase().trim();
  const currentYear = new Date().getFullYear();
  const nextYear = currentYear + 1;
  const yearPattern = new RegExp(`\\b(${currentYear}|${nextYear})\\b`);

  const patterns = [
    /\b(new|latest|recent)\b/,
    /\b(this|last|past)\s+(year|month)\b/,
    yearPattern, // Dynamic current and next year
    /\bcurrent(ly)?\s+(showing|running|airing|playing|in\s+theaters?)\b/,
    /\bin\s+theaters?\b/,
    /\bnow\s+(showing|playing)\b/,
  ];

  return patterns.some((pattern) => pattern.test(q));
}

/**
 * Analyzes a query using Gemini to get structured TMDB discover parameters
 * @param {string} query - The search query
 * @param {string} type - The content type (movie/series)
 * @param {string} geminiKey - The Gemini API key
 * @param {string} geminiModel - The Gemini model to use
 * @returns {Promise<Object>} - The structured parameters
 */
async function analyzeQueryForDiscover(query, type, geminiKey, geminiModel) {
  // Create a cache key
  const cacheKey = `${query}_${type}`;

  // Check cache first
  if (queryAnalysisCache.has(cacheKey)) {
    const cached = queryAnalysisCache.get(cacheKey);
    logger.info("Query analysis cache hit", {
      cacheKey,
      query,
      type,
      cachedAt: new Date(cached.timestamp).toISOString(),
    });
    return cached.data;
  }

  logger.info("Query analysis cache miss", { cacheKey, query, type });

  // First, use the existing genre extraction logic
  const genreCriteria = extractGenreCriteria(query);

  // Map genre names to TMDB genre IDs - now includes TV specific genres
  const genreNameToId = {
    // Common genres for both movies and TV
    animation: "16",
    comedy: "35",
    crime: "80",
    documentary: "99",
    drama: "18",
    family: "10751",
    mystery: "9648",
    western: "37",

    // Movie-specific genres
    ...(type === "movie"
      ? {
          action: "28",
          adventure: "12",
          fantasy: "14",
          history: "36",
          horror: "27",
          music: "10402",
          romance: "10749",
          scifi: "878",
          "science fiction": "878",
          "tv movie": "10770",
          thriller: "53",
          war: "10752",
        }
      : {}),

    // TV-specific genres
    ...(type === "series"
      ? {
          "action & adventure": "10759",
          action: "10759",
          adventure: "10759",
          kids: "10762",
          children: "10762",
          news: "10763",
          reality: "10764",
          "reality tv": "10764",
          realty: "10764",
          "sci-fi & fantasy": "10765",
          "sci-fi": "10765",
          scifi: "10765",
          fantasy: "10765",
          soap: "10766",
          "soap opera": "10766",
          talk: "10767",
          "talk show": "10767",
          "war & politics": "10768",
          war: "10768",
          politics: "10768",
        }
      : {}),
  };

  // Check if we have sufficient genre information from extractGenreCriteria
  if (
    genreCriteria &&
    (genreCriteria.include.length > 0 || genreCriteria.exclude.length > 0)
  ) {
    const params = {};

    // Handle included genres
    if (genreCriteria.include.length > 0) {
      const includedGenreIds = genreCriteria.include
        .map((genre) => {
          const normalizedGenre = genre.toLowerCase();
          return genreNameToId[normalizedGenre];
        })
        .filter(Boolean);

      if (includedGenreIds.length > 0) {
        params.with_genres = includedGenreIds.join(",");
      }
    }

    // Handle excluded genres
    if (genreCriteria.exclude.length > 0) {
      const excludedGenreIds = genreCriteria.exclude
        .map((genre) => {
          const normalizedGenre = genre.toLowerCase();
          return genreNameToId[normalizedGenre];
        })
        .filter(Boolean);

      if (excludedGenreIds.length > 0) {
        params.without_genres = excludedGenreIds.join(",");
      }
    }

    // Check for date-related keywords in the query
    const currentDate = new Date();
    const oneYearAgo = new Date(currentDate);
    oneYearAgo.setFullYear(currentDate.getFullYear() - 1);

    const q = query.toLowerCase();
    const dateField =
      type === "movie" ? "primary_release_date.gte" : "first_air_date.gte";

    // Simple date pattern matching without AI
    if (q.includes("new") || q.includes("latest")) {
      if (type === "movie") {
        // For movies, stick to current year
        params[dateField] = `${currentDate.getFullYear()}-01-01`;
      } else {
        // For TV shows, use last 18 months to catch recent and current shows
        const eighteenMonthsAgo = new Date(currentDate);
        eighteenMonthsAgo.setMonth(currentDate.getMonth() - 18);
        params[dateField] = eighteenMonthsAgo.toISOString().split("T")[0];
        // Remove the upper bound for "latest" queries
        // params["first_air_date.lte"] = currentDate.toISOString().split("T")[0];
      }
    } else if (q.includes("recent")) {
      params[dateField] = oneYearAgo.toISOString().split("T")[0];
      // For TV shows, add upper bound to ensure recent shows
      if (type === "series") {
        params["first_air_date.lte"] = currentDate.toISOString().split("T")[0];
      }
    } else if (q.includes("this year")) {
      params[dateField] = `${currentDate.getFullYear()}-01-01`;
    } else if (q.includes("past year")) {
      params[dateField] = oneYearAgo.toISOString().split("T")[0];
    }

    // If we have either genre or date criteria, return the params
    if (Object.keys(params).length > 0) {
      logger.debug("Using direct genre/date extraction without AI", {
        query,
        params,
        extractedGenres: genreCriteria,
      });

      // Cache the results
      queryAnalysisCache.set(cacheKey, {
        timestamp: Date.now(),
        data: params,
      });

      return params;
    }
  }

  // If we don't have sufficient information from direct extraction, fall back to AI analysis
  const genAI = new GoogleGenerativeAI(geminiKey);
  const model = genAI.getGenerativeModel({ model: geminiModel });

  const currentDate = new Date();
  const oneYearAgo = new Date(currentDate);
  oneYearAgo.setFullYear(currentDate.getFullYear() - 1);

  const promptText = `Analyze this query for ${
    type === "movie" ? "movies" : "TV shows"
  }: "${query}"

Your task is to convert this query into TMDB discover API parameters.

RESPONSE FORMAT:
Use * as separator between parameters, in this exact order:
${
  type === "movie" ? "primary_release_date.gte" : "first_air_date.gte"
}*with_genres*without_genres

IMPORTANT: Only include parameters that have actual values. Skip empty ones.

DATE HANDLING:
Current date: ${currentDate.toISOString().split("T")[0]}
One year ago: ${oneYearAgo.toISOString().split("T")[0]}

1. Time Periods (ALWAYS use YYYY-MM-DD format):
   - "new/latest": Use ${oneYearAgo.toISOString().split("T")[0]}
   - "this year": Use ${currentDate.getFullYear()}-01-01
   - "past year": Use ${oneYearAgo.toISOString().split("T")[0]}

2. Specific Years:
   - Single year (e.g., "2010"): Use YYYY-01-01
   - Decade format 1 (e.g., "80s"): Use 1980-01-01
   - Decade format 2 (e.g., "1990s"): Use 1990-01-01

3. Relative Terms:
   - "modern/recent": Last 2-3 years
   - "classic/old": Use 1900-01-01
   - "vintage": Use 1920-01-01

4. Special Cases:
   - "between X and Y": Use start date (YYYY-01-01)
   - "pre-YYYY": Use 1900-01-01
   - "post-YYYY": Use YYYY-01-01

GENRE IDs:
${
  type === "movie"
    ? `- Action: 28            - Adventure: 12         - Animation: 16
- Comedy: 35           - Crime: 80            - Documentary: 99
- Drama: 18            - Family: 10751        - Fantasy: 14
- History: 36          - Horror: 27           - Music: 10402
- Mystery: 9648        - Romance: 10749       - Science Fiction: 878
- TV Movie: 10770      - Thriller: 53         - War: 10752
- Western: 37`
    : `- Action & Adventure: 10759  - Animation: 16          - Comedy: 35
- Crime: 80               - Documentary: 99       - Drama: 18
- Family: 10751           - Kids: 10762           - Mystery: 9648
- News: 10763             - Reality: 10764        - Sci-Fi & Fantasy: 10765
- Soap: 10766             - Talk: 10767           - War & Politics: 10768
- Western: 37`
}

MULTI-VALUE FIELDS:
- Use comma (,) for AND: "28,53" means Action AND Thriller
- Use pipe (|) for OR: "28|12" means Action OR Adventure

EXAMPLES:
${
  type === "movie"
    ? `"latest mystery thrillers":
${oneYearAgo.toISOString().split("T")[0]}*9648,53

"new action movies not horror":
${oneYearAgo.toISOString().split("T")[0]}*28*27`
    : `"latest drama series":
${oneYearAgo.toISOString().split("T")[0]}*18

"new reality shows":
${oneYearAgo.toISOString().split("T")[0]}*10764

"current comedy series not reality":
${oneYearAgo.toISOString().split("T")[0]}*35*10764`
}

Respond with ONLY the parameter string, no other text.`;

  try {
    logger.info("Making query analysis API call (fallback)", {
      query,
      type,
      model: geminiModel,
      genreCriteria,
    });

    // Use withRetry for the Gemini API call
    const text = await withRetry(
      async () => {
        try {
          const aiResult = await model.generateContent(promptText);
          const response = await aiResult.response;
          const responseText = response.text().trim();

          logger.info("Query analysis API response", {
            promptTokens: aiResult.promptFeedback?.tokenCount,
            responseText,
          });

          return responseText;
        } catch (error) {
          logger.error("Query analysis API call failed", {
            error: error.message,
            status: error.httpStatus || 500,
          });
          error.status = error.httpStatus || 500;
          throw error;
        }
      },
      {
        maxRetries: 3,
        initialDelay: 2000,
        maxDelay: 10000,
        shouldRetry: (error) => !error.status || error.status !== 400,
        operationName: "Query analysis API call",
      }
    );

    // Parse the response
    const params = {};
    const values = text.split("*").map((param) => param.trim());
    const paramNames = [
      `${type === "movie" ? "primary_release_date" : "first_air_date"}.gte`,
      "with_genres",
      "without_genres",
    ];

    // Only add parameters that have actual values and clean them up
    values.forEach((value, index) => {
      if (value && value !== "") {
        // Clean up the value by removing any parameter name prefixes
        let cleanValue = value;
        const paramName = paramNames[index];

        // Check if the value starts with "paramName:" and remove it
        if (cleanValue.startsWith(`${paramName}:`)) {
          cleanValue = cleanValue.substring(paramName.length + 1).trim();
        }

        // Also check if it starts with just the base name (without .gte/.lte)
        const baseName = paramName.split(".")[0];
        if (cleanValue.startsWith(`${baseName}:`)) {
          cleanValue = cleanValue.substring(baseName.length + 1).trim();
        }

        params[paramNames[index]] = cleanValue;
      }
    });

    logger.debug("Final discover parameters (from AI)", {
      query,
      params,
      extractedGenres: genreCriteria,
    });

    // Cache the results
    queryAnalysisCache.set(cacheKey, {
      timestamp: Date.now(),
      data: params,
    });

    return params;
  } catch (error) {
    logger.error("Query analysis error", {
      error: error.message,
      stack: error.stack,
    });
    return null;
  }
}

/**
 * Fetches content from TMDB discover API
 * @param {Object} params - The discover API parameters
 * @param {string} type - The content type (movie/series)
 * @param {string} tmdbKey - The TMDB API key
 * @param {string} language - The language for results
 * @returns {Promise<Array>} - The discovered items
 */
async function fetchTmdbDiscover(
  params,
  type,
  tmdbKey,
  language = "en-US",
  numResults = 20
) {
  const searchType = type === "movie" ? "movie" : "tv";
  const endpoint = `${TMDB_API_BASE}/discover/${searchType}`;

  // Extract key parameters for the cache key
  const genres = params.with_genres || "any";

  // Get the release date from parameters
  let releaseDate =
    params["primary_release_date.gte"] ||
    params["primary_release_date.lte"] ||
    params["first_air_date.gte"] ||
    params["first_air_date.lte"] ||
    "any";

  // Convert specific date to first day of month for cache key
  if (releaseDate !== "any" && /^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) {
    // Extract year and month from the date string (YYYY-MM-DD)
    const [year, month] = releaseDate.split("-");
    // Use first day of month for cache key
    releaseDate = `${year}-${month}-01`;
  }

  // Create a more concise cache key
  const cacheKey = `discover_${type}_${genres}_${releaseDate}_${language}`;

  // Check cache first
  if (tmdbDiscoverCache.has(cacheKey)) {
    const cached = tmdbDiscoverCache.get(cacheKey);
    logger.info("TMDB discover cache hit", {
      cacheKey,
      type,
      cachedAt: new Date(cached.timestamp).toISOString(),
    });

    // Randomly select items from the cached results to provide variety
    const allCachedResults = cached.data;
    if (allCachedResults.length > numResults) {
      // Shuffle the array using Fisher-Yates algorithm
      const shuffled = [...allCachedResults];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }

      // Take the first numResults items from the shuffled array
      const randomSelection = shuffled.slice(0, numResults);

      logger.debug("Randomly selected items from cached results", {
        totalCachedItems: allCachedResults.length,
        selectedItems: numResults,
      });

      return randomSelection;
    }

    return cached.data;
  }

  logger.info("TMDB discover cache miss", { cacheKey, type });

  try {
    // Filter out internal properties that shouldn't be sent to TMDB
    const filteredParams = Object.fromEntries(
      Object.entries(params).filter(([key, value]) => value !== undefined)
    );

    // Build base query parameters
    const baseParams = {
      api_key: tmdbKey,
      language: language,
      include_adult: false,
      sort_by: "vote_average.desc",
      vote_count: 100,
      ...filteredParams,
    };

    let allResults = [];
    let currentPage = 1;
    let totalPages = 1;

    do {
      const queryParams = new URLSearchParams({
        ...baseParams,
        page: currentPage,
      });

      const url = `${endpoint}?${queryParams.toString()}`;

      logger.info("Making TMDB discover API call", {
        url: url.replace(tmdbKey, "***"),
        params: {
          ...baseParams,
          api_key: "***", // Mask the API key
          page: currentPage,
        },
        progress: `Page ${currentPage}/${totalPages}`,
      });

      const response = await withRetry(
        async () => {
          const res = await fetch(url);
          if (!res.ok) {
            const error = new Error(`TMDB discover API error: ${res.status}`);
            error.status = res.status;
            throw error;
          }
          return res.json();
        },
        {
          maxRetries: 3,
          initialDelay: 1000,
          maxDelay: 8000,
          operationName: "TMDB discover API call",
        }
      );

      // Update total pages on first response
      if (currentPage === 1) {
        totalPages = Math.min(response.total_pages, 5); // Limit to 5 pages (100 results) to avoid excessive API calls
      }

      // Transform and add results
      const transformedResults = response.results.map((item) => ({
        name: item.title || item.name,
        year: new Date(item.release_date || item.first_air_date).getFullYear(),
        type: type,
        id: `tmdb_${type}_${item.id}`,
        tmdb_id: item.id,
        poster: item.poster_path
          ? `https://image.tmdb.org/t/p/w500${item.poster_path}`
          : null,
        backdrop: item.backdrop_path
          ? `https://image.tmdb.org/t/p/original${item.backdrop_path}`
          : null,
        overview: item.overview,
        vote_average: item.vote_average,
        vote_count: item.vote_count,
        genres: item.genre_ids,
      }));

      allResults = allResults.concat(transformedResults);
      currentPage++;
    } while (currentPage <= totalPages);

    // Cache the combined results
    tmdbDiscoverCache.set(cacheKey, {
      timestamp: Date.now(),
      data: allResults,
    });

    logger.debug("TMDB discover results cached", {
      cacheKey,
      resultsCount: allResults.length,
      totalPages,
    });

    // If we have more than numResults results, randomly select numResults to return
    if (allResults.length > numResults) {
      // Shuffle the array using Fisher-Yates algorithm
      const shuffled = [...allResults];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }

      // Take the first numResults items from the shuffled array
      const randomSelection = shuffled.slice(0, numResults);

      logger.debug("Randomly selected items from new results", {
        totalItems: allResults.length,
        selectedItems: numResults,
      });

      return randomSelection;
    }

    return allResults;
  } catch (error) {
    logger.error("TMDB discover API Error:", {
      error: error.message,
      stack: error.stack,
    });
    return [];
  }
}
function getRpdbTierFromApiKey(apiKey) {
  if (!apiKey) return -1;
  try {
    const tierMatch = apiKey.match(/^t(\d+)-/);
    if (tierMatch && tierMatch[1] !== undefined) {
      return parseInt(tierMatch[1]);
    }
    return -1;
  } catch (error) {
    logger.error("Error parsing RPDB tier from API key", {
      error: error.message,
    });
    return -1;
  }
}
module.exports = {
  builder,
  addonInterface,
  catalogHandler,
  clearTmdbCache,
  clearTmdbDetailsCache,
  clearTmdbDiscoverCache,
  clearAiCache,
  removeAiCacheByKeywords,
  clearRpdbCache,
  clearTraktCache,
  clearTraktRawDataCache,
  clearQueryAnalysisCache,
  getCacheStats,
  serializeAllCaches,
  deserializeAllCaches,
  discoverTypeAndGenres,
  filterTraktDataByGenres,
  incrementQueryCounter,
  getQueryCount,
  setQueryCount,
  isNewContentQuery,
  analyzeQueryForDiscover,
  fetchTmdbDiscover,
  removeTmdbDiscoverCacheItem,
  listTmdbDiscoverCacheKeys,
  getRpdbTierFromApiKey,
  searchTMDBExactMatch,
};
