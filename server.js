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
  logger.warn("dotenv module not found, continuing without .env file support");
}

const { serveHTTP } = require("stremio-addon-sdk");
const { addonInterface, catalogHandler, determineIntentFromKeywords } = require("./addon");
const express = require("express");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const fs = require("fs");
const path = require("path");
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
const zlib = require("zlib");
const { initDb, storeTokens, getTokens } = require("./database");

// Admin token for cache management
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "change-me-in-env-file";

// Cache persistence configuration
const CACHE_BACKUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const CACHE_FOLDER = path.join(__dirname, "cache_data");

// Ensure cache folder exists
if (!fs.existsSync(CACHE_FOLDER)) {
  fs.mkdirSync(CACHE_FOLDER, { recursive: true });
}

// Function to validate admin token
const validateAdminToken = (req, res, next) => {
  const token = req.query.adminToken;

  if (!token || token !== ADMIN_TOKEN) {
    return res
      .status(403)
      .json({ error: "Unauthorized. Invalid admin token." });
  }

  next();
};

// Function to save all caches to files
async function saveCachesToFiles() {
  try {
    const { serializeAllCaches } = require("./addon");
    const allCaches = serializeAllCaches();
    const savePromises = [];
    const results = {};
    for (const [cacheName, cacheData] of Object.entries(allCaches)) {
      const cacheFilePath = path.join(CACHE_FOLDER, `${cacheName}.json.gz`);
      const tempCacheFilePath = `${cacheFilePath}.${process.pid}.tmp`;
      const promise = (async () => {
        try {
          const jsonData = JSON.stringify(cacheData);
          const compressed = zlib.gzipSync(jsonData);
          await fs.promises.writeFile(tempCacheFilePath, compressed);
          await fs.promises.rename(tempCacheFilePath, cacheFilePath);
          if (cacheName === "stats") {
            results[cacheName] = {
              success: true,
              originalSize: jsonData.length,
              compressedSize: compressed.length,
              compressionRatio:
                ((compressed.length / jsonData.length) * 100).toFixed(2) + "%",
              path: cacheFilePath,
            };
          } else {
            results[cacheName] = {
              success: true,
              size: cacheData.entries ? cacheData.entries.length : 0,
              originalSize: jsonData.length,
              compressedSize: compressed.length,
              compressionRatio:
                ((compressed.length / jsonData.length) * 100).toFixed(2) + "%",
              path: cacheFilePath,
            };
          }
        } catch (err) {
          logger.error(`Error saving ${cacheName} to file`, {
            error: err.message,
            stack: err.stack,
          });
          results[cacheName] = {
            success: false,
            error: err.message,
          };
          try {
            if (fs.existsSync(tempCacheFilePath)) {
              await fs.promises.unlink(tempCacheFilePath);
            }
          } catch (cleanupErr) {
            logger.warn(
              `Failed to delete temporary cache file: ${tempCacheFilePath}`,
              {
                error: cleanupErr.message,
              }
            );
          }
        }
      })();
      savePromises.push(promise);
    }
    await Promise.all(savePromises);
    logger.info("Cache data saved to individual compressed files", {
      timestamp: new Date().toISOString(),
      cacheFolder: CACHE_FOLDER,
      results,
    });
    return {
      success: true,
      timestamp: new Date().toISOString(),
      cacheFolder: CACHE_FOLDER,
      results,
    };
  } catch (error) {
    logger.error("Error saving cache data to files", {
      error: error.message,
      stack: error.stack,
    });
    return {
      success: false,
      error: error.message,
    };
  }
}

// Function to load caches from files
async function loadCachesFromFiles() {
  try {
    // Check if cache folder exists
    if (!fs.existsSync(CACHE_FOLDER)) {
      logger.info("No cache folder found, starting with empty caches", {
        cacheFolder: CACHE_FOLDER,
      });
      return {
        success: false,
        reason: "No cache folder found",
      };
    }

    // Get all cache files (both compressed and uncompressed for backward compatibility)
    const files = fs
      .readdirSync(CACHE_FOLDER)
      .filter((file) => file.endsWith(".json.gz") || file.endsWith(".json"));

    if (files.length === 0) {
      logger.info("No cache files found, starting with empty caches", {
        cacheFolder: CACHE_FOLDER,
      });
      return {
        success: false,
        reason: "No cache files found",
      };
    }

    // Create an object to hold all cache data
    const allCacheData = {};
    const results = {};

    // Read each cache file
    for (const file of files) {
      try {
        const isCompressed = file.endsWith(".json.gz");
        const cacheName = path.basename(
          file,
          isCompressed ? ".json.gz" : ".json"
        );
        const cacheFilePath = path.join(CACHE_FOLDER, file);

        // Read the file
        const fileData = await fs.promises.readFile(cacheFilePath);

        let cacheDataJson;
        if (isCompressed) {
          // Decompress the data
          cacheDataJson = zlib.gunzipSync(fileData).toString();
        } else {
          // Handle uncompressed files for backward compatibility
          cacheDataJson = fileData.toString("utf8");
        }

        const cacheData = JSON.parse(cacheDataJson);

        allCacheData[cacheName] = cacheData;
        results[cacheName] = {
          success: true,
          entriesCount:
            cacheName === "stats" ? "N/A" : cacheData.entries?.length || 0,
          compressed: isCompressed,
          path: cacheFilePath,
        };
      } catch (err) {
        logger.error(`Error reading cache file ${file}`, {
          error: err.message,
          stack: err.stack,
        });
        results[file] = {
          success: false,
          error: err.message,
        };
        // Continue with other files even if one fails
        continue;
      }
    }

    // Deserialize the caches
    const { deserializeAllCaches } = require("./addon");
    const deserializeResults = deserializeAllCaches(allCacheData);

    // Combine results
    for (const [cacheName, result] of Object.entries(deserializeResults)) {
      if (results[cacheName]) {
        results[cacheName].deserialized = result;
      }
    }

    logger.info("Cache data loaded from individual files", {
      timestamp: new Date().toISOString(),
      results,
    });

    return {
      success: true,
      results,
    };
  } catch (error) {
    logger.error("Error loading cache data from files", {
      error: error.message,
      stack: error.stack,
    });

    return {
      success: false,
      error: error.message,
    };
  }
}

async function refreshTraktToken(username, refreshToken) {
  logger.info(`Attempting to refresh Trakt token for user: ${username}`);
  try {
    const response = await fetch("https://api.trakt.tv/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        refresh_token: refreshToken,
        client_id: process.env.TRAKT_CLIENT_ID,
        client_secret: process.env.TRAKT_CLIENT_SECRET,
        redirect_uri: `${HOST}/aisearch/oauth/callback`,
        grant_type: "refresh_token",
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Failed to refresh token: ${response.status} - ${errorBody}`);
    }

    const tokenData = await response.json();
    await storeTokens(username, tokenData.access_token, tokenData.refresh_token, tokenData.expires_in);
    logger.info(`Successfully refreshed and stored new Trakt token for user: ${username}`);

    return {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_in: tokenData.expires_in,
    };
  } catch (error) {
    logger.error(`Error refreshing Trakt token for ${username}:`, { error: error.message });
    return null;
  }
}

const ENABLE_LOGGING = process.env.ENABLE_LOGGING === "true" || false;

if (ENABLE_LOGGING) {
  logger.info("Logging enabled via ENABLE_LOGGING environment variable");
}

const PORT = 7000;
const HOST = process.env.HOST
  ? `https://${process.env.HOST}`
  : "https://stremio.itcon.au";
const BASE_PATH = "/aisearch";

const DEFAULT_RPDB_KEY = process.env.RPDB_API_KEY;
const TRAKT_CLIENT_ID = process.env.TRAKT_CLIENT_ID;
const TRAKT_CLIENT_SECRET = process.env.TRAKT_CLIENT_SECRET;
const TRAKT_API_BASE = "https://api.trakt.tv";

const setupManifest = {
  id: "au.itcon.aisearch",
  version: "1.0.65",
  name: "AI Search",
  description: "AI-powered movie and series recommendations",
  logo: `${HOST}${BASE_PATH}/logo.png`,
  background: `${HOST}${BASE_PATH}/bg.jpg`,
  resources: ["catalog"],
  types: ["movie", "series"],
  catalogs: [],
  behaviorHints: {
    configurable: true,
    configurationRequired: true,
  },
  configurationURL: `${HOST}${BASE_PATH}/configure`,
};

const getConfiguredManifest = (geminiKey, tmdbKey) => ({
  ...setupManifest,
  behaviorHints: {
    configurable: false,
  },
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
});

async function startServer() {
  try {
    await initDb();
    // Load caches from files on startup
    await loadCachesFromFiles();
    const { purgeEmptyAiCacheEntries } = require("./addon");
    logger.info("Running a one-time purge of empty AI cache entries...");
    const purgeStats = purgeEmptyAiCacheEntries();
    logger.info("Empty AI cache purge complete.", { purged: purgeStats.purged, remaining: purgeStats.remaining });

    // Set up periodic cache saving
    setInterval(async () => {
      await saveCachesToFiles();
    }, CACHE_BACKUP_INTERVAL_MS);

    // Set up graceful shutdown handlers
    const gracefulShutdown = async (signal) => {
      logger.info(`Received ${signal}. Starting graceful shutdown...`);

      try {
        logger.info("Saving all caches and stats before shutdown...");
        const result = await saveCachesToFiles();
        logger.info("Cache save completed", { result });
      } catch (error) {
        logger.error("Error saving caches during shutdown", {
          error: error.message,
          stack: error.stack,
        });
      }

      logger.info("Graceful shutdown completed. Exiting process.");
      process.exit(0);
    };

    // Register shutdown handlers for different signals
    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
    process.on("SIGINT", () => gracefulShutdown("SIGINT"));
    process.on("SIGHUP", () => gracefulShutdown("SIGHUP"));

    if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length < 32) {
      logger.error(
        "CRITICAL ERROR: ENCRYPTION_KEY environment variable is missing or too short!"
      );
      logger.error("The ENCRYPTION_KEY must be at least 32 characters long.");
      logger.error(
        "Please set this environment variable before starting the server."
      );
      process.exit(1);
    }

    const app = express();
    app.use(require("express").json({ limit: "10mb" }));
    app.use(
      compression({
        level: 6,
        threshold: 1024,
      })
    );

    app.use("/aisearch", express.static(path.join(__dirname, "public")));
    app.use("/", express.static(path.join(__dirname, "public")));

    if (ENABLE_LOGGING) {
      logger.debug("Static file paths:", {
        publicDir: path.join(__dirname, "public"),
        baseUrl: HOST,
        logoUrl: `${HOST}${BASE_PATH}/logo.png`,
        bgUrl: `${HOST}${BASE_PATH}/bg.jpg`,
      });
    }

    app.use((req, res, next) => {
      if (ENABLE_LOGGING) {
        logger.info("Incoming request", {
          method: req.method,
          path: req.path,
          originalUrl: req.originalUrl || req.url,
          query: req.query,
          params: req.params,
          headers: req.headers,
          timestamp: new Date().toISOString(),
        });
      }
      next();
    });

    app.use((req, res, next) => {
      const userAgent = req.headers["user-agent"] || "";
      const platform = req.headers["stremio-platform"] || "";

      let detectedPlatform = "unknown";
      if (
        platform.toLowerCase() === "android-tv" ||
        userAgent.toLowerCase().includes("android tv") ||
        userAgent.toLowerCase().includes("chromecast") ||
        userAgent.toLowerCase().includes("androidtv")
      ) {
        detectedPlatform = "android-tv";
      } else if (
        !userAgent.toLowerCase().includes("stremio/") &&
        (userAgent.toLowerCase().includes("android") ||
          userAgent.toLowerCase().includes("mobile") ||
          userAgent.toLowerCase().includes("phone"))
      ) {
        detectedPlatform = "mobile";
      } else if (
        userAgent.toLowerCase().includes("windows") ||
        userAgent.toLowerCase().includes("macintosh") ||
        userAgent.toLowerCase().includes("linux") ||
        userAgent.toLowerCase().includes("stremio/")
      ) {
        detectedPlatform = "desktop";
      }

      req.stremioInfo = {
        platform: detectedPlatform,
        userAgent: userAgent,
        originalPlatform: platform,
      };

      req.headers["stremio-platform"] = detectedPlatform;
      req.headers["stremio-user-agent"] = userAgent;
      res.header("Access-Control-Allow-Origin", "*");
      res.header("Access-Control-Allow-Headers", "*");
      res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.header("Cache-Control", "no-cache");

      if (ENABLE_LOGGING) {
        logger.debug("Platform info", {
          platform: req.stremioInfo?.platform,
          userAgent: req.stremioInfo?.userAgent,
          originalPlatform: req.stremioInfo?.originalPlatform,
        });
      }

      next();
    });

    const addonRouter = require("express").Router();
    const routeHandlers = {
      manifest: (req, res, next) => {
        next();
      },
      catalog: (req, res, next) => {
        const searchParam = req.params.extra?.split("search=")[1];
        const searchQuery = searchParam
          ? decodeURIComponent(searchParam)
          : req.query.search || "";
        next();
      },
      ping: (req, res) => {
        res.json({
          status: "ok",
          timestamp: new Date().toISOString(),
          platform: req.stremioInfo?.platform || "unknown",
          path: req.path,
        });
      },
    };

    ["/"].forEach((routePath) => {
      addonRouter.get(routePath + "manifest.json", (req, res) => {
        const baseManifest = {
          ...setupManifest,
          behaviorHints: {
            ...setupManifest.behaviorHints,
            configurationRequired: true,
          },
        };
        res.json(baseManifest);
      });

      addonRouter.get(routePath + ":config/manifest.json", (req, res) => {
        try {
          const encryptedConfig = req.params.config;
          req.stremioConfig = encryptedConfig;
          let manifestWithConfig = {
            ...addonInterface.manifest,
          };
          
          // Start with only the search catalogs from the base manifest
          manifestWithConfig.catalogs = manifestWithConfig.catalogs.filter(
              catalog => catalog.isSearch === true
          );

          if (encryptedConfig && isValidEncryptedFormat(encryptedConfig)) {
            const decryptedConfigStr = decryptConfig(encryptedConfig);
            if (decryptedConfigStr) {
              try {
                const configData = JSON.parse(decryptedConfigStr);
                const enableHomepage = configData.EnableHomepage !== undefined ? configData.EnableHomepage : true;
                let homepageQueries = configData.HomepageQuery;

                if (enableHomepage) {
                    if (!homepageQueries || homepageQueries.trim() === '') {
                        homepageQueries = "AI Recommendations:recommend a hidden gem movie, AI Recommendations:recommend a binge-worthy series";
                    }
                    const catalogEntries = homepageQueries.split(',').map(q => q.trim()).filter(Boolean);
                    const homepageCatalogs = [];

                    catalogEntries.forEach((entry, index) => {
                        let title = entry;
                        let query = entry;
                        
                        const parts = entry.split(/:(.*)/s);
                        if (parts.length > 1 && parts[0].trim() && parts[1].trim()) {
                            title = parts[0].trim();
                            query = parts[1].trim();
                        }

                        const intent = determineIntentFromKeywords(query);
                        const id_prefix = `aisearch.home.${index}`;
                        const name = title;

                        if (intent === 'movie' || intent === 'ambiguous') {
                            homepageCatalogs.push({
                                type: 'movie',
                                id: `${id_prefix}.movie`,
                                name: `${name}`
                            });
                        }
                        if (intent === 'series' || intent === 'ambiguous') {
                            homepageCatalogs.push({
                                type: 'series',
                                id: `${id_prefix}.series`,
                                name: `${name}`
                            });
                        }
                    });

                    manifestWithConfig.catalogs.push(...homepageCatalogs);
                }
              } catch (e) {
                logger.warn("Failed to parse decrypted config for manifest generation", { error: e.message });
              }
            }
          }

          manifestWithConfig.behaviorHints = {
            ...manifestWithConfig.behaviorHints,
            configurationRequired: !encryptedConfig,
          };
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.setHeader("Content-Type", "application/json");
          res.send(JSON.stringify(manifestWithConfig));
        } catch (error) {
          if (ENABLE_LOGGING) {
            logger.error("Manifest error:", error);
          }
          res.status(500).send({ error: "Failed to serve manifest" });
        }
      });

      addonRouter.get(
        routePath + ":config/catalog/:type/:id/:extra?.json",
        async (req, res, next) => {
          try {
            if (ENABLE_LOGGING) {
              logger.debug("Received catalog request", {
                type: req.params.type,
                id: req.params.id,
                extra: req.params.extra,
                query: req.query,
              });
            }

            const encryptedConfig = req.params.config;

            if (encryptedConfig && !isValidEncryptedFormat(encryptedConfig)) {
              if (ENABLE_LOGGING) {
                logger.error("Invalid encrypted config format", {
                  configLength: encryptedConfig.length,
                  configSample: encryptedConfig.substring(0, 20) + "...",
                });
              }
              return res.json({ metas: [], error: "Invalid configuration format" });
            }

            // DECRYPT CONFIG and HANDLE TOKENS
            let decryptedConfig = {};
            if (encryptedConfig) {
              const decryptedStr = decryptConfig(encryptedConfig);
              decryptedConfig = JSON.parse(decryptedStr);

              // If user is configured with Trakt, get and refresh tokens if needed
              if (decryptedConfig.traktUsername) {
                let tokenData = await getTokens(decryptedConfig.traktUsername);
                if (tokenData) {
                  // Check if token is expired (with a 5-minute buffer)
                  if (tokenData.expires_at < Date.now() - 5 * 60 * 1000) {
                    const newTokens = await refreshTraktToken(decryptedConfig.traktUsername, tokenData.refresh_token);
                    if (newTokens) {
                      decryptedConfig.TraktAccessToken = newTokens.access_token;
                    } else {
                      // Refresh failed, proceed without a token
                      delete decryptedConfig.TraktAccessToken;
                      decryptedConfig.traktConnectionError = true;
                      logger.warn(`Proceeding without Trakt data for ${decryptedConfig.traktUsername} due to refresh failure.`);
                    }
                  } else {
                    decryptedConfig.TraktAccessToken = tokenData.access_token;
                  }
                }
              }
            }

            res.setHeader("Access-Control-Allow-Origin", "*");
            res.setHeader("Content-Type", "application/json");

            const searchParam = req.params.extra?.split("search=")[1];
            const searchQuery = searchParam ? decodeURIComponent(searchParam) : req.query.search || "";

            const args = {
              type: req.params.type,
              id: req.params.id,
              extra: { search: searchQuery },
              config: decryptedConfig,
            };

            catalogHandler(args, req)
              .then((response) => {
                const transformedMetas = (response.metas || []).map((meta) => ({
                  ...meta,
                  releaseInfo: meta.year?.toString() || "",
                  genres: (meta.genres || []).map((g) => g.toLowerCase()),
                  trailers: [],
                }));

                if (ENABLE_LOGGING) {
                  logger.debug("Catalog handler response", { metasCount: transformedMetas.length });
                }

                res.json({
                  metas: transformedMetas,
                  cacheAge: response.cacheAge || 3600,
                  staleAge: response.staleAge || 7200,
                });
              })
              .catch((error) => {
                if (ENABLE_LOGGING) {
                  logger.error("Catalog handler error:", { error: error.message, stack: error.stack });
                }
                res.json({ metas: [] });
              });
          } catch (error) {
            if (ENABLE_LOGGING) {
              logger.error("Catalog route error:", { error: error.message, stack: error.stack });
            }
            res.json({ metas: [] });
          }
        }
      );

      addonRouter.get(
        routePath + ":config/meta/:type/:id.json",
        async (req, res) => {
          try {
            if (ENABLE_LOGGING) {
              logger.info("--- META ROUTE MATCHED ---", {
                path: req.path,
                params: req.params,
              });
            }

            const args = {
              type: req.params.type,
              id: req.params.id,
              config: req.params.config,
            };

            const { metaHandler } = require("./addon");
            const response = await metaHandler(args);

            res.setHeader("Access-Control-Allow-Origin", "*");
            res.setHeader("Content-Type", "application/json");
            res.json(response);

            if (ENABLE_LOGGING) {
              logger.info("[Meta Route] Successfully sent response from metaHandler.", { metaName: response?.meta?.name });
            }
          } catch (error) {
            logger.error("[Meta Route] A CRITICAL error occurred in the meta route handler:", {
              message: error.message,
              stack: error.stack,
            });
            if (!res.headersSent) {
              res.status(500).json({ meta: null, error: "Internal server error" });
            }
          }
        }
      );

      addonRouter.get(
        routePath + ":config/stream/:type/:id.json",
        async (req, res, next) => {
          logger.info("--- STREAM ROUTE MATCHED ---");
          logger.info(`[Stream Route] Path: ${req.path}`);
          logger.info(`[Stream Route] Params: type=${req.params.type}, id=${req.params.id}, config=${req.params.config}`);

          try {

            const args = {
              type: req.params.type,
              id: req.params.id,
              config: req.params.config,
            };

            if (ENABLE_LOGGING) {
              logger.info("[Stream Route] Manually calling the stream handler from addon.js");
            }

            const { streamHandler } = require("./addon");
            const response = await streamHandler(args, req);

            res.setHeader("Access-Control-Allow-Origin", "*");
            res.setHeader("Content-Type", "application/json");
            res.json(response);

            if (ENABLE_LOGGING) {
              logger.info("[Stream Route] Successfully received response from streamHandler and sent to client.", { streamCount: response?.streams?.length || 0 });
            }

          } catch (error) {
            logger.error("[Stream Route] A CRITICAL error occurred in the route handler itself:", {
              message: error.message,
              stack: error.stack,
            });
            if (!res.headersSent) {
                res.status(500).json({ streams: [], error: "Internal server error" });
            }
          }
        }
      );

      addonRouter.get(routePath + "ping", routeHandlers.ping);
      addonRouter.get(routePath + "configure", (req, res) => {
        const configurePath = path.join(__dirname, "public", "configure.html");

        if (!fs.existsSync(configurePath)) {
          return res.status(404).send("Configuration page not found");
        }

        fs.readFile(configurePath, "utf8", (err, data) => {
          if (err) {
            return res.status(500).send("Error loading configuration page");
          }

          const hostWithoutProtocol = HOST.replace(/^https?:\/\//, "");
          const modifiedHtml = data
            .replace(
              'const TRAKT_CLIENT_ID = "YOUR_ADDON_CLIENT_ID";',
              `const TRAKT_CLIENT_ID = "${TRAKT_CLIENT_ID}";`
            )
            .replace(
              'const HOST = "stremio.itcon.au";',
              `const HOST = "${hostWithoutProtocol}";`
            )
            .replace('src="logo.png"', `src="${BASE_PATH}/logo.png"`)
            .replace('src="bmc.png"', `src="${BASE_PATH}/bmc.png"`);

          res.send(modifiedHtml);
        });
      });

      // Add Trakt.tv OAuth callback endpoint
      addonRouter.get(routePath + "oauth/callback", async (req, res) => {
        try {
          const { code, state } = req.query;

          if (!code) {
            return res.status(400).send(`
              <html>
                <body style="background: #141414; color: #d9d9d9; font-family: Arial, sans-serif; text-align: center; padding: 20px;">
                  <h2>Authentication Failed</h2>
                  <p>No authorization code received from Trakt.tv</p>
                  <script>
                    window.close();
                  </script>
                </body>
              </html>
            `);
          }

          // Exchange the code for an access token
          const tokenResponse = await fetch(
            "https://api.trakt.tv/oauth/token",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                code,
                client_id: TRAKT_CLIENT_ID,
                client_secret: TRAKT_CLIENT_SECRET,
                redirect_uri: `${HOST}/aisearch/oauth/callback`,
                grant_type: "authorization_code",
              }),
            }
          );

          if (!tokenResponse.ok) {
            throw new Error("Failed to exchange code for token");
          }

          const tokenData = await tokenResponse.json();

          // Send the token data back to the parent window
          res.send(`
            <html>
              <body style="background: #141414; color: #d9d9d9; font-family: Arial, sans-serif; text-align: center; padding: 20px;">
                <h2>Authentication Successful</h2>
                <p>You can close this window now.</p>
                <script>
                  if (window.opener) {
                    window.opener.postMessage({
                      type: "TRAKT_AUTH_SUCCESS",
                      access_token: "${tokenData.access_token}",
                      refresh_token: "${tokenData.refresh_token}",
                      expires_in: ${tokenData.expires_in}
                    }, "${HOST}");
                    window.close();
                  }
                </script>
              </body>
            </html>
          `);
        } catch (error) {
          logger.error("OAuth callback error:", {
            error: error.message,
            stack: error.stack,
          });
          res.status(500).send("Error during OAuth callback");
        }
      });

      // Handle configuration editing with encrypted config
      addonRouter.get(routePath + ":encryptedConfig/configure", (req, res) => {
        const { encryptedConfig } = req.params;

        if (!encryptedConfig || !isValidEncryptedFormat(encryptedConfig)) {
          return res.status(400).send("Invalid configuration format");
        }

        const configurePath = path.join(__dirname, "public", "configure.html");
        if (!fs.existsSync(configurePath)) {
          return res.status(404).send("Configuration page not found");
        }

        fs.readFile(configurePath, "utf8", (err, data) => {
          if (err) {
            return res.status(500).send("Error loading configuration page");
          }

          const hostWithoutProtocol = HOST.replace(/^https?:\/\//, "");
          let modifiedHtml = data
            .replace(
              'const TRAKT_CLIENT_ID = "YOUR_ADDON_CLIENT_ID";',
              `const TRAKT_CLIENT_ID = "${TRAKT_CLIENT_ID}";`
            )
            .replace(
              'const HOST = "stremio.itcon.au";',
              `const HOST = "${hostWithoutProtocol}";`
            )
            .replace('src="logo.png"', `src="${BASE_PATH}/logo.png"`)
            .replace('src="bmc.png"', `src="${BASE_PATH}/bmc.png"`);

          modifiedHtml = modifiedHtml.replace(
            'value=""',
            `value="${encryptedConfig}"`
          );

          res.send(modifiedHtml);
        });
      });

      // Update the getConfig endpoint to handle the full path
      addonRouter.get(routePath + "api/getConfig/:configId", (req, res) => {
        try {
          const { configId } = req.params;

          // Remove any path prefix if present
          const cleanConfigId = configId.split("/").pop();

          if (!cleanConfigId || !isValidEncryptedFormat(cleanConfigId)) {
            return res
              .status(400)
              .json({ error: "Invalid configuration format" });
          }

          const decryptedConfig = decryptConfig(cleanConfigId);
          if (!decryptedConfig) {
            return res
              .status(400)
              .json({ error: "Failed to decrypt configuration" });
          }

          // Parse and return the configuration
          const config = JSON.parse(decryptedConfig);
          res.json(config);
        } catch (error) {
          logger.error("Error getting configuration:", {
            error: error.message,
            stack: error.stack,
          });
          res.status(500).json({ error: "Internal server error" });
        }
      });

      addonRouter.get(
        routePath + "cache/stats",
        validateAdminToken,
        (req, res) => {
          const { getCacheStats } = require("./addon");
          res.json(getCacheStats());
        }
      );

      // API endpoint to decrypt configuration
      addonRouter.post(routePath + "api/decrypt-config", (req, res) => {
        try {
          const { encryptedConfig } = req.body;

          if (!encryptedConfig || !isValidEncryptedFormat(encryptedConfig)) {
            return res
              .status(400)
              .json({ error: "Invalid configuration format" });
          }

          const decryptedConfig = decryptConfig(encryptedConfig);

          if (!decryptedConfig) {
            return res
              .status(400)
              .json({ error: "Failed to decrypt configuration" });
          }

          // Parse the decrypted JSON
          const config = JSON.parse(decryptedConfig);

          // Return the configuration object
          res.json(config);
        } catch (error) {
          logger.error("Error decrypting configuration:", {
            error: error.message,
            stack: error.stack,
          });
          res.status(500).json({ error: "Internal server error" });
        }
      });

      addonRouter.get(
        routePath + "cache/clear/tmdb",
        validateAdminToken,
        (req, res) => {
          const { clearTmdbCache } = require("./addon");
          res.json(clearTmdbCache());
        }
      );

      addonRouter.get(
        routePath + "cache/clear/tmdb-details",
        validateAdminToken,
        (req, res) => {
          const { clearTmdbDetailsCache } = require("./addon");
          res.json(clearTmdbDetailsCache());
        }
      );

      addonRouter.get(
        routePath + "cache/clear/tmdb-discover",
        validateAdminToken,
        (req, res) => {
          const { clearTmdbDiscoverCache } = require("./addon");
          res.json(clearTmdbDiscoverCache());
        }
      );

      addonRouter.get(
        routePath + "cache/clear/ai",
        validateAdminToken,
        (req, res) => {
          const { clearAiCache } = require("./addon");
          res.json(clearAiCache());
        }
      );

      addonRouter.get(
        routePath + "cache/clear/ai/keywords",
        validateAdminToken,
        (req, res) => {
          try {
            const keywords = req.query.keywords;
            if (!keywords || typeof keywords !== "string") {
              return res.status(400).json({
                error: "Keywords parameter is required and must be a string",
              });
            }

            const { removeAiCacheByKeywords } = require("./addon");
            const result = removeAiCacheByKeywords(keywords);

            if (!result) {
              return res
                .status(500)
                .json({ error: "Failed to remove cache entries" });
            }

            res.json(result);
          } catch (error) {
            logger.error("Error in cache/clear/ai/keywords endpoint:", {
              error: error.message,
              stack: error.stack,
              keywords: req.query.keywords,
            });
            res.status(500).json({
              error: "Internal server error",
              message: error.message,
            });
          }
        }
      );

      addonRouter.get(
        routePath + "cache/purge/ai-empty",
        validateAdminToken,
        (req, res) => {
          try {
            const { purgeEmptyAiCacheEntries } = require("./addon");
            const stats = purgeEmptyAiCacheEntries();
            res.json({
              message: "Purge of empty AI cache entries completed.",
              ...stats
            });
          } catch (error) {
            logger.error("Error in cache/purge/ai-empty endpoint:", {
              error: error.message,
              stack: error.stack,
            });
            res.status(500).json({
              error: "Internal server error",
              message: error.message,
            });
          }
        }
      );

      addonRouter.get(
        routePath + "cache/clear/rpdb",
        validateAdminToken,
        (req, res) => {
          const { clearRpdbCache } = require("./addon");
          res.json(clearRpdbCache());
        }
      );

      addonRouter.get(
        routePath + "cache/clear/trakt",
        validateAdminToken,
        (req, res) => {
          const { clearTraktCache } = require("./addon");
          res.json(clearTraktCache());
        }
      );

      addonRouter.get(
        routePath + "cache/clear/trakt-raw",
        validateAdminToken,
        (req, res) => {
          const { clearTraktRawDataCache } = require("./addon");
          res.json(clearTraktRawDataCache());
        }
      );

      addonRouter.get(
        routePath + "cache/clear/query-analysis",
        validateAdminToken,
        (req, res) => {
          const { clearQueryAnalysisCache } = require("./addon");
          res.json(clearQueryAnalysisCache());
        }
      );

      // Add endpoint to remove a specific TMDB discover cache item
      addonRouter.get(
        routePath + "cache/remove/tmdb-discover",
        validateAdminToken,
        (req, res) => {
          const { removeTmdbDiscoverCacheItem } = require("./addon");
          const cacheKey = req.query.key;
          res.json(removeTmdbDiscoverCacheItem(cacheKey));
        }
      );

      // Add endpoint to list all TMDB discover cache keys
      addonRouter.get(
        routePath + "cache/list/tmdb-discover",
        validateAdminToken,
        (req, res) => {
          const { listTmdbDiscoverCacheKeys } = require("./addon");
          res.json(listTmdbDiscoverCacheKeys());
        }
      );

      addonRouter.get(
        routePath + "cache/clear/all",
        validateAdminToken,
        (req, res) => {
          const {
            clearTmdbCache,
            clearTmdbDetailsCache,
            clearTmdbDiscoverCache,
            clearAiCache,
            clearRpdbCache,
            clearTraktCache,
            clearTraktRawDataCache,
            clearQueryAnalysisCache,
          } = require("./addon");
          const tmdbResult = clearTmdbCache();
          const tmdbDetailsResult = clearTmdbDetailsCache();
          const tmdbDiscoverResult = clearTmdbDiscoverCache();
          const aiResult = clearAiCache();
          const rpdbResult = clearRpdbCache();
          const traktResult = clearTraktCache();
          const traktRawResult = clearTraktRawDataCache();
          const queryAnalysisResult = clearQueryAnalysisCache();
          res.json({
            tmdb: tmdbResult,
            tmdbDetails: tmdbDetailsResult,
            tmdbDiscover: tmdbDiscoverResult,
            ai: aiResult,
            rpdb: rpdbResult,
            trakt: traktResult,
            traktRaw: traktRawResult,
            queryAnalysis: queryAnalysisResult,
          });
        }
      );

      // Add endpoint to manually save caches to files
      addonRouter.get(
        routePath + "cache/save",
        validateAdminToken,
        async (req, res) => {
          const result = await saveCachesToFiles();
          res.json(result);
        }
      );

      // Add endpoint to set query counter
      addonRouter.post(
        routePath + "stats/count/set",
        validateAdminToken,
        express.json(),
        (req, res) => {
          try {
            const { count } = req.body;
            if (typeof count !== "number" || count < 0) {
              return res.status(400).json({
                error: "Count must be a non-negative number",
              });
            }
            const { setQueryCount } = require("./addon");
            const newCount = setQueryCount(count);
            res.json({
              success: true,
              newCount,
              message: `Query counter set to ${newCount}`,
            });
          } catch (error) {
            res.status(400).json({
              error: error.message,
            });
          }
        }
      );

      // Add stats endpoint to the addonRouter
      addonRouter.get(routePath + "stats/count", (req, res) => {
        const { getQueryCount } = require("./addon");
        const count = getQueryCount();

        // Check if the request wants JSON or widget HTML
        const format = req.query.format || "json";

        if (format === "json") {
          res.json({ count });
        } else if (format === "widget") {
          res.send(`
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
          `);
        } else if (format === "badge") {
          // Simple text for embedding in markdown or other places
          res
            .type("text/plain")
            .send(`${count.toLocaleString()} queries served`);
        } else {
          res.status(400).json({
            error: "Invalid format. Use 'json', 'widget', or 'badge'",
          });
        }
      });

      // Add an embeddable widget endpoint to the addonRouter
      addonRouter.get(routePath + "stats/widget.js", (req, res) => {
        res.type("application/javascript").send(`
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
                  logger.error('Error fetching stats:', error);
                });
            }
            
            // Initial update
            updateCounter();
            
            // Update every 5 minutes
            setInterval(updateCounter, 5 * 60 * 1000);
          })();
        `);
      });

      // Update Trakt.tv token refresh endpoint to use pre-configured credentials
      addonRouter.post("/oauth/refresh", async (req, res) => {
        try {
          const { refresh_token } = req.body;

          if (!refresh_token) {
            return res.status(400).json({ error: "Missing refresh token" });
          }

          const response = await fetch("https://api.trakt.tv/oauth/token", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              refresh_token,
              client_id: TRAKT_CLIENT_ID,
              client_secret: TRAKT_CLIENT_SECRET,
              redirect_uri: `${HOST}/aisearch/oauth/callback`,
              grant_type: "refresh_token",
            }),
          });

          if (!response.ok) {
            throw new Error("Failed to refresh token");
          }

          const tokenData = await response.json();
          res.json(tokenData);
        } catch (error) {
          logger.error("Token refresh error:", {
            error: error.message,
            stack: error.stack,
          });
          res.status(500).json({ error: "Failed to refresh token" });
        }
      });
    });

    app.use("/", addonRouter);
    app.use(BASE_PATH, addonRouter);

    app.post(["/encrypt", "/aisearch/encrypt"], express.json(), async (req, res) => {
      try {
        const { configData, traktAuthData } = req.body;
        if (!configData) {
          return res.status(400).json({ error: "Missing config data" });
        }

        // If Trakt data is present, store it in the database
        if (traktAuthData && traktAuthData.username) {
          await storeTokens(
            traktAuthData.username,
            traktAuthData.accessToken,
            traktAuthData.refreshToken,
            traktAuthData.expiresIn
          );
          configData.traktUsername = traktAuthData.username;
        }

        if (!configData.RpdbApiKey) {
          delete configData.RpdbApiKey;
        }

        const configStr = JSON.stringify(configData);
        const encryptedConfig = encryptConfig(configStr);

        if (!encryptedConfig) {
          return res.status(500).json({ error: "Encryption failed" });
        }

        return res.json({
          encryptedConfig,
          usingDefaultRpdb: !configData.RpdbApiKey && !!DEFAULT_RPDB_KEY,
        });
      } catch (error) {
        logger.error("Encryption endpoint error:", {
          error: error.message,
          stack: error.stack,
        });
        return res.status(500).json({ error: "Server error" });
      }
    });

    app.post(["/decrypt", "/aisearch/decrypt"], express.json(), (req, res) => {
      try {
        const { encryptedConfig } = req.body;
        if (!encryptedConfig) {
          return res.status(400).json({ error: "Missing encrypted config" });
        }

        const decryptedConfig = decryptConfig(encryptedConfig);
        if (!decryptedConfig) {
          return res.status(500).json({ error: "Decryption failed" });
        }

        try {
          const configData = JSON.parse(decryptedConfig);
          return res.json({ success: true, config: configData });
        } catch (error) {
          return res
            .status(500)
            .json({ error: "Invalid JSON in decrypted config" });
        }
      } catch (error) {
        logger.error("Decryption endpoint error:", {
          error: error.message,
          stack: error.stack,
        });
        return res.status(500).json({ error: "Server error" });
      }
    });

    app.use(
      ["/encrypt", "/decrypt", "/aisearch/encrypt", "/aisearch/decrypt"],
      (req, res, next) => {
        res.header("Access-Control-Allow-Origin", "*");
        res.header(
          "Access-Control-Allow-Headers",
          "Content-Type, Authorization"
        );
        res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

        if (req.method === "OPTIONS") {
          return res.sendStatus(200);
        }

        next();
      }
    );

app.use(["/validate", "/aisearch/validate"], (req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

app.post(["/validate", "/aisearch/validate"], express.json(), async (req, res) => {
  const startTime = Date.now();
  try {
    const {
      TmdbApiKey,
      TraktAccessToken,
      FanartApiKey,
      traktUsername,
    } = req.body;
    
    const validationResults = {
      ai: false,
      aiProvider: null,
      gemini: false,
      openaiCompat: false,
      tmdb: false,
      fanart: true, // Optional, so default to true
      trakt: true,
      errors: {},
    };
    
    const aiProviderConfig = getAiProviderConfigFromConfig(req.body);
    validationResults.aiProvider = aiProviderConfig.provider;

    if (ENABLE_LOGGING) {
      logger.debug("Validation request received", {
        path: req.path,
        aiProvider: aiProviderConfig.provider,
        hasAiKey: !!aiProviderConfig.apiKey,
        hasTmdbKey: !!TmdbApiKey,
        hasTraktToken: !!TraktAccessToken,
        hasTraktUsername: !!traktUsername,
      });
    }

    const validations = [];

    // AI Provider Validation (Gemini or OpenAI-compatible)
    if (aiProviderConfig.apiKey) {
      validations.push((async () => {
        try {
          const aiClient = createAiTextGenerator(aiProviderConfig);
          const responseText = await aiClient.generateText("Test prompt");
          if (responseText && responseText.length > 0) {
            validationResults.ai = true;
            if (aiProviderConfig.provider === "gemini") {
              validationResults.gemini = true;
            } else {
              validationResults.openaiCompat = true;
            }
          } else {
            validationResults.errors.ai = "Invalid AI provider API key - No response";
          }
        } catch (error) {
          validationResults.errors.ai = `Invalid AI provider API key: ${error.message}`;
        }
      })());
    } else {
      if (aiProviderConfig.provider === "openai-compat") {
        validationResults.errors.ai = "OpenAI-compatible API key is required.";
      } else {
        validationResults.errors.ai = "Gemini API Key is required.";
      }
    }

    // TMDB Validation
    if (TmdbApiKey) {
      validations.push((async () => {
        try {
          const tmdbUrl = `https://api.themoviedb.org/3/configuration?api_key=${TmdbApiKey}`;
          const tmdbResponse = await fetch(tmdbUrl);
          if (tmdbResponse.ok) {
            validationResults.tmdb = true;
          } else {
            validationResults.errors.tmdb = `Invalid TMDB API key (Status: ${tmdbResponse.status})`;
          }
        } catch (error) {
          validationResults.errors.tmdb = "TMDB API validation failed";
        }
      })());
    } else {
        validationResults.errors.tmdb = "TMDB API Key is required.";
    }

    // Fanart.tv Validation (Optional)
    if (FanartApiKey) {
      validations.push((async () => {
        try {
          // Test with a known movie (Harry Potter) to validate the API key
          const fanartUrl = `http://webservice.fanart.tv/v3/movies/120?api_key=${FanartApiKey}`;
          const fanartResponse = await fetch(fanartUrl);
          if (fanartResponse.ok) {
            const data = await fanartResponse.json();
            if (data && (data.moviethumb || data.hdmovielogo || data.movieposter)) {
              validationResults.fanart = true;
            } else {
              validationResults.errors.fanart = "Fanart.tv API key valid but no data returned";
            }
          } else if (fanartResponse.status === 401) {
            validationResults.fanart = false;
            validationResults.errors.fanart = "Invalid Fanart.tv API key";
          } else {
            validationResults.fanart = false;
            validationResults.errors.fanart = `Fanart.tv API error (Status: ${fanartResponse.status})`;
          }
        } catch (error) {
          validationResults.fanart = false;
          validationResults.errors.fanart = "Fanart.tv API validation failed";
        }
      })());
    }
    // Note: Fanart.tv is optional, so no error if missing

    // --- NEW TRAKT VALIDATION LOGIC ---
    let tokenToCheck = TraktAccessToken;

    // If a username is provided, this is a health check. Get the token from the DB.
    if (traktUsername) {
      const tokenData = await getTokens(traktUsername);
      if (tokenData && tokenData.access_token) {
        tokenToCheck = tokenData.access_token;
      } else {
        tokenToCheck = null; // No token found in DB
        validationResults.trakt = false;
        validationResults.errors.trakt = "No stored Trakt credentials found for this user.";
      }
    }

    // Now, validate the token we found (either from the request body or the DB)
    if (tokenToCheck) {
      validations.push((async () => {
        try {
          const traktResponse = await fetch(`${TRAKT_API_BASE}/users/me`, {
            headers: {
              "Content-Type": "application/json",
              "trakt-api-version": "2",
              "trakt-api-key": TRAKT_CLIENT_ID,
              Authorization: `Bearer ${tokenToCheck}`,
            },
          });
          if (!traktResponse.ok) {
            validationResults.trakt = false;
            validationResults.errors.trakt = "Trakt.tv connection is invalid. Please re-login.";
          } else {
            validationResults.trakt = true; // Explicitly confirm it's valid
          }
        } catch (error) {
          validationResults.trakt = false;
          validationResults.errors.trakt = "Trakt.tv API validation failed.";
        }
      })());
    } else if (TraktAccessToken || traktUsername) {
      // If we expected a token but didn't have one to check, it's a failure.
      validationResults.trakt = false;
      if (!validationResults.errors.trakt) {
        validationResults.errors.trakt = "Missing Trakt access token for validation.";
      }
    }
    
    // Wait for all validations to complete
    await Promise.all(validations);

    if (ENABLE_LOGGING) {
      logger.debug("API key validation results:", {
        results: validationResults,
        duration: `${Date.now() - startTime}ms`,
      });
    }

    res.json(validationResults);
  } catch (error) {
    if (ENABLE_LOGGING) {
      logger.error("Validation endpoint error:", {
        error: error.message,
        stack: error.stack,
      });
    }
    res.status(500).json({
      error: "Validation failed due to a server error.",
      message: error.message,
    });
  }
});

    app.get("/test-crypto", (req, res) => {
      try {
        const testData = JSON.stringify({
          test: "data",
          timestamp: Date.now(),
        });

        const encrypted = encryptConfig(testData);
        const decrypted = decryptConfig(encrypted);

        res.json({
          original: testData,
          encrypted: encrypted,
          decrypted: decrypted,
          success: testData === decrypted,
          encryptedLength: encrypted ? encrypted.length : 0,
          decryptedLength: decrypted ? decrypted.length : 0,
        });
      } catch (error) {
        res.status(500).json({
          error: error.message,
          stack: error.stack,
        });
      }
    });

    // Add rate limiter for issue submissions
    const issueRateLimiter = rateLimit({
      windowMs: 60 * 60 * 1000, // 1 hour window
      max: 5, // limit each IP to 5 submissions per window
      message: {
        error:
          "Too many submissions from this IP, please try again after an hour",
      },
      standardHeaders: true,
      legacyHeaders: false,
    });

    // Add the issue submission endpoint to the addonRouter
    addonRouter.post(
      "/submit-issue",
      issueRateLimiter,
      express.json(),
      async (req, res) => {
        try {
          if (ENABLE_LOGGING) {
            logger.debug("Issue submission received", {
              title: req.body.title,
              feedbackType: req.body.feedbackType,
              email: req.body.email,
              hasRecaptcha: !!req.body.recaptchaToken,
              timestamp: new Date().toISOString(),
            });
          }

          const result = await handleIssueSubmission(req.body);
          res.json(result);
        } catch (error) {
          if (ENABLE_LOGGING) {
            logger.error("Issue submission error:", {
              error: error.message,
              stack: error.stack,
              timestamp: new Date().toISOString(),
            });
          }
          res.status(400).json({ error: error.message });
        }
      }
    );

    app.listen(PORT, "0.0.0.0", () => {
      if (ENABLE_LOGGING) {
        logger.info("Server started", {
          environment: "production",
          port: PORT,
          urls: {
            base: HOST,
            manifest: `${HOST}${BASE_PATH}/manifest.json`,
            configure: `${HOST}${BASE_PATH}/configure`,
          },
          addon: {
            id: setupManifest.id,
            version: setupManifest.version,
            name: setupManifest.name,
          },
          static: {
            publicDir: path.join(__dirname, "public"),
            logo: setupManifest.logo,
            background: setupManifest.background,
          },
        });
      }
    });
  } catch (error) {
    if (ENABLE_LOGGING) {
      logger.error("Server error:", {
        error: error.message,
        stack: error.stack,
      });
    }
    process.exit(1);
  }
}

startServer();
