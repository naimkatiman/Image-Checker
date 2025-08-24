// Netlify Function: screenshot-post
// Takes a Facebook post URL, renders a mobile/basic page with headless Chromium, and returns a base64 screenshot

const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const ENV_COOKIES_JSON = process.env.FACEBOOK_COOKIES_JSON || process.env.FB_COOKIES_JSON || '';
const ENV_COOKIE_HEADER = process.env.FACEBOOK_COOKIE_HEADER || process.env.FB_COOKIE_HEADER || '';
const NAV_TIMEOUT = Number(process.env.NAV_TIMEOUT_MS || 10000); // Reduced timeout

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

	let url = '';
	try {
		const body = event.body ? JSON.parse(event.body) : {};
		url = String(body.url || '').trim();
		if (!url) throw new Error('Missing url');
		url = normalizeFacebookUrl(url);
	} catch (_) {
		return {
			statusCode: 400,
			headers: { 'Content-Type': 'application/json', ...corsHeaders },
			body: JSON.stringify({ error: 'Invalid request body. Expected JSON with { url }.' }),
		};
	}

	const cookies = parseCookies(getCookieInput(event));

	let browser = null;
	try {
		let usedFallback = false;
		// Prefer local Puppeteer in dev (no AWS Lambda env), fall back to Lambda-compatible Chromium
		const runningOnLambda = !!process.env.AWS_EXECUTION_ENV;
		try {
			if (!runningOnLambda) {
				const puppeteerLocal = require('puppeteer');
				browser = await puppeteerLocal.launch({
					headless: true,
					defaultViewport: { width: 640, height: 1024 },
					ignoreHTTPSErrors: true,
					args: ['--no-sandbox', '--disable-setuid-sandbox']
				});
				usedFallback = true;
			} else {
				throw new Error('Use Lambda chromium');
			}
		} catch (localErr) {
			const executablePath = await chromium.executablePath();
			browser = await puppeteer.launch({
				args: chromium.args,
				defaultViewport: { width: 640, height: 1024 },
				executablePath,
				headless: chromium.headless,
				ignoreHTTPSErrors: true,
			});
		}

		const page = await browser.newPage();
		// Tighter timeouts to avoid Netlify Dev 30s cap
		page.setDefaultNavigationTimeout(NAV_TIMEOUT);
		page.setDefaultTimeout(NAV_TIMEOUT);
		// Use a mobile-ish UA to increase chances of seeing content on m/mbasic
		await page.setUserAgent(
			'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
		);

		// Speed up by blocking heavy resources (images, fonts, media, stylesheets)
		try {
			await page.setRequestInterception(true);
			page.on('request', (req) => {
				const type = req.resourceType();
				if (type === 'image' || type === 'font' || type === 'media' || type === 'stylesheet' || type === 'other') {
					return req.abort();
				}
				return req.continue();
			});
		} catch (_) {}

		// Preload base domain and apply cookies if provided
		if (cookies && cookies.length) {
			try {
				await page.goto('https://mbasic.facebook.com/', { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
				await page.setCookie(...cookies);
			} catch (e) {}
		}

		// Navigate to target
		await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });

		// Hide potential banners/headers to keep screenshot focused
		await page.addStyleTag({
			content: `
				#header, header, [role="banner"], [data-cookiebanner], [data-nosnippet], [data-testid="cookie-policy-banner"],
				div[role="dialog"], ._53iv, ._5hn6 { display: none !important; }
				html, body { background: #fff !important; }
			`,
		});

		// Give the page a moment to settle after style injection
		await page.waitForTimeout(1200);

		// Try to locate primary post container (best-effort). If not found, fallback to full page.
		let clip = null;
		try {
			const candidate = await page.$('article, #m_story_permalink_view, .userContentWrapper, [data-ft], [role="main"]');
			if (candidate) {
				const box = await candidate.boundingBox();
				if (box && box.width > 0 && box.height > 0) {
					clip = { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 8), width: box.width + 16, height: box.height + 16 };
				}
			}
		} catch (_) {}

		const buffer = await page.screenshot({ type: 'jpeg', quality: 80, fullPage: !clip, clip: clip || undefined });
		await browser.close();

		const dataUrl = `data:image/jpeg;base64,${buffer.toString('base64')}`;
		return {
			statusCode: 200,
			headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders },
			body: JSON.stringify({ dataUrl, url }),
		};
	} catch (err) {
		try { if (browser && typeof browser.close === 'function') { await browser.close(); } } catch (_) {}
		return {
			statusCode: 500,
			headers: { 'Content-Type': 'application/json', ...corsHeaders },
			body: JSON.stringify({ error: 'Failed to screenshot', details: String(err) }),
		};
	}
};

function normalizeFacebookUrl(input) {
	try {
		const u = new URL(input);
		if (/facebook\.com$/i.test(u.hostname) || /facebook\.com$/i.test(u.hostname.replace(/^www\./, ''))) {
			// Prefer mbasic for simpler markup (less gating)
			u.hostname = 'mbasic.facebook.com';
			return u.toString();
		}
		return input;
	} catch (_) {
		return input;
	}
}

function getCookieInput(event) {
	try {
		const body = event.body ? JSON.parse(event.body) : {};
		return body.cookies || body.cookie || ENV_COOKIES_JSON || ENV_COOKIE_HEADER || '';
	} catch (_) {
		return ENV_COOKIES_JSON || ENV_COOKIE_HEADER || '';
	}
}

function parseCookies(input) {
	if (!input) return [];
	try {
		if (Array.isArray(input)) return sanitizeCookiesArray(input);
		if (typeof input === 'string') {
			const trimmed = input.trim();
			if (!trimmed) return [];
			if (trimmed.startsWith('[')) {
				const arr = JSON.parse(trimmed);
				return sanitizeCookiesArray(arr);
			}
			// Cookie header string: "name=value; name2=value2"
			const parts = trimmed.split(';').map(s => s.trim()).filter(Boolean);
			const arr = parts.map(p => {
				const eq = p.indexOf('=');
				if (eq === -1) return null;
				const name = p.slice(0, eq).trim();
				const value = p.slice(eq + 1).trim();
				return { name, value, domain: '.facebook.com', path: '/', httpOnly: false, secure: true };
			}).filter(Boolean);
			return arr;
		}
	} catch (_) {}
	return [];
}

function sanitizeCookiesArray(arr) {
	if (!Array.isArray(arr)) return [];
	return arr.map(c => {
		const name = String(c.name || '').trim();
		const value = String(c.value || '').trim();
		if (!name) return null;
		const out = {
			name,
			value,
			domain: c.domain || '.facebook.com',
			path: c.path || '/',
			httpOnly: !!c.httpOnly,
			secure: typeof c.secure === 'boolean' ? c.secure : true,
			sameSite: c.sameSite || 'Lax'
		};
		if (typeof c.expires === 'number') out.expires = c.expires;
		return out;
	}).filter(Boolean);
}

