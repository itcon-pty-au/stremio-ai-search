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
            // Perform the AI search
            const results = await searchWithAI(extra.search);
            
            // Map the results to Stremio format
            const metas = results.map(result => formatSearchResult(result, type));
            
            return {
                metas,
                cacheMaxAge: 3600 // Cache for 1 hour
            };
        } catch (error) {
            console.error('Search error:', error);
            return {
                metas: [],
                notification: {
                    message: "Please configure the addon in Settings > Addons",
                    title: "Configuration Required",
                    type: "info"
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

// Helper function to perform AI search
async function searchWithAI(query) {
    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY || 'YOUR_DEFAULT_KEY'}`
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
            throw new Error(`API request failed: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        
        if (!data.choices || !data.choices[0] || !data.choices[0].message || !data.choices[0].message.content) {
            throw new Error('Invalid response format from OpenAI API');
        }

        try {
            const parsedResults = JSON.parse(data.choices[0].message.content);
            if (!Array.isArray(parsedResults)) {
                throw new Error('Expected array of results');
            }
            return parsedResults;
        } catch (parseError) {
            console.error('Parse error:', data.choices[0].message.content);
            throw new Error('Failed to parse AI response as JSON');
        }
    } catch (error) {
        console.error('OpenAI API error:', error);
        // Return a default response instead of throwing
        return [{
            title: `Search Results for: ${query}`,
            year: 2024,
            description: "Unable to fetch AI recommendations. Please check your API key configuration.",
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
    console.log('Static files generated');
    process.exit(0);
} else {
    const { serveHTTP } = require("stremio-addon-sdk");
    serveHTTP(addonInterface, { port: 7000 });
} 