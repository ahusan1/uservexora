const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ymgyekgmonqhehmnskcw.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InltZ3lla2dtb25xaGVobW5za2N3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE5NTA0MjQsImV4cCI6MjA4NzUyNjQyNH0.1KjMMPJaU849XJ0w3NjsUKSBugjjNAR_mGyu7wJCURw';

// Allowed production hosts — prevents open-redirect via Host header injection
const ALLOWED_HOSTS = new Set([
  'plusvexora.vercel.app',
  'www.plusvexora.vercel.app',
  'localhost:3000',
  'localhost:5173',
  '127.0.0.1:3000',
  '127.0.0.1:5173',
]);

const { rateLimiterMiddleware } = require('../../_middleware/rateLimiter.js');
const { publicCorsMiddleware } = require('../../_middleware/cors.js');

const esc = (value) =>
  String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const toAbsoluteUrl = (origin, value) => {
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('//')) return `https:${value}`;
  return `${origin}${value.startsWith('/') ? '' : '/'}${value}`;
};

module.exports = async function handler(req, res) {
  // CORS protection — only allow trusted origins
  const corsAllowed = publicCorsMiddleware(req, res);
  if (!corsAllowed) return;

  // Rate limiting — prevent abuse
  const rateLimitPassed = await rateLimiterMiddleware(req, res);
  if (!rateLimitPassed) return;

  const id = String((req.query && req.query.id) || '').trim();

  // Validate and sanitise the host to prevent open-redirect via Host header injection
  const rawHost = (req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0] +
    (((req.headers['x-forwarded-host'] || req.headers.host || '')).includes(':')
      ? ':' + (req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[1]
      : '');
  const safeHost = ALLOWED_HOSTS.has(rawHost) ? rawHost : 'plusvexora.vercel.app';
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const origin = `${protocol}://${safeHost}`;

  if (!id) {
    res.status(400).send('Missing product id');
    return;
  }

  const productPageUrl = `${origin}/product/${encodeURIComponent(id)}`;

  try {
    const query = `${SUPABASE_URL}/rest/v1/products?id=eq.${encodeURIComponent(id)}&select=title,price,original_price,category,preview_image`;
    const response = await fetch(query, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
    });

    const data = await response.json();
    const product = Array.isArray(data) ? data[0] : null;

    if (!product) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="refresh" content="0;url=${productPageUrl}" />
    <title>Vexora</title>
  </head>
  <body>Redirecting...</body>
</html>`);
      return;
    }

    const title = esc(product.title || 'Product');
    const category = product.category ? ` | Category: ${product.category}` : '';
    const originalPrice = product.original_price && product.original_price > product.price
      ? ` (Original: ₹${product.original_price})`
      : '';
    const description = esc(`Price: ₹${product.price}${originalPrice}${category}`);
    const imageUrl = toAbsoluteUrl(origin, product.preview_image);
    const image = esc(imageUrl);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600');
    res.status(200).send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title} - Vexora</title>
    <meta name="description" content="${description}" />

    <meta property="og:type" content="product" />
    <meta property="og:site_name" content="Vexora" />
    <meta property="og:title" content="${title}" />
    <meta property="og:description" content="${description}" />
    ${image ? `<meta property="og:image" content="${image}" />` : ''}
    ${image ? `<meta property="og:image:secure_url" content="${image}" />` : ''}
    <meta property="og:url" content="${productPageUrl}" />

    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${title}" />
    <meta name="twitter:description" content="${description}" />
    ${image ? `<meta name="twitter:image" content="${image}" />` : ''}

    <meta http-equiv="refresh" content="0;url=${productPageUrl}" />
    <link rel="canonical" href="${productPageUrl}" />
  </head>
  <body>
    <a href="${productPageUrl}">Open product</a>
  </body>
</html>`);
  } catch (_) {
    console.error('Share product handler error:', _);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="refresh" content="0;url=${productPageUrl}" />
    <title>Vexora</title>
  </head>
  <body>Redirecting...</body>
</html>`);
  }
};
