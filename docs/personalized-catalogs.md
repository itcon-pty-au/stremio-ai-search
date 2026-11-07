# Personalized catalogs: implementation and validation

This contribution adds opt-in AI recommendation rows using Stremio's native
Likes and Loves. It does not change Stremio, collect playback history, add
Trakt integration, or manage Stremio login credentials.

## Configuration and protocol

| Field | Default | Meaning |
| --- | --- | --- |
| `EnablePersonalizedCatalogs` | `false` | Register the two personal rows |
| `StremioLikedManifestUrl` | empty | Private official Liked addon-key manifest URL |
| `StremioLovedManifestUrl` | empty | Private official Loved addon-key manifest URL |

At least one source is required when enabled. The existing encrypted install
configuration and edit route carry these fields. Format validation happens
before the existing paid AI-key validation and again on encryption. It checks
the exact official HTTPS origin, addon kind and addon-key installation route;
it does not assert that the key is valid.

Catalog IDs are `aisearch.personal.movie` and `aisearch.personal.series`. They
return standard `{ metas, cacheAge: 0, staleAge: 0 }` responses, so client caching
does not hide the server's 15-minute source refresh. Unsupported or disabled
personal catalog requests return no items. Existing search/homepage/similar
catalog behavior is unchanged.

## Data flow

The source reader fetches the official manifests, reads declared movie/series
catalogs, and advances `skip` by the number of items actually returned until an
empty page. Redirects are rejected; requests time out after 10 seconds; bodies
are limited to 5 MiB. Repeated pages, 100-page traversal limits and invalid
responses fail the refresh rather than silently replacing a complete profile
with partial data. All configured sources must succeed for a new snapshot.

Ratings merge by type/ID with Love winning duplicates. The full snapshot is
fingerprinted independently of catalog order. The prompt selects up to 60
titles, prioritizing a 40-Love/20-Like allocation and redistributing spare slots.
Both output types learn from the same profile. Already-rated titles are filtered
using IDs and normalized title/year, before and after metadata resolution.

Source snapshots are shared across the two rows for 15 minutes. Each row's
results are reused for 24 hours unless the profile changes. SHA-256 keys include
the private sources and generation/rendering settings (including provider key,
model, language, adult setting, result count and poster/platform settings).
Concurrent requests share source and generation promises. A failure backs off
for 15 minutes. Successful old results can be served on failure, after filtering
out newly rated titles. Cache storage is bounded to 1,000 source snapshots and
1,000 recommendation entries, held only in memory. The existing clear-all-cache
admin action clears them too.

Private prompts never enter shared query logging or search caches. AI errors are
sanitized before the retry logger sees them, since providers can echo prompt
text. Official source URLs never go to the AI. Public metadata resolution still
uses the existing TMDB/artwork pipeline and caches. Removing or disabling a
source stops its use; memory entries are reclaimed by eviction or restart.

Personal responses accept the requested `type|title|year` lines as well as
`title|year` lines, numbered title/year lists, Markdown tables and structured
recommendation arrays. An unparseable AI reply, invalid TMDB key, unresolved
metadata and an all-already-rated result now produce distinct safe diagnostics;
raw provider responses are never exposed in those diagnostics.

## Automated checks

For local HTTP instances (for example `http://127.0.0.1:7000`) and custom HTTPS
ports, the configure button displays and copies the full HTTP(S) installation
URL. Paste it unchanged in **Stremio > Addons > Add addon**. The native
`stremio://` handler can rewrite HTTP to HTTPS and drop the port. One-click
installation remains enabled for standard-port HTTPS hosting only.

Run `npm ci` followed by `npm test` on Node 20.17 or newer. No real Stremio, TMDB,
or paid AI requests are made by the tests.

Tests cover URL normalization/allowlisting, older configurations, one or both
sources, paginated lists, duplicate ratings, preference changes/removal, empty
and malformed responses, bounded reads, source/AI failures, cache timing,
concurrent requests, isolation between users/settings and private prompt data.
HTTP integration tests exercise encryption/editing, manifests, catalog responses,
zero cache hints and the existing search/homepage routes and similar opt-out.

## Manual acceptance with a real account — pending

A local real-account diagnostic confirmed reading the official sources and
receiving a successful AI response. The provider returned `title|year` rather
than `type|title|year`; replaying that captured response through the corrected
parser and live TMDB resolution returned ordinary movie entries without an
error poster. This replay made no additional AI requests. Private diagnostic
links and responses stay excluded from Git and are removed after diagnosis.

Native-app verification and rating-change/removal checks below remain pending.
Do these locally; do not put URLs, passwords or session keys in issues, commits,
screenshots or test fixtures.

1. Use the official configurators to obtain both private addon-key URLs. In a
   local AI Search instance, enable personalization and install its updated URL.
2. Like a movie and Love a series. Confirm the official Liked/Loved catalogs
   contain them, then open both personal rows. Check both output types and confirm
   neither rated title is recommended. Expect up to the configured result count;
   invalid/unresolvable AI suggestions may reduce it.
3. Change the movie from Like to Love. After 15 minutes, request a personal row
   again and confirm its next source read reflects the new rating. Reopen within
   the cache window and confirm that it does not generate another AI request.
4. Remove one rating, wait for the source refresh window, and verify regeneration.
   Remove all ratings and confirm the explanatory poster appears without an AI call.
5. Temporarily disable networking and reopen a previously loaded row. Confirm
   cached results remain usable, or a diagnostic appears if no results exist.
6. Edit the addon configuration and confirm its toggle and private URL fields
   round-trip. Disable personalization and verify the personal rows disappear
   while search, custom homepage catalogs and Similar continue to work.

The official service has been observed returning a valid manifest and an empty
catalog even for an invalid key. Never interpret an empty response as verified
authentication. The real-account acceptance check above is required before
claiming end-to-end synchronization works against production Stremio.
