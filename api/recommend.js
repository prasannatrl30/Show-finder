const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${process.env.GEMINI_API_KEY}`;
const TMDB_KEY = process.env.TMDB_API_KEY;

const SYSTEM_PROMPT = `You are an expert at matching people with the perfect show or film to watch.
Given a description of someone's mood, vibe, or what kind of story they want, recommend
4-5 TV shows or movies that fit perfectly. Be specific and thoughtful — go beyond obvious
picks when the mood calls for it. Mix genres when it makes sense (e.g. a documentary
alongside a drama). Keep each reason to 1-2 sentences, focused on why it matches the mood.
Return only the plain title with no year, no parentheses, and no extra punctuation.`;

async function enrichWithTMDB(show) {
  if (!TMDB_KEY) {
    console.log('[recommend] TMDB_KEY not set — skipping enrichment');
    return show;
  }
  try {
    // Strip trailing year "(1997)" or " 1997" that Gemini often appends — breaks TMDB search
    const cleanTitle = show.title.replace(/\s*[\[(]?\d{4}[\])]?\s*$/, '').trim();
    const url = `https://api.themoviedb.org/3/search/multi?query=${encodeURIComponent(cleanTitle)}&api_key=${TMDB_KEY}&include_adult=false`;
    console.log(`[recommend] TMDB fetching: ${url.replace(TMDB_KEY, '***')}`);
    const res = await fetch(url);
    const data = await res.json();
    console.log(`[recommend] TMDB for "${show.title}": status=${res.status} results=${data.results?.length ?? 0} first_poster=${data.results?.[0]?.poster_path ?? 'none'}`);

    const result = data.results?.[0];
    if (result) {
      return {
        ...show,
        poster:    result.poster_path ? `https://image.tmdb.org/t/p/w500${result.poster_path}` : null,
        imdbRating: result.vote_average ? result.vote_average.toFixed(1) : null,
        year:      (result.release_date ?? result.first_air_date ?? '').slice(0, 4) || null,
        mediaType: result.media_type === 'tv' ? 'series' : result.media_type === 'movie' ? 'movie' : null,
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

    const parsed = JSON.parse(text);
    const enriched = await Promise.all(parsed.recommendations.map(enrichWithTMDB));
    res.json({ recommendations: enriched });
  } catch (err) {
    console.error('Recommendation error:', err?.message ?? err);
    res.status(500).json({ error: 'Failed to get recommendations. Please try again.' });
  }
}
