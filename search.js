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
        return JSON.parse(data.choices[0].message.content);
    } catch (error) {
        console.error('OpenAI API error:', error);
        throw new Error('Failed to fetch recommendations');
    }
} 