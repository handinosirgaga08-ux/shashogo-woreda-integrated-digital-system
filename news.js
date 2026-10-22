// news.js - SWIDS news: posts with photos stored in PostgreSQL (survive Render redeploys)
// In server.js add:  require('./news').mount(app, { pool, wrap, requireAuth });
const express = require('express');
module.exports.mount = function (app, { pool, wrap, requireAuth }) {
  pool.query(`
    CREATE TABLE IF NOT EXISTS news(id SERIAL PRIMARY KEY, title_am TEXT DEFAULT '', title_en TEXT DEFAULT '',
      body_am TEXT DEFAULT '', body_en TEXT DEFAULT '', created_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE IF NOT EXISTS news_images(id SERIAL PRIMARY KEY, news_id INT REFERENCES news(id) ON DELETE CASCADE,
      mime TEXT, data BYTEA, created_at TIMESTAMPTZ DEFAULT now());
  `).catch(e => console.error('news tables:', e.message));

  // Admin only: server.js requireAuth is plain middleware and sets req.user
  const adminOnly = (req, res, next) => requireAuth(req, res, err => {
    if (err) return next(err);
    if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator only' });
    next();
  });
  const clean = (v, n) => String(v || '').trim().slice(0, n);
  const fields = b => [clean(b.title_am, 300), clean(b.title_en, 300), clean(b.body_am, 20000), clean(b.body_en, 20000)];

  app.get('/api/news', wrap(async (req, res) => {
    const r = await pool.query(`SELECT n.id,n.title_am,n.title_en,n.body_am,n.body_en,n.created_at,
      COALESCE((SELECT json_agg(i.id ORDER BY i.id) FROM news_images i WHERE i.news_id=n.id),'[]') AS images
      FROM news n ORDER BY n.created_at DESC LIMIT 50`);
    res.json({ items: r.rows });
  }));

  app.get('/api/news/image/:id', wrap(async (req, res) => {
    const r = await pool.query('SELECT mime,data FROM news_images WHERE id=$1', [parseInt(req.params.id, 10) || 0]);
    if (!r.rows.length) return res.status(404).end();
    res.set('Content-Type', r.rows[0].mime).set('Cache-Control', 'public, max-age=86400').send(r.rows[0].data);
  }));

  app.post('/api/news', adminOnly, wrap(async (req, res) => {
    const f = fields(req.body || {});
    if (!f[0] && !f[1]) return res.status(400).json({ error: 'Title is required' });
    const r = await pool.query('INSERT INTO news(title_am,title_en,body_am,body_en) VALUES($1,$2,$3,$4) RETURNING id', f);
    res.json({ id: r.rows[0].id });
  }));

  app.put('/api/news/:id', adminOnly, wrap(async (req, res) => {
    const f = fields(req.body || {});
    await pool.query('UPDATE news SET title_am=$1,title_en=$2,body_am=$3,body_en=$4 WHERE id=$5', [...f, parseInt(req.params.id, 10) || 0]);
    res.json({ ok: true });
  }));

  app.delete('/api/news/:id', adminOnly, wrap(async (req, res) => {
    await pool.query('DELETE FROM news WHERE id=$1', [parseInt(req.params.id, 10) || 0]);
    res.json({ ok: true });
  }));

  app.post('/api/news/:id/images', adminOnly,
    express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '3mb' }),
    wrap(async (req, res) => {
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'No image received' });
      const r = await pool.query('INSERT INTO news_images(news_id,mime,data) VALUES($1,$2,$3) RETURNING id',
        [parseInt(req.params.id, 10) || 0, req.get('Content-Type').split(';')[0], req.body]);
      res.json({ id: r.rows[0].id });
    }));

  app.delete('/api/news/image/:id', adminOnly, wrap(async (req, res) => {
    await pool.query('DELETE FROM news_images WHERE id=$1', [parseInt(req.params.id, 10) || 0]);
    res.json({ ok: true });
  }));

  // Public news page: /news
  app.get('/news', (req, res) => res.type('html').send(PAGE));
};

const PAGE = `<!doctype html><html lang="am"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SWIDS News</title><link rel="icon" href="/icon-192.png">
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Ethiopic:wght@400;600;700&display=swap" rel="stylesheet">
<style>body{margin:0;background:#f4f6fa;color:#0f1b33;font:17px/1.8 "Noto Sans Ethiopic",Arial,sans-serif}
header{background:#0b1120;color:#fff;padding:14px 18px;display:flex;justify-content:space-between;align-items:center;gap:10px}
header a{color:#fff;text-decoration:none;font-weight:700}button{border:0;border-radius:999px;padding:8px 16px;font:inherit;font-weight:600;cursor:pointer}
main{max-width:760px;margin:0 auto;padding:18px}article{background:#fff;border-radius:12px;padding:18px;margin-bottom:20px;box-shadow:0 2px 10px #0001}
h1{font-size:24px;margin:0 0 6px}.d{color:#667085;font-size:14px;margin-bottom:12px}p{margin:0 0 14px}
.g{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin:12px 0}.g img{width:100%;border-radius:8px;display:block}.g img:first-child{grid-column:1/-1}</style></head>
<body><header><a href="/">SWIDS · <span id="h"></span></a><button id="b">English</button></header><main id="m"></main>
<script>
var lang='am',items=[],T={am:['ዜና','English','ምንም ዜና የለም።'],en:['News','አማርኛ','No news yet.']};
function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e}
function draw(){var m=document.getElementById('m');m.textContent='';document.getElementById('h').textContent=T[lang][0];document.getElementById('b').textContent=T[lang][1];document.documentElement.lang=lang;
if(!items.length){m.appendChild(el('p','',T[lang][2]));return}
items.forEach(function(n){var a=el('article'),o=lang==='am'?'en':'am';
var title=n['title_'+lang]||n['title_'+o],body=n['body_'+lang]||n['body_'+o];
a.appendChild(el('h1','',title));a.appendChild(el('div','d',new Date(n.created_at).toLocaleDateString(lang==='am'?'am-ET':'en-GB')));
if(n.images.length){var g=el('div','g');n.images.forEach(function(i){var im=new Image();im.src='/api/news/image/'+i;im.loading='lazy';im.alt=title;g.appendChild(im)});a.appendChild(g)}
body.split(/\\n\\s*\\n/).forEach(function(p){if(p.trim())a.appendChild(el('p','',p.trim()))});m.appendChild(a)})}
document.getElementById('b').onclick=function(){lang=lang==='am'?'en':'am';draw()};
fetch('/api/news').then(function(r){return r.json()}).then(function(d){items=d.items;draw()}).catch(draw);
</script></body></html>`;
