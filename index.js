const { addonBuilder } = require("stremio-addon-sdk");
const manifest = require("./manifest.json");
const fs = require("fs");
const fetch = require("node-fetch");

const builder = new addonBuilder(manifest);

// Define catalog handler for search results
builder.defineCatalogHandler(async ({ type, id, extra }) => {
    if ((id === 'aisearch.movies' || id === 'aisearch.series') && extra.search) {
        try {
            const apiKey = process.env.OPENAI_API_KEY;
            if (!apiKey) {
                throw new Error('API key not configured');
            }

            const results = await searchWithAI(extra.search, apiKey);
            return { 
                metas: results.map(result => formatSearchResult(result, type)),
                cacheMaxAge: 3600 // Cache for 1 hour
            };
        } catch (error) {
            console.error('Search error:', error);
            return { metas: [] };
        }
    }
    return { metas: [] };
});

function formatSearchResult(result, type) {
    return {
        id: `ai_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        type: type, // Use the type passed from the catalog request
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

async function searchWithAI(query, apiKey) {
    try {
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

        const data = await response.json();
        const suggestions = JSON.parse(data.choices[0].message.content);
        return suggestions;
    } catch (error) {
        console.error('OpenAI API error:', error);
        return [{
            title: `AI Search Result for: ${query}`,
            year: 2024,
            description: "Unable to fetch AI recommendations at the moment.",
            rating: null,
            poster: null
        }];
    }
}

// Generate static configuration
const addonInterface = builder.getInterface();

// Generate both config.json and manifest.json
fs.writeFileSync('config.json', JSON.stringify(addonInterface, null, 4));
fs.writeFileSync('manifest.json', JSON.stringify(manifest, null, 4));

if (process.env.NODE_ENV === 'production') {
    // Exit immediately after generating config in production
    console.log('Static files generated');
    process.exit(0);
} else {
    // Run server in development
    const { serveHTTP } = require("stremio-addon-sdk");
    serveHTTP(addonInterface, { port: 7000 });
} 