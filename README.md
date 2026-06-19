<div align="center">
  <img src="public/logo.png" alt="AI Search" width="120" height="120" style="background: #2a2a2a; border-radius: 20px; padding: 20px;"/>
</div>

# Stremio AI Search

An intelligent search addon for Stremio powered by AI (Gemini-compatible or any OpenAI-compatible provider like OpenAI, OpenRouter, Z.ai). Get personalized movie and TV series recommendations based on natural language queries.

<img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fstremio.itcon.au%2Faisearch%2Fstats%2Fcount%3Fformat%3Djson&query=%24.count&label=Recommendations%20served&color=blue" alt="Recommendations served" />

## Features

- Trakt integration to help the AI suggest personalized recommendations. Note: Only searches starting with "Recommend" will provide personalized recommendations using your watch history from Trakt.
- Choose between Gemini-compatible and OpenAI-compatible models (provider + model are configurable)
- You can set the number of recommendations AI should return for a query (30 Max)
- TMDB integration ensures you have a content rich catalog for movies and series
- RPDB integration gives you access to awesome posters with inbuilt ratings
- Optional Movie and Series recommendation catalogs in homescreen (Multiple supported)
- Optional Adult content recommendation
- AI based Similar items recommendation in streams view
- Error Posters in case of errors for better user experience

## Installation

1. Visit [Addon configuration](https://stremio.itcon.au/aisearch/configure)
2. Enter your API keys
3. Provide optional parameters
4. Install
5. Buy me a coffee :)
   <br/><br/>
   <a href="https://buymeacoffee.com/itcon">
   <img src="public/bmc.png" alt="Buy Me A Coffee" height="40" />
   </a>

## AI Provider Setup

In the configuration page you can choose an AI provider:

- **Gemini**: use a key from Google AI Studio and a Gemini model id (e.g. `gemini-2.5-flash-lite`)
- **OpenAI-compatible**: works with OpenAI / OpenRouter / Z.ai / other OpenAI-compatible APIs
  - Base URL examples: `https://api.openai.com`, `https://openrouter.ai/api`
  - Model examples: `gpt-4o-mini`, `openai/gpt-4o-mini` (OpenRouter-style)
  - Optional extra headers (JSON): `{"HTTP-Referer":"https://example.com","X-Title":"Stremio AI Search"}`

Advanced option:
- **AI Temperature**: controls randomness (lower is more deterministic; default `0.2`)

## Customizing Your Homepage

One of the most powerful features of this addon is the ability to create your own recommendation rows directly on the Stremio homepage. In the "Custom Homepage Catalogs" field within the addon's advanced settings, you can define multiple, comma-separated catalogs.

Use a Title:Query format for each entry. This colon-separated, key-value pair approach provides a more structured and intuitive way to define your homepage. The Title serves as the distinct name for your catalog, while the Query is the natural language request for recommendations. This method prevents ambiguity and makes your configuration easier to read and manage.

### Tips for Effective Homepage Catalogs

-   **Use a Comma-Separated List**: To create multiple catalogs in your homepage, separate each Title:Query pair with a comma.
    -   *Example*: `Mystery:recommend mystery thrillers,Sports:recommend sports movies`
-   **Get Personalized Recommendations**: Start your query with the word recommend to leverage your Trakt.tv watch history and ratings for highly personalized suggestions.
    -   *Example*: `For You:recommend feel-good movies` will find movies similar to what you've watched and liked on Trakt.
-   **Find the Latest Content**: Use keywords like new, latest, or recent to discover the most up-to-date movies and shows.
    -   *Example*: `New Series:new popular series` or `Recent Anime:latest anime movies`
-   **Be Specific**: The addon is intelligent. If you specify "movies" in your query, it will only create a movie catalog. Similarly, asking for "series" will result in only a series catalog. For ambiguous queries, it will create catalogs for both movies and series.
    -   *Example*: `Pixar Films:Pixar movies` will create a single "Pixar Films - Movie" catalog.

### Example Homepage Configuration
An example setting in the configuration page could be:
`Thrillers:recommend mind-bending thrillers,Popular Series:new popular series,A24 Films:best of A24,Anime Classics:90s anime`

This configuration would generate the following catalogs on your Stremio homepage:
- Thrillers - Movie
- Thrillers - Series
- Popular Series - Series
- A24 Films - Movie
- Anime Classics - Movie
- Anime Classics - Series

### Example Homepage Configuration

An example setting in the configuration page could be:
`recommend mind-bending thrillers, new popular series, best of A24, 90s anime`

This would generate the following catalogs on your Stremio homepage:
-   `Recommend mind-bending thrillers - Movie`
-   `Recommend mind-bending thrillers - Series`
-   `New popular series - Series`
-   `Best of A24 - Movie`
-   `90s anime - Movie`
-   `90s anime - Series`

## Query ideas

Here are some examples showing how versatile this addon is.

### Natural Language Queries

- "A heartwarming comedy about family relationships"
- "Critically acclaimed movies that flopped at the box office"
- "Best period dramas set in the 1800s"
- "Movies that take place in one night"
- "If I liked Inception, what should I watch next?"
- "Movies that feel like a Black Mirror episode"
- "Movies based on Stephen King novels"
- "Movies under 90 minutes long"
- "Movies in the Spanish language"
- "Movies set in Japan"
- "Movies where the protagonist has a hidden identity"
- "Movies where someone fakes their own death"
- "Movies to watch with pizza & beer"
- "Tell me a movie I've never heard of"
- "What movie should I watch with my grandmother?"

### Time Periods

- "Sci-fi movies from the 80s"
- "Modern crime series from 2020-2023"
- "Movies released in 1977"
- "90s teen comedies"
- "Films that captured the spirit of the 1960s counterculture"
- "Movies set in the future but made before 2000"
- "Best films of each decade from 1950-2020"
- "Most influential films by year since 2000"

### Genre Combinations

- "Best horror movies of all time"
- "Action comedy with martial arts"
- "Dark mystery thriller series"
- "Best indie horror films post-2015"
- "Sci-Fi Western crossovers"
- "Blade Runner + Film Noir"
- "Romantic comedies with supernatural elements"
- "Historical dramas with elements of magical realism"

### Mood & Style

- "Feel-good movies for a rainy day"
- "Feel-good comedies for a lazy Sunday"
- "Intense psychological thrillers"
- "Dark psychological thrillers from the last 5 years"
- "Movies to watch when I'm feeling nostalgic"
- "Movies to make me feel inspired"
- "Films that capture the feeling of summer nostalgia"
- "Movies with a dreamlike atmosphere"

### Similarities

- "Movies with crazy plot twists like The Sixth Sense"
- "Non-linear storytelling like Memento"
- "Road trip movies similar to Little Miss Sunshine"
- "Animated films with the emotional depth of Inside Out"
- "Movies with the same vibe as Lost in Translation"

### Franchise/Studio

- "Movies by A24 Studio"
- "Mission Impossible movies"
- "Last 5 James Bond movies"
- "Studio Ghibli films suitable for young children"
- "Star Wars movies in chronological order"
- "Horror franchises with the most sequels"
- "Netflix original documentaries"
- "Pixar movies with the best animation"

### By Director/Cast

- "Underrated movies by Christopher Nolan"
- "Best performances of Meryl Streep"
- "Movies with Ryan Gosling and Emma Stone"
- "Movies directed by female directors in the 2010s"
- "Films where comedians play serious roles"
- "Movies where the director also stars as the main character"
- "Films featuring actors who won Oscars for their roles"
- "Movies with ensemble casts"

### Thematic Searches

- "Revenge movies with satisfying endings"
- "Films about time travel that actually make sense"
- "Movies where the protagonist is the villain"
- "Films exploring the concept of memory"
- "Movies about unlikely friendships across generations"
- "Films that deal with grief in a meaningful way"
- "Movies about redemption"
- "Films that explore artificial intelligence"

### Exclusion Searches

- "Horror movies NOT involving supernatural elements"
- "Best movies NOT by Disney"
- "Sci-fi films without aliens"
- "Comedies that don't rely on crude humor"
- "Action movies without gun violence"
- "Thrillers without plot twists"
- "Romance movies without love triangles"
- "Disaster films that aren't about climate change"

### Maturity Rating

- "R-rated comedies from the 2000s"
- "Best PG movies for family movie night"
- "NC-17 films that are critically acclaimed"
- "G-rated movies that adults can enjoy too"
- "PG-13 action movies with minimal violence"
- "TV-MA series with complex storylines"
- "Films that pushed the boundaries of their rating"
- "Movies that were controversially rated"

### Cultural & Historical Context

- "Movies that capture the essence of 1970s New York"
- "Films that accurately portray historical events in Ancient Rome"
- "Movies about the fall of the Berlin Wall"
- "Series that explore post-Soviet Eastern Europe"
- "Films about cultural revolutions around the world"
- "Movies that defined Generation X"
- "Films that captured the zeitgeist of their era"
- "Historical events told from multiple perspectives"

### Technical & Cinematic Elements

- "Movies with exceptional cinematography in natural landscapes"
- "Films shot entirely in one take"
- "Movies with innovative practical effects (no CGI)"
- "Films with unreliable narrators"
- "Movies with fourth wall breaks"
- "Films with the most impressive long tracking shots"
- "Movies with experimental editing techniques"
- "Films with distinctive color palettes"

### Niche Combinations

- "Sci-fi horror set underwater"
- "Animated films for adults with philosophical themes"
- "Mockumentaries about fictional musicians"
- "Heist movies with female-led casts"
- "Dystopian stories that don't involve teenagers"
- "Comedies set in medieval times"
- "Sports films that aren't about winning the big game"
- "Romantic comedies with science fiction elements"

### Emotional Impact

- "Movies that will make me ugly cry"
- "Films that restore faith in humanity"
- "Movies that will leave me thinking for days"
- "Comfort films for anxiety"
- "Movies that feel like a warm hug"
- "Films that will help process grief"
- "Movies with unexpected emotional depth"
- "Films that changed people's worldviews"

### Situational

- "Movies to watch after a breakup"
- "Films perfect for a first date"
- "Movies to watch when you can't sleep"
- "Series to binge when sick in bed"
- "Films that are better on second viewing"
- "Movies to watch when you're home alone"
- "Films to inspire a career change"
- "Movies that pair well with specific foods"

### Unconventional Parameters

- "Movies where the villain wins"
- "Films with no dialogue for the first 15 minutes"
- "Movies where the main character dies halfway through"
- "Series where the setting is almost like another character"
- "Films with ambiguous endings that leave you guessing"
- "Movies that take place entirely in real-time"
- "Films set entirely in one location"
- "Movies told in reverse chronological order"

### Surprising & Unusual Queries

- "Movies where the dog doesn't die"
- "Films where food plays a central role"
- "Movies that accurately portray computer hacking"
- "Films where the twist is that there is no twist"
- "Movies set entirely in elevators or confined spaces"
- "Films where the soundtrack tells the story better than dialogue"
- "Movies that predicted real-world technology or events"
- "Films where the background extras are more interesting than the main plot"
- "Movies that are secretly about capitalism"
- "Films that work better if you watch them backwards"
- "Movies where the opening scene is the best part"
- "Films that were shot in your hometown but set somewhere else"
- "Movies where the weather is practically a character"
- "Films that are actually better when watched with commentary"
- "Movies that are impossible to explain to someone else"

### International & Language-Specific

- "Korean thrillers similar to Parasite"
- "French romantic comedies from the last decade"
- "Bollywood films that break traditional formulas"
- "Japanese animated films not made by Studio Ghibli"
- "Scandinavian crime dramas with female detectives"
- "African cinema exploring post-colonial themes"
- "Latin American magical realism films"
- "Middle Eastern movies about everyday life"

### Experimental & Art House

- "Surrealist films that aren't too pretentious"
- "Experimental movies that are still accessible to casual viewers"
- "Art house films with compelling narratives"
- "Movies that blend animation with live action meaningfully"
- "Films that play with color theory and visual symbolism"
- "Avant-garde cinema that actually tells a story"
- "Experimental documentaries with unique formats"
- "Films that challenge conventional narrative structure"

### Runtime & Viewing Experience

- "Best movies under 90 minutes"
- "Epic films that justify their long runtime"
- "Movies that feel shorter than they actually are"
- "Films perfect for a movie marathon"
- "Short films with powerful messages"
- "Movies you can watch while doing something else"
- "Films that demand your full attention"
- "TV series with short episodes"

### Adaptation & Source Material

- "Book-to-film adaptations that improved on the source"
- "Comic book movies that pleased hardcore fans"
- "Video game adaptations that actually worked"
- "Films based on true stories that stayed accurate"
- "Movies that are better than the books they're based on"
- "TV shows expanded from short films"
- "Adaptations that completely changed the source material"
- "Films based on obscure source material"

## Ranking Options

### Chronological Rankings

- "Star Wars movies ranked by release date"
- "Oscar winners for Best Picture ranked by year"
- "Horror franchises ranked by longevity"
- "Animated films ranked from oldest to newest"
- "Movie adaptations ranked by time between book and film release"
- "Film series ranked by consistency across decades"

### Rating-Based Rankings

- "Highest IMDB rated movies of all time"
- "Rotten Tomatoes' freshest horror films"
- "Movies with the biggest gap between critic and audience scores"
- "Films with perfect Metacritic scores"
- "Highest-grossing movies adjusted for inflation"
- "Cult classics with the lowest initial ratings"
- "Movies that won the most Academy Awards"
- "Films that swept all major award categories"

### Studio/Production Company Rankings

- "Disney animated films ranked by box office success"
- "Marvel movies ranked by critical reception"
- "Netflix original series ranked by viewer ratings"
- "HBO shows ranked by cultural impact"
- "Blumhouse horror films ranked by scariness"
- "Dreamworks animations ranked by humor"
- "A24 films ranked by artistic merit"
- "Warner Bros. franchises ranked by longevity"

### Director-Based Rankings

- "Christopher Nolan films ranked by complexity"
- "Quentin Tarantino movies ranked by dialogue quality"
- "Steven Spielberg films ranked by historical accuracy"
- "Martin Scorsese gangster films ranked by realism"
- "Wes Anderson movies ranked by visual style"
- "David Fincher thrillers ranked by plot twists"
- "Greta Gerwig films ranked by feminist themes"
- "Denis Villeneuve sci-fi movies ranked by visual effects"

### Actor Performance Rankings

- "Tom Hanks roles ranked by dramatic range"
- "Meryl Streep performances ranked by accent accuracy"
- "Leonardo DiCaprio films ranked by physical transformation"
- "Viola Davis performances ranked by emotional intensity"
- "Jim Carrey comedies ranked by physical comedy"
- "Daniel Day-Lewis roles ranked by method acting commitment"
- "Cate Blanchett performances ranked by character complexity"
- "Denzel Washington films ranked by monologue power"

### Technical Achievement Rankings

- "Movies ranked by innovative cinematography techniques"
- "Films ranked by practical effects excellence"
- "Movies ranked by sound design innovation"
- "Films ranked by editing complexity"
- "Movies ranked by costume design authenticity"
- "Films ranked by makeup transformation quality"
- "Movies ranked by long-take difficulty"
- "Films ranked by musical score memorability"

### Cultural Impact Rankings

- "Sci-fi movies ranked by influence on real technology"
- "Films ranked by quotability in popular culture"
- "Movies ranked by meme generation"
- "Films ranked by fashion trend influence"
- "Movies ranked by political controversy caused"
- "Films ranked by tourism impact on filming locations"
- "Movies ranked by merchandise sales"
- "Films ranked by academic study frequency"

### Audience Response Rankings

- "Horror movies ranked by jump scare effectiveness"
- "Comedies ranked by laugh-out-loud moments"
- "Dramas ranked by tear-jerking scenes"
- "Thrillers ranked by plot twist unexpectedness"
- "Action movies ranked by audience adrenaline"
- "Romances ranked by chemistry between leads"
- "Documentaries ranked by mind-changing potential"
- "Animated films ranked by adult appeal"

### Niche and Specific Rankings

- "Disaster movies ranked by scientific accuracy"
- "Heist films ranked by plan complexity"
- "Superhero movies ranked by villain memorability"
- "Time travel films ranked by paradox avoidance"
- "Zombie movies ranked by survival strategy realism"
- "Spy films ranked by gadget innovation"
- "Sports movies ranked by inspirational speeches"
- "Courtroom dramas ranked by legal accuracy"

### Budget & Box Office Rankings

- "Highest ROI movies of all time"
- "Blockbusters ranked by budget efficiency"
- "Low-budget films with the biggest cultural impact"
- "Movies that bombed financially but became classics"
- "Highest-grossing independent films"
- "Films that saved their studios from bankruptcy"
- "Most expensive movies that flopped at the box office"
- "Franchises ranked by average box office performance"

### Unconventional Rankings

- "Movies ranked by rewatchability factor"
- "Films ranked by 'so bad it's good' quality"
- "Movies ranked by unexpected cameos"
- "Films ranked by background detail richness"
- "Movies ranked by fan theory generation"
- "Films ranked by director's cut improvement"
- "Movies ranked by soundtrack sales"
- "Films ranked by sequel potential"

### Popularity Shift Rankings

- "Movies that gained cult status years after release"
- "Films that were ahead of their time"
- "Initially panned movies now considered masterpieces"
- "Critically acclaimed films that audiences hated"
- "Movies whose reputation improved with director's cuts"
- "Films that launched trends in cinema"
- "Movies that killed their franchises"
- "Forgotten classics deserving rediscovery"

## Self Hosting

### Environment Variables

When self-hosting the addon, you can configure the following environment variables in a `.env` file:

- `HOST` - Your domain/hostname without protocol (e.g., `example.com` or `localhost:7000`)
- `TRAKT_CLIENT_ID` - Your Trakt API client ID
- `TRAKT_CLIENT_SECRET` - Your Trakt API client secret
- `ENCRYPTION_KEY` - Key used for encrypting sensitive configuration data
- `RPDB_API_KEY` - API key for RPDB integration
- `ENABLE_LOGGING` - Set to "true" to enable logging
- `GITHUB_TOKEN` - GitHub token for issue submission
- `RECAPTCHA_SECRET_KEY` - Secret key for reCAPTCHA
- `ADMIN_TOKEN` - Token required for accessing cache management endpoints (new)

### Admin Endpoints

The addon provides several administrative endpoints for cache management. All endpoints require an admin token which should be set in the `.env` file as `ADMIN_TOKEN`.

### Cache Management

All endpoints are GET requests and require the `adminToken` as a query parameter. You can run any of these endpoints directly in your browser.

#### Cache Statistics

```bash
GET https://stremio.itcon.au/aisearch/cache/stats?adminToken=your-admin-token
```

#### AI Cache Management

```bash
# Clear all AI cache
GET https://stremio.itcon.au/aisearch/cache/clear/ai?adminToken=your-admin-token

# Remove specific AI cache entries by keywords
GET https://stremio.itcon.au/aisearch/cache/clear/ai/keywords?adminToken=your-admin-token&keywords=ocean%20thriller

# Purge all empty AI recommendation entries from the cache
GET https://stremio.itcon.au/aisearch/cache/purge/ai-empty?adminToken=your-admin-token
```

#### TMDB Cache Management

```bash
# Clear TMDB cache
GET https://stremio.itcon.au/aisearch/cache/clear/tmdb?adminToken=your-admin-token

# Clear TMDB details cache
GET https://stremio.itcon.au/aisearch/cache/clear/tmdb-details?adminToken=your-admin-token

# Clear TMDB discover cache
GET https://stremio.itcon.au/aisearch/cache/clear/tmdb-discover?adminToken=your-admin-token

# List all TMDB discover cache keys
GET https://stremio.itcon.au/aisearch/cache/list/tmdb-discover?adminToken=your-admin-token

# Remove a specific TMDB discover cache item
GET https://stremio.itcon.au/aisearch/cache/remove/tmdb-discover?key=discover_series_80_2023-09-01_en-US&adminToken=your-admin-token
```

#### Other Cache Management

```bash
# Clear RPDB cache
GET https://stremio.itcon.au/aisearch/cache/clear/rpdb?adminToken=your-admin-token

# Clear Trakt cache
GET https://stremio.itcon.au/aisearch/cache/clear/trakt?adminToken=your-admin-token

# Clear Trakt raw data cache
GET https://stremio.itcon.au/aisearch/cache/clear/trakt-raw?adminToken=your-admin-token

# Clear query analysis cache
GET https://stremio.itcon.au/aisearch/cache/clear/query-analysis?adminToken=your-admin-token

# Clear all caches
GET https://stremio.itcon.au/aisearch/cache/clear/all?adminToken=your-admin-token

# Save all caches to files
GET https://stremio.itcon.au/aisearch/cache/save?adminToken=your-admin-token
```

### Example Usage

You can use these endpoints directly in your browser by visiting:

```
https://stremio.itcon.au/aisearch/cache/clear/ai?adminToken=your-admin-token
https://stremio.itcon.au/aisearch/cache/clear/ai/keywords?adminToken=your-admin-token&keywords=your search terms
https://stremio.itcon.au/aisearch/cache/purge/ai-empty?adminToken=your-admin-token
https://stremio.itcon.au/aisearch/cache/list/tmdb-discover?adminToken=your-admin-token
https://stremio.itcon.au/aisearch/cache/remove/tmdb-discover?key=discover_series_80_2023-09-01_en-US&adminToken=your-admin-token
https://stremio.itcon.au/aisearch/cache/clear/all?adminToken=your-admin-token
```

### Response Examples

**Keywords-based cache removal response:**

```json
{
  "removed": 2,
  "entries": [
    {
      "key": "ocean thriller_movie_no_trakt",
      "timestamp": "2024-03-20T12:34:56.789Z",
      "query": "ocean thriller"
    }
  ]
}
```

**AI empty cache purge response:**
```json
{
  "message": "Purge of empty AI cache entries completed.",
  "scanned": 150,
  "purged": 12,
  "remaining": 138
}
```

**Keywords-based cache removal response:**
```json
{
  "removed": 2,
  "entries": [
    {
      "key": "ocean thriller_movie_no_trakt",
      "timestamp": "2024-03-20T12:34:56.789Z",
      "query": "ocean thriller"
    }
  ]
}
```

**TMDB discover cache list response:**

```json
{
  "success": true,
  "count": 3,
  "keys": [
    "discover_series_80_2023-09-01_en-US",
    "discover_movie_28_2024-01-01_en-US",
    "discover_series_18_2023-03-01_en-US"
  ]
}
```

**TMDB discover cache item removal response:**

```json
{
  "success": true,
  "message": "Cache item removed successfully",
  "key": "discover_series_80_2023-09-01_en-US"
}
```

**General cache clearing response:**

```json
{
  "cleared": true,
  "previousSize": 42
}
```

**Clear all caches response:**

```json
{
  "tmdb": { "cleared": true, "previousSize": 15 },
  "tmdbDetails": { "cleared": true, "previousSize": 10 },
  "tmdbDiscover": { "cleared": true, "previousSize": 8 },
  "ai": { "cleared": true, "previousSize": 42 },
  "rpdb": { "cleared": true, "previousSize": 8 },
  "trakt": { "cleared": true, "previousSize": 12 },
  "traktRaw": { "cleared": true, "previousSize": 5 },
  "queryAnalysis": { "cleared": true, "previousSize": 20 }
}
```
