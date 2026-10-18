const logger = require("./utils/logger");
const { decryptConfig } = require("./utils/crypto");
const { withRetry } = require("./utils/apiRetry");
const {
  createAiTextGenerator,
  getAiProviderConfigFromConfig,
} = require("./utils/aiProvider");
const {
  analyzeQueryLanguage,
  getLanguageName,
} = require("./utils/queryLanguage");
const { isRecencyQuery } = require("./utils/queryRecency");
const { SimpleLRUCache } = require("./utils/cache");
const { HOST, BASE_PATH } = require("./utils/host");
const {
  tmdbCache,
  tmdbDetailsCache,
  tmdbDiscoverCache,
  validateTmdbKey,
  searchTMDB,
  searchTmdbTitles,
  getTmdbDetailsByImdbId,
  fetchRecentReleases,
  genreNames,
} = require("./utils/tmdb");
const {
  rpdbCache,
  fanartCache,
  getRpdbSettings,
  fetchRpdbPoster,
  getLandscapeThumbnail,
} = require("./utils/artwork");

const AI_CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_AI_RECOMMENDATIONS = 30;
const MAX_SIMILAR_RECOMMENDATIONS = 25;
const DEFAULT_HOMEPAGE_QUERY =
  "AI Recommendations:recommend a hidden gem movie, AI Recommendations:recommend a binge-worthy series";

const aiRecommendationsCache = new SimpleLRUCache({
  max: 25000,
  ttl: AI_CACHE_DURATION,
});

const similarContentCache = new SimpleLRUCache({
  max: 5000,
  ttl: AI_CACHE_DURATION,
});

// Every persisted cache, keyed by the file name it is saved under in
// cache_data/ (<name>.json.gz).
const CACHES = {
  tmdbCache,
  tmdbDetailsCache,
  tmdbDiscoverCache,
  aiRecommendationsCache,
  rpdbCache,
  fanartCache,
  similarContentCache,
};

// Short names used by the admin endpoints (/cache/clear/<alias>).
const CACHE_ALIASES = {
  tmdb: "tmdbCache",
  "tmdb-details": "tmdbDetailsCache",
  "tmdb-discover": "tmdbDiscoverCache",
  ai: "aiRecommendationsCache",
  rpdb: "rpdbCache",
  fanart: "fanartCache",
  similar: "similarContentCache",
};

// Stats counter for tracking total queries
let queryCounter = 0;

setInterval(() => {
  logger.info("Cache statistics", getCacheStats());
}, 60 * 60 * 1000).unref();

const manifest = {
  id: "au.itcon.aisearch",
  version: "1.0.65",
  name: "AI Search",
  description: "AI-powered movie and series recommendations",
  // Ownership proof for stremio-addons.net. Must appear in every manifest we
  // serve; server.js builds the unconfigured manifest from this one.
  stremioAddonsConfig: {
    issuer: "https://stremio-addons.net",
    signature:
      "eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..IuQnMO0MAGwCCkdKhW253w.sdxXckhHtOmnSWY9RdfK2UWbGmpVwZNrukt67ytRDizG4x1MlNd8qWr_PIaMRM3Eqx2Mq7l1Pvx1yaKKKPs7IRj2gBnbg1rkwchEtWZbeKf71eT7hgcg2rbB7nvJij-k._iJUauFMIGT_3nw0pdgpJg",
  },
  resources: [
    "catalog",
    {
      name: "meta",
      types: ["movie", "series"],
      idPrefixes: ["ai-recs"],
    },
    {
      name: "stream",
      types: ["movie", "series"],
      idPrefixes: ["tt"],
    },
  ],
  types: ["movie", "series"],
  catalogs: [
    {
      type: "movie",
      id: "aisearch.top",
      name: "AI Movie Search",
      extra: [{ name: "search", isRequired: true }],
      isSearch: true,
    },
    {
      type: "series",
      id: "aisearch.top",
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

/**
 * Creates a Stremio meta object with a dynamically generated SVG poster for displaying errors.
 * @param {string} title - The title of the error message.
 * @param {string} message - The main body of the error message.
 * @returns {object} A Stremio meta object.
 */
function createErrorMeta(title, message) {
  // Simple text wrapping for the message
  const words = message.split(" ");
  const lines = [];
  let currentLine = words[0] || "";
  for (let i = 1; i < words.length; i++) {
    const testLine = currentLine + " " + words[i];
    if (testLine.length > 35) {
      // Approx characters per line
      lines.push(currentLine);
      currentLine = words[i];
    } else {
      currentLine = testLine;
    }
  }
  lines.push(currentLine);

  const messageTspans = lines
    .map((line, index) => `<tspan x="250" y="${560 + index * 30}">${line}</tspan>`)
    .join("");

  const svg = `
    <svg width="500" height="750" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#2d2d2d" />
      <path d="M250 50 L450 400 L50 400 Z" fill="#c0392b"/>
      <path d="M250 120 L400 380 L100 380 Z" fill="#e74c3c"/>
      <text fill="white" font-size="60" font-family="Arial, sans-serif" x="250" y="270" text-anchor="middle" font-weight="bold">!</text>
      <text fill="white" font-size="32" font-family="Arial, sans-serif" x="250" y="500" text-anchor="middle" font-weight="bold">${title}</text>
      <text fill="white" font-size="24" font-family="Arial, sans-serif" text-anchor="middle">
        ${messageTspans}
      </text>
      <text fill="#bdc3c7" font-size="20" font-family="Arial, sans-serif" x="250" y="700" text-anchor="middle">Please check the addon configuration.</text>
    </svg>
  `;

  return {
    id: `error:${title.replace(/\s+/g, "_")}`,
    type: "movie",
    name: title,
    description: message,
    poster: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
    posterShape: "regular",
  };
}

function errorResponse(title, message) {
  logger.error(title, { reason: message });
  return { metas: [createErrorMeta(title, message)] };
}

// [pattern, weight] pairs scored by determineIntentFromKeywords.
const MOVIE_INTENT_PATTERNS = [
  [/\bmovie(s)?\b/, 3],
  [/\bfilm(s)?\b/, 3],
  [/\bcinema\b/, 3],
  [/\bfeature\b/, 3],
  [/\bmotion picture\b/, 3],
  [/\bdirector\b/, 2],
  [/\bscreenplay\b/, 2],
  [/\bboxoffice\b/, 2],
  [/\btheater\b/, 2],
  [/\btheatre\b/, 2],
  [/\bcinematic\b/, 2],
  [/\bwatch\b/, 1],
  [/\bactor\b/, 1],
  [/\bactress\b/, 1],
  [/\bscreenwriter\b/, 1],
  [/\bproducer\b/, 1],
  [/\b(cinema|theatrical|box office|imax)\b/, 1],
];

const SERIES_INTENT_PATTERNS = [
  [/\bseries\b/, 3],
  [/\btv show(s)?\b/, 3],
  [/\btelevision\b/, 3],
  [/\bshow(s)?\b/, 3],
  [/\bepisode(s)?\b/, 3],
  [/\bseason(s)?\b/, 3],
  [/\bdocumentary?\b/, 3],
  [/\bdocumentaries?\b/, 3],
  [/\bnetflix\b/, 2],
  [/\bhbo\b/, 2],
  [/\bhulu\b/, 2],
  [/\bamazon prime\b/, 2],
  [/\bdisney\+\b/, 2],
  [/\bapple tv\+\b/, 2],
  [/\bpilot\b/, 2],
  [/\bfinale\b/, 2],
  [/\bcharacter\b/, 1],
  [/\bcast\b/, 1],
  [/\bplot\b/, 1],
  [/\bstoryline\b/, 1],
  [/\bnarrative\b/, 1],
  [/\b(netflix|hulu|hbo|disney\+|apple tv\+)\b/, 1],
  [/\b\d{4}-\d{4}\b/, 1],
];

function scoreIntent(query, patterns) {
  return patterns.reduce((score, [pattern, weight]) => score + (pattern.test(query) ? weight : 0), 0);
}

/**
 * Determines the intent of a search query based on keywords
 * @param {string} query
 * @returns {"movie"|"series"|"ambiguous"}
 */
function determineIntentFromKeywords(query) {
  if (!query) return "ambiguous";

  const normalizedQuery = query.toLowerCase().trim();
  const movieScore = scoreIntent(normalizedQuery, MOVIE_INTENT_PATTERNS);
  const seriesScore = scoreIntent(normalizedQuery, SERIES_INTENT_PATTERNS);

  if (Math.abs(movieScore - seriesScore) < 2) return "ambiguous";
  return movieScore > seriesScore ? "movie" : "series";
}

/**
 * Parses the user's homepage setting ("Title:query, Title:query, ...") into
 * catalog entries. The manifest and the catalog handler both index into this
 * list, so they must parse it identically.
 */
function parseHomepageQueries(configData) {
  const raw = (configData?.HomepageQuery || "").trim() || DEFAULT_HOMEPAGE_QUERY;
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const parts = entry.split(/:(.*)/s);
      if (parts.length > 1 && parts[0].trim() && parts[1].trim()) {
        return { title: parts[0].trim(), query: parts[1].trim() };
      }
      return { title: entry, query: entry };
    });
}

/** Homepage catalogs for the configured manifest (empty when disabled). */
function buildHomepageCatalogs(configData) {
  if (configData?.EnableHomepage === false) return [];
  const catalogs = [];
  parseHomepageQueries(configData).forEach(({ title, query }, index) => {
    const intent = determineIntentFromKeywords(query);
    for (const type of ["movie", "series"]) {
      if (intent === type || intent === "ambiguous") {
        catalogs.push({ type, id: `aisearch.home.${index}.${type}`, name: title });
      }
    }
  });
  return catalogs;
}

const BASIC_GENRES = {
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

const SUB_GENRES = {
  cyberpunk: /\b(cyberpunk|cyber\s*punk)\b/i,
  noir: /\b(noir|neo-noir)\b/i,
  psychological: /\b(psychological)\b/i,
  superhero: /\b(superhero|comic\s*book|marvel|dc)\b/i,
  musical: /\b(musical|music)\b/i,
  war: /\b(war|military)\b/i,
  western: /\b(western|cowboy)\b/i,
  sports: /\b(sports?|athletic)\b/i,
};

const MOODS = {
  feelGood: /\b(feel-?good|uplifting|heartwarming)\b/i,
  dark: /\b(dark|gritty|disturbing)\b/i,
  thoughtProvoking: /\b(thought-?provoking|philosophical|deep)\b/i,
  intense: /\b(intense|gripping|edge.*seat)\b/i,
  lighthearted: /\b(light-?hearted|fun|cheerful)\b/i,
};

// Common genre aliases that might appear in exclusions
const GENRE_ALIASES = {
  "sci-fi": "scifi",
  "science fiction": "scifi",
  "rom-com": "comedy",
  "romantic comedy": "comedy",
  "rom com": "comedy",
  "super hero": "superhero",
  "super-hero": "superhero",
};

const SUPPORTED_GENRES = new Set([
  ...Object.keys(BASIC_GENRES),
  ...Object.keys(SUB_GENRES),
  ...Object.keys(GENRE_ALIASES),
]);

const COMBINED_GENRE_PATTERN =
  /(?:action[- ]comedy|romantic[- ]comedy|sci-?fi[- ]horror|dark[- ]comedy|romantic[- ]thriller)/i;

function extractGenreCriteria(query) {
  const q = query.toLowerCase();

  // First, find all negated genres
  const notPattern = /\b(?:not|no|except|excluding)\s+(\w+(?:\s+\w+)?)/gi;
  const excludedGenres = new Set();
  let match;
  while ((match = notPattern.exec(q)) !== null) {
    const negatedTerm = match[1].toLowerCase().trim();
    if (SUPPORTED_GENRES.has(negatedTerm)) {
      excludedGenres.add(GENRE_ALIASES[negatedTerm] || negatedTerm);
      continue;
    }
    for (const table of [BASIC_GENRES, SUB_GENRES]) {
      for (const [genre, pattern] of Object.entries(table)) {
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

  const combinedMatch = q.match(COMBINED_GENRE_PATTERN);
  if (combinedMatch) {
    genres.include.push(combinedMatch[0].toLowerCase().replace(/\s+/g, "-"));
  }

  // Include matched genres that are neither excluded nor right after a negation
  for (const table of [BASIC_GENRES, SUB_GENRES]) {
    for (const [genre, pattern] of Object.entries(table)) {
      if (pattern.test(q) && !excludedGenres.has(genre)) {
        const beforeGenre = q.substring(0, q.search(pattern));
        if (!/\b(not|no|except|excluding)\s+$/.test(beforeGenre)) {
          genres.include.push(genre);
        }
      }
    }
  }

  for (const [mood, pattern] of Object.entries(MOODS)) {
    if (pattern.test(q)) genres.mood.push(mood);
  }

  return Object.values(genres).some((arr) => arr.length > 0) ? genres : null;
}

function isRecommendationQuery(query) {
  return query.toLowerCase().trim().startsWith("recommend");
}

/**
 * Runs an array of async tasks with a maximum concurrency limit.
 * Prevents simultaneous API calls from overwhelming rate limits.
 */
async function limitedPromiseAll(tasks, concurrency = 8) {
  const results = new Array(tasks.length);
  let index = 0;
  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

/**
 * Converts an AI recommendation ({ name, year, type }) into a Stremio meta,
 * or null when TMDB has no IMDb id or poster for it.
 */
async function toStremioMeta(item, { platform, tmdbKey, language, includeAdult, rpdb }) {
  if (!item.id || !item.name) return null;

  const type = item.type || (item.id.includes("movie") ? "movie" : "series");
  const tmdbData = await searchTMDB(
    item.name,
    type,
    item.year,
    tmdbKey,
    language,
    includeAdult,
    item.queryLang || null
  );
  if (!tmdbData || !tmdbData.imdb_id) return null;

  let poster = tmdbData.poster;
  let posterSource = "tmdb";
  if (rpdb.enabled) {
    const rpdbPoster = await fetchRpdbPoster(tmdbData.imdb_id, rpdb);
    if (rpdbPoster) {
      poster = rpdbPoster;
      posterSource = "rpdb";
    }
  }
  if (!poster) return null;

  const isAndroidTv = platform === "android-tv";
  const meta = {
    id: tmdbData.imdb_id,
    type,
    name: tmdbData.title || tmdbData.name,
    description: isAndroidTv
      ? (tmdbData.overview || "").slice(0, 200)
      : tmdbData.overview || "",
    year: parseInt(item.year) || 0,
    poster: isAndroidTv && poster.includes("/w500/") ? poster.replace("/w500/", "/w342/") : poster,
    background: tmdbData.backdrop,
    posterShape: "regular",
    posterSource,
  };

  if (tmdbData.genres && tmdbData.genres.length > 0) {
    meta.genres = genreNames(tmdbData.genres, type);
  }
  if (type === "movie") {
    meta.behaviorHints = { defaultVideoId: meta.id };
  }
  return meta;
}

/** Builds the prompt for a catalog search. */
async function buildSearchPrompt({
  searchQuery,
  type,
  numResults,
  tmdbInitialResults,
  tmdbKey,
  includeAdult,
  queryLang,
  queryLangMatch,
  mentionedLang,
  isHomepageQuery,
  enableGrounding,
}) {
  const genreCriteria = extractGenreCriteria(searchQuery);
  const currentYear = new Date().getFullYear();

  let franchiseInstruction = `your TOP PRIORITY is to list ALL official mainline movies from that franchise, followed by any relevant spin-offs or related content.`;
  if (type === "series") {
    franchiseInstruction = `your TOP PRIORITY is to provide a **comprehensive list** of ALL television content related to that franchise. Your search MUST include, but is not limited to:
        - Official narrative series and mini-series (both live-action and animated).
        - Documentary series (e.g., 'making of' or historical series like 'Icons Unearthed').
        - Competition or reality shows (e.g., 'Hogwarts Tournament of Houses', 'Wizards of Baking').
        - Any related TV specials or one-off televised events.`;
  }

  const prompt = [
    `You are a ${type} recommendation expert. Analyze this query: "${searchQuery}"`,
    "",
    "QUERY ANALYSIS:",
  ];
  if (genreCriteria?.include?.length > 0) {
    prompt.push(`Requested genres: ${genreCriteria.include.join(", ")}`);
  }
  if (genreCriteria?.mood?.length > 0) {
    prompt.push(`Mood/Style: ${genreCriteria.mood.join(", ")}`);
  }
  prompt.push("");

  if (tmdbInitialResults.length > 0) {
    const initialTitles = tmdbInitialResults
      .slice(0, 15)
      .map(
        (item) =>
          `- ${item.title || item.name} (${(item.release_date || item.first_air_date || "N/A").substring(0, 4)})`
      )
      .join("\n");

    prompt.push(
      "CONTEXT FROM INITIAL DATABASE SEARCH:",
      "The following is a list of relevant titles found in an initial database search. Your main task is use this as the primary data source, add any official entries that might be missing, add similar titles, sort them by relevance and return the comprehensive list.",
      "",
      "Found Titles:",
      initialTitles,
      "",
      `If you are unable to collate ${numResults} ${type} recommendations add the missing ones from the initial database search results to the end of your recommendations.`
    );
  }

  // On recency queries the AI's training cutoff means it cannot know the
  // newest releases, so ground the prompt with live TMDB data (filtered to
  // the requested language when one was detected). The AI still authors
  // every recommendation — this only tells it what exists.
  if (isRecencyQuery(searchQuery, currentYear)) {
    const recentReleases = await fetchRecentReleases(type, tmdbKey, queryLang, includeAdult);
    if (recentReleases.length > 0) {
      const recentTitles = recentReleases
        .map((item) => {
          const title = item.title || item.name;
          const date = (item.release_date || item.first_air_date || "").slice(0, 4);
          const overview = String(item.overview || "").slice(0, 120);
          return `- ${title} (${date})${overview ? `: ${overview}` : ""}`;
        })
        .join("\n");

      prompt.push(
        "RECENT RELEASES CONTEXT (live from TMDB, current as of today):",
        "The user is asking about new/recent releases. Your training data may not include the newest titles. Every title below is a REAL, released title matching the requested recency" +
          (queryLang ? ` and original language (${getLanguageName(queryLang)})` : "") +
          ".",
        "For the recent portion of your recommendations, choose the best matches for the query FROM THIS LIST rather than from memory. You may add older titles you know where the query allows it.",
        "",
        recentTitles,
        ""
      );
    }
  }

  const examplesText =
    type === "movie"
      ? ["EXAMPLES:", "movie|The Matrix|1999", "movie|Inception|2010"].join("\n")
      : ["EXAMPLES:", "series|Breaking Bad|2008", "series|Game of Thrones|2011"].join("\n");

  prompt.push(
    "IMPORTANT INSTRUCTIONS:",
    `- Base your recommendations on the most current, publicly available information, especially for queries about new, recent, or future releases.`,
    `- Current year is ${currentYear}. For time-based queries:`,
    `  * 'past year' means content from ${currentYear - 1} to ${currentYear}`,
    `  * 'recent' means within the last 2-3 years (${currentYear - 2} to ${currentYear})`,
    `  * 'new' or 'latest' means released in ${currentYear}`,
    "SPECIFIC QUERY HANDLING:",
    "First, determine if the query matches one of the types below. If it does, follow its rules precisely.",
    "",
    `0. EXACT TITLE LOOKUP: If the query appears to be the specific name of a single movie or TV show (e.g., 'Inception', 'The Godfather', 'Breaking Bad', 'Parasite') — rather than a genre, mood, theme, or person — you MUST include that exact title as the FIRST result, regardless of your quality judgment. After the exact title, fill the remaining slots with closely related or similar content.`,
    `   - The user searched for this title directly; omitting it is always wrong.`,
    "",
    `1. FRANCHISE/SERIES: If the query is for a specific title that is part of a larger series (e.g., 'Shrek', 'The Matrix Reloaded', 'Harry Potter', 'star wars', 'Jurassic Park') or explicitly asks for a franchise ('James Bond movies'), ${franchiseInstruction}`,
    `   - List them first, in STRICT chronological order of release.`,
    `   - After listing the entire franchise, if you need more results to reach the count of ${numResults}, you may add official spin-offs or highly similar titles.`,
    "",
    `2. ACTOR/DIRECTOR/STUDIO FILMOGRAPHY: If the query is for the works of a person or entity (e.g., 'Tom Cruise movies', 'Christopher Nolan films', 'Pixar movies', 'Marvel movies', 'dc universe', 'Fast and Furious franchise'), list their most notable and critically acclaimed works.`,
    `   - Provide a comprehensive selection covering different genres and eras of their career.`,
    `   - Order these results chronologically by release year.`,
    "",
    `3. GENERAL RECOMMENDATIONS: For ALL other queries, provide diverse recommendations that best match the query's theme, genre, and mood.`,
    `   - Order these results by their relevance to the query.`,
    "CRITICAL REQUIREMENTS:",
    // Only instruct the model to use Google Search when grounding is
    // actually enabled — otherwise it's told to use a tool it doesn't have.
    enableGrounding
      ? `- You MUST use the Google Search tool to find ALL recommendations. Your internal knowledge is outdated and should only be used in conjunction with Google search tool for this task.`
      : `- For new or recent releases, rely on the RECENT RELEASES CONTEXT above when provided — your internal knowledge of very recent titles may be incomplete or outdated.`
  );
  if (isHomepageQuery) {
    const rotationBucket = Math.floor(Math.random() * 50) + 1;
    prompt.push(
      `- VARIETY REQUIREMENT: This is a homepage recommendation shown repeatedly to the user. You MUST provide a fresh, diverse selection. Rotation key: ${rotationBucket}. Do NOT default to the same well-known titles you would typically recommend first — explore the full spectrum of excellent ${type}s matching this query, including lesser-known gems, international titles, and titles from different eras.`
    );
  }
  prompt.push(
    `- You MUST return upto ${numResults} ${type} recommendations. If you can't find enough perfect matches, broaden your criteria while staying within the genre/theme requirements.`,
    `- Prioritize quality over exact matching for genre/theme/mood queries — but if the query looks like a specific title, that exact title MUST appear first in your results.`,
    `- If the user has watched many content in the requested genre, consider recommending lesser-known gems, international films, or recent releases they might have missed.`,
    "",
    "RESPONSE FORMAT: You MUST respond in the following format (without any additional commentary):",
    "[type]|[name]|[year]",
    "",
    examplesText,
    "",
    "RULES:",
    "- Use | separator",
    "- Year: YYYY format",
    `- Type: Accurately label each item as 'movie' or 'series'.`,
    "- Titles: Provide clean, official titles only. Do NOT add extra text like '(film)', '(documentary)', or other descriptions.",
    "- Content: ONLY include official, released movies and TV series. Exclude games, books, fan-made content, and stage productions.",
    "- Only best matches that strictly match ALL query requirements",
    "- If specific genres/time periods are requested, ALL recommendations must match those criteria"
  );

  if (genreCriteria) {
    if (genreCriteria.include.length > 0) {
      prompt.push(`- Must match genres: ${genreCriteria.include.join(", ")}`);
    }
    if (genreCriteria.exclude.length > 0) {
      prompt.push(`- Exclude genres: ${genreCriteria.exclude.join(", ")}`);
    }
    if (genreCriteria.mood.length > 0) {
      prompt.push(`- Match mood/style: ${genreCriteria.mood.join(", ")}`);
    }
  }

  if (queryLang) {
    const name = getLanguageName(queryLang);
    prompt.push(
      `- LANGUAGE REQUIREMENT: The user asked for ${name}-language content. ALL recommendations MUST be titles whose ORIGINAL language is ${name}. Do NOT include titles originally made in other languages, and do NOT substitute a popular foreign film with a similar name.`
    );
  } else if (mentionedLang) {
    const mentionedName = getLanguageName(mentionedLang);
    prompt.push(
      `- LANGUAGE NOTE: The query mentions something ${mentionedName}-related ("${queryLangMatch.alias}"). Only prefer titles whose original language is ${mentionedName} if the user is asking for ${mentionedName}-language content. If the word only describes a character, place or subject (e.g. "a movie about a Mexican boy"), do NOT filter by original language — recommend the titles that best match the description, whatever their language.`
    );
  }

  return { prompt: prompt.join("\n"), genreCriteria };
}

/**
 * Parses "type|name|year" lines (also "type|name (year)") from the AI
 * response, keeping only items of the requested type.
 */
function parseRecommendationLines(text, type, queryLang) {
  const items = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("type|")) continue;

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
        name = nameWithYear.substring(0, nameWithYear.lastIndexOf("(")).trim();
      } else {
        const anyYearMatch = nameWithYear.match(/\b(19\d{2}|20\d{2})\b/);
        if (!anyYearMatch) continue;
        year = anyYearMatch[0];
        name = nameWithYear.replace(anyYearMatch[0], "").trim();
      }
    } else {
      continue;
    }

    const yearNum = parseInt(year);
    if (lineType !== type || !name || !yearNum) continue;
    items.push({
      name,
      year: yearNum,
      type,
      // Carried through to searchTMDB so title resolution can prefer
      // candidates in the language the user asked for.
      queryLang: queryLang || undefined,
      id: `ai_${type}_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
    });
  }
  return items;
}

/**
 * Calls the AI with retry. Errors that cannot fix themselves are not retried:
 * bad requests, bad keys, out of credits (402) and unknown models (404, e.g.
 * a retired Gemini model) fail on the first attempt instead of after ~15s.
 */
function generateWithRetry(aiClient, prompt, operationName) {
  return withRetry(
    async () => {
      try {
        return await aiClient.generateText(prompt);
      } catch (error) {
        error.status = error.status || error.httpStatus || 500;
        throw error;
      }
    },
    {
      maxRetries: 3,
      initialDelay: 2000,
      maxDelay: 10000,
      shouldRetry: (error) => ![400, 401, 402, 403, 404].includes(error.status),
      operationName,
    }
  );
}

function describeAiError(error, provider) {
  const status = error.status || error.httpStatus;
  const message = typeof error.message === "string" ? error.message : "";
  const openai = provider === "openai-compat";

  if (
    status === 402 ||
    /requires more credits|insufficient (credits|funds|balance)|payment required/i.test(message)
  ) {
    return "Your AI provider account is out of credits. Please add credits (or raise the key's spending limit) with your provider, then try again.";
  }
  if (status === 401 || status === 403 || /api key|unauthorized|forbidden/i.test(message)) {
    return openai
      ? "Your OpenAI-compatible API key is invalid or has been revoked. Please update it in the settings."
      : "Your Gemini API key is invalid or has been revoked. Please update it in the settings.";
  }
  if (status === 429 || /quota|rate limit/i.test(message)) {
    return openai
      ? "You have exceeded your OpenAI-compatible provider quota/rate limit. Please check your provider account."
      : "You have exceeded your Gemini API quota for the day. Please check your Google AI Studio account.";
  }
  if (status === 404 || /not found/i.test(message)) {
    return openai
      ? "The selected model was not found. Please try a different model name in the settings."
      : "The selected Gemini Model is invalid or not found. Please try a different model in the settings.";
  }
  return "The AI model failed to respond. This may be a temporary issue.";
}

/** Recommendations cached for this query, or null on a miss/stale entry. */
function getCachedRecommendations(cacheKey, type, numResults) {
  const cached = aiRecommendationsCache.get(cacheKey);
  if (!cached) return null;

  const items = cached.data?.recommendations?.[type === "movie" ? "movies" : "series"];
  // A larger NumResults than the cached run asked for needs a fresh answer.
  if (!items?.length || (cached.configNumResults && numResults > cached.configNumResults)) {
    aiRecommendationsCache.delete(cacheKey);
    return null;
  }
  return items;
}

const catalogHandler = async function (args, req) {
  const startTime = Date.now();
  const { id, type, extra } = args;

  try {
    const configData = args.config;
    if (!configData || Object.keys(configData).length === 0) {
      return errorResponse(
        "Configuration Missing",
        "The addon has not been configured yet. Please set your API keys."
      );
    }

    const tmdbKey = configData.TmdbApiKey;
    const aiProviderConfig = getAiProviderConfigFromConfig(configData);
    let aiClient;
    try {
      aiClient = createAiTextGenerator(aiProviderConfig);
    } catch (error) {
      logger.error("AI provider configuration error", { error: error.message });
      return {
        metas: [
          createErrorMeta(
            "AI Provider Configuration Error",
            "The selected AI provider is misconfigured. Please review your addon settings."
          ),
        ],
      };
    }

    if (!tmdbKey || tmdbKey.length < 10) {
      return errorResponse(
        "TMDB API Key Invalid",
        "Your TMDB API key is missing or invalid. Please correct it in the addon settings."
      );
    }
    if (!aiProviderConfig.apiKey || aiProviderConfig.apiKey.length < 10) {
      const providerName =
        aiProviderConfig.provider === "openai-compat" ? "OpenAI-Compatible" : "Gemini";
      return errorResponse(
        `${providerName} API Key Invalid`,
        `Your ${providerName} API key is missing or invalid. Please correct it in the addon settings.`
      );
    }
    const tmdbValidation = await validateTmdbKey(tmdbKey);
    if (!tmdbValidation.ok) {
      return errorResponse(
        "TMDB API Key Invalid",
        `The key failed validation (Status: ${tmdbValidation.status}). Please check your TMDB key in the addon settings.`
      );
    }

    const isSearchRequest = !!extra?.search;
    let searchQuery = extra?.search || "";
    const isHomepageQuery = !searchQuery && id.startsWith("aisearch.home.");
    if (isHomepageQuery) {
      const queryIndex = parseInt(id.split(".")[2], 10);
      searchQuery = parseHomepageQueries(configData)[queryIndex]?.query || "";
      if (!searchQuery) {
        return errorResponse(
          "Configuration Error",
          "Could not find the matching homepage query for this catalog."
        );
      }
    } else if (!searchQuery) {
      return errorResponse(
        "Search Required",
        "Please enter a search term to get AI recommendations."
      );
    }

    if (isSearchRequest) {
      logger.query(searchQuery);
      logger.info("Processing search query", { searchQuery, type });
    }

    // A query that clearly asks for the other type gets no results here; the
    // matching catalog (movie vs series) answers it instead.
    const intent = determineIntentFromKeywords(searchQuery);
    if (intent !== "ambiguous" && intent !== type) {
      logger.info("Intent mismatch - returning empty results", { intent, type, searchQuery });
      return { metas: [] };
    }

    const language = configData.TmdbLanguage || "en-US";
    const includeAdult = configData.IncludeAdult === true;
    const numResults = Math.min(parseInt(configData.NumResults) || 20, MAX_AI_RECOMMENDATIONS);
    const enableAiCache = configData.EnableAiCache !== false;
    const metaContext = {
      platform: req?.stremioInfo?.platform || "unknown",
      tmdbKey,
      language,
      includeAdult,
      rpdb: getRpdbSettings(configData),
    };

    // A plain search also asks TMDB directly; its titles go into the prompt
    // as context. Only needed on a cache miss, so it is fetched lazily.
    const getTmdbInitialResults = () =>
      isRecommendationQuery(searchQuery)
        ? []
        : searchTmdbTitles(searchQuery, type, tmdbKey, language, includeAdult);

    // Did the query name a language ("latest malayalam movies", "k-drama...")?
    // A strong match is a request for that language: it steers the AI prompt
    // with a hard requirement and disambiguates TMDB title resolution. A weak
    // match ("a movie about a Mexican boy") may only describe a character or
    // setting, so it becomes a soft hint the AI weighs and nothing else.
    const queryLangMatch = analyzeQueryLanguage(searchQuery);
    const queryLang = queryLangMatch?.strong ? queryLangMatch.code : null;
    const mentionedLang = queryLangMatch && !queryLangMatch.strong ? queryLangMatch.code : null;
    if (queryLangMatch) {
      logger.info("Query language detected", {
        searchQuery,
        queryLang: queryLangMatch.code,
        strong: queryLangMatch.strong,
      });
    }

    // The "_no_trakt" segment is a leftover of the retired Trakt integration.
    // It stays so cache entries saved before the removal still hit. The
    // language part is only appended when a language was detected.
    const langKeyPart = queryLangMatch
      ? `_lang:${queryLangMatch.code}-${queryLangMatch.strong ? "strong" : "weak"}`
      : "";
    const cacheKey = `${searchQuery}_${type}_no_trakt${langKeyPart}`;
    const useCache = enableAiCache && !isHomepageQuery;

    let recommendations = useCache ? getCachedRecommendations(cacheKey, type, numResults) : null;
    logger.info(recommendations ? "AI recommendations cache hit" : "AI recommendations cache miss", {
      cacheKey,
      useCache,
    });

    if (!recommendations) {
      try {
        const { prompt, genreCriteria } = await buildSearchPrompt({
          searchQuery,
          type,
          numResults,
          tmdbInitialResults: await getTmdbInitialResults(),
          tmdbKey,
          includeAdult,
          queryLang,
          queryLangMatch,
          mentionedLang,
          isHomepageQuery,
          enableGrounding: aiProviderConfig.enableGrounding,
        });

        logger.info("Making AI API call", {
          provider: aiClient.provider,
          model: aiProviderConfig.model,
          query: searchQuery,
          type,
          prompt,
          genreCriteria,
          numResults,
        });
        const text = await generateWithRetry(aiClient, prompt, "AI API call");
        logger.info("AI API response", {
          duration: `${Date.now() - startTime}ms`,
          responseTextLength: text.length,
        });

        recommendations = parseRecommendationLines(text, type, queryLang);
      } catch (error) {
        logger.error("AI API Error:", {
          error: error.message,
          status: error.status || error.httpStatus,
          query: searchQuery,
          aiProvider: aiProviderConfig.provider,
        });
        return { metas: [createErrorMeta("AI Error", describeAiError(error, aiProviderConfig.provider))] };
      }

      if (useCache && recommendations.length > 0) {
        aiRecommendationsCache.set(cacheKey, {
          timestamp: Date.now(),
          data: {
            recommendations: { [type === "movie" ? "movies" : "series"]: recommendations },
            fromCache: false,
          },
          configNumResults: numResults,
        });
      }
    }

    const metas = (
      await limitedPromiseAll(recommendations.map((item) => () => toStremioMeta(item, metaContext)))
    ).filter(Boolean);

    if (metas.length === 0) {
      logger.error("No results found for query", { query: searchQuery, type });
      return { metas: [] };
    }

    if (isSearchRequest) incrementQueryCounter();
    logger.info("Catalog response", {
      query: searchQuery,
      type,
      results: metas.length,
      duration: `${Date.now() - startTime}ms`,
    });
    return { metas };
  } catch (error) {
    logger.error("Catalog processing error", { error: error.message, stack: error.stack });
    return {
      metas: [
        createErrorMeta(
          "Addon Error",
          "A critical error occurred. Please check the server logs for more details."
        ),
      ],
    };
  }
};

function readEncryptedConfig(config) {
  if (!config) return null;
  const decrypted = decryptConfig(config);
  return decrypted ? JSON.parse(decrypted) : null;
}

const streamHandler = async (args, req) => {
  let configData = {};
  try {
    configData = readEncryptedConfig(args.config) || {};
  } catch (error) {
    logger.error("Failed to read config in streamHandler, falling back to defaults.", {
      error: error.message,
    });
  }

  if (configData.EnableSimilar === false) {
    return { streams: [] };
  }

  const recsId = "ai-recs:" + args.id;

  // The origin header cannot tell the two clients apart: Stremio's desktop
  // shell hosts the same web UI and sends origin: https://web.stremio.com,
  // exactly like the browser client. So the client is taken from config.
  //
  // metaHandler always builds the recommendations page as a "series" -- the
  // only meta type Stremio renders as a selectable list -- so every link below
  // says series regardless of what the source title was.
  let externalUrl;
  if (configData.StremioWebClient === true) {
    // Already in a browser; link straight at the web client.
    externalUrl = "https://web.stremio.com/#/detail/series/" + recsId;
  } else {
    // Native clients mangle a stremio:// externalUrl -- the colon is stripped
    // and https:// prepended, so it arrives as https://stremio///detail/...
    // and resolves to nothing. Plain http is passed through untouched, so
    // bounce off this addon's /open route, which hands the protocol handler
    // an unmodified deep link.
    const headers = req?.headers || {};
    const forwardedProto = String(headers["x-forwarded-proto"] || "").split(",")[0].trim();
    const proto = forwardedProto || (req?.secure ? "https" : "http");
    const host = headers["x-forwarded-host"] || headers.host || "";
    const prefix = String(req?.originalUrl || "").startsWith("/aisearch/") ? "/aisearch" : "";
    externalUrl = host
      ? proto + "://" + host + prefix + "/open/" + recsId
      : "stremio:///detail/series/" + recsId;
  }

  return {
    streams: [
      {
        name: "✨ AI Search",
        description: "Similar movies and shows.",
        externalUrl,
        behaviorHints: { notWebReady: true },
      },
    ],
  };
};

function buildSimilarPrompt(sourceTitle, sourceYear, numResults) {
  return `
      You are an expert recommendation engine for movies and TV shows.
      Your task is to generate a list of exactly ${numResults} recommendations that are highly similar to "${sourceTitle} (${sourceYear})".

      Your final list must be constructed in two parts:

      **PART 1: FRANCHISE ENTRIES**
      First, list all other official movies/series from the same franchise as "${sourceTitle}". This is your highest priority.
      *   This part of the list **MUST be sorted chronologically by release year**.

      **PART 2: SIMILAR RECOMMENDATIONS**
      After the franchise entries (if any), fill the remaining slots to reach ${numResults} total recommendations with unrelated titles that are highly similar in mood, theme, and genre.
      *   This part of the list **MUST be sorted by relevance to "${sourceTitle}", with the most similar item first**.

      **CRITICAL RULES:**
      1.  **Exclusion:** You **MUST NOT** include the original item, "${sourceTitle} (${sourceYear})", in your list.
      2.  **Final Output:** Provide **ONLY** the combined list of recommendations. Do not include any headers (like "PART 1"), introductory text, or explanations.

      **Format:**
      Your response must be a list of pipe-separated values, with each entry on a new line:
      type|name|year

      **Example (if the source was 'The Dark Knight' and numResults was 5):**
      movie|Batman Begins|2005
      movie|The Dark Knight Rises|2012
      movie|The Town|2010
      movie|Zodiac|2007
      movie|Prisoners|2013
      `;
}

function toIsoDate(date) {
  const parsed = new Date(date || "1970-01-01");
  return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString();
}

/** Builds the "AI: Recommendations for <title>" page behind the stream link. */
const metaHandler = async function (args) {
  const { type, id } = args;
  const startTime = Date.now();

  try {
    if (!id || !id.startsWith("ai-recs:")) return { meta: null };
    const configData = readEncryptedConfig(args.config);
    if (!configData) return { meta: null };

    const { TmdbApiKey, NumResults, FanartApiKey } = configData;
    const originalId = id.split(":")[1];

    const cacheKey = `similar_${originalId}_${type}_${NumResults || 15}`;
    const cached = similarContentCache.get(cacheKey);
    if (cached) return { meta: cached.data };

    const sourceDetails =
      (await getTmdbDetailsByImdbId(originalId, type, TmdbApiKey)) ||
      (await getTmdbDetailsByImdbId(originalId, type === "movie" ? "series" : "movie", TmdbApiKey));
    if (!sourceDetails) {
      throw new Error(`Could not find source details for original ID: ${originalId}`);
    }

    const sourceTitle = sourceDetails.title || sourceDetails.name;
    const sourceYear = (sourceDetails.release_date || sourceDetails.first_air_date || "").substring(0, 4);
    const numResults = Math.min(parseInt(NumResults) || 15, MAX_SIMILAR_RECOMMENDATIONS);

    const aiClient = createAiTextGenerator(getAiProviderConfigFromConfig(configData));
    const responseText = await generateWithRetry(
      aiClient,
      buildSimilarPrompt(sourceTitle, sourceYear, numResults),
      "AI API call (similar content)"
    );

    const tasks = responseText
      .split("\n")
      .map((line) => line.trim().split("|"))
      .filter((parts) => parts.length === 3)
      .map((parts) => async () => {
        const [recType, name, year] = parts.map((p) => p.trim());
        const tmdbData = await searchTMDB(name, recType, year, TmdbApiKey);
        if (!tmdbData || !tmdbData.imdb_id) return null;

        let overview = tmdbData.overview || "";
        if (tmdbData.tmdbRating > 0) {
          overview = `⭐ TMDB Rating: ${tmdbData.tmdbRating.toFixed(1)}/10\n\n${overview}`;
        }
        return {
          id: tmdbData.imdb_id,
          title: tmdbData.title,
          released: toIsoDate(tmdbData.release_date),
          overview,
          thumbnail: await getLandscapeThumbnail(tmdbData, FanartApiKey),
        };
      });
    const videos = (await limitedPromiseAll(tasks)).filter(Boolean);

    const meta = {
      id,
      type: "series",
      name: `AI: Recommendations for ${sourceTitle}`,
      description: `A collection of titles similar to ${sourceTitle} (${sourceYear}), generated by AI.`,
      poster: sourceDetails.poster_path
        ? `https://image.tmdb.org/t/p/w500${sourceDetails.poster_path}`
        : null,
      background: sourceDetails.backdrop_path
        ? `https://image.tmdb.org/t/p/original${sourceDetails.backdrop_path}`
        : null,
      videos,
    };

    if (videos.length > 0) {
      similarContentCache.set(cacheKey, { timestamp: Date.now(), data: meta });
    }
    logger.info("Similar recommendations generated", {
      source: sourceTitle,
      count: videos.length,
      duration: Date.now() - startTime,
    });
    return { meta };
  } catch (error) {
    logger.error("Meta Handler Error:", { message: error.message, stack: error.stack, id });
    return { meta: null };
  }
};

// --- Cache administration -------------------------------------------------

function getCacheStats() {
  return Object.fromEntries(
    Object.entries(CACHES).map(([name, cache]) => [name, cache.stats()])
  );
}

/** Clears one cache by its admin alias; returns null for an unknown alias. */
function clearCache(alias) {
  const cache = CACHES[CACHE_ALIASES[alias]];
  if (!cache) return null;
  const previousSize = cache.size;
  cache.clear();
  logger.info(`Cache cleared: ${alias}`, { previousSize });
  return { cleared: true, previousSize };
}

function clearAllCaches() {
  return Object.fromEntries(Object.keys(CACHE_ALIASES).map((alias) => [alias, clearCache(alias)]));
}

function serializeAllCaches() {
  const data = Object.fromEntries(
    Object.entries(CACHES).map(([name, cache]) => [name, cache.serialize()])
  );
  data.stats = { queryCounter };
  return data;
}

function deserializeAllCaches(data) {
  const results = {};
  for (const [name, cache] of Object.entries(CACHES)) {
    if (data[name]) results[name] = cache.deserialize(data[name]);
  }
  if (typeof data.stats?.queryCounter === "number") {
    queryCounter = data.stats.queryCounter;
  }
  return results;
}

/** Removes AI cache entries that hold no recommendations. */
function purgeEmptyAiCacheEntries() {
  const keys = aiRecommendationsCache.keys();
  let purged = 0;
  for (const key of keys) {
    const recommendations = aiRecommendationsCache.get(key)?.data?.recommendations;
    if (!recommendations?.movies?.length && !recommendations?.series?.length) {
      aiRecommendationsCache.delete(key);
      purged++;
    }
  }
  return { scanned: keys.length, purged, remaining: aiRecommendationsCache.size };
}

/** Removes AI cache entries whose query contains the given phrase. */
function removeAiCacheByKeywords(keywords) {
  const searchPhrase = keywords.toLowerCase().trim();
  const entries = [];
  for (const key of aiRecommendationsCache.keys()) {
    // The query is everything before the first "_<type>_" segment.
    const query = key.split("_")[0];
    if (!query.toLowerCase().includes(searchPhrase)) continue;
    const entry = aiRecommendationsCache.get(key);
    aiRecommendationsCache.delete(key);
    entries.push({ key, timestamp: new Date(entry?.timestamp || 0).toISOString(), query });
  }
  logger.info("AI recommendations cache entries removed by keywords", {
    keywords: searchPhrase,
    removed: entries.length,
  });
  return { removed: entries.length, entries };
}

function removeTmdbDiscoverCacheItem(cacheKey) {
  if (!cacheKey) return { success: false, message: "No cache key provided" };
  if (!tmdbDiscoverCache.delete(cacheKey)) {
    return { success: false, message: "Cache key not found", key: cacheKey };
  }
  return { success: true, message: "Cache item removed successfully", key: cacheKey };
}

function listTmdbDiscoverCacheKeys() {
  const keys = tmdbDiscoverCache.keys();
  return { success: true, count: keys.length, keys };
}

// --- Query counter --------------------------------------------------------

function incrementQueryCounter() {
  return ++queryCounter;
}

function getQueryCount() {
  return queryCounter;
}

function setQueryCount(newCount) {
  if (typeof newCount !== "number" || newCount < 0) {
    throw new Error("Query count must be a non-negative number");
  }
  queryCounter = newCount;
  logger.info("Query counter manually set", { newCount });
  return queryCounter;
}

module.exports = {
  manifest,
  createErrorMeta,
  catalogHandler,
  streamHandler,
  metaHandler,
  buildHomepageCatalogs,
  determineIntentFromKeywords,
  CACHE_NAMES: Object.keys(CACHES),
  getCacheStats,
  clearCache,
  clearAllCaches,
  serializeAllCaches,
  deserializeAllCaches,
  purgeEmptyAiCacheEntries,
  removeAiCacheByKeywords,
  removeTmdbDiscoverCacheItem,
  listTmdbDiscoverCacheKeys,
  getQueryCount,
  setQueryCount,
};
