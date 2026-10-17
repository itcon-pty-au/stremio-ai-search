/**
 * Detects whether a search query names a language/film-industry, so the
 * pipeline can (a) tell the AI to recommend titles in that original language
 * and (b) prefer TMDB candidates whose original_language matches when
 * resolving the AI's title|year output.
 *
 * Detection is intentionally conservative: an exact token match against a
 * curated alias list, then a fuzzy pass (Damerau-Levenshtein) that only
 * considers tokens of 6+ chars sharing the alias's first letter — typos
 * rarely change the first letter, and this blocks real-word collisions like
 * "trench" -> "french" or "spawn" -> "spain".
 *
 * A match is "strong" (the user asked for content in that language) or
 * "weak" (the word may only describe a character, setting or subject — "a
 * movie where a Mexican boy..." must not restrict results to Spanish-language
 * films). Strong means the alias is a language-only word or industry
 * nickname ("malayalam", "bollywood", "k-drama"), sits next to a content
 * noun ("mexican movies", "películas mexicanas", "dorama coreano",
 * "películas de méxico", "movies in korean"), or the query is short enough
 * that it can only be naming a kind of content ("korean revenge", "italian
 * giallo") — describing a character takes a sentence.
 */

// ISO 639-1 code -> display name + query aliases (lowercase, no accents).
// `aliases` are English and also feed the fuzzy pass; `local` are the
// Spanish/Portuguese/French/Italian/German forms (incl. feminine and plural),
// matched exactly only — fuzzy-matching them would collide with everyday
// words ("gracia" -> "grecia").
// Industry nicknames (bollywood, kollywood...) are high-signal and included.
const LANGUAGES = {
  en: {
    name: "English",
    aliases: ["english", "hollywood", "american"],
    local: [
      "ingles", "inglesa", "ingleses", "inglesas", "americano", "americana",
      "americanos", "americanas", "estadounidense", "estadounidenses",
      "anglais", "anglaise", "anglaises", "englisch",
    ],
  },
  hi: { name: "Hindi", aliases: ["hindi", "bollywood"], local: [] },
  ta: { name: "Tamil", aliases: ["tamil", "kollywood"], local: [] },
  te: { name: "Telugu", aliases: ["telugu", "tollywood"], local: [] },
  ml: { name: "Malayalam", aliases: ["malayalam", "mollywood"], local: [] },
  kn: { name: "Kannada", aliases: ["kannada", "sandalwood"], local: [] },
  bn: { name: "Bengali", aliases: ["bengali", "bangla"], local: [] },
  mr: { name: "Marathi", aliases: ["marathi"], local: [] },
  pa: { name: "Punjabi", aliases: ["punjabi"], local: [] },
  gu: { name: "Gujarati", aliases: ["gujarati"], local: [] },
  ur: { name: "Urdu", aliases: ["urdu"], local: [] },
  ko: {
    name: "Korean",
    aliases: ["korean", "korea", "kdrama"],
    local: [
      "coreano", "coreana", "coreanos", "coreanas", "corea", "coreia",
      "coreen", "coreenne", "coreens", "coreennes", "coreani", "coreane",
      "koreanisch", "koreanische", "koreanischen",
    ],
  },
  ja: {
    name: "Japanese",
    aliases: ["japanese", "japan", "anime", "jdrama"],
    local: [
      "japones", "japonesa", "japoneses", "japonesas", "japon", "japao",
      "japonais", "japonaise", "japonaises", "giapponese", "giapponesi",
      "giappone", "japanisch", "japanische", "japanischen",
    ],
  },
  zh: {
    name: "Chinese",
    aliases: ["chinese", "mandarin", "cantonese", "china"],
    local: [
      "chino", "chinos", "chinas", "chines", "chinesa", "chinesas",
      "chineses", "chinois", "chinoise", "chinoises", "cinese", "cinesi",
      "chinesisch", "chinesische", "chinesischen",
    ],
  },
  fr: {
    name: "French",
    aliases: ["french", "france"],
    local: [
      "frances", "francesa", "franceses", "francesas", "francia", "francais",
      "francaise", "francaises", "francese", "francesi", "franzosisch",
      "franzosische", "franzosischen", "frankreich",
    ],
  },
  es: {
    name: "Spanish",
    aliases: ["spanish", "spain", "mexican", "mexico", "argentine"],
    // "colombian" is exact-only: fuzzy-matched it catches "columbia"
    local: [
      "colombian", "espanol", "espanola", "espanoles", "espanolas", "espana", "castellano",
      "mexicano", "mexicana", "mexicanos", "mexicanas", "argentino",
      "argentina", "argentinos", "argentinas", "colombiano", "colombiana",
      "colombianos", "colombianas", "colombia", "espanhol", "espanhola",
      "espanhois", "espagnol", "espagnole", "espagnols", "espagnoles",
      "espagne", "spagnolo", "spagnola", "spagnoli", "spagnole", "spanisch",
      "spanische", "spanischen",
    ],
  },
  de: {
    name: "German",
    aliases: ["german", "germany"],
    local: [
      "aleman", "alemana", "alemanes", "alemanas", "alemania", "alemao",
      "alema", "alemaes", "allemand", "allemande", "allemands", "allemandes",
      "allemagne", "tedesco", "tedesca", "tedeschi", "tedesche", "deutsch",
      "deutsche", "deutschen", "deutschland",
    ],
  },
  it: {
    name: "Italian",
    aliases: ["italian", "italy"],
    local: [
      "italiano", "italiana", "italianos", "italianas", "italiani",
      "italiane", "italia", "italien", "italienne", "italiens", "italiennes",
      "italie", "italienisch", "italienische", "italienischen",
    ],
  },
  pt: {
    name: "Portuguese",
    aliases: ["portuguese", "portugal", "brazilian", "brazil"],
    local: [
      "portugues", "portuguesa", "portugueses", "portuguesas", "brasileno",
      "brasilena", "brasilenos", "brasilenas", "brasileiro", "brasileira",
      "brasileiros", "brasileiras", "brasil", "bresilien", "bresilienne",
      "bresiliens", "bresiliennes", "bresil", "portugais", "portugaise",
      "portoghese", "brasiliano", "brasiliana", "portugiesisch",
      "brasilianisch",
    ],
  },
  ru: {
    name: "Russian",
    aliases: ["russian", "russia"],
    local: [
      "ruso", "rusa", "rusos", "rusas", "rusia", "russo", "russa", "russos",
      "russas", "russe", "russes", "russie", "russisch", "russische",
    ],
  },
  pl: {
    name: "Polish",
    aliases: ["polish", "poland"],
    local: [
      "polaco", "polaca", "polacos", "polacas", "polonia", "polones",
      "polonesa", "polonais", "polonaise", "polacco", "polnisch",
    ],
  },
  tr: {
    name: "Turkish",
    aliases: ["turkish"],
    local: [
      "turco", "turca", "turcos", "turcas", "turquia", "turc", "turque",
      "turcs", "turques", "turquie", "turchi", "turkisch", "turkische",
    ],
  },
  th: {
    name: "Thai",
    aliases: ["thai", "thailand"],
    local: [
      "tailandes", "tailandesa", "tailandeses", "tailandesas", "tailandia",
      "thailandais", "thailandaise", "thailandese",
    ],
  },
  id: {
    name: "Indonesian",
    aliases: ["indonesian", "indonesia"],
    local: ["indonesio", "indonesios", "indonesias", "indonesien"],
  },
  vi: {
    name: "Vietnamese",
    aliases: ["vietnamese", "vietnam"],
    local: ["vietnamita", "vietnamitas", "vietnamien", "vietnamienne"],
  },
  ar: { name: "Arabic", aliases: ["arabic"], local: ["arabe", "arabes"] },
  fa: {
    name: "Persian",
    aliases: ["persian", "farsi", "iranian", "iran"],
    local: ["persa", "persas", "irani", "iranies", "iranien", "iranienne"],
  },
  he: {
    name: "Hebrew",
    aliases: ["hebrew", "israeli"],
    local: ["hebreo", "hebrea", "hebraico", "hebreu", "israelies", "israelien"],
  },
  el: {
    name: "Greek",
    aliases: ["greek"],
    local: [
      "griego", "griega", "griegos", "griegas", "grecia", "grego", "grega",
      "grec", "grecque", "grecs", "grecques", "greco", "griechisch",
    ],
  },
  sv: {
    name: "Swedish",
    aliases: ["swedish", "sweden"],
    local: [
      "sueco", "sueca", "suecos", "suecas", "suecia", "suedois", "suedoise",
      "svedese", "schwedisch",
    ],
  },
  no: {
    name: "Norwegian",
    aliases: ["norwegian", "norway"],
    local: [
      "noruego", "noruega", "noruegos", "noruegas", "norueguesa", "noruegues",
      "norvegien", "norvegienne", "norvegese", "norwegisch",
    ],
  },
  da: {
    name: "Danish",
    aliases: ["danish", "denmark"],
    local: [
      "danes", "danesa", "daneses", "danesas", "dinamarca", "danois",
      "danoise", "danese", "danisch",
    ],
  },
  fi: {
    name: "Finnish",
    aliases: ["finnish", "finland"],
    local: [
      "finlandes", "finlandesa", "finlandeses", "finlandesas", "finlandia",
      "finlandais", "finlandaise", "finlandese", "finnisch",
    ],
  },
  nl: {
    name: "Dutch",
    aliases: ["dutch"],
    local: [
      "holandes", "holandesa", "holandeses", "holandesas", "neerlandes",
      "neerlandais", "neerlandaise", "olandese", "niederlandisch",
    ],
  },
  cs: { name: "Czech", aliases: ["czech"], local: ["checo", "checa", "tcheque"] },
  hu: {
    name: "Hungarian",
    aliases: ["hungarian"],
    local: ["hungaro", "hungara", "hongrois", "hongroise", "ungherese"],
  },
  ro: {
    name: "Romanian",
    aliases: ["romanian"],
    local: ["rumano", "rumana", "romeno", "romena", "roumain", "roumaine"],
  },
  uk: {
    name: "Ukrainian",
    aliases: ["ukrainian", "ukraine"],
    local: [
      "ucraniano", "ucraniana", "ucranianos", "ucranianas", "ucrania",
      "ukrainien", "ukrainienne",
    ],
  },
};

// Words that only ever mean the language or its film industry, so they count
// as a request for that language wherever they appear. Nationality and
// country words ("korean", "mexicano") need a content noun next to them.
// "sandalwood" and "hollywood" are left out: both are common subjects.
const STRONG_ALIASES = new Set([
  "hindi", "bollywood", "tamil", "kollywood", "telugu", "tollywood",
  "malayalam", "mollywood", "kannada", "bengali", "bangla", "marathi",
  "punjabi", "gujarati", "urdu", "kdrama", "jdrama", "anime", "mandarin",
  "cantonese", "farsi", "castellano",
]);

// Content nouns that make an adjacent nationality word a language request.
// Matched against normalized tokens; plurals and Spanish/Portuguese/French/
// Italian/German forms included.
const CONTENT_NOUNS = new Set([
  "movie", "movies", "film", "films", "filme", "filmes", "filmen", "cinema",
  "cine", "kino", "pelicula", "peliculas", "peli", "pelis", "show", "shows",
  "series", "serie", "serien", "tv", "sitcom", "sitcoms", "drama", "dramas",
  "dorama", "doramas", "telenovela", "telenovelas", "novela", "novelas",
  "thriller", "thrillers", "horror", "terror", "comedy", "comedies",
  "comedia", "comedias", "comedie", "commedia", "commedie",
  "komodie", "romance", "romances", "action", "accion", "acao", "crime",
  "crimen", "mystery", "mysteries", "misterio", "suspense", "suspenso",
  "fantasy", "fantasia", "western", "westerns", "musical", "musicals",
  "documentary", "documentaries", "documental", "documentales",
  "documentario", "documentarios", "documentaire", "documentaires",
  "animation", "animated", "animacion", "animada", "animadas", "animado",
  "animados", "animacao", "zombie", "zombies", "noir", "scifi", "sci",
  "anime", "kdrama", "jdrama", "cinematografia", "variety", "reality",
  "romcom", "romcoms", "wuxia", "giallo", "dizi", "dizis",
]);

// A query with at most this many non-filler words that names a nationality
// is treated as a language request.
const SHORT_QUERY_MAX_WORDS = 3;

// Articles/prepositions skipped when looking for the content noun next to a
// nationality word ("película de la India", "movies in korean").
const FILLER_WORDS = new Set([
  "a", "an", "the", "of", "from", "in", "made", "de", "del", "la", "las",
  "el", "los", "lo", "en", "em", "da", "do", "das", "dos", "du", "des",
  "di", "le", "les", "aus", "im", "un", "une", "una", "uno", "um", "uma",
]);

// alias -> code, insertion order preserved for the fuzzy pass
const ALIAS_INDEX = new Map(); // every alias, exact pass
const FUZZY_INDEX = new Map(); // English aliases only, fuzzy pass
for (const [code, def] of Object.entries(LANGUAGES)) {
  for (const alias of def.aliases) {
    ALIAS_INDEX.set(alias, code);
    FUZZY_INDEX.set(alias, code);
  }
  for (const alias of def.local) {
    if (!ALIAS_INDEX.has(alias)) ALIAS_INDEX.set(alias, code);
  }
}

/**
 * Lowercases, strips accents ("películas" -> "peliculas", "ñ" -> "n") and
 * splits on anything that isn't a letter or digit.
 */
function tokenizeQuery(query) {
  if (!query || typeof query !== "string") return [];
  return query
    .toLowerCase()
    .normalize("NFKC")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function isContentNoun(token) {
  return Boolean(token) && CONTENT_NOUNS.has(token);
}

/**
 * Optimal string alignment distance (Damerau-Levenshtein with adjacent
 * transpositions counted as one edit — covers "malayalm" -> "malayalam").
 */
function osaDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0)
  );
  for (let i = 0; i <= a.length; i++) d[i][0] = i;
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

function fuzzyMatch(tok) {
  if (tok.length < 6) return null;
  for (const [alias, code] of FUZZY_INDEX) {
    if (alias.length < 6) continue;
    if (alias[0] !== tok[0]) continue;
    const max = alias.length >= 9 ? 2 : 1;
    if (osaDistance(tok, alias, max) <= max) return { alias, code };
  }
  return null;
}

/**
 * Is there a content noun next to tokens[start..end], skipping up to two
 * filler words on either side?
 */
function hasAdjacentContentNoun(tokens, start, end) {
  for (const step of [-1, 1]) {
    let i = step < 0 ? start - 1 : end + 1;
    let skipped = 0;
    while (i >= 0 && i < tokens.length && FILLER_WORDS.has(tokens[i]) && skipped < 2) {
      i += step;
      skipped++;
    }
    if (i >= 0 && i < tokens.length && isContentNoun(tokens[i])) return true;
  }
  return false;
}

/**
 * Returns the language the query names and how strongly, or null:
 *   { code, strong, alias, fuzzy }
 * A strong match anywhere wins over an earlier weak one.
 * e.g. "latest malayalam movies"     -> { code: "ml", strong: true }
 *      "películas mexicanas"         -> { code: "es", strong: true }
 *      "a movie about a mexican boy" -> { code: "es", strong: false }
 *      "time loop movie"             -> null
 */
function analyzeQueryLanguage(query) {
  const tokens = tokenizeQuery(query);
  const isShortQuery =
    tokens.filter((t) => !FILLER_WORDS.has(t)).length <= SHORT_QUERY_MAX_WORDS;
  let firstWeak = null;

  for (let i = 0; i < tokens.length; i++) {
    // Single token, then the adjacent-pair join ("k-drama" -> "kdrama"),
    // then the fuzzy pass for typos ("malayalm")
    const attempts = [{ tok: tokens[i], end: i }];
    if (i < tokens.length - 1) {
      attempts.push({ tok: tokens[i] + tokens[i + 1], end: i + 1 });
    }

    let match = null;
    for (const { tok, end } of attempts) {
      if (ALIAS_INDEX.has(tok)) {
        match = { code: ALIAS_INDEX.get(tok), alias: tok, fuzzy: false, end };
        break;
      }
    }
    if (!match) {
      const fuzzy = fuzzyMatch(tokens[i]);
      if (fuzzy) match = { ...fuzzy, fuzzy: true, end: i };
    }
    if (!match) continue;

    const strong =
      isShortQuery ||
      STRONG_ALIASES.has(match.alias) ||
      hasAdjacentContentNoun(tokens, i, match.end);
    const result = {
      code: match.code,
      strong,
      alias: match.alias,
      fuzzy: match.fuzzy,
    };
    if (strong) return result;
    if (!firstWeak) firstWeak = result;
  }

  return firstWeak;
}

/**
 * Returns the ISO 639-1 code of a language the query names (strong or weak),
 * or null. e.g. "latest malayalam movies" -> "ml", "malayalm thriller" -> "ml",
 * "k-drama about revenge" -> "ko", "time loop movie" -> null
 */
function detectQueryLanguage(query) {
  const match = analyzeQueryLanguage(query);
  return match ? match.code : null;
}

/** Display name for a detected code, e.g. "ml" -> "Malayalam". */
function getLanguageName(code) {
  return (code && LANGUAGES[code] && LANGUAGES[code].name) || null;
}

module.exports = {
  analyzeQueryLanguage,
  detectQueryLanguage,
  getLanguageName,
  tokenizeQuery,
  isContentNoun,
  LANGUAGES,
};
