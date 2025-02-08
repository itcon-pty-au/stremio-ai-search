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

// Add this near the top of your file
const logs = [];
const MAX_LOGS = 1000;

function maskSensitiveData(data) {
    if (typeof data === 'string') {
        // Mask OpenAI API keys (sk-...)
        data = data.replace(/sk-[a-zA-Z0-9]{32,}/g, 'sk-***MASKED***');
        
        // Mask any JSON strings that might contain the key
        try {
            const obj = JSON.parse(data);
            return JSON.stringify(maskSensitiveData(obj));
        } catch (e) {
            return data;
        }
    }
    
    if (typeof data === 'object' && data !== null) {
        const masked = Array.isArray(data) ? [] : {};
        for (const [key, value] of Object.entries(data)) {
            // Mask sensitive field values
            if (['openaiKey', 'apiKey', 'key', 'token', 'authorization'].includes(key.toLowerCase())) {
                masked[key] = '***MASKED***';
            } else {
                masked[key] = maskSensitiveData(value);
            }
        }
        return masked;
    }
    
    return data;
}

function addLog(message, type = '') {
    try {
        // Mask sensitive data before logging
        const maskedMessage = maskSensitiveData(message);
        
        const log = {
            timestamp: new Date(),
            message: maskedMessage,
            type
        };
        
        logs.unshift(log);
        if (logs.length > MAX_LOGS) {
            logs.pop();
        }
        
        // Also mask any sensitive data in the full logs array
        const maskedLogs = logs.map(log => ({
            ...log,
            message: maskSensitiveData(log.message)
        }));
        
        fs.writeFileSync(path.join(__dirname, 'debug.json'), JSON.stringify(maskedLogs, null, 2));
    } catch (error) {
        console.error('Logging error:', error);
    }
}

// Logging function
function writeLog(message, type = 'info') {
    try {
        const logPath = path.join(__dirname, 'public', 'debug.json');
        let logs = [];
        if (fs.existsSync(logPath)) {
            logs = JSON.parse(fs.readFileSync(logPath, 'utf8'));
        }
        
        logs.unshift({
            timestamp: new Date(),
            message: message,
            type: type
        });

        // Keep only last 1000 logs
        if (logs.length > 1000) logs = logs.slice(0, 1000);
        
        fs.writeFileSync(logPath, JSON.stringify(logs, null, 2));
    } catch (error) {
        console.error('Error writing log:', error);
    }
}

// Define the catalog handler
async function catalogHandler({ type, id, extra, config }) {
    writeLog(`Catalog Request - Type: ${type}, ID: ${id}`);
    writeLog(`Extra: ${JSON.stringify(extra)}`);
    writeLog(`Has Config: ${!!config}`);

    if (!extra?.search) {
        writeLog('No search term provided, returning empty catalog');
        return { metas: [] };
    }

    try {
        writeLog(`Processing search: ${extra.search}`);
        const apiKey = config?.openaiKey;
        
        if (!apiKey) {
            writeLog('No API key configured', 'error');
            return { 
                metas: [],
                notification: {
                    message: "Please configure your OpenAI API key",
                    title: "Configuration Required",
                    type: "info"
                }
            };
        }

        const results = await searchWithAI(extra.search, apiKey);
        return { metas: results.map(result => formatSearchResult(result, type)) };
    } catch (error) {
        writeLog(`Error in catalog handler: ${error.message}`, 'error');
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

// Store our handler
builder.defineCatalogHandler(catalogHandler);

// Add stream handler (returns empty streams as we don't provide actual streaming)
builder.defineStreamHandler(async ({ type, id }) => {
    writeLog(`Stream request - Type: ${type}, ID: ${id}`);
    return { streams: [] };
});

// Add this before the production check
const addonInterface = builder.getInterface();

if (process.env.NODE_ENV === 'production') {
    // Create public directory if it doesn't exist
    if (!fs.existsSync('public')) {
        fs.mkdirSync('public');
    }
    
    // Write the static files
    fs.writeFileSync('public/manifest.json', JSON.stringify(addonInterface.manifest));
    writeLog('Static files generated');
    console.log('Running in production mode');
    console.log('Static files generated');
    process.exit(0);
}

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