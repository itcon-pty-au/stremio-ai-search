const { addonBuilder } = require("stremio-addon-sdk");
const manifest = require("./manifest.json");
const fs = require("fs");

const builder = new addonBuilder(manifest);

// Define search handler
builder.defineSearchHandler(async (query) => {
    try {
        const results = await searchWithAI(query.search);
        return { metas: results };
    } catch (error) {
        console.error('Search error:', error);
        return { metas: [] };
    }
});

async function searchWithAI(query) {
    // This is a placeholder for the AI search implementation
    // You would integrate with your preferred AI service here
    return [
        {
            id: "tt1234567",
            type: "movie",
            name: `AI Search Result for: ${query}`,
            poster: "https://example.com/poster.jpg",
            background: "https://example.com/background.jpg",
            description: "This is a sample search result"
        }
    ];
}

// Generate static configuration
const addonInterface = builder.getInterface();
const configJson = JSON.stringify(addonInterface, null, 4);
fs.writeFileSync('config.json', configJson);

// Only run server in development
if (process.env.NODE_ENV !== 'production') {
    const { serveHTTP } = require("stremio-addon-sdk");
    serveHTTP(addonInterface, { port: 7000 });
} 