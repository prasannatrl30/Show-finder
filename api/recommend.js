const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${process.env.GEMINI_API_KEY}`;

const SYSTEM_PROMPT = `You are an expert at matching people with the perfect thing to watch. You have deep knowledge of global cinema and television — Hollywood, Bollywood, Korean, Tamil, Japanese, French, and beyond.

For each recommendation provide:
- title: plain title only, no year, no punctuation
- genre: one short genre label (e.g. "Crime Drama", "Romantic Comedy")
- format: exactly one of "Movie", "Series", "Documentary", "Limited Series"
- language: primary language (e.g. "English", "Tamil", "Korean", "Hindi", "French")
- runtime: for movies "1h 52m" style; for series "3 seasons" or "6 episodes"; for limited series "N episodes"
- reason: 10–15 words max — punchy and evocative, not a synopsis

Return only valid JSON matching the schema. No markdown, no extra text.`;

function buildUserPrompt(mood, refinements, exclude, history) {
  let text = mood.trim();

  // Refinement constraints
  if (refinements) {
    const formatMap = {
      movie:       'Only recommend movies — no TV series or documentaries.',
      series:      'Only recommend TV series — no movies or documentaries.',
      documentary: 'Only recommend documentaries.',
    };
    const langMap = {
      english: 'Only recommend English-language content.',
      tamil:   'Only recommend Tamil-language content.',
      korean:  'Only recommend Korean-language content.',
      hindi:   'Only recommend Hindi-language content.',
      other:   'Avoid English, Tamil, Korean, and Hindi — recommend other world languages.',
    };
    const lengthMap = {
      short: 'Only recommend films under 2 hours runtime.',
      long:  'Only recommend films 2 hours or longer.',
      mini:  'Only recommend mini-series or limited series (fewer than 10 episodes).',
    };
    const parts = [
      formatMap[refinements.format],
      langMap[refinements.language],
      lengthMap[refinements.length],
    ].filter(Boolean);
    if (parts.length) text += '\n\nConstraints: ' + parts.join(' ');
  }

  // Exclude already-shown titles
  const excludeList = Array.isArray(exclude) ? exclude.filter(Boolean) : [];
  if (excludeList.length) {
    text += `\n\nDo not recommend any of these titles the user has already seen: ${excludeList.map(t => `"${t}"`).join(', ')}.`;
  }

  // Personalisation from search history
  const pastSearches = Array.isArray(history)
    ? history.filter(h => typeof h === 'string' && h.trim()).slice(0, 3)
    : [];
  if (pastSearches.length) {
    text += `\n\nThe user has previously searched for: ${pastSearches.map(h => `"${h}"`).join(', ')}. Factor this in but do not repeat titles they have likely already seen.`;
  }

  return text;
}

async function enrichWithTMDB(show) {
  const TMDB_KEY = process.env.TMDB_API_KEY;
  if (!TMDB_KEY) {
    console.log('[recommend] TMDB_KEY not configured');
    return show;
  }
  try {
    const cleanTitle = show.title.replace(/\s*[\[(]?\d{4}[\])]?\s*$/, '').trim();
    const url = `https://api.themoviedb.org/3/search/multi?query=${encodeURIComponent(cleanTitle)}&api_key=${TMDB_KEY}&include_adult=false&language=en-US`;
    const res  = await fetch(url);
    const data = await res.json();

    const candidates = (data.results ?? []).filter(
      r => r.media_type === 'movie' || r.media_type === 'tv'
    );
    const result = candidates.find(r => r.poster_path) ?? candidates[0] ?? null;

    console.log(`[recommend] TMDB "${show.title}" → ${res.status} | ${candidates.length} hits | poster=${result?.poster_path ?? 'none'}`);

    if (result) {
      return {
        ...show,
        poster:     result.poster_path ? `https://image.tmdb.org/t/p/w500${result.poster_path}` : null,
        imdbRating: result.vote_average ? result.vote_average.toFixed(1) : null,
        year:       (result.release_date ?? result.first_air_date ?? '').slice(0, 4) || null,
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

  const { mood, history, refinements, exclude } = req.body ?? {};

  if (!mood || typeof mood !== 'string' || !mood.trim()) {
    return res.status(400).json({ error: 'mood is required' });
  }

  console.log('[recommend] mood:', mood.trim(), '| refinements:', JSON.stringify(refinements ?? {}));

  const userPrompt = buildUserPrompt(mood, refinements, exclude, history);

  const requestBody = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ parts: [{ text: userPrompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: {
          recommendations: {
            type: 'array',
            minItems: 5,
            maxItems: 5,
            items: {
              type: 'object',
              properties: {
                title:    { type: 'string' },
                genre:    { type: 'string' },
                format:   { type: 'string' },
                language: { type: 'string' },
                runtime:  { type: 'string' },
                reason:   { type: 'string' },
              },
              required: ['title', 'genre', 'format', 'language', 'runtime', 'reason'],
            },
          },
        },
        required: ['recommendations'],
      },
    },
  };

  const MAX_RETRIES    = 3;
  const RETRY_DELAY_MS = 2000;

  let response;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    response = await fetch(GEMINI_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(requestBody),
    });
    if (response.status === 503) {
      console.warn(`[recommend] Gemini 503 — attempt ${attempt}/${MAX_RETRIES}, retrying in ${RETRY_DELAY_MS}ms`);
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
    }
    break;
  }

  try {
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Gemini ${response.status}: ${err}`);
    }

    const geminiData = await response.json();
    const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error(`Empty Gemini response: ${JSON.stringify(geminiData)}`);

    let parsed;
    try { parsed = JSON.parse(text); }
    catch (e) { throw new Error(`JSON parse failed: ${e.message} — raw: ${text?.slice(0, 300)}`); }

    const enriched = await Promise.all(parsed.recommendations.map(enrichWithTMDB));
    res.json({ recommendations: enriched });
  } catch (err) {
    console.error('Recommendation error:', err?.message ?? err);
    res.status(500).json({ error: 'Failed to get recommendations. Please try again.' });
  }
}
