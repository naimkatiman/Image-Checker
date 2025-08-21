// Netlify Function: screenshot-post
// Takes a Facebook post URL, renders a mobile/basic page with headless Chromium, and returns a base64 screenshot

const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

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

	try {
		// Prepare chromium
		const executablePath = await chromium.executablePath();
		const browser = await puppeteer.launch({
			args: chromium.args,
			defaultViewport: { width: 640, height: 1024 },
			executablePath,
			headless: chromium.headless,
			ignoreHTTPSErrors: true,
		});

		const page = await browser.newPage();
		// Use a mobile-ish UA to increase chances of seeing content on m/mbasic
		await page.setUserAgent(
			'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
		);

		// Be lenient with timeouts due to FB
		await page.goto(url, { waitUntil: ['domcontentloaded', 'networkidle2'], timeout: 45000 });

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


