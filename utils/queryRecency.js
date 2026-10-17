const { tokenizeQuery, isContentNoun } = require("./queryLanguage");

// Phrases that ask for new releases on their own. Matched against the
// accent-stripped, lowercased query ("últimos estrenos" -> "ultimos
// estrenos"), so \b behaves on Spanish/Portuguese/French words too.
const RECENCY_PHRASES = new RegExp(
  "\\b(" +
    [
      // English
      "latest", "newest", "recent", "recently", "just released", "brand new",
      "now playing", "in theat(?:er|re)s", "this year", "this month",
      "currently airing", "new releases?",
      // Spanish
      "recientes?", "recientemente", "recien estrenad[ao]s?", "estrenos?",
      "estrenad[ao]s", "este ano", "este mes", "en cines?", "en cartelera",
      "en emision",
      // Portuguese
      "recentes?", "lancamentos?", "novidades", "nos cinemas?", "em cartaz",
      "acabou de sair", "neste ano",
      // French
      "recents?", "nouveautes?", "cette annee", "ce mois", "au cinema", "a l'affiche",
    ].join("|") +
    ")\\b"
);

// "New"/"latest" adjectives that only count next to a content noun, so
// "nueva york" or "el último samurái" don't trigger. Portuguese "nova" is
// left out: "bossa nova" and the "Nova" documentaries are far more common. Spanish/Portuguese/French
// adjectives can sit on either side ("películas nuevas", "nuevas películas").
const RECENCY_ADJECTIVES = new Set([
  "nuevo", "nueva", "nuevos", "nuevas", "ultimo", "ultima", "ultimos",
  "ultimas", "novo", "novos", "novas", "nouveau",
  "nouveaux", "nouvelle", "nouvelles", "dernier", "derniere", "derniers",
  "dernieres",
]);

function normalizeForMatch(query) {
  return String(query || "")
    .toLowerCase()
    .normalize("NFKC")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "");
}

/**
 * Does the query ask for new/recent releases? These are the queries where the
 * AI's training cutoff hurts, so we ground the prompt with live TMDB data.
 * A bare "new" is only counted in release-related phrases ("new movies") so
 * "new york movies" doesn't trigger. A year mention only counts for the
 * current or previous year — "movies from 1995" is not a recency query.
 */
function isRecencyQuery(query, currentYear) {
  const q = normalizeForMatch(query);
  if (RECENCY_PHRASES.test(q)) return true;
  if (/\bnew\b\s+(movies?|films?|shows?|series|releases?)/.test(q)) {
    return true;
  }

  const tokens = tokenizeQuery(query);
  for (let i = 0; i < tokens.length; i++) {
    if (!RECENCY_ADJECTIVES.has(tokens[i])) continue;
    if (isContentNoun(tokens[i - 1]) || isContentNoun(tokens[i + 1])) {
      return true;
    }
  }

  if (
    currentYear &&
    new RegExp(`\\b(${currentYear}|${currentYear - 1})\\b`).test(q)
  ) {
    return true;
  }
  return false;
}

module.exports = { isRecencyQuery };
