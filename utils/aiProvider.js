const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite";

// Reasoning models (DeepSeek V4, o-series, ...) spend output tokens on hidden
// reasoning before emitting any text. The old hardcoded 2000 was consumed
// entirely by reasoning, so the API returned finish_reason "length" with an
// empty message and the addon silently produced an empty catalog.
const DEFAULT_OPENAI_MAX_TOKENS = 8000;

let fetchFn = globalThis.fetch;
if (!fetchFn) {
  try {
    const nodeFetch = require("node-fetch");
    fetchFn = nodeFetch.default || nodeFetch;
  } catch {
    // If neither global fetch nor node-fetch exists, callers will get a clear error at runtime.
    fetchFn = null;
  }
}

const fetch = fetchFn ? fetchFn.bind(globalThis) : null;

function normalizeProviderName(provider) {
  if (!provider) return null;
  const normalized = String(provider).trim().toLowerCase();
  if (normalized === "gemini" || normalized === "google") return "gemini";
  if (
    normalized === "openai" ||
    normalized === "openai-compat" ||
    normalized === "openai_compat" ||
    normalized === "openai-compatible" ||
    normalized === "openrouter" ||
    normalized === "zai"
  ) {
    return "openai-compat";
  }
  return null;
}

function validateExternalUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Disallowed URL scheme: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block loopback
  if (hostname === "localhost" || hostname === "::1") {
    throw new Error("Requests to loopback addresses are not allowed");
  }

  // Parse IPv4
  const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [, a, b, c] = ipv4.map(Number);
    if (
      a === 127 || // loopback
      a === 10 || // RFC 1918
      (a === 172 && b >= 16 && b <= 31) || // RFC 1918
      (a === 192 && b === 168) || // RFC 1918
      (a === 169 && b === 254) || // link-local / cloud metadata
      a === 0 // reserved
    ) {
      throw new Error("Requests to private/reserved IP ranges are not allowed");
    }
  }
}

// Known API-key prefixes mapped to the provider they belong to.
// "Base URL" is labelled optional, so users routinely leave it blank -- which
// used to send an OpenRouter key to api.openai.com and surface a confusing
// "Incorrect API key provided" 401. Infer the endpoint from the key instead.
const API_KEY_PREFIX_PROVIDERS = [
  {
    prefix: "sk-or-v1-",
    name: "OpenRouter",
    article: "an",
    baseUrl: "https://openrouter.ai/api/v1",
  },
];

function detectProviderFromApiKey(apiKey) {
  const key = (apiKey || "").trim();
  if (!key) return null;
  return API_KEY_PREFIX_PROVIDERS.find((entry) => key.startsWith(entry.prefix)) || null;
}

function getOpenAIChatCompletionsUrl(baseUrl, apiKey) {
  const raw = (baseUrl || "").trim().replace(/\/+$/, "");
  if (!raw) {
    const detected = detectProviderFromApiKey(apiKey);
    if (detected) return `${detected.baseUrl}/chat/completions`;
    return "https://api.openai.com/v1/chat/completions";
  }
  if (raw.includes("/chat/completions")) return raw;
  // Already versioned (e.g. /v1 for OpenAI/OpenRouter, /v4 for Z.ai)
  if (/\/v\d+$/i.test(raw)) return `${raw}/chat/completions`;
  return `${raw}/v1/chat/completions`;
}

function normalizeTemperature(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return undefined;
  return Math.max(0, Math.min(1, num));
}

function parseOptionalJsonObject(text) {
  if (!text) return null;
  const raw = String(text).trim();
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Extra headers must be a JSON object");
  }
  return parsed;
}

function buildExtraHeaders(extraHeaders) {
  if (!extraHeaders) return {};

  const forbidden = new Set(["authorization", "content-type", "content-length", "host"]);
  const headers = {};

  for (const [key, value] of Object.entries(extraHeaders)) {
    const headerName = String(key).trim();
    if (!headerName) continue;
    if (forbidden.has(headerName.toLowerCase())) continue;
    if (value === undefined || value === null) continue;
    headers[headerName] = String(value).replace(/[\r\n]/g, "");
  }

  return headers;
}

function getAiProviderConfigFromConfig(configData = {}) {
  const provider = normalizeProviderName(configData.AiProvider);
  const temperature = normalizeTemperature(configData.AiTemperature);

  if (provider === "openai-compat") {
    return {
      provider: "openai-compat",
      apiKey: (configData.OpenAICompatApiKey || "").trim(),
      baseUrl: (configData.OpenAICompatBaseUrl || "").trim(),
      model: (configData.OpenAICompatModel || "gpt-4o-mini").trim(),
      extraHeaders: (configData.OpenAICompatExtraHeaders || "").trim(),
      timeoutMs: Number(configData.OpenAICompatTimeoutMs) || undefined,
      maxTokens: Number(configData.OpenAICompatMaxTokens) || undefined,
      temperature,
    };
  }

  if (provider === "gemini") {
    return {
      provider: "gemini",
      apiKey: (configData.GeminiApiKey || "").trim(),
      model: (configData.GeminiModel || DEFAULT_GEMINI_MODEL).trim(),
      temperature,
      enableGrounding: configData.EnableGeminiGrounding === true,
    };
  }

  // Backwards compatibility: older configs only had Gemini fields.
  const hasGeminiKey = !!(configData.GeminiApiKey && String(configData.GeminiApiKey).trim());
  const hasOpenAICompatKey = !!(
    configData.OpenAICompatApiKey && String(configData.OpenAICompatApiKey).trim()
  );

  if (hasOpenAICompatKey && !hasGeminiKey) {
    return {
      provider: "openai-compat",
      apiKey: String(configData.OpenAICompatApiKey).trim(),
      baseUrl: (configData.OpenAICompatBaseUrl || "").trim(),
      model: (configData.OpenAICompatModel || "gpt-4o-mini").trim(),
      extraHeaders: (configData.OpenAICompatExtraHeaders || "").trim(),
      timeoutMs: Number(configData.OpenAICompatTimeoutMs) || undefined,
      maxTokens: Number(configData.OpenAICompatMaxTokens) || undefined,
      temperature,
    };
  }

  return {
    provider: "gemini",
    apiKey: (configData.GeminiApiKey || "").trim(),
    model: (configData.GeminiModel || DEFAULT_GEMINI_MODEL).trim(),
    temperature,
    enableGrounding: configData.EnableGeminiGrounding === true,
  };
}

function createAiTextGenerator(aiProviderConfig) {
  if (!aiProviderConfig || !aiProviderConfig.provider) {
    throw new Error("AI provider configuration is missing");
  }

  if (aiProviderConfig.provider === "gemini") {
    return {
      provider: "gemini",
      model: aiProviderConfig.model,
      async generateText(prompt) {
        const { GoogleGenerativeAI } = require("@google/generative-ai");
        const genAI = new GoogleGenerativeAI(aiProviderConfig.apiKey);
        const model = genAI.getGenerativeModel({
          model: aiProviderConfig.model,
          generationConfig: {
            temperature:
              typeof aiProviderConfig.temperature === "number"
                ? aiProviderConfig.temperature
                : 0.2,
          },
          ...(aiProviderConfig.enableGrounding ? { tools: [{ googleSearch: {} }] } : {}),
        });
        const aiResult = await model.generateContent(prompt);
        return aiResult.response.text().trim();
      },
    };
  }

  if (aiProviderConfig.provider === "openai-compat") {
    return {
      provider: "openai-compat",
      model: aiProviderConfig.model,
      async generateText(prompt) {
        if (!fetch) {
          throw new Error(
            "Fetch API is not available (need Node 18+ or install node-fetch)"
          );
        }

        const timeoutMs =
          typeof aiProviderConfig.timeoutMs === "number" && aiProviderConfig.timeoutMs > 0
            ? aiProviderConfig.timeoutMs
            : 30000;
        const maxTokens =
          typeof aiProviderConfig.maxTokens === "number" && aiProviderConfig.maxTokens > 0
            ? aiProviderConfig.maxTokens
            : DEFAULT_OPENAI_MAX_TOKENS;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        let extraHeadersObj;
        try {
          extraHeadersObj = parseOptionalJsonObject(aiProviderConfig.extraHeaders);
        } catch (error) {
          const parseError = new Error(`Invalid extra headers JSON: ${error.message}`);
          parseError.status = 400;
          throw parseError;
        }

        const url = getOpenAIChatCompletionsUrl(
          aiProviderConfig.baseUrl,
          aiProviderConfig.apiKey
        );
        validateExternalUrl(url);
        let response;
        try {
          response = await fetch(url, {
            method: "POST",
            signal: controller.signal,
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${aiProviderConfig.apiKey}`,
              ...buildExtraHeaders(extraHeadersObj),
            },
            body: JSON.stringify({
              model: aiProviderConfig.model,
              messages: [{ role: "user", content: prompt }],
              temperature:
                typeof aiProviderConfig.temperature === "number"
                  ? aiProviderConfig.temperature
                  : 0.2,
              max_tokens: maxTokens,
            }),
          });
        } catch (error) {
          if (error && error.name === "AbortError") {
            const timeoutError = new Error(
              `OpenAI-compatible API request timed out after ${timeoutMs}ms`
            );
            timeoutError.status = 504;
            throw timeoutError;
          }
          throw error;
        } finally {
          clearTimeout(timeoutId);
        }

        if (!response.ok) {
          const errorText = await response.text().catch(() => "");
          let hint = "";
          if (response.status === 401) {
            const detected = detectProviderFromApiKey(aiProviderConfig.apiKey);
            if (detected && !url.startsWith(detected.baseUrl)) {
              hint =
                ` This looks like ${detected.article || "a"} ${detected.name} API key, but the request went to ` +
                `${new URL(url).host}. Set "Base URL" to ${detected.baseUrl} and try again.`;
            }
          }
          const error = new Error(
            `OpenAI-compatible API error (Status: ${response.status})${errorText ? `: ${errorText}` : ""}${hint}`
          );
          error.status = response.status;
          throw error;
        }

        const data = await response.json();
        const choice = data?.choices?.[0];
        const content = choice?.message?.content ?? choice?.text ?? "";
        const text = String(content).trim();

        // A reasoning model can burn the whole output budget before writing a
        // single visible character. Surface that instead of returning "" and
        // letting the caller render an empty catalog with no explanation.
        if (!text && choice?.finish_reason === "length") {
          const reasoningTokens =
            data?.usage?.completion_tokens_details?.reasoning_tokens;
          const error = new Error(
            `Model "${aiProviderConfig.model}" returned no text: it used the entire ` +
              `${maxTokens}-token output budget` +
              (reasoningTokens ? ` on internal reasoning (${reasoningTokens} tokens)` : "") +
              `. Raise "Max Output Tokens" in the advanced settings, or choose a model ` +
              `that does not reason before answering.`
          );
          error.status = 502;
          throw error;
        }

        return text;
      },
    };
  }

  throw new Error(`Unsupported AI provider: ${aiProviderConfig.provider}`);
}

module.exports = {
  createAiTextGenerator,
  getAiProviderConfigFromConfig,
  getOpenAIChatCompletionsUrl,
  detectProviderFromApiKey,
  DEFAULT_GEMINI_MODEL,
};
