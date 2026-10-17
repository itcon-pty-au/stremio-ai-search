const test = require("node:test");
const assert = require("node:assert/strict");
const {
  analyzeQueryLanguage,
  detectQueryLanguage,
} = require("../utils/queryLanguage");
const { isRecencyQuery } = require("../utils/queryRecency");

function lang(query) {
  const match = analyzeQueryLanguage(query);
  return match ? `${match.code}:${match.strong ? "strong" : "weak"}` : null;
}

test("a nationality describing a character is only a weak match (issue #253)", () => {
  assert.equal(
    lang("película donde un niño mexicano viaja a la tierra de los muertos por la música"),
    "es:weak"
  );
  assert.equal(lang("movie where a mexican boy travels to the land of the dead"), "es:weak");
  assert.equal(lang("a movie about a korean family"), "ko:weak");
  assert.equal(lang("movie about the french revolution"), "fr:weak");
});

test("Spanish language and nationality words next to a content noun are strong", () => {
  assert.equal(lang("comedias españolas"), "es:strong");
  assert.equal(lang("comedias espanolas"), "es:strong");
  assert.equal(lang("dorama coreano"), "ko:strong");
  assert.equal(lang("terror coreano"), "ko:strong");
  assert.equal(lang("series francesas"), "fr:strong");
  assert.equal(lang("películas mexicanas"), "es:strong");
  assert.equal(lang("una película japonesa de terror"), "ja:strong");
  assert.equal(lang("películas en español"), "es:strong");
  assert.equal(lang("filmes brasileiros"), "pt:strong");
  assert.equal(lang("films français"), "fr:strong");
});

test("English queries keep working", () => {
  assert.equal(lang("latest malayalam movies"), "ml:strong");
  assert.equal(lang("latest malayalm movies"), "ml:strong");
  assert.equal(lang("k-drama about revenge"), "ko:strong");
  assert.equal(lang("korean thriller"), "ko:strong");
  assert.equal(lang("mexican movies"), "es:strong");
  assert.equal(lang("movies in korean"), "ko:strong");
  assert.equal(lang("bollywood dance movies"), "hi:strong");
  assert.equal(lang("anime like death note"), "ja:strong");
});

test("language-only words are strong without a content noun", () => {
  assert.equal(lang("something in hindi"), "hi:strong");
  assert.equal(lang("tamil revenge story"), "ta:strong");
});

test("a nationality in a short query is strong", () => {
  assert.equal(lang("korean revenge"), "ko:strong");
  assert.equal(lang("korean romcom"), "ko:strong");
  assert.equal(lang("chinese martial arts"), "zh:strong");
  assert.equal(lang("japanese ghost stories"), "ja:strong");
  assert.equal(lang("italian giallo"), "it:strong");
  assert.equal(lang("french new wave"), "fr:strong");
  assert.equal(lang("turkish dizi"), "tr:strong");
  // filler words don't count towards the length
  assert.equal(lang("the best of the korean revenge"), "ko:strong");
});

test("the extra content nouns make a nationality strong in longer queries", () => {
  assert.equal(lang("best korean variety shows to watch"), "ko:strong");
  assert.equal(lang("some korean reality competitions with drama"), "ko:strong");
  assert.equal(lang("old chinese wuxia with great fights"), "zh:strong");
  assert.equal(lang("classic italian giallo with a masked killer"), "it:strong");
  assert.equal(lang("long turkish dizi with family feuds"), "tr:strong");
});

test("colombian only matches exactly", () => {
  assert.equal(lang("columbia pictures classics"), null);
  assert.equal(lang("colombian movies"), "es:strong");
  assert.equal(lang("películas colombianas"), "es:strong");
});

test("a strong match later in the query wins over an earlier weak one", () => {
  assert.equal(lang("about a mexican painter, korean movies only"), "ko:strong");
});

test("no false positives on ordinary words", () => {
  assert.equal(lang("time loop movie"), null);
  assert.equal(lang("trench warfare movie"), null);
  assert.equal(lang("spawn"), null);
  assert.equal(lang("una comedia con gracia"), null);
});

test("detectQueryLanguage still returns the code for strong and weak matches", () => {
  assert.equal(detectQueryLanguage("un niño mexicano"), "es");
  assert.equal(detectQueryLanguage("comedias españolas"), "es");
  assert.equal(detectQueryLanguage("time loop movie"), null);
});

test("recency: English", () => {
  assert.equal(isRecencyQuery("latest malayalam movies", 2026), true);
  assert.equal(isRecencyQuery("new movies about heists", 2026), true);
  assert.equal(isRecencyQuery("new york movies", 2026), false);
  assert.equal(isRecencyQuery("best thrillers of 2025", 2026), true);
  assert.equal(isRecencyQuery("movies from 1995", 2026), false);
});

test("recency: Spanish, Portuguese and French", () => {
  assert.equal(isRecencyQuery("comedias españolas recientes", 2026), true);
  assert.equal(isRecencyQuery("estrenos de terror", 2026), true);
  assert.equal(isRecencyQuery("películas nuevas de acción", 2026), true);
  assert.equal(isRecencyQuery("nuevas películas coreanas", 2026), true);
  assert.equal(isRecencyQuery("últimas películas de Nolan", 2026), true);
  assert.equal(isRecencyQuery("series de este año", 2026), true);
  assert.equal(isRecencyQuery("qué hay en cines", 2026), true);
  assert.equal(isRecencyQuery("lançamentos de terror", 2026), true);
  assert.equal(isRecencyQuery("films récents", 2026), true);
});

test("recency: Spanish words that are not about new releases", () => {
  assert.equal(isRecencyQuery("películas de nueva york", 2026), false);
  assert.equal(isRecencyQuery("el último samurái", 2026), false);
  assert.equal(isRecencyQuery("comedias españolas", 2026), false);
});

test("recency: nova is not a recency word", () => {
  assert.equal(isRecencyQuery("bossa nova movie", 2026), false);
  assert.equal(isRecencyQuery("nova documentaries", 2026), false);
  assert.equal(isRecencyQuery("novos filmes de terror", 2026), true);
});
