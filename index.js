const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const manifest = require("./manifest.json");
const fs = require("fs");
const fetch = require("node-fetch");
const express = require('express');
const path = require('path');

// Create express app for serving static files
const app = express();

// Create the addon builder
const builder = new addonBuilder(manifest);

// Add this near the top of your file, after creating the app
app.use((req, res, next) => {
    console.log('\n=== Incoming Request ===');
    console.log('Time:', new Date().toISOString());
    console.log('Method:', req.method);
    console.log('URL:', req.url);
    console.log('Headers:', req.headers);
    console.log('Query:', req.query);
    console.log('Body:', req.body);
    console.log('======================\n');
    next();
});

// Add debug logging for all requests
app.use((req, res, next) => {
    console.log('----------------------------------------');
    console.log('Incoming request:', req.method, req.url);
    console.log('Query parameters:', req.query);
    console.log('Headers:', req.headers);
    console.log('----------------------------------------');
    next();
});

// Add this debug middleware at the top after creating the app
app.use((req, res, next) => {
    console.log('\n=== New Request ===');
    console.log('Time:', new Date().toISOString());
    console.log('Method:', req.method);
    console.log('URL:', req.url);
    console.log('Query:', req.query);
    console.log('Body:', req.body);
    console.log('==================\n');
    next();
});

// Serve static files
app.use(express.static(path.join(__dirname)));

// Store our handler
const catalogHandler = async ({ type, id, extra, config }) => {
    console.log('\n=== Catalog Handler Called ===');
    console.log('Type:', type);
    console.log('ID:', id);
    console.log('Extra:', JSON.stringify(extra, null, 2));
    console.log('Config:', config ? 'Present' : 'Missing');

    // Return empty catalog for initial load (when no search term)
    if (!extra || !extra.search) {
        console.log('No search term - returning initial catalog');
        return {
            metas: [],
            cacheMaxAge: 0,
            staleRevalidate: 0,
            staleError: 0
        };
    }

    if ((id === 'aisearch.movies' || id === 'aisearch.series') && extra?.search) {
        try {
            console.log('Processing search:', extra.search);
            const apiKey = config?.openaiKey;
            if (!apiKey) {
                console.log('No API key configured');
                return {
                    metas: [],
                    notification: {
                        message: "Please configure your OpenAI API key in the addon settings",
                        title: "Configuration Required",
                        type: "info"
                    }
                };
            }

            const results = await searchWithAI(extra.search, apiKey);
            return { metas: results.map(result => formatSearchResult(result, type)) };
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

    console.log('Invalid catalog request or missing search term');
    return { metas: [] };
};

// Define the catalog handler
builder.defineCatalogHandler(catalogHandler);

// Serve configure.html with proper content type
app.get('/configure', (req, res) => {
    console.log('Serving configure.html');
    res.setHeader('Content-Type', 'text/html');
    res.sendFile(path.join(__dirname, 'configure.html'));
});

// Add error handling
app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(500).send('Internal Server Error');
});

// Define stream handler
builder.defineStreamHandler(({ type, id }) => {
    console.log('Stream handler called:', { type, id });
    return {
        streams: [],
        notification: {
            message: "This is a recommendation-only addon. It doesn't provide streaming links.",
            title: "No Streams Available",
            type: "info"
        }
    };
});

async function searchWithAI(query, apiKey) {
    console.log('Making OpenAI API request for query:', query);
    
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
                content: "You are a movie and TV show recommendation expert. You must respond with ONLY a raw JSON array, no markdown formatting, no explanation, no backticks."
            }, {
                role: "user",
                content: `Suggest 5 relevant movies or TV shows related to: "${query}".
                Respond with ONLY a raw JSON array like this:
                [{"title":"The Matrix","year":1999,"description":"A computer programmer discovers that reality is a simulation and joins a rebellion to overthrow the machines.","type":"movie"}]
                Your response must be a similar array with 5 items. Do not include any text before or after the JSON array. Do not use markdown formatting or backticks.`
            }],
            temperature: 0.7
        })
    });

    if (!response.ok) {
        console.error('OpenAI API error:', response.status, response.statusText);
        throw new Error('Invalid API key or API error');
    }

    const data = await response.json();
    console.log('Raw OpenAI response:', data.choices[0].message.content);

    try {
        let content = data.choices[0].message.content;
        
        // Remove any markdown formatting
        content = content.replace(/```json\s*|\s*```/g, '');
        content = content.replace(/```\s*|\s*```/g, '');
        content = content.replace(/`/g, '');
        
        // Remove any text before the first [ and after the last ]
        content = content.substring(content.indexOf('['), content.lastIndexOf(']') + 1);
        
        console.log('Cleaned content:', content);
        
        const parsed = JSON.parse(content);
        console.log('Successfully parsed results:', parsed);
        
        if (!Array.isArray(parsed)) {
            throw new Error('Response is not an array');
        }
        
        return parsed;
    } catch (error) {
        console.error('Error parsing OpenAI response:', error);
        console.error('Parse error details:', error.message);
        throw new Error('Failed to parse AI response');
    }
}

function formatSearchResult(result, type) {
    const defaultPoster = "https://img.freepik.com/free-vector/cinema-film-strips-movie-production-logo-design_1017-33466.jpg";
    
    return {
        id: `ai_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        type: type === 'movie' ? 'movie' : 'series',
        name: result.title,
        poster: defaultPoster,
        background: defaultPoster,
        description: result.description,
        releaseInfo: result.year?.toString() || ""
    };
}

// Generate static configuration
const addonInterface = builder.getInterface();
fs.writeFileSync('config.json', JSON.stringify(addonInterface, null, 4));
fs.writeFileSync('manifest.json', JSON.stringify(manifest, null, 4));

if (process.env.NODE_ENV === 'production') {
    console.log('Running in production mode');
    console.log('Static files generated');
    process.exit(0);
} else {
    console.log('Running in development mode');
    // Get the router from the SDK
    app.use(getRouter(builder.getInterface()));
    
    app.listen(7000, () => {
        console.log('========================================');
        console.log('Configure URL:', 'https://github.com/itcon-pty-au/stremio-ai-search/blob/gh-pages/configure.html');
        console.log('Manifest URL:', 'https://github.com/itcon-pty-au/stremio-ai-search/blob/gh-pages/manifest.json');
        console.log('Test URL:', 'https://github.com/itcon-pty-au/stremio-ai-search/blob/gh-pages/test-catalog');
        console.log('========================================');
    });
}

// Add test endpoints
app.get('/test-catalog', async (req, res) => {
    console.log('Test catalog endpoint called');
    try {
        // Get the API key from URL parameters if present
        const configParam = req.query.configuration;
        let openaiKey;
        
        if (configParam) {
            try {
                const config = JSON.parse(decodeURIComponent(configParam));
                openaiKey = config.openaiKey;
                console.log('Found API key in URL configuration');
            } catch (e) {
                console.error('Error parsing configuration:', e);
            }
        }

        // Fallback to environment variable if URL config not present
        if (!openaiKey) {
            openaiKey = process.env.OPENAI_API_KEY;
            console.log('Using API key from environment');
        }

        if (!openaiKey) {
            throw new Error('No API key found in configuration or environment');
        }

        // Test parameters
        const testRequest = {
            type: 'movie',
            id: 'aisearch.movies',
            extra: { search: 'test' },
            config: { openaiKey: openaiKey }
        };

        console.log('Making test request with config:', {
            ...testRequest,
            config: { openaiKey: openaiKey ? '[PRESENT]' : '[MISSING]' }
        });
        
        // Call our handler directly
        const result = await catalogHandler(testRequest);
        
        console.log('Catalog result:', result);
        res.json(result);
    } catch (error) {
        console.error('Test catalog error:', error);
        res.status(500).json({
            error: error.message,
            stack: error.stack,
            query: req.query
        });
    }
});

// Add simple test endpoint
app.get('/test', (req, res) => {
    res.json({
        status: 'ok',
        message: 'Server is running',
        manifest: manifest,
        hasHandler: true
    });
});

// Add a debug endpoint
app.get('/debug', (req, res) => {
    res.json({
        manifest: manifest,
        env: {
            hasApiKey: !!process.env.OPENAI_API_KEY
        }
    });
}); 