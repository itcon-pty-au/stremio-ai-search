const { addonBuilder } = require("stremio-addon-sdk");
const manifest = require("./manifest.json");
const fs = require("fs");

const builder = new addonBuilder(manifest);

// Define catalog handler for search results
builder.defineCatalogHandler(async ({ type, id, extra }) => {
    if (id === 'search') {
        const query = extra.search;
        // Your search logic here
        return {
            metas: [] // Return your search results here
        };
    }
    return { metas: [] };
});

// Define search handler
builder.defineSearchHandler(async (query) => {
    try {
        const apiKey = localStorage.getItem('stremio-ai-search-apikey');
        if (!apiKey) {
            throw new Error('API key not configured');
        }

        const results = await searchWithAI(query.search, apiKey);
        return { metas: results.map(formatSearchResult) };
    } catch (error) {
        console.error('Search error:', error);
        return { metas: [] };
    }
});

function formatSearchResult(result) {
    return {
        id: `ai_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        type: "movie",
        name: result.title,
        poster: result.poster || "https://example.com/default-poster.jpg",
        background: result.background || "https://example.com/default-background.jpg",
        description: result.description,
        releaseInfo: result.year?.toString() || "",
        imdbRating: result.rating || null,
        behaviorHints: {
            defaultVideoId: "no_video_id",
            hasScheduledVideos: false
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
const configJson = JSON.stringify(addonInterface, null, 4);
fs.writeFileSync('config.json', configJson);

// Only run server in development
if (process.env.NODE_ENV !== 'production') {
    const { serveHTTP } = require("stremio-addon-sdk");
    serveHTTP(addonInterface, { port: 7000 });
} 