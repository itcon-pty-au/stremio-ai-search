const fs = require("fs");
const path = require("path");

// Use environment variable for logging
const ENABLE_LOGGING = process.env.ENABLE_LOGGING === "true" || false;

// Create logs directory if it doesn't exist (always create it for query logging)
const logsDir = path.join(__dirname, "..", "logs");
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Redaction patterns for secrets that must never reach log files.
// Order matters: specific key formats first, generic token shapes last.
const REDACTION_PATTERNS = [
  [/AIza[0-9A-Za-z_-]{30,}/g, "AIza***REDACTED***"], // Google/Gemini API keys
  [/sk-[A-Za-z0-9_-]{20,}/g, "sk-***REDACTED***"], // OpenAI-compatible keys
  [/(api[_-]?key['"]?\s*[=:]\s*['"]?)[A-Za-z0-9_-]{8,}/gi, "$1***REDACTED***"],
  [/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, "$1***REDACTED***"],
  [/\b[a-f0-9]{64}\b/g, "***REDACTED-TOKEN***"], // 64-hex bearer tokens
];

function redactSecrets(text) {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  for (const [pattern, replacement] of REDACTION_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

// Keep track of last query and timestamp to prevent duplicates
let lastQuery = "";
let lastQueryTime = 0;
const DUPLICATE_WINDOW = 15000; // 15 second window to detect duplicates

/**
 * Helper function to format and write logs
 * @param {string} level - Log level (DEBUG, INFO, WARN, ERROR)
 * @param {string} message - Log message
 * @param {object} data - Optional data to log
 */
function writeLog(level, message, data) {
  // Format the log message
  const timestamp = new Date().toISOString();
  const formattedData = data
    ? `\n${redactSecrets(JSON.stringify(data, null, 2))}`
    : "";
  const logMessage = `[${timestamp}] ${level}: ${redactSecrets(message)}${formattedData}\n`;

  // Write to file
  fs.appendFile(
    path.join(logsDir, "app.log"),
    logMessage,
    () => {} // Silent error handling
  );
}

/**
 * Helper function to get Melbourne time with DST correction
 * @returns {string} Formatted timestamp
 */
function getMelbourneTime() {
  return new Date()
    .toLocaleString("en-AU", {
      timeZone: "Australia/Melbourne",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
    .replace(/[/]/g, "-")
    .replace(",", "");
}

/**
 * Helper function to log queries independently of ENABLE_LOGGING
 * @param {string} query - The search query
 */
function logQuery(query) {
  const now = Date.now();

  // Check if this is a duplicate query within the time window
  if (query === lastQuery && now - lastQueryTime < DUPLICATE_WINDOW) {
    return; // Skip duplicate query
  }

  // Update last query tracking
  lastQuery = query;
  lastQueryTime = now;

  // Create log line with Melbourne time
  const logLine = `${getMelbourneTime()}|${query}\n`;

  // Write to query log file with error handling
  fs.appendFile(path.join(logsDir, "query.log"), logLine, (err) => {
    if (err) {
      console.error("Error writing to query.log:", err);
    }
  });
}

// Simplified logger without console logs, only file logging
const logger = {
  debug: function (message, data) {
    if (ENABLE_LOGGING) {
      writeLog("DEBUG", message, data);
    }
  },
  info: function (message, data) {
    if (ENABLE_LOGGING) {
      writeLog("INFO", message, data);
    }
  },
  warn: function (message, data) {
    if (ENABLE_LOGGING) {
      writeLog("WARN", message, data);
    }
  },
  error: function (message, data) {
    // Errors always log regardless of ENABLE_LOGGING
    writeLog("ERROR", message, data);
    const formattedData = data ? ` ${redactSecrets(JSON.stringify(data))}` : "";
    console.error(`[ERROR] ${redactSecrets(message)}${formattedData}`);
  },
  query: logQuery,
  ENABLE_LOGGING,
};

module.exports = logger;
