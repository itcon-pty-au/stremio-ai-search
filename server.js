require('dotenv').config();
const { serveHTTP } = require("stremio-addon-sdk");
const addon = require("./addon");

// Add a custom logging function
function logWithTime(message, data = '') {
    const timestamp = new Date().toISOString();
    if (data) {
        console.log(`\n[${timestamp}] 🔵 ${message}`, data);
    } else {
        console.log(`\n[${timestamp}] 🔵 ${message}`);
    }
}

// Update the environment variable check to be more permissive
if (!process.env.GEMINI_API_KEY) {
    console.warn(`\n[${new Date().toISOString()}] ⚠️ WARNING: GEMINI_API_KEY environment variable is not set!`);
    // Don't exit, just warn
}

if (!process.env.TMDB_API_KEY) {
    console.warn(`\n[${new Date().toISOString()}] ⚠️ WARNING: TMDB_API_KEY environment variable is not set!`);
    // Don't exit, just warn
}

// Error handlers
process.on('uncaughtException', (err) => {
    console.error(`\n[${new Date().toISOString()}] 🔴 Uncaught Exception:`, err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error(`\n[${new Date().toISOString()}] 🔴 Unhandled Rejection:`, reason);
});

const PORT = process.env.PORT || 7000;

// Function to kill process using a port
function killProcessOnPort(port) {
    return new Promise((resolve, reject) => {
        const command = process.platform === 'win32' 
            ? `netstat -ano | findstr :${port}`
            : `lsof -i :${port} -t`;

        require('child_process').exec(command, (error, stdout, stderr) => {
            if (error || !stdout) {
                resolve(); // No process found, that's fine
                return;
            }

            const pids = stdout.split('\n')
                .map(line => line.trim())
                .filter(Boolean);

            pids.forEach(pid => {
                try {
                    process.kill(pid, 'SIGKILL');
                    logWithTime(`Killed process ${pid} on port ${port}`);
                } catch (e) {
                    // Ignore errors
                }
            });
            
            setTimeout(resolve, 1000); // Give processes time to die
        });
    });
}

// Modify the server startup
async function startServer() {
    try {
        // First kill any existing processes on our port
        await killProcessOnPort(PORT);

        logWithTime('Starting Stremio Addon Server...');
        logWithTime('Manifest:', addon.manifest);
        
        // Just log whether keys are configured, not their values
        if (process.env.GEMINI_API_KEY) {
            logWithTime('✓ Gemini API Key is configured');
        } else {
            logWithTime('✗ Gemini API Key is missing');
        }
        
        if (process.env.TMDB_API_KEY) {
            logWithTime('✓ TMDB API Key is configured');
        } else {
            logWithTime('✗ TMDB API Key is missing');
        }
        
        // Create HTTP server with request logging middleware
        const app = require('express')();

        // Add Android TV specific middleware
        app.use((req, res, next) => {
            // Increase timeout for Android TV
            if (req.headers['stremio-platform'] === 'android-tv' || 
                req.headers['user-agent']?.toLowerCase().includes('android tv')) {
                req.setTimeout(45000); // 45 seconds for TV
            }

            // Add TV-specific headers
            res.header('Cache-Control', 'public, max-age=3600'); // 1 hour cache
            res.header('X-Content-Type-Options', 'nosniff');
            res.header('X-Frame-Options', 'SAMEORIGIN');
            
            next();
        });

        // Modify the existing timeout middleware
        app.use((req, res, next) => {
            // Set longer timeout for search requests
            if (req.url.includes('/catalog/')) {
                const defaultTimeout = 30000;
                const tvTimeout = 45000;
                
                // Check if request is from Android TV
                const isTV = req.headers['stremio-platform'] === 'android-tv' || 
                            req.headers['user-agent']?.toLowerCase().includes('android tv');
                            
                req.setTimeout(isTV ? tvTimeout : defaultTimeout);
            }
            next();
        });

        // Add keep-alive settings
        app.use((req, res, next) => {
            res.set('Connection', 'keep-alive');
            res.set('Keep-Alive', 'timeout=120, max=1000');
            next();
        });

        // Add CORS headers for Android TV
        app.use((req, res, next) => {
            res.header('Access-Control-Allow-Origin', '*');
            res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.header('Access-Control-Allow-Headers', 'Content-Type');
            next();
        });

        // Add response time logging
        app.use((req, res, next) => {
            const start = Date.now();
            res.on('finish', () => {
                const duration = Date.now() - start;
                logWithTime(`Request completed: ${req.method} ${req.url}`, {
                    duration: `${duration}ms`,
                    userAgent: req.headers['user-agent'],
                    platform: req.headers['stremio-platform'] || 'unknown'
                });
            });
            next();
        });

        // Add response size logging
        app.use((req, res, next) => {
            const start = Date.now();
            let size = 0;
            
            const oldWrite = res.write;
            const oldEnd = res.end;
            
            res.write = function(chunk) {
                size += chunk.length;
                oldWrite.apply(res, arguments);
            };
            
            res.end = function(chunk) {
                if (chunk) size += chunk.length;
                oldEnd.apply(res, arguments);
                
                logWithTime(`Response completed: ${req.method} ${req.url}`, {
                    duration: `${Date.now() - start}ms`,
                    size: `${(size/1024).toFixed(2)}KB`,
                    platform: req.headers['stremio-platform'] || 'unknown',
                    userAgent: req.headers['user-agent']
                });
            };
            
            next();
        });

        // Add error handling middleware
        app.use((err, req, res, next) => {
            logError('Express error:', err);
            next(err);
        });

        // Add custom routes mapping to the addon interface endpoints

        // Route for the manifest
        app.get('/manifest.json', (req, res) => {
            res.json(addon.manifest);
        });

        // Standard catalog route (for web/desktop/mobile)
        app.get('/catalog/:resourceType/:catalogId.json', async (req, res) => {
            try {
                const args = {
                    type: req.params.resourceType,
                    id: req.params.catalogId,
                    extra: {
                        search: req.query.search,
                        headers: req.headers,
                        userAgent: req.headers['user-agent'],
                        platform: req.headers['stremio-platform'] || 'unknown'
                    }
                };

                // Get the result from the handler
                const result = await addon(args);
                res.json(result);
            } catch (error) {
                console.error('Catalog route error:', error);
                res.status(500).json({ error: error.message });
            }
        });

        // Updated Route for catalog requests to support the search parameter in the URL path (required by Android TV)
        app.get('/catalog/:resourceType/:catalogId/:searchParam?.json', (req, res, next) => {
            try {
                // Determine the search query from either the query string or the URL path parameter.
                let search = req.query.search;
                if (!search && req.params.searchParam) {
                    // Remove the "search=" prefix if present.
                    search = req.params.searchParam.startsWith('search=') ? req.params.searchParam.slice(7) : req.params.searchParam;
                }

                // Prepare the args for the catalog handler
                const args = {
                    method: 'catalog',
                    type: req.params.resourceType,
                    id: req.params.catalogId,
                    extra: {
                        search,
                        headers: req.headers,
                        userAgent: req.headers['user-agent'],
                        platform: req.headers['stremio-platform'] || 'unknown'
                    }
                };

                // If this is an Android TV request (has searchParam), handle it
                if (req.params.searchParam) {
                    addon(args)
                        .then(result => res.json(result))
                        .catch(error => {
                            console.error('Catalog handler error:', error);
                            res.status(500).json({ error: error.message });
                        });
                } else {
                    // If no searchParam, pass to the next matching route
                    next();
                }
            } catch (error) {
                console.error('Catalog route error:', error);
                res.status(500).json({ error: error.message });
            }
        });

        // Route for meta requests
        app.get('/meta/:resourceType/:metaId.json', (req, res) => {
            try {
                const args = {
                    method: 'meta',
                    type: req.params.resourceType,
                    id: req.params.metaId
                };
                
                // Get the result from the handler
                addon(args)
                    .then(result => res.json(result))
                    .catch(error => {
                        console.error('Meta handler error:', error);
                        res.status(500).json({ error: error.message });
                    });
            } catch (error) {
                console.error('Meta route error:', error);
                res.status(500).json({ error: error.message });
            }
        });

        // Start the Express server (your middleware will be active for all requests)
        app.listen(PORT, process.env.HOST || '0.0.0.0', () => {
            console.log(`\n[${new Date().toISOString()}] 🔵 Server started on port ${PORT}`);
            // Log connection details as before
        });
        
    } catch (error) {
        logError('Failed to start server:', error);
        process.exit(1);
    }
}

function logError(message, error = '') {
    const timestamp = new Date().toISOString();
    console.error(`\n[${timestamp}] 🔴 ${message}`, error);
    if (error && error.stack) {
        console.error(`Stack trace:`, error.stack);
    }
}

// Remove the testServer code and just call startServer
startServer();