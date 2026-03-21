const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${process.env.GEMINI_API_KEY}`;

const SYSTEM_PROMPT = `You are an expert at matching people with the perfect show or film to watch. You have deep knowledge of global cinema — Hollywood, Bollywood, Korean, Tamil, Japanese, French, and beyond. If the user does not specify a language or region, recommend the best match from anywhere in the world. If they do specify one, stay within it.
Given a description of someone's mood, vibe, or what kind of story they want, recommend 15-20 TV shows or movies that fit perfectly. Be specific and thoughtful — go beyond obvious picks when the mood calls for it. Mix genres when it makes sense (e.g. a documentary alongside a drama). Keep each reason to 1-2 sentences, focused on why it matches the mood. Return only the plain title with no year, no parentheses, and no extra punctuation.`;

async function enrichWithTMDB(show) {
  // Read inside function — avoids stale undefined if env var was added after a cold start
  const TMDB_KEY = process.env.TMDB_API_KEY;
  if (!TMDB_KEY) {
    console.log('[recommend] TMDB_KEY not configured');
    return show;
  }
  try {
    // Strip trailing year "(1997)" or " 1997" that Gemini often appends
    const cleanTitle = show.title.replace(/\s*[\[(]?\d{4}[\])]?\s*$/, '').trim();
    const url = `https://api.themoviedb.org/3/search/multi?query=${encodeURIComponent(cleanTitle)}&api_key=${TMDB_KEY}&include_adult=false&language=en-US`;
    const res = await fetch(url);
    const data = await res.json();

    // Bug fix: /search/multi returns people too — skip them, only use movie/tv results.
    // Prefer results that already have a poster; fall back to any movie/tv result.
    const candidates = (data.results ?? []).filter(
      r => r.media_type === 'movie' || r.media_type === 'tv'
    );
    const result = candidates.find(r => r.poster_path) ?? candidates[0] ?? null;

    console.log(`[recommend] TMDB "${show.title}" → ${res.status} | ${candidates.length} movie/tv hits | poster=${result?.poster_path ?? 'none'}`);

    if (result) {
      return {
        ...show,
        poster:     result.poster_path ? `https://image.tmdb.org/t/p/w500${result.poster_path}` : null,
        imdbRating: result.vote_average ? result.vote_average.toFixed(1) : null,
        year:       (result.release_date ?? result.first_air_date ?? '').slice(0, 4) || null,
        mediaType:  result.media_type === 'tv' ? 'series' : 'movie',
      };
    }
  } catch (e) {
    console.error('[recommend] TMDB lookup failed for', show.title, e?.message);
  }
  return show;
}

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
            minItems: 15,
            maxItems: 20,
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
    const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
    console.log('[recommend] Gemini text:', text ?? '(empty)');
    if (!text) throw new Error(`Empty response from Gemini: ${JSON.stringify(geminiData)}`);

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (parseErr) {
      throw new Error(`JSON parse failed: ${parseErr.message} — raw: ${text?.slice(0, 300)}`);
    }
    const enriched = await Promise.all(parsed.recommendations.map(enrichWithTMDB));
    res.json({ recommendations: enriched });
  } catch (err) {
    console.error('Recommendation error:', err?.message ?? err);
    res.status(500).json({ error: 'Failed to get recommendations. Please try again.' });
  }
}
