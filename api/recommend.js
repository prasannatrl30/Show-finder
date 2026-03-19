const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${process.env.GEMINI_API_KEY}`;

const SYSTEM_PROMPT = `You are an expert at matching people with the perfect show or film to watch.
Given a description of someone's mood, vibe, or what kind of story they want, recommend
4-5 TV shows or movies that fit perfectly. Be specific and thoughtful — go beyond obvious
picks when the mood calls for it. Mix genres when it makes sense (e.g. a documentary
alongside a drama). Keep each reason to 1-2 sentences, focused on why it matches the mood.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { mood } = req.body ?? {};

  if (!mood || typeof mood !== 'string' || !mood.trim()) {
    return res.status(400).json({ error: 'mood is required' });
  }

  const prompt = mood.trim();
  console.log('[recommend] mood:', prompt);

  const requestBody = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: {
          recommendations: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title:  { type: 'string' },
                genre:  { type: 'string' },
                reason: { type: 'string' },
              },
              required: ['title', 'genre', 'reason'],
            },
          },
        },
        required: ['recommendations'],
      },
    },
  };
  console.log('[recommend] prompt to Gemini:', JSON.stringify(requestBody, null, 2));

  try {
    const response = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Gemini ${response.status}: ${err}`);
    }

    const geminiData = await response.json();
    console.log('[recommend] raw Gemini response:', JSON.stringify(geminiData, null, 2));
    const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Empty response from Gemini');

    res.json(JSON.parse(text));
  } catch (err) {
    console.error('Recommendation error:', err?.message ?? err);
    res.status(500).json({ error: 'Failed to get recommendations. Please try again.' });
  }
}
