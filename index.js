const { addonBuilder } = require("stremio-addon-sdk");
const manifest = require("./manifest.json");
const fs = require("fs");
const fetch = require("node-fetch");

const builder = new addonBuilder(manifest);

// Define settings for API key storage
builder.defineSettings({
    apiKey: {
        type: 'string',
        title: 'OpenAI API Key',
        required: true
    }
});

// Define catalog handler for search results
builder.defineCatalogHandler(async ({ type, id, extra, config }) => {
    console.log('----------------------------------------');
    console.log('Received catalog request:', { type, id, extra });
    console.log('----------------------------------------');

    if ((id === 'aisearch.movies' || id === 'aisearch.series') && extra.search) {
        try {
            // Get API key from Stremio settings
            const apiKey = config.apiKey;
            if (!apiKey) {
                return {
                    metas: [],
                    notification: {
                        message: "Please configure your OpenAI API key in the addon settings",
                        title: "Configuration Required",
                        type: "info"
                    }
                };
            }

            // Perform the search with the stored API key
            const results = await searchWithAI(extra.search, apiKey);
            return {
                metas: results.map(result => formatSearchResult(result, type))
            };
        } catch (error) {
            console.error('Search error:', error);
            return { metas: [] };
        }
    }
    return { metas: [] };
});

async function searchWithAI(query, apiKey) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: "gpt-3.5-turbo",
            messages: [{
                role: "system",
                content: "You are a movie and TV show recommendation expert. Provide relevant suggestions based on the user's query."
            }, {
                role: "user",
                content: `Suggest 5 movies or TV shows related to: ${query}. Return response in JSON format with array of objects containing: title, year, description, rating (1-10), poster (leave empty)`
            }]
        })
    });

    if (!response.ok) {
        throw new Error('Invalid API key or API error');
    }

    const data = await response.json();
    return JSON.parse(data.choices[0].message.content);
}

function formatSearchResult(result, type) {
    return {
        id: `ai_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        type: type,
        name: result.title,
        poster: result.poster || null,
        background: result.background || null,
        description: result.description,
        releaseInfo: result.year?.toString() || "",
        imdbRating: result.rating ? result.rating.toString() : null
    };
}

// Generate static configuration
const addonInterface = builder.getInterface();
fs.writeFileSync('config.json', JSON.stringify(addonInterface, null, 4));
fs.writeFileSync('manifest.json', JSON.stringify(manifest, null, 4));

if (process.env.NODE_ENV === 'production') {
    console.log('Static files generated');
    process.exit(0);
} else {
    const { serveHTTP } = require("stremio-addon-sdk");
    serveHTTP(addonInterface, { port: 7000 });
} 