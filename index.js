const { addonBuilder } = require("stremio-addon-sdk");
const manifest = require("./manifest.json");
const fs = require("fs");

const builder = new addonBuilder(manifest);

// Define search handler
builder.defineSearchHandler(async (query) => {
    try {
        // Get AI suggestions first
        const aiResults = await searchWithAI(query.search);
        
        return {
            metas: aiResults.map(result => ({
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
            }))
        };
    } catch (error) {
        console.error('Search error:', error);
        return { metas: [] };
    }
});

async function searchWithAI(query) {
    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
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