window.searchWithAI = async function(query, apiKey) {
    if (!apiKey) {
        throw new Error('API key is required');
    }

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
        throw new Error(`API request failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    let content = data.choices[0].message.content;
    
    // Clean up the response
    content = content.replace(/```json\s*|\s*```/g, '');
    content = content.replace(/```\s*|\s*```/g, '');
    content = content.replace(/`/g, '');
    content = content.substring(content.indexOf('['), content.lastIndexOf(']') + 1);
    
    return JSON.parse(content);
}; 