// Suppress punycode deprecation warning
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (
    warning.name !== "DeprecationWarning" ||
    !warning.message.includes("punycode")
  ) {
    console.warn(warning);
  }
});

try {
  require("dotenv").config();
} catch (error) {
  console.warn("dotenv could not be loaded; continuing with process environment:", error.message);
}

const express = require("express");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { promisify } = require("util");
const logger = require("./utils/logger");
const { handleIssueSubmission } = require("./utils/issueHandler");
const {
  createAiTextGenerator,
  getAiProviderConfigFromConfig,
} = require("./utils/aiProvider");
const {
  encryptConfig,
  decryptConfig,
  isValidEncryptedFormat,
} = require("./utils/crypto");
const { HOST, BASE_PATH } = require("./utils/host");
const { validateTmdbKey } = require("./utils/tmdb");
const { DEFAULT_RPDB_KEY } = require("./utils/artwork");
const addon = require("./addon");

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const PORT = 7000;
const ENABLE_LOGGING = process.env.ENABLE_LOGGING === "true";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const CACHE_BACKUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const CACHE_FOLDER = path.join(__dirname, "cache_data");
const PUBLIC_DIR = path.join(__dirname, "public");

if (!fs.existsSync(CACHE_FOLDER)) {
  fs.mkdirSync(CACHE_FOLDER, { recursive: true });
}

// The manifest served before the user has configured the addon. Built from
// the addon's own manifest so the id, version and stremio-addons.net
// signature can never drift apart.
const setupManifest = {
  id: addon.manifest.id,
  version: addon.manifest.version,
  name: addon.manifest.name,
  description: addon.manifest.description,
  stremioAddonsConfig: addon.manifest.stremioAddonsConfig,
  logo: addon.manifest.logo,
  background: addon.manifest.background,
  resources: ["catalog"],
  types: ["movie", "series"],
  catalogs: [],
  behaviorHints: {
    configurable: true,
    configurationRequired: true,
  },
  configurationURL: `${HOST}${BASE_PATH}/configure`,
};

// Token is read from the X-Admin-Token header (not the query string, which
// leaks into access logs and proxies). Fails closed if ADMIN_TOKEN is unset.
const validateAdminToken = (req, res, next) => {
  const token = req.headers["x-admin-token"];
  if (!ADMIN_TOKEN || !token || token !== ADMIN_TOKEN) {
    return res.status(403).json({ error: "Unauthorized. Invalid admin token." });
  }
  next();
};

// --- Cache persistence ----------------------------------------------------

// Remove orphaned .tmp files left behind by saves that died between
// writeFile and rename (crash, OOM kill, SIGKILL). Tmp paths embed the pid,
// so files from previous processes are never reused and must be swept here.
function cleanupStaleTempFiles() {
  try {
    for (const file of fs.readdirSync(CACHE_FOLDER)) {
      if (!file.endsWith(".tmp")) continue;
      try {
        fs.unlinkSync(path.join(CACHE_FOLDER, file));
      } catch (err) {
        logger.warn(`Failed to delete stale temp cache file: ${file}`, { error: err.message });
      }
    }
  } catch (err) {
    logger.warn("Failed to scan cache folder for stale temp files", { error: err.message });
  }
}

let saveInProgress = null;
let tempFileCounter = 0;

// Serialize saves: an hourly interval tick, the admin endpoint, or a shutdown
// save overlapping an in-flight save would race on temp files.
function saveCachesToFiles() {
  if (!saveInProgress) {
    saveInProgress = doSaveCachesToFiles().finally(() => {
      saveInProgress = null;
    });
  }
  return saveInProgress;
}

async function doSaveCachesToFiles() {
  const results = {};
  try {
    const allCaches = addon.serializeAllCaches();
    await Promise.all(
      Object.entries(allCaches).map(async ([cacheName, cacheData]) => {
        const cacheFilePath = path.join(CACHE_FOLDER, `${cacheName}.json.gz`);
        const tempPath = `${cacheFilePath}.${process.pid}.${++tempFileCounter}.tmp`;
        try {
          const jsonData = JSON.stringify(cacheData);
          // Async gzip keeps the event loop free while large caches compress.
          const compressed = await gzip(jsonData);
          await fs.promises.writeFile(tempPath, compressed);
          await fs.promises.rename(tempPath, cacheFilePath);
          results[cacheName] = {
            success: true,
            size: cacheData.entries ? cacheData.entries.length : undefined,
            originalSize: jsonData.length,
            compressedSize: compressed.length,
          };
        } catch (err) {
          logger.error(`Error saving ${cacheName} to file`, { error: err.message });
          results[cacheName] = { success: false, error: err.message };
          await fs.promises.unlink(tempPath).catch(() => {});
        }
      })
    );
    logger.info("Cache data saved to compressed files", { cacheFolder: CACHE_FOLDER, results });
    return { success: true, timestamp: new Date().toISOString(), cacheFolder: CACHE_FOLDER, results };
  } catch (error) {
    logger.error("Error saving cache data to files", { error: error.message, stack: error.stack });
    return { success: false, error: error.message };
  }
}

// Loads only the caches the addon still has. Files left behind by removed
// features (e.g. the Trakt caches) are ignored.
async function loadCachesFromFiles() {
  const allCacheData = {};
  for (const cacheName of [...addon.CACHE_NAMES, "stats"]) {
    const cacheFilePath = path.join(CACHE_FOLDER, `${cacheName}.json.gz`);
    try {
      const fileData = await fs.promises.readFile(cacheFilePath);
      allCacheData[cacheName] = JSON.parse((await gunzip(fileData)).toString());
    } catch (err) {
      if (err.code !== "ENOENT") {
        logger.error(`Error reading cache file ${cacheFilePath}`, { error: err.message });
      }
    }
  }
  const results = addon.deserializeAllCaches(allCacheData);
  logger.info("Cache data loaded from files", { results });
  return results;
}

// --- Request helpers --------------------------------------------------------

function detectPlatform(req) {
  const userAgent = (req.headers["user-agent"] || "").toLowerCase();
  const platform = (req.headers["stremio-platform"] || "").toLowerCase();
  const has = (...needles) => needles.some((n) => userAgent.includes(n));

  if (platform === "android-tv" || has("android tv", "chromecast", "androidtv")) {
    return "android-tv";
  }
  if (!has("stremio/") && has("android", "mobile", "phone")) return "mobile";
  if (has("windows", "macintosh", "linux", "stremio/")) return "desktop";
  return "unknown";
}

/** Decrypts and parses an install URL's config segment, or returns null. */
function readConfig(encryptedConfig) {
  if (!encryptedConfig || !isValidEncryptedFormat(encryptedConfig)) return null;
  const decrypted = decryptConfig(encryptedConfig);
  if (!decrypted) return null;
  try {
    return JSON.parse(decrypted);
  } catch {
    return null;
  }
}

// The configure page is static: the script derives the host, path prefix and
// config id from window.location. Read it once instead of on every request.
let configurePageHtml = null;
function sendConfigurePage(res) {
  try {
    configurePageHtml ??= fs.readFileSync(path.join(PUBLIC_DIR, "configure.html"), "utf8");
    res.type("html").send(configurePageHtml);
  } catch (error) {
    logger.error("Error loading configuration page", { error: error.message });
    res.status(500).send("Error loading configuration page");
  }
}

function renderStatsWidget(count) {
  return `
            <!DOCTYPE html>
            <html>
            <head>
              <meta charset="UTF-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <title>Stremio AI Search Stats</title>
              <style>
                body {
                  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                  margin: 0;
                  padding: 0;
                  display: flex;
                  justify-content: center;
                  align-items: center;
                  height: 100vh;
                  background-color: transparent;
                }
                .counter {
                  background-color: #1e1e1e;
                  color: #ffffff;
                  border-radius: 8px;
                  padding: 15px 25px;
                  text-align: center;
                  box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
                  min-width: 200px;
                }
                .count {
                  font-size: 2.5rem;
                  font-weight: bold;
                  margin: 10px 0;
                  color: #00b3ff;
                }
                .label {
                  font-size: 1rem;
                  opacity: 0.8;
                }
              </style>
            </head>
            <body>
              <div class="counter">
                <div class="count">${count.toLocaleString()}</div>
                <div class="label">user queries served</div>
              </div>
            </body>
            </html>
          `;
}

const STATS_WIDGET_JS = `
          (function() {
            const widgetContainer = document.createElement('div');
            widgetContainer.id = 'stremio-ai-search-counter';
            widgetContainer.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
            widgetContainer.style.backgroundColor = '#1e1e1e';
            widgetContainer.style.color = '#ffffff';
            widgetContainer.style.borderRadius = '8px';
            widgetContainer.style.padding = '15px 25px';
            widgetContainer.style.textAlign = 'center';
            widgetContainer.style.boxShadow = '0 4px 6px rgba(0, 0, 0, 0.1)';
            widgetContainer.style.minWidth = '200px';
            widgetContainer.style.margin = '10px auto';

            // Insert the widget where the script is included
            const currentScript = document.currentScript;
            currentScript.parentNode.insertBefore(widgetContainer, currentScript);

            function updateCounter() {
              fetch('${HOST}${BASE_PATH}/stats/count?format=json')
                .then(response => response.json())
                .then(data => {
                  widgetContainer.innerHTML = \`
                    <div style="font-size: 2.5rem; font-weight: bold; margin: 10px 0; color: #00b3ff;">\${data.count.toLocaleString()}</div>
                    <div style="font-size: 1rem; opacity: 0.8;">user queries served</div>
                  \`;
                })
                .catch(error => {
                  widgetContainer.innerHTML = '<div>Error loading stats</div>';
                  console.error('Error fetching stats:', error);
                });
            }

            // Initial update
            updateCounter();

            // Update every 5 minutes
            setInterval(updateCounter, 5 * 60 * 1000);
          })();
        `;

// --- Routes ---------------------------------------------------------------

function buildRouter() {
  const router = express.Router();

  router.get("/manifest.json", (req, res) => {
    res.json(setupManifest);
  });

  router.get("/:config/manifest.json", (req, res) => {
    try {
      const encryptedConfig = req.params.config;
      const manifest = {
        ...addon.manifest,
        catalogs: addon.manifest.catalogs.filter((catalog) => catalog.isSearch === true),
        behaviorHints: {
          ...addon.manifest.behaviorHints,
          configurationRequired: !encryptedConfig,
        },
      };
      const configData = readConfig(encryptedConfig);
      if (configData) {
        manifest.catalogs = [...manifest.catalogs, ...addon.buildHomepageCatalogs(configData)];
      }
      res.json(manifest);
    } catch (error) {
      logger.error("Manifest error:", { error: error.message });
      res.status(500).send({ error: "Failed to serve manifest" });
    }
  });

  router.get("/:config/catalog/:type/:id/:extra?.json", async (req, res) => {
    try {
      const encryptedConfig = req.params.config;
      if (encryptedConfig && !isValidEncryptedFormat(encryptedConfig)) {
        return res.json({ metas: [], error: "Invalid configuration format" });
      }
      // A config that no longer decrypts was made under a different
      // ENCRYPTION_KEY (e.g. before the 2026-08 rebuild). Only a reinstall
      // fixes it, so say that instead of "not configured".
      const config = readConfig(encryptedConfig);
      if (!config) {
        return res.json({
          metas: [
            addon.createErrorMeta(
              "Reinstall Required",
              "This install's settings can no longer be read. Open the addon's configure page and install it again."
            ),
          ],
        });
      }

      const searchParam = req.params.extra?.split("search=")[1];
      const searchQuery = searchParam ? decodeURIComponent(searchParam) : req.query.search || "";

      const response = await addon.catalogHandler(
        {
          type: req.params.type,
          id: req.params.id,
          extra: { search: searchQuery },
          config,
        },
        req
      );
      res.json({
        metas: (response.metas || []).map((meta) => ({
          ...meta,
          releaseInfo: meta.year?.toString() || "",
          genres: (meta.genres || []).map((g) => g.toLowerCase()),
          trailers: [],
        })),
        cacheAge: response.cacheAge || 3600,
        staleAge: response.staleAge || 7200,
      });
    } catch (error) {
      logger.error("Catalog route error:", { error: error.message, stack: error.stack });
      res.json({ metas: [] });
    }
  });

  router.get("/:config/meta/:type/:id.json", async (req, res) => {
    try {
      res.json(
        await addon.metaHandler({ type: req.params.type, id: req.params.id, config: req.params.config })
      );
    } catch (error) {
      logger.error("[Meta Route] error:", { message: error.message, stack: error.stack });
      if (!res.headersSent) res.status(500).json({ meta: null, error: "Internal server error" });
    }
  });

  router.get("/:config/stream/:type/:id.json", async (req, res) => {
    try {
      res.json(
        await addon.streamHandler(
          { type: req.params.type, id: req.params.id, config: req.params.config },
          req
        )
      );
    } catch (error) {
      logger.error("[Stream Route] error:", { message: error.message, stack: error.stack });
      if (!res.headersSent) res.status(500).json({ streams: [], error: "Internal server error" });
    }
  });

  // Stremio's desktop client mangles a stremio:// externalUrl before it
  // ever reaches the OS: it strips the colon and prepends https://, so
  // "stremio:///detail/x" arrives at the browser as
  // "https://stremio///detail/x" and resolves to nothing. The very same
  // link works when the protocol handler receives it intact. So the stream
  // points here over plain http -- which the client passes through
  // untouched -- and this page hands the deep link over unmodified.
  router.get("/open/:id", (req, res) => {
    const id = String(req.params.id || "");
    if (!/^ai-recs:[A-Za-z0-9._:-]+$/.test(id)) {
      return res.status(400).send("Invalid recommendation id");
    }
    const deepLink = "stremio:///detail/series/" + id;
    const html = [
      '<!doctype html><html><head><meta charset="utf-8">',
      "<title>Opening Stremio</title>",
      '<meta http-equiv="refresh" content="0;url=' + deepLink + '">',
      "<style>body{background:#0d1117;color:#c9d1d9;font-family:system-ui,sans-serif;",
      "display:flex;align-items:center;justify-content:center;height:100vh;margin:0}",
      "a{color:#58a6ff}</style></head><body><div style=\"text-align:center\">",
      "<p>Opening Stremio&hellip;</p>",
      '<p><a href="' + deepLink + '">Click here if it does not open</a></p>',
      "</div><script>location.replace(" + JSON.stringify(deepLink) + ");</script>",
      "</body></html>",
    ].join("");
    res.type("html").send(html);
  });

  router.get("/ping", (req, res) => {
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      platform: req.stremioInfo?.platform || "unknown",
      path: req.path,
    });
  });

  router.get("/configure", (req, res) => sendConfigurePage(res));

  // Editing an existing install: the page reads the config id from its URL.
  router.get("/:encryptedConfig/configure", (req, res) => {
    if (!isValidEncryptedFormat(req.params.encryptedConfig)) {
      return res.status(400).send("Invalid configuration format");
    }
    sendConfigurePage(res);
  });

  // Rate-limit config decryption to hinder bulk harvesting of configs.
  // The configure page makes a single call per edit-page load.
  const getConfigRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    message: { error: "Too many requests, please try again later" },
    standardHeaders: true,
    legacyHeaders: false,
  });

  router.get("/api/getConfig/:configId", getConfigRateLimiter, (req, res) => {
    if (!isValidEncryptedFormat(req.params.configId)) {
      return res.status(400).json({ error: "Invalid configuration format" });
    }
    const config = readConfig(req.params.configId);
    if (!config) {
      return res.status(400).json({ error: "Failed to decrypt configuration" });
    }
    res.json(config);
  });

  router.post("/encrypt", (req, res) => {
    const { configData } = req.body || {};
    if (!configData || typeof configData !== "object") {
      return res.status(400).json({ error: "Missing config data" });
    }
    if (!configData.RpdbApiKey) delete configData.RpdbApiKey;

    const encryptedConfig = encryptConfig(JSON.stringify(configData));
    if (!encryptedConfig) {
      return res.status(500).json({ error: "Encryption failed" });
    }
    res.json({
      encryptedConfig,
      usingDefaultRpdb: !configData.RpdbApiKey && !!DEFAULT_RPDB_KEY,
    });
  });

  router.post("/validate", async (req, res) => {
    const body = req.body || {};
    const { TmdbApiKey, FanartApiKey } = body;
    const aiProviderConfig = getAiProviderConfigFromConfig(body);
    const results = {
      ai: false,
      aiProvider: aiProviderConfig.provider,
      tmdb: false,
      fanart: true, // Optional, so default to true
      errors: {},
    };

    const validations = [];

    if (aiProviderConfig.apiKey) {
      validations.push(
        (async () => {
          try {
            const responseText = await createAiTextGenerator(aiProviderConfig).generateText("Test prompt");
            if (responseText) {
              results.ai = true;
            } else {
              results.errors.ai = "Invalid AI provider API key - No response";
            }
          } catch (error) {
            const message = error.message || "";
            if (error.status === 429 || message.includes("429") || /quota|rate.?limit/i.test(message)) {
              // 429 means the key IS valid — just rate limited. Don't block installation.
              results.ai = true;
              results.warnings = {
                ai: "API key is valid but the quota is currently exceeded. The addon will work once the rate limit resets.",
              };
            } else {
              results.errors.ai = `Invalid AI provider API key: ${message}`;
            }
          }
        })()
      );
    } else {
      results.errors.ai =
        aiProviderConfig.provider === "openai-compat"
          ? "OpenAI-compatible API key is required."
          : "Gemini API Key is required.";
    }

    if (TmdbApiKey) {
      validations.push(
        (async () => {
          try {
            const { ok, status } = await validateTmdbKey(TmdbApiKey);
            if (ok) results.tmdb = true;
            else results.errors.tmdb = `Invalid TMDB API key (Status: ${status})`;
          } catch {
            results.errors.tmdb = "TMDB API validation failed";
          }
        })()
      );
    } else {
      results.errors.tmdb = "TMDB API Key is required.";
    }

    if (FanartApiKey) {
      validations.push(
        (async () => {
          try {
            // Test with a known movie to validate the API key
            const response = await fetch(
              `https://webservice.fanart.tv/v3/movies/120?api_key=${encodeURIComponent(FanartApiKey)}`
            );
            if (!response.ok) {
              results.fanart = false;
              results.errors.fanart =
                response.status === 401
                  ? "Invalid Fanart.tv API key"
                  : `Fanart.tv API error (Status: ${response.status})`;
            }
          } catch {
            results.fanart = false;
            results.errors.fanart = "Fanart.tv API validation failed";
          }
        })()
      );
    }

    await Promise.all(validations);
    res.json(results);
  });

  // --- Admin: caches ---

  router.get("/cache/stats", validateAdminToken, (req, res) => {
    res.json(addon.getCacheStats());
  });

  router.get("/cache/clear/ai/keywords", validateAdminToken, (req, res) => {
    const keywords = req.query.keywords;
    if (!keywords || typeof keywords !== "string") {
      return res.status(400).json({ error: "Keywords parameter is required and must be a string" });
    }
    res.json(addon.removeAiCacheByKeywords(keywords));
  });

  router.get("/cache/clear/all", validateAdminToken, (req, res) => {
    res.json(addon.clearAllCaches());
  });

  // tmdb, tmdb-details, tmdb-discover, ai, rpdb, fanart, similar
  router.get("/cache/clear/:name", validateAdminToken, (req, res) => {
    const result = addon.clearCache(req.params.name);
    if (!result) return res.status(404).json({ error: `Unknown cache: ${req.params.name}` });
    res.json(result);
  });

  router.get("/cache/purge/ai-empty", validateAdminToken, (req, res) => {
    res.json({
      message: "Purge of empty AI cache entries completed.",
      ...addon.purgeEmptyAiCacheEntries(),
    });
  });

  router.get("/cache/remove/tmdb-discover", validateAdminToken, (req, res) => {
    res.json(addon.removeTmdbDiscoverCacheItem(req.query.key));
  });

  router.get("/cache/list/tmdb-discover", validateAdminToken, (req, res) => {
    res.json(addon.listTmdbDiscoverCacheKeys());
  });

  router.get("/cache/save", validateAdminToken, async (req, res) => {
    res.json(await saveCachesToFiles());
  });

  // --- Stats ---

  router.post("/stats/count/set", validateAdminToken, (req, res) => {
    const { count } = req.body || {};
    if (typeof count !== "number" || count < 0) {
      return res.status(400).json({ error: "Count must be a non-negative number" });
    }
    const newCount = addon.setQueryCount(count);
    res.json({ success: true, newCount, message: `Query counter set to ${newCount}` });
  });

  router.get("/stats/count", (req, res) => {
    const count = addon.getQueryCount();
    const format = req.query.format || "json";
    if (format === "json") {
      res.json({ count });
    } else if (format === "widget") {
      res.send(renderStatsWidget(count));
    } else if (format === "badge") {
      res.type("text/plain").send(`${count.toLocaleString()} queries served`);
    } else {
      res.status(400).json({ error: "Invalid format. Use 'json', 'widget', or 'badge'" });
    }
  });

  router.get("/stats/widget.js", (req, res) => {
    res.type("application/javascript").send(STATS_WIDGET_JS);
  });

  // --- Feedback ---

  const issueRateLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour window
    max: 5, // limit each IP to 5 submissions per window
    message: { error: "Too many submissions from this IP, please try again after an hour" },
    standardHeaders: true,
    legacyHeaders: false,
  });

  router.post("/submit-issue", issueRateLimiter, async (req, res) => {
    try {
      res.json(await handleIssueSubmission(req.body || {}));
    } catch (error) {
      logger.error("Issue submission error:", { error: error.message });
      res.status(400).json({ error: error.message });
    }
  });

  return router;
}

// --- Startup --------------------------------------------------------------

async function startServer() {
  if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length < 32) {
    logger.error("CRITICAL ERROR: ENCRYPTION_KEY environment variable is missing or too short!");
    logger.error("The ENCRYPTION_KEY must be at least 32 characters long.");
    process.exit(1);
  }

  cleanupStaleTempFiles();
  await loadCachesFromFiles();
  setInterval(saveCachesToFiles, CACHE_BACKUP_INTERVAL_MS);

  let shuttingDown = false;
  const gracefulShutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}. Saving caches before shutdown...`);
    try {
      await saveCachesToFiles();
    } catch (error) {
      logger.error("Error saving caches during shutdown", { error: error.message });
    }
    process.exit(0);
  };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => gracefulShutdown(signal));
  }

  const app = express();
  // nginx (on loopback) sets X-Forwarded-For to the real visitor, resolved
  // from Cloudflare's CF-Connecting-IP. Trusting only the loopback hop makes
  // req.ip that visitor; without it every request came from 127.0.0.1 and
  // the rate limits were shared by all users at once.
  app.set("trust proxy", "loopback");
  app.use(express.json({ limit: "1mb" }));
  app.use(compression({ level: 6, threshold: 1024 }));
  app.use("/aisearch", express.static(PUBLIC_DIR));
  app.use("/", express.static(PUBLIC_DIR));

  // The app owns CORS (nginx must not add its own headers, or browsers see
  // "*, *" and reject every install from web.stremio.com).
  app.use((req, res, next) => {
    if (ENABLE_LOGGING) {
      logger.info("Incoming request", {
        method: req.method,
        originalUrl: req.originalUrl || req.url,
        userAgent: req.headers["user-agent"],
      });
    }
    req.stremioInfo = { platform: detectPlatform(req) };
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Cache-Control", "no-cache");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
  });

  // The prefixed mount goes first: mounted at "/", "/:config/manifest.json"
  // would also match "/aisearch/manifest.json" with config = "aisearch".
  // (The public nginx strips /aisearch/ before proxying, so this only matters
  // for direct and self-hosted access.)
  const router = buildRouter();
  app.use(BASE_PATH, router);
  app.use("/", router);

  // Bind to loopback by default; the public entry point is the reverse proxy.
  // Set BIND_ADDRESS=0.0.0.0 to expose directly (not recommended).
  app.listen(PORT, process.env.BIND_ADDRESS || "127.0.0.1", () => {
    logger.info("Server started", {
      port: PORT,
      manifest: `${HOST}${BASE_PATH}/manifest.json`,
      configure: `${HOST}${BASE_PATH}/configure`,
      version: setupManifest.version,
    });
  });
}

startServer().catch((error) => {
  logger.error("Server error:", { error: error.message, stack: error.stack });
  process.exit(1);
});
