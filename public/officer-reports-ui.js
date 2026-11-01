// officer-reports-ui.js — adds an "Officer Reports" tab to the SWIDS admin panel.
// Sector officers submit work reports; sector heads review them and give feedback.
// Uses the page's own api(), esc(), $, me and lang, and the /api/officer-reports routes.
// Load it with one line just before </body>:  <script src="/officer-reports-ui.js"></script>
(function () {
  "use strict";

  const D = {
    en: {
      tab: "Officer Reports", submitTitle: "Submit a work report", editTitle: "Edit your report",
      submitHint: "Your sector head will review it and send feedback.",
      editHint: "Fix your report, save, then press \"Resubmit for review\" if it was returned.",
      title: "Report title", period: "Period", details: "Details (activities, results against targets)",
      submit: "Submit report", save: "Save changes", cancel: "Cancel", edit: "Edit",
      listOfficer: "My reports", listHead: "Reports from sector officers",
      none: "No reports yet.", feedback: "Feedback", noFb: "No feedback yet.",
      writeOfficer: "Reply to your sector head...", writeHead: "Write feedback to the officer...",
      sendReply: "Send reply", sendFb: "Send feedback", approve: "Approve", ret: "Return for revision",
      resubmit: "Resubmit for review", Pending: "Pending", Approved: "Approved", Returned: "Returned for revision",
      required: "Title, period and details are required.", needsText: "Write something first.",
      needsReason: "Write feedback explaining what to revise.",
      head: "Sector head", officer: "Sector officer", refresh: "Refresh"
    },
    am: {
      tab: "የሠራተኛ ሪፖርቶች", submitTitle: "የሥራ ሪፖርት ያስገቡ", editTitle: "ሪፖርትዎን ያርሙ",
      submitHint: "የዘርፍ ኃላፊዎ ይገመግማል እና አስተያየት ይሰጣል።",
      editHint: "ሪፖርትዎን ያስተካክሉ፣ ያስቀምጡ፣ ከተመለሰ \"ለግምገማ እንደገና አስገባ\" ይጫኑ።",
      title: "የሪፖርት ርዕስ", period: "ወቅት", details: "ዝርዝር (ተግባራት፣ ከዕቅድ አንጻር ውጤት)",
      submit: "ሪፖርት አስገባ", save: "ለውጦችን አስቀምጥ", cancel: "ሰርዝ", edit: "አርም",
      listOfficer: "የእኔ ሪፖርቶች", listHead: "ከዘርፍ ሠራተኞች የመጡ ሪፖርቶች",
      none: "እስካሁን ሪፖርት የለም።", feedback: "አስተያየት", noFb: "እስካሁን አስተያየት የለም።",
      writeOfficer: "ለዘርፍ ኃላፊዎ ምላሽ ይጻፉ...", writeHead: "ለሠራተኛው አስተያየት ይጻፉ...",
      sendReply: "ምላሽ ላክ", sendFb: "አስተያየት ላክ", approve: "አጽድቅ", ret: "ለማሻሻል መልስ",
      resubmit: "ለግምገማ እንደገና አስገባ", Pending: "በመጠባበቅ ላይ", Approved: "ጸድቋል", Returned: "ለማሻሻል ተመልሷል",
      required: "ርዕስ፣ ወቅት እና ዝርዝር ያስፈልጋሉ።", needsText: "መጀመሪያ አስተያየት ይጻፉ።",
      needsReason: "ምን መሻሻል እንዳለበት የሚያብራራ አስተያየት ይጻፉ።",
      head: "የዘርፍ ኃላፊ", officer: "የዘርፍ ሠራተኛ", refresh: "አድስ"
    }
  };
  const curLang = () => (typeof lang !== "undefined" && D[lang]) ? lang : "en";
  const L = k => D[curLang()][k] || D.en[k] || k;
  const getMe = () => (typeof me !== "undefined" ? me : null);
  const allowed = u => !!u && ["sector_officer", "sector_head", "admin"].includes(u.role);

  let btn = null, panel = null, reports = [], lastEmail = null, lastLang = null, busy = false;
  let editingId = null; // id of the report the officer is editing, or null

  function addStyle() {
    const s = document.createElement("style");
    s.textContent =
      ".orfb{border-left:3px solid #1769aa;background:#f8f9fb;padding:8px 10px;margin:6px 0;border-radius:0 8px 8px 0;font-size:14px;white-space:pre-wrap}" +
      ".orfb.officer{border-left-color:#c98a1f}" +
      ".orcard{border:1px solid #eaecf0;border-radius:12px;padding:16px;margin-top:14px}" +
      ".orcard h3{margin:0 0 4px;color:#0b1120}.orcard textarea{min-height:60px;margin-top:8px}";
    document.head.appendChild(s);
  }

  function build() {
    if (btn) return;
    addStyle();
    btn = document.createElement("button");
    btn.className = "tab-btn hidden";
    btn.id = "orTabBtn";
    const link = document.querySelector(".tabs .tab-link");
    link ? link.before(btn) : document.querySelector(".tabs").appendChild(btn);

    panel = document.createElement("div");
    panel.id = "orTab";
    panel.className = "hidden";
    document.getElementById("setupTab").after(panel);

    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      ["recordsTab", "reportsTab", "setupTab"].forEach(id => document.getElementById(id).classList.add("hidden"));
      panel.classList.remove("hidden");
      load();
    });
    // When any other tab is chosen, hide this panel (the page's own handler shows its tab).
    document.querySelectorAll(".tab-btn").forEach(b => {
      if (b !== btn) b.addEventListener("click", () => panel.classList.add("hidden"));
    });
    panel.addEventListener("click", onClick);
  }

  function setErr(msg) { const e = document.getElementById("orError"); if (e) e.textContent = msg || ""; }

  async function load() {
    try {
      reports = (await api("/api/officer-reports")).reports || [];
      render();
    } catch (err) {
      render();
      setErr(err.message);
    }
  }

  const badge = s => `<span class="status ${s === "Pending" ? "pending" : (s === "Returned" ? "inactive" : "")}">${esc(L(s))}</span>`;

  function thread(r) {
    const list = r.feedback || [];
    return list.length
      ? list.map(f => `<div class="orfb ${esc(f.role)}"><b>${esc(f.by)} · ${esc(L(f.role))} · ${esc(String(f.createdAt).slice(0, 10))}</b><br>${esc(f.text)}</div>`).join("")
      : `<p class="muted">${esc(L("noFb"))}</p>`;
  }

  function card(r, isOfficer) {
    const who = isOfficer ? "" : `${esc(r.officerName || r.officerEmail)} · ${esc(r.sector)} · `;
    const buttons = isOfficer
      ? `<button class="primary" data-act="fb" data-id="${esc(r.id)}">${esc(L("sendReply"))}</button>` +
        (r.status !== "Approved" ? `<button class="secondary" data-act="edit" data-id="${esc(r.id)}">${esc(L("edit"))}</button>` : "") +
        (r.status === "Returned" ? `<button class="secondary" data-act="resubmit" data-id="${esc(r.id)}">${esc(L("resubmit"))}</button>` : "")
      : `<button class="primary" data-act="fb" data-id="${esc(r.id)}">${esc(L("sendFb"))}</button>
         <button class="secondary" data-act="approve" data-id="${esc(r.id)}">${esc(L("approve"))}</button>
         <button class="danger" data-act="return" data-id="${esc(r.id)}">${esc(L("ret"))}</button>`;
    return `<div class="orcard">
      <h3>${esc(r.title)} ${badge(r.status)}</h3>
      <div class="muted">${who}${esc(r.period)} · ${esc(String(r.createdAt).slice(0, 10))}</div>
      <p style="white-space:pre-wrap">${esc(r.details)}</p>
      <b>${esc(L("feedback"))}</b>${thread(r)}
      <textarea id="orbox_${esc(r.id)}" maxlength="2000" placeholder="${esc(L(isOfficer ? "writeOfficer" : "writeHead"))}"></textarea>
      <div class="actions">${buttons}</div></div>`;
  }

  function render() {
    const u = getMe();
    if (!panel || !allowed(u)) return;
    const isOfficer = u.role === "sector_officer";
    btn.textContent = L("tab");

    // Stop editing a report that is gone or already approved.
    if (editingId) {
      const cur = reports.find(r => r.id === editingId);
      if (!cur || cur.status === "Approved") editingId = null;
    }

    // Keep what the officer has typed so a refresh does not wipe it.
    const ids = ["orTitle", "orPeriod", "orDetails"];
    const keep = ids.map(id => { const el = document.getElementById(id); return el ? el.value : null; });

    const editing = !!editingId;
    const form = isOfficer ? `
      <h2>${esc(L(editing ? "editTitle" : "submitTitle"))}</h2>
      <p class="muted">${esc(L(editing ? "editHint" : "submitHint"))}</p>
      <div class="grid">
        <label>${esc(L("title"))} *<input id="orTitle" maxlength="150"></label>
        <label>${esc(L("period"))} *<input id="orPeriod" maxlength="40" placeholder="2026-09"></label>
      </div>
      <label style="margin-top:14px">${esc(L("details"))} *<textarea id="orDetails" maxlength="5000"></textarea></label>
      <div class="actions">
        <button class="primary" data-act="submit">${esc(L(editing ? "save" : "submit"))}</button>
        ${editing ? `<button class="secondary" data-act="cancel">${esc(L("cancel"))}</button>` : ""}
      </div>
      <h2 style="margin-top:24px">${esc(L("listOfficer"))}</h2>` : `<h2>${esc(L("listHead"))}</h2>`;
    panel.innerHTML = `<div class="card">${form}
      <div class="actions" style="margin-top:0"><button class="secondary" data-act="refresh">${esc(L("refresh"))}</button></div>
      <div id="orError" class="error"></div>
      ${reports.length ? reports.map(r => card(r, isOfficer)).join("") : `<p class="muted">${esc(L("none"))}</p>`}
    </div>`;

    ids.forEach((id, i) => {
      const el = document.getElementById(id);
      if (el && keep[i] !== null) el.value = keep[i];
    });
  }

  function startEdit(id) {
    const r = reports.find(x => x.id === id);
    if (!r || r.status === "Approved") return;
    editingId = id;
    render();
    document.getElementById("orTitle").value = r.title;
    document.getElementById("orPeriod").value = r.period;
    document.getElementById("orDetails").value = r.details;
    document.getElementById("orTitle").scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function clearForm() {
    ["orTitle", "orPeriod", "orDetails"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    });
  }

  async function onClick(e) {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    if (busy) return; // ignore double taps while a request is running
    const act = b.dataset.act, id = b.dataset.id;

    // These two only change the screen, no request needed.
    if (act === "edit") { setErr(""); startEdit(id); return; }
    if (act === "cancel") { editingId = null; clearForm(); render(); return; }

    const box = id ? document.getElementById("orbox_" + id) : null;
    const text = box ? box.value.trim() : "";
    setErr("");
    busy = true;
    b.disabled = true;
    try {
      if (act === "refresh") { await load(); return; }
      if (act === "submit") {
        const body = {
          title: document.getElementById("orTitle").value.trim(),
          period: document.getElementById("orPeriod").value.trim(),
          details: document.getElementById("orDetails").value.trim()
        };
        if (!body.title || !body.period || !body.details) return setErr(L("required"));
        if (editingId) {
          await api(`/api/officer-reports/${encodeURIComponent(editingId)}`, { method: "PUT", body: JSON.stringify(body) });
        } else {
          await api("/api/officer-reports", { method: "POST", body: JSON.stringify(body) });
        }
        editingId = null;
        clearForm();
      } else if (act === "fb") {
        if (!text) return setErr(L("needsText"));
        await api(`/api/officer-reports/${encodeURIComponent(id)}/feedback`, { method: "POST", body: JSON.stringify({ text }) });
      } else if (act === "approve" || act === "return") {
        if (act === "return" && !text) return setErr(L("needsReason"));
        await api(`/api/officer-reports/${encodeURIComponent(id)}/decision`, {
          method: "POST", body: JSON.stringify({ status: act === "approve" ? "Approved" : "Returned", text })
        });
      } else if (act === "resubmit") {
        await api(`/api/officer-reports/${encodeURIComponent(id)}/resubmit`, { method: "POST", body: "{}" });
      }
      await load();
    } catch (err) {
      setErr(err.message);
    } finally {
      busy = false;
      b.disabled = false; // harmless if the button was replaced by a re-render
    }
  }

  // The page signs users in and out on its own, so check its state regularly.
  function tick() {
    const u = getMe();
    if (allowed(u)) {
      build();
      btn.classList.remove("hidden");
      if (u.email !== lastEmail) {
        lastEmail = u.email; reports = []; editingId = null;
        panel.classList.add("hidden"); btn.classList.remove("active");
      }
      const cl = curLang();
      if (cl !== lastLang) { lastLang = cl; btn.textContent = L("tab"); if (!panel.classList.contains("hidden")) render(); }
    } else if (btn) {
      lastEmail = null;
      editingId = null;
      btn.classList.add("hidden");
      panel.classList.add("hidden");
    }
  }
  setInterval(tick, 600);
  tick();
})();
