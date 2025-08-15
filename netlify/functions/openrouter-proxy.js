// Netlify Function: openrouter-proxy
// Proxies requests to OpenRouter and injects the API key from environment variables.

const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

exports.handler = async function (event) {
  // Basic CORS support (not strictly needed for same-origin, but harmless)
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

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: 'OPENROUTER_API_KEY is not configured on the server.' }),
    };
  }

  try {
    // Parse incoming JSON
    const payload = event.body ? JSON.parse(event.body) : {};

    // Compose headers required by OpenRouter
    const referer = process.env.URL || event.headers?.referer || '';

    const response = await fetch(OPENROUTER_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': referer,
        'X-Title': 'AI Image Checker',
      },
      body: JSON.stringify(payload),
    });

    const text = await response.text();

    return {
      statusCode: response.status,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...corsHeaders,
      },
      body: text,
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: 'Proxy request failed', details: String(err) }),
    };
  }
};
