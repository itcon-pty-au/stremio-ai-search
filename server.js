require('dotenv').config();
const { serveHTTP } = require("stremio-addon-sdk");
const addonInterface = require("./addon");

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
        logWithTime('Manifest:', addonInterface.manifest);
        
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

        // Add timeout middleware
        app.use((req, res, next) => {
            // Set a longer timeout for search requests
            if (req.url.includes('/catalog/')) {
                req.setTimeout(30000); // 30 seconds
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

        // Add error handling middleware
        app.use((err, req, res, next) => {
            logError('Express error:', err);
            next(err);
        });

        // Start the Stremio addon server
        serveHTTP(addonInterface, { port: PORT, host: process.env.HOST || '0.0.0.0' });
        logWithTime('Server started successfully! 🚀');
        
        // Add more detailed connection information
        const publicUrl = `http://${process.env.HOST || '0.0.0.0'}:${process.env.PORT || 7000}`;
        logWithTime('Server is accessible at:', publicUrl);
        logWithTime('Add to Stremio using:', `${publicUrl}/manifest.json`);
        
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