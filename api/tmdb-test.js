export default async function handler(req, res) {
  const TMDB_KEY = process.env.TMDB_API_KEY;

  if (!TMDB_KEY) {
    return res.status(200).json({
      status: 'MISSING',
      message: 'TMDB_API_KEY is not set in this Vercel environment.',
      fix: 'Go to Vercel → Settings → Environment Variables → add TMDB_API_KEY for Production, then redeploy.',
    });
  }

  try {
    const url = `https://api.themoviedb.org/3/search/multi?query=Forrest+Gump&api_key=${TMDB_KEY}&include_adult=false&language=en-US`;
    const r = await fetch(url);
    const data = await r.json();

    const candidates = (data.results ?? []).filter(
      x => x.media_type === 'movie' || x.media_type === 'tv'
    );
    const hit = candidates.find(x => x.poster_path) ?? candidates[0] ?? null;

    return res.status(200).json({
      status: r.ok ? 'OK' : 'TMDB_ERROR',
      tmdbStatus: r.status,
      keyConfigured: true,
      keyPrefix: TMDB_KEY.slice(0, 6) + '…',
      totalResults: data.results?.length ?? 0,
      movieTvResults: candidates.length,
      posterFound: !!hit?.poster_path,
      posterUrl: hit?.poster_path ? `https://image.tmdb.org/t/p/w500${hit.poster_path}` : null,
      tmdbError: data.status_message ?? null,
    });
  } catch (e) {
    return res.status(200).json({
      status: 'FETCH_ERROR',
      message: e.message,
    });
  }
}
