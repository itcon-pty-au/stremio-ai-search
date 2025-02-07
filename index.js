const { addonBuilder } = require("stremio-addon-sdk");
const manifest = require("./manifest.json");
const fs = require("fs");
const fetch = require("node-fetch");

const builder = new addonBuilder(manifest);

// Define catalog handler for search results
builder.defineCatalogHandler(async ({ type, id, extra }) => {
    console.log('----------------------------------------');
    console.log('Received catalog request:');
    console.log('Type:', type);
    console.log('ID:', id);
    console.log('Extra:', JSON.stringify(extra, null, 2));
    console.log('----------------------------------------');

    // Handle both movie and series searches
    if ((id === 'aisearch.movies' || id === 'aisearch.series') && extra.search) {
        try {
            // Create a proxy endpoint that will handle the search
            // This will be called by the client with their API key
            return {
                metas: [],
                notification: {
                    message: "Search using the AI Search addon in Settings > Addons",
                    title: "How to Search",
                    type: "info"
                }
            };
        } catch (error) {
            console.error('Search error:', error);
            return {
                metas: [],
                notification: {
                    message: error.message,
                    title: "Search Error",
                    type: "error"
                }
            };
        }
    }

    return { metas: [] };
});

// Add a new endpoint for proxying the search
builder.defineResourceHandler('stream', async ({ type, id }) => {
    // This will be called when a user clicks on a search result
    return { streams: [] };
});

function formatSearchResult(result, type) {
    return {
        id: `ai_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        type: type,
        name: result.title,
        poster: result.poster || null,
        background: result.background || null,
        description: result.description,
        releaseInfo: result.year?.toString() || "",
        imdbRating: result.rating ? result.rating.toString() : null,
        behaviorHints: {
            adult: false
        }
    };
}

// Generate static configuration
const addonInterface = builder.getInterface();

// Generate both config.json and manifest.json
fs.writeFileSync('config.json', JSON.stringify(addonInterface, null, 4));
fs.writeFileSync('manifest.json', JSON.stringify(manifest, null, 4));

if (process.env.NODE_ENV === 'production') {
    console.log('Static files generated');
    process.exit(0);
} else {
    const { serveHTTP } = require("stremio-addon-sdk");
    serveHTTP(addonInterface, { port: 7000 });
} 