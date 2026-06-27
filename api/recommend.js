import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM_PROMPT = `You are an expert at matching people with the perfect thing to watch. You have deep knowledge of global cinema and television — Hollywood, Bollywood, Korean, Tamil, Japanese, French, and beyond.

For each recommendation provide:
- title: plain title only, no year, no punctuation
- genre: one short genre label (e.g. "Crime Drama", "Romantic Comedy")
- format: exactly one of "Movie", "Series", "Documentary", "Limited Series"
- language: primary language (e.g. "English", "Tamil", "Korean", "Hindi", "French")
- runtime: for movies "1h 52m" style; for series "3 seasons" or "6 episodes"; for limited series "N episodes"
- reason: 10–15 words max — punchy and evocative, not a synopsis`;

/* ── Weather helpers ── */
function interpretWeatherCode(code) {
  if (code === 0)                                                    return ['clear and sunny',  'sunny'];
  if (code >= 1  && code <= 3)                                       return ['partly cloudy',    'cloudy'];
  if (code === 45 || code === 48)                                    return ['foggy',             'foggy'];
  if ((code >= 51 && code <= 55) || (code >= 61 && code <= 65))     return ['rainy',             'rainy'];
  if (code >= 71 && code <= 75)                                      return ['snowing',           'snowy'];
  if (code >= 80 && code <= 82)                                      return ['showery',           'showery'];
  if (code >= 95 && code <= 99)                                      return ['stormy',            'stormy'];
  return ['overcast', 'overcast'];
}

function weatherEmoji(code) {
  if (code === 0)                                                    return '☀️';
  if (code >= 1  && code <= 3)                                       return '⛅';
  if (code === 45 || code === 48)                                    return '🌫️';
  if ((code >= 51 && code <= 55) || (code >= 61 && code <= 65))     return '🌧️';
  if (code >= 71 && code <= 75)                                      return '❄️';
  if (code >= 80 && code <= 82)                                      return '🌦️';
  if (code >= 95 && code <= 99)                                      return '⛈️';
  return '🌤️';
}

/* ── Location + weather from Vercel headers + Open-Meteo ── */
async function getLocationAndWeather(req) {
  const country = ((req.headers['x-vercel-ip-country']) || 'AU').toUpperCase();
  const rawCity = req.headers['x-vercel-ip-city'];
  const city    = rawCity ? decodeURIComponent(rawCity) : null;

  console.log(`[location] country=${country} city=${city ?? 'unknown'}`);

  if (!city) {
    return { country, city: null, weather: null, weatherAdj: null, temp: null, emoji: null };
  }

  try {
    const geoRes  = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`
    );
    const geoData = await geoRes.json();
    const loc     = geoData.results?.[0];

    if (!loc) {
      console.log(`[location] Geocode returned no results for "${city}"`);
      return { country, city, weather: null, weatherAdj: null, temp: null, emoji: null };
    }

    const wxRes  = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,weathercode&timezone=auto`
    );
    const wxData  = await wxRes.json();
    const current = wxData.current;
    const code    = current?.weathercode ?? 0;
    const temp    = current?.temperature_2m != null ? Math.round(current.temperature_2m) : null;

    const [weather, weatherAdj] = interpretWeatherCode(code);
    const emoji                 = weatherEmoji(code);

    console.log(`[location] ${city}, ${country}: ${weather} (code=${code}), ${temp}°C`);

    return { country, city, weather, weatherAdj, temp, emoji };
  } catch (e) {
    console.error('[location] Weather/geocoding failed:', e.message);
    return { country, city, weather: null, weatherAdj: null, temp: null, emoji: null };
  }
}

/* ── Prompt builder ── */
function buildUserPrompt(mood, refinements, exclude, history, watched, rejected, locationCtx) {
  let text = mood.trim();

  if (locationCtx?.city && locationCtx?.weather && locationCtx?.temp != null) {
    text += `\n\nContext: The user is in ${locationCtx.city}, ${locationCtx.country}. It is currently ${locationCtx.weather} outside and ${locationCtx.temp}°C. Factor all of this into your recommendations — a rainy ${locationCtx.city} evening calls for different content than a sunny afternoon. Recommend content that genuinely fits this exact moment.`;
  } else if (locationCtx?.country) {
    text += `\n\nContext: The user is in ${locationCtx.country}.`;
  }

  if (refinements) {
    const formatMap = {
      movie:       'Only recommend movies — no TV series or documentaries.',
      series:      'Only recommend TV series — no movies or documentaries.',
      documentary: 'Only recommend documentaries.',
    };
    const parts = [formatMap[refinements.format]].filter(Boolean);
    if (parts.length) text += '\n\nConstraints: ' + parts.join(' ');
  }

  const watchedList = Array.isArray(watched) ? watched.filter(Boolean).slice(0, 40) : [];
  const excludeList = Array.isArray(exclude)  ? exclude.filter(Boolean)              : [];
  const allExclude  = [...new Set([...excludeList, ...watchedList])];
  if (allExclude.length) {
    text += `\n\nDo not recommend any of these titles: ${allExclude.map(t => `"${t}"`).join(', ')}.`;
  }

  const rejectedList = Array.isArray(rejected) ? rejected.filter(r => r && r.title && r.reason) : [];
  if (rejectedList.length) {
    text += `\n\nThe user rejected these suggestions — avoid similar content:\n`;
    text += rejectedList.map(r => `- "${r.title}" rejected because: ${r.reason}`).join('\n');
  }

  const pastSearches = Array.isArray(history)
    ? history.filter(h => typeof h === 'string' && h.trim()).slice(0, 3)
    : [];
  if (pastSearches.length) {
    text += `\n\nThe user has previously searched for: ${pastSearches.map(h => `"${h}"`).join(', ')}. Factor this in but do not repeat titles they have likely already seen.`;
  }

  return text;
}

/* ── TMDB enrichment — poster, rating, streaming providers ── */
async function enrichWithTMDB(show, countryCode = 'AU') {
  const TMDB_KEY = process.env.TMDB_API_KEY;
  if (!TMDB_KEY) {
    console.log('[recommend] TMDB_KEY not configured');
    return show;
  }
  try {
    const cleanTitle = show.title.replace(/\s*[\[(]?\d{4}[\])]?\s*$/, '').trim();
    const searchUrl  = `https://api.themoviedb.org/3/search/multi?query=${encodeURIComponent(cleanTitle)}&api_key=${TMDB_KEY}&include_adult=false&language=en-US`;
    const searchRes  = await fetch(searchUrl);
    const searchData = await searchRes.json();

    const candidates = (searchData.results ?? []).filter(
      r => r.media_type === 'movie' || r.media_type === 'tv'
    );
    const result = candidates.find(r => r.poster_path) ?? candidates[0] ?? null;

    console.log(`[recommend] TMDB "${show.title}" → ${searchRes.status} | ${candidates.length} hits | poster=${result?.poster_path ?? 'none'}`);

    if (!result) return show;

    const mediaType    = result.media_type;
    const providersUrl = `https://api.themoviedb.org/3/${mediaType}/${result.id}/watch/providers?api_key=${TMDB_KEY}`;

    let streaming = [];
    try {
      const provRes    = await fetch(providersUrl);
      const provData   = await provRes.json();
      const regionData = provData.results?.[countryCode] ?? provData.results?.['AU'] ?? {};
      streaming        = (regionData.flatrate ?? []).map(p => p.provider_name);
      console.log(`[recommend] Providers "${show.title}" [${countryCode}] flatrate: [${streaming.join(', ') || 'none'}]`);
    } catch (e) {
      console.error('[recommend] Providers fetch failed for', show.title, e?.message);
    }

    return {
      ...show,
      poster:      result.poster_path ? `https://image.tmdb.org/t/p/w500${result.poster_path}` : null,
      imdbRating:  result.vote_average ? result.vote_average.toFixed(1) : null,
      year:        (result.release_date ?? result.first_air_date ?? '').slice(0, 4) || null,
      streamingAU: streaming,
    };
  } catch (e) {
    console.error('[recommend] TMDB lookup failed for', show.title, e?.message);
  }
  return show;
}

/* ── Main handler ── */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { mood, history, refinements, exclude, watched, rejected, count } = req.body ?? {};

  if (!mood || typeof mood !== 'string' || !mood.trim()) {
    return res.status(400).json({ error: 'mood is required' });
  }

  const resultCount   = (Number.isInteger(count) && count >= 2 && count <= 5) ? count : 5;
  const rejectedCount = Array.isArray(rejected) ? rejected.length : 0;

  console.log('[recommend] mood:', mood.trim(), '| refinements:', JSON.stringify(refinements ?? {}), '| count:', resultCount, '| rejected:', rejectedCount);

  // Fetch location + weather non-blocking — 3 s timeout before falling back
  const locationCtx = await Promise.race([
    getLocationAndWeather(req),
    new Promise(resolve =>
      setTimeout(() => resolve({ country: 'AU', city: null, weather: null, weatherAdj: null, temp: null, emoji: null }), 3000)
    ),
  ]);

  const userPrompt = buildUserPrompt(mood, refinements, exclude, history, watched, rejected, locationCtx);
  console.log('[recommend] Full prompt:\n', userPrompt);

  // Tool schema for structured JSON output
  const recommendTool = {
    name: 'return_recommendations',
    description: 'Return the film and TV show recommendations as structured data.',
    input_schema: {
      type: 'object',
      properties: {
        recommendations: {
          type: 'array',
          minItems: resultCount,
          maxItems: resultCount,
          items: {
            type: 'object',
            properties: {
              title:    { type: 'string', description: 'Plain title, no year' },
              genre:    { type: 'string', description: 'One short genre label' },
              format:   { type: 'string', enum: ['Movie', 'Series', 'Documentary', 'Limited Series'] },
              language: { type: 'string', description: 'Primary language' },
              runtime:  { type: 'string', description: '"1h 52m" for movies, "3 seasons" for series' },
              reason:   { type: 'string', description: '10-15 words max, punchy and evocative' },
            },
            required: ['title', 'genre', 'format', 'language', 'runtime', 'reason'],
          },
        },
      },
      required: ['recommendations'],
    },
  };

  try {
    const message = await client.messages.create({
      model:      MODEL,
      max_tokens: 1024,
      system:     SYSTEM_PROMPT,
      tools:      [recommendTool],
      tool_choice: { type: 'tool', name: 'return_recommendations' },
      messages:   [{ role: 'user', content: userPrompt }],
    });

    const toolUse = message.content.find(c => c.type === 'tool_use');
    if (!toolUse) throw new Error('No tool_use block in Claude response');

    const parsed = toolUse.input;
    console.log('[recommend] Claude response:', JSON.stringify(parsed));

    const countryCode = locationCtx.country || 'AU';
    const enriched    = await Promise.all(parsed.recommendations.map(s => enrichWithTMDB(s, countryCode)));

    res.json({ recommendations: enriched, locationContext: locationCtx });
  } catch (err) {
    console.error('Recommendation error:', err?.message ?? err);
    res.status(500).json({ error: 'Failed to get recommendations. Please try again.' });
  }
}
