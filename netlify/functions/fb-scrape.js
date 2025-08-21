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
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ ok: false, reason: 'missing-url', name: 'unknown', caption: '', imageUrl: '' }),
      };
    }

    const tried = [];
    const candidates = buildCandidateUrls(url);
    const userAgents = ['chrome', 'fb'];
    let html = null;
    let finalUrl = null;

    outer: for (const candidate of candidates) {
      for (const ua of userAgents) {
        tried.push(`${candidate} [ua:${ua}]`);
        const res = await safeFetch(candidate, { headers: buildHeaders(ua), redirect: 'follow' });
        if (res && res.ok && res.text) {
          const text = res.text;
          if (!isFacebookLoginInterstitial(text)) {
            html = text;
            finalUrl = res.url || candidate;
            break outer;
          }
        }
      }
    }

    if (!html) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ ok: false, reason: 'fetch-failed', tried, name: 'unknown', caption: '', imageUrl: '' }),
      };
    }

    const meta = extractMeta(html, finalUrl);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({
        ok: true,
        inputUrl: url,
        finalUrl,
        name: meta.name || 'unknown',
        caption: meta.caption || '',
        imageUrl: meta.image || '',
        ogTitle: meta.ogTitle || '',
        ogDesc: meta.ogDesc || '',
        rawTitle: meta.rawTitle || '',
        tried
      }),
    };
  } catch (err) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ ok: false, reason: 'exception', details: String(err), name: 'unknown', caption: '', imageUrl: '' }),
    };
  }
};

function buildHeaders(uaVariant) {
  const ua = uaVariant === 'fb'
    ? 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext/)'
    : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
  return {
    'User-Agent': ua,
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

async function safeFetch(url, opts) {
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { ...(opts||{}), signal: controller.signal }).catch(() => null);
    clearTimeout(id);
    if (!res) return null;
    const text = await res.text().catch(() => '');
    return { ok: res.ok, status: res.status, url: res.url, text };
  } catch (_) {
    return null;
  }
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
  const metaDesc = pick(/<meta\s+name=["']description["']\s+content=["']([^"']*)["'][^>]*>/i);
  const ogImage = pick(/<meta\s+property=["']og:image["']\s+content=["']([^"']*)["'][^>]*>/i);
  const ogImageSecure = pick(/<meta\s+property=["']og:image:secure_url["']\s+content=["']([^"']*)["'][^>]*>/i);
  const ogImageUrl = pick(/<meta\s+property=["']og:image:url["']\s+content=["']([^"']*)["'][^>]*>/i);
  const ogSite = pick(/<meta\s+property=["']og:site_name["']\s+content=["']([^"']*)["'][^>]*>/i);
  const twDesc = pick(/<meta\s+name=["']twitter:description["']\s+content=["']([^"']*)["'][^>]*>/i);
  const titleTag = extractTitle(html);

  let image = ogImage || ogImageSecure || ogImageUrl;
  if (image) {
    try { image = new URL(image, baseUrl).href; } catch (_) {}
    image = unwrapSafeImage(image);
  }
  if (!image) {
    image = extractImageFallback(html, baseUrl);
  }

  const name = ogSite || ogTitle || titleTag || '';
  const caption = ogDesc || twDesc || metaDesc || '';
  return { name, caption, image, ogTitle, ogDesc, rawTitle: titleTag };
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

function unwrapSafeImage(imageUrl) {
  try {
    const u = new URL(imageUrl);
    if (u.pathname.includes('/safe_image.php')) {
      const original = u.searchParams.get('url');
      if (original) {
        try { return new URL(decodeURIComponent(original)).href; } catch (_) { return decodeURIComponent(original); }
      }
    }
    return imageUrl;
  } catch (_) {
    return imageUrl;
  }
}

function extractImageFallback(html, baseUrl) {
  try {
    const candidates = [];
    const re = /<img[^>]+(?:data-src|src)=["']([^"']+)["'][^>]*>/ig;
    let m;
    while ((m = re.exec(html)) !== null) {
      const src = m[1];
      if (!src) continue;
      let abs;
      try { abs = new URL(src, baseUrl).href; } catch (_) { continue; }
      if (!abs) continue;
      if (abs.startsWith('data:')) continue;
      if (/pixel|analytics|spacer/i.test(abs)) continue;
      if (/\.svg($|\?)/i.test(abs)) continue;
      candidates.push(abs);
    }
    for (const c of candidates) {
      if (c.includes('/safe_image.php')) return unwrapSafeImage(c);
    }
    return candidates[0] || '';
  } catch (_) {
    return '';
  }
}

function isFacebookLoginInterstitial(html) {
  if (!html) return false;
  if (/See\s+posts,\s+photos\s+and\s+more\s+on\s+Facebook/i.test(html)) return true;
  if (/Log\s*in\s*or\s*sign\s*up\s*to\s*view/i.test(html)) return true;
  if (/Log\s*into\s*Facebook/i.test(html)) return true;
  return false;
}


