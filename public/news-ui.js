// news-ui.js - adds an admin-only "News" tab to the admin panel
(function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  async function j(url, opt = {}) {
    const r = await fetch(url, { credentials: 'include', ...opt, headers: { 'Content-Type': 'application/json', ...(opt.headers || {}) } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Request failed');
    return d;
  }
  const tabs = document.querySelector('#app .tabs');
  if (!tabs) return;
  const btn = document.createElement('button');
  btn.className = 'tab-btn hidden'; btn.dataset.tab = 'newsTab'; btn.textContent = 'News / ዜና';
  tabs.insertBefore(btn, tabs.querySelector('.tab-link'));
  const panel = document.createElement('div');
  panel.id = 'newsTab'; panel.className = 'hidden';
  panel.innerHTML = `
    <div class="card"><h2 id="nHead">Post news / ዜና ለጥፍ</h2>
      <input id="nId" type="hidden">
      <div class="grid">
        <label>Title (አማርኛ)<input id="nTa" maxlength="300"></label>
        <label>Title (English)<input id="nTe" maxlength="300"></label>
        <label>Text (አማርኛ)<textarea id="nBa" style="min-height:160px"></textarea></label>
        <label>Text (English)<textarea id="nBe" style="min-height:160px"></textarea></label>
      </div>
      <label style="margin-top:14px">Photos / ፎቶዎች<input id="nPh" type="file" accept="image/*" multiple></label>
      <div class="actions"><button id="nSave" class="primary">Publish / ለጥፍ</button><button id="nClear" class="secondary">Clear</button></div>
      <div id="nErr" class="error"></div>
    </div>
    <div class="card"><h2>Posts / ዜናዎች</h2><div id="nList"></div></div>`;
  $('app').appendChild(panel);

  setInterval(() => {
    const admin = !$('app').classList.contains('hidden') && !$('setupTabBtn').classList.contains('hidden');
    btn.classList.toggle('hidden', !admin);
  }, 800);
  tabs.addEventListener('click', e => {
    const b = e.target.closest('.tab-btn'); if (!b) return;
    panel.classList.toggle('hidden', b !== btn);
    if (b === btn) load();
  });

  function shrink(file) {
    return new Promise((ok, no) => {
      const img = new Image(), u = URL.createObjectURL(file);
      img.onload = () => {
        const s = Math.min(1, 1000 / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(u);
        c.toBlob(b => b ? ok(b) : no(new Error('Image error')), 'image/jpeg', 0.75);
      };
      img.onerror = () => no(new Error('Could not read image'));
      img.src = u;
    });
  }
  async function upload(id, files) {
    for (const f of files) {
      const blob = await shrink(f);
      const r = await fetch('/api/news/' + id + '/images', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Photo upload failed');
    }
  }
  let items = [];
  async function load() {
    try { items = (await j('/api/news')).items; } catch (e) { $('nErr').textContent = e.message; return; }
    $('nList').innerHTML = items.length ? items.map(n => `
      <div class="list-row" style="align-items:flex-start"><div style="flex:1;min-width:200px">
        <b>${esc(n.title_am || n.title_en)}</b><div class="muted">${new Date(n.created_at).toLocaleDateString()}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">${n.images.map(i => `
          <span style="position:relative"><img src="/api/news/image/${i}" style="width:70px;height:56px;object-fit:cover;border-radius:6px">
          <button data-delimg="${i}" class="danger" style="position:absolute;top:0;right:0;padding:0 6px">×</button></span>`).join('')}</div></div>
        <div><label class="secondary" style="display:inline-block;padding:10px 14px;border-radius:8px;cursor:pointer;margin:0">+ Photos
          <input type="file" accept="image/*" multiple hidden data-add="${n.id}"></label>
          <button class="secondary" data-edit="${n.id}">Edit</button> <button class="danger" data-del="${n.id}">Delete</button></div></div>`).join('')
      : '<p class="muted">No posts yet.</p>';
  }
  $('nList').addEventListener('click', async e => {
    const t = e.target;
    try {
      if (t.dataset.edit) {
        const n = items.find(x => x.id == t.dataset.edit);
        $('nId').value = n.id; $('nTa').value = n.title_am; $('nTe').value = n.title_en; $('nBa').value = n.body_am; $('nBe').value = n.body_en;
        $('nHead').textContent = 'Edit news'; window.scrollTo({ top: panel.offsetTop, behavior: 'smooth' });
      } else if (t.dataset.del && confirm('Delete this news post?')) { await j('/api/news/' + t.dataset.del, { method: 'DELETE' }); load(); }
      else if (t.dataset.delimg && confirm('Delete this photo?')) { await j('/api/news/image/' + t.dataset.delimg, { method: 'DELETE' }); load(); }
    } catch (err) { $('nErr').textContent = err.message; }
  });
  $('nList').addEventListener('change', async e => {
    if (!e.target.dataset.add) return;
    try { await upload(e.target.dataset.add, e.target.files); load(); } catch (err) { $('nErr').textContent = err.message; }
  });
  function clear() { ['nId', 'nTa', 'nTe', 'nBa', 'nBe', 'nPh'].forEach(i => $(i).value = ''); $('nHead').textContent = 'Post news / ዜና ለጥፍ'; $('nErr').textContent = ''; }
  $('nClear').onclick = clear;
  $('nSave').onclick = async () => {
    $('nErr').textContent = ''; $('nSave').disabled = true;
    try {
      const body = JSON.stringify({ title_am: $('nTa').value, title_en: $('nTe').value, body_am: $('nBa').value, body_en: $('nBe').value });
      const id = $('nId').value;
      const r = await j(id ? '/api/news/' + id : '/api/news', { method: id ? 'PUT' : 'POST', body });
      await upload(id || r.id, $('nPh').files);
      clear(); load();
    } catch (err) { $('nErr').textContent = err.message; }
    $('nSave').disabled = false;
  };
})();
