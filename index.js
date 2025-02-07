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
    if (id === 'aisearch.movies' || id === 'aisearch.series') {
        if (!extra.search) {
            return { metas: [] };
        }

        try {
            // Return a message prompting for configuration
            return { 
                metas: [],
                notification: {
                    message: "Please configure your API key in addon settings",
                    title: "Configuration Required",
                    type: "info"
                }
            };
        } catch (error) {
            console.error('Search error:', error);
            return { 
                metas: [],
                notification: {
                    message: "An error occurred while searching",
                    title: "Search Error",
                    type: "error"
                }
            };
        }
    }

    return { metas: [] };
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