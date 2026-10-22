(function () {
  var lang = 'en';
  try { lang = localStorage.getItem('swids_lang') || 'en'; } catch (e) {}
  var am = lang === 'am';
  var L = am
    ? { h: 'ዜና', all: 'ሁሉንም ዜና ይመልከቱ', none: '' }
    : { h: 'Latest News', all: 'View all news', none: '' };

  // 1) News link in the menu
  var nav = document.querySelector('nav');
  if (nav && !nav.querySelector('a[href="/news"]')) {
    var first = nav.querySelector('a');
    var link = document.createElement('a');
    link.href = '/news';
    link.textContent = am ? 'ዜና' : 'News';
    if (first) link.className = first.className;
    nav.appendChild(link);
  }

  // 2) Latest news section
  fetch('/api/news').then(function (r) { return r.json(); }).then(function (d) {
    var items = (d.items || []).slice(0, 3);
    if (!items.length) return;
    var host = document.querySelector('main') || document.body;
    var sec = document.createElement('section');
    sec.style.cssText = 'background:#fff;border-radius:16px;padding:20px;margin:18px 0;box-shadow:0 2px 10px rgba(0,0,0,.08)';
    var h = document.createElement('h2');
    h.textContent = L.h;
    h.style.cssText = 'margin:0 0 12px;color:#0b1120';
    sec.appendChild(h);

    items.forEach(function (n) {
      var o = am ? 'en' : 'am';
      var title = n['title_' + (am ? 'am' : 'en')] || n['title_' + o];
      var body = n['body_' + (am ? 'am' : 'en')] || n['body_' + o] || '';
      var card = document.createElement('a');
      card.href = '/news';
      card.style.cssText = 'display:block;text-decoration:none;color:inherit;padding:12px 0;border-top:1px solid #eaecf0';
      if (n.images && n.images.length) {
        var im = new Image();
        im.src = '/api/news/image/' + n.images[0];
        im.loading = 'lazy';
        im.alt = title;
        im.style.cssText = 'width:100%;border-radius:10px;display:block;margin-bottom:8px';
        card.appendChild(im);
      }
      var t = document.createElement('div');
      t.textContent = title;
      t.style.cssText = 'font-weight:700;font-size:17px';
      var dt = document.createElement('div');
      dt.textContent = new Date(n.created_at).toLocaleDateString(am ? 'am-ET' : 'en-GB');
      dt.style.cssText = 'color:#667085;font-size:13px;margin:2px 0 6px';
      var ex = document.createElement('div');
      ex.textContent = body.length > 160 ? body.slice(0, 160) + '…' : body;
      ex.style.cssText = 'color:#344054;font-size:15px';
      card.appendChild(t); card.appendChild(dt); card.appendChild(ex);
      sec.appendChild(card);
    });

    var more = document.createElement('a');
    more.href = '/news';
    more.textContent = L.all + ' →';
    more.style.cssText = 'display:inline-block;margin-top:8px;font-weight:700;color:#1769aa;text-decoration:none';
    sec.appendChild(more);
    host.appendChild(sec);
  }).catch(function () {});
})();
