// Netlify Function: fb-scrape
// Fetches Facebook post metadata (og:title, og:description, og:image) for a given URL.

exports.handler = async function (event) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: 'Method Not Allowed' }),
    };
  }

  try {
    const { url } = JSON.parse(event.body || '{}');
    if (!url || typeof url !== 'string') {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ error: 'Missing url' }),
      };
    }

    const tried = [];
    const candidates = buildCandidateUrls(url);
    let html = null;
    let finalUrl = null;

    for (const candidate of candidates) {
      tried.push(candidate);
      const res = await fetch(candidate, {
        headers: buildHeaders(),
        redirect: 'follow',
      }).catch(() => null);
      if (res && res.ok) {
        try {
          html = await res.text();
          finalUrl = res.url || candidate;
          if (containsOg(html)) break;
        } catch (_) {}
      }
    }

    if (!html) {
      return {
        statusCode: 502,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ error: 'Failed to fetch page', tried }),
      };
    }

    const meta = extractMeta(html, finalUrl);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({
        inputUrl: url,
        finalUrl,
        name: meta.name || 'unknown',
        caption: meta.caption || '',
        imageUrl: meta.image || '',
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: 'Scrape failed', details: String(err) }),
    };
  }
};

function buildHeaders() {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
  };
}

function buildCandidateUrls(input) {
  const u = new URL(input);
  const hosts = [u.host];
  if (!hosts.includes('m.facebook.com')) hosts.push('m.facebook.com');
  if (!hosts.includes('mbasic.facebook.com')) hosts.push('mbasic.facebook.com');
  const paths = u.href.substring(u.origin.length);
  return hosts.map(h => `https://${h}${paths}`);
}

function containsOg(html) {
  return /<meta\s+property=["']og:(title|image|description)["']/i.test(html);
}

function extractMeta(html, baseUrl) {
  const pick = (re) => {
    const m = html.match(re); return m ? decodeHtml(m[1]) : '';
  };
  const ogTitle = pick(/<meta\s+property=["']og:title["']\s+content=["']([^"']*)["'][^>]*>/i);
  const ogDesc = pick(/<meta\s+property=["']og:description["']\s+content=["']([^"']*)["'][^>]*>/i);
  const ogImage = pick(/<meta\s+property=["']og:image["']\s+content=["']([^"']*)["'][^>]*>/i);
  const ogSite = pick(/<meta\s+property=["']og:site_name["']\s+content=["']([^"']*)["'][^>]*>/i);
  const twDesc = pick(/<meta\s+name=["']twitter:description["']\s+content=["']([^"']*)["'][^>]*>/i);
  const titleTag = extractTitle(html);

  let image = ogImage;
  if (image) {
    try { image = new URL(image, baseUrl).href; } catch (_) {}
  }

  const name = ogSite || ogTitle || titleTag || '';
  const caption = ogDesc || twDesc || '';
  return { name, caption, image };
}

function extractTitle(html) {
  const m = html.match(/<title>([^<]*)<\/title>/i);
  return m ? decodeHtml(m[1]) : '';
}

function decodeHtml(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}


