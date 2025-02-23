<!DOCTYPE html>
<html>
<head>
    <title>Stremio AI Search</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        :root {
            --primary-color: #ced4da;
        }
        
        body {
            font-family: Arial, sans-serif;
            max-width: 800px;
            margin: 20px auto;
            padding: 20px;
            background: #141414;
            color: #d9d9d9;
        }

        .container {
            background: #1f1f1f;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.2);
        }

        .logo {
            width: 120px;
            height: 120px;
            margin: 0 auto 20px;
            display: block;
            background: #2a2a2a;
            border-radius: 20px;
            padding: 20px;
        }

        h1, h2 {
            color: var(--primary-color);
            text-align: center;
            margin-bottom: 20px;
        }

        .examples {
            margin: 30px 0;
            padding: 0 20px;
        }

        .example-card {
            background: #2a2a2a;
            padding: 15px;
            margin-bottom: 15px;
            border-radius: 8px;
        }

        .example-card h3 {
            color: var(--primary-color);
            margin-top: 0;
        }

        .example-query {
            background: #1f1f1f;
            padding: 10px;
            border-radius: 4px;
            margin: 10px 0;
            font-family: monospace;
        }

        button {
            display: block;
            margin: 30px auto;
            width: calc(100% - 40px);
            max-width: 300px;
            background: var(--primary-color);
            font-weight: bold;
            color: #495057;
            border: none;
            padding: 15px 30px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 1.1em;
        }

        button:hover {
            background: #ced4da;
        }

        footer {
            text-align: center;
            padding: 20px;
            color: #888;
            font-size: 0.9em;
        }

        .heart {
            color: #ff4444;
            font-size: 1.5em;
        }

        .github-icon {
            height: 20px;
            width: 20px;
            vertical-align: middle;
            margin-left: 5px;
            fill: currentColor;
        }

        .github-link:hover {
            color: var(--primary-color);
        }

        .github-link:hover .github-icon {
            fill: var(--primary-color);
        }

        @media (max-width: 600px) {
            body {
                padding: 10px;
            }
            
            .container {
                padding: 15px;
            }

            .examples {
                padding: 0 10px;
            }

            .logo {
                width: 80px;
                height: 80px;
                padding: 15px;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <img src="aisearch/logo.png" alt="AI Search" class="logo">
        <h1>Stremio AI Search</h1>
        
        <p style="text-align: center">
            An intelligent search addon for Stremio powered by Google's Gemini AI. Get personalized movie and TV series recommendations based on natural language queries.
        </p>

        <div class="examples">
            <h2>Example Searches</h2>

            <div class="example-card">
                <h3>Natural Language</h3>
                <div class="example-query">"A heartwarming comedy about family relationships"</div>
                <p>Search using natural language descriptions of what you want to watch.</p>
            </div>

            <div class="example-card">
                <h3>Time Periods</h3>
                <div class="example-query">"Sci-fi movies from the 80s"</div>
                <div class="example-query">"Modern crime series from 2020-2023"</div>
                <p>Specify time periods or years for more targeted results.</p>
            </div>

            <div class="example-card">
                <h3>Genre Combinations</h3>
                <div class="example-query">"Action comedy with martial arts"</div>
                <div class="example-query">"Dark mystery thriller series"</div>
                <p>Combine multiple genres and themes.</p>
            </div>

            <div class="example-card">
                <h3>Mood & Style</h3>
                <div class="example-query">"Feel-good movies for a rainy day"</div>
                <div class="example-query">"Intense psychological thrillers"</div>
                <p>Search based on mood or emotional impact.</p>
            </div>
        </div>

        <button onclick="window.location.href='configure.html'">Configure Addon</button>
    </div>

    <footer>
        © 2025 ITCON • Made with <span class="heart">♥</span> in Melbourne, AU<br>
        Submit feature requests, issues at 
        <a href="https://github.com/itcon-pty-au/stremio-ai-search" target="_blank" class="github-link">
            <svg height="20" aria-hidden="true" color="#fff" viewBox="0 0 24 24" version="1.1" width="20" class="github-icon">
                <path d="M12.5.75C6.146.75 1 5.896 1 12.25c0 5.089 3.292 9.387 7.863 10.91.575.101.79-.244.79-.546 0-.273-.014-1.178-.014-2.142-2.889.532-3.636-.704-3.866-1.35-.13-.331-.69-1.352-1.18-1.625-.402-.216-.977-.748-.014-.762.906-.014 1.553.834 1.769 1.179 1.035 1.74 2.688 1.25 3.349.948.1-.747.402-1.25.733-1.538-2.559-.287-5.232-1.279-5.232-5.678 0-1.25.445-2.285 1.178-3.09-.115-.288-.517-1.467.115-3.048 0 0 .963-.302 3.163 1.179.92-.259 1.897-.388 2.875-.388.977 0 1.955.13 2.875.388 2.2-1.495 3.162-1.179 3.162-1.179.633 1.581.23 2.76.115 3.048.733.805 1.179 1.825 1.179 3.09 0 4.413-2.688 5.39-5.247 5.678.417.36.776 1.05.776 2.128 0 1.538-.014 2.774-.014 3.162 0 .302.216.662.79.547C20.709 21.637 24 17.324 24 12.25 24 5.896 18.854.75 12.5.75Z"></path>
            </svg>
        </a>
    </footer>
</body>
</html> 
