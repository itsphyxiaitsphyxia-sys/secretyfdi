const $ = (s) => document.querySelector(s);

const API = ""; // same origin (server serves client)
let token = localStorage.getItem("token") || "";
let me = null;
let users = [];
let activeUserId = null;
let socket = null;
let activeNoteId = null;

function setScreen(id) {
  for (const el of document.querySelectorAll(".screen")) el.dataset.visible = "false";
  $(id).dataset.visible = "true";
}

function randHex(n){
  const chars="0123456789ABCDEF";
  let out="";
  for(let i=0;i<n;i++) out += chars[(Math.random()*chars.length)|0];
  return out;
}
$("#hud-session").textContent = `${randHex(4)}-${randHex(4)}-${randHex(4)}`;

function fmtTime(ts){
  const d = new Date(ts);
  return d.toLocaleTimeString("fr-FR", { hour12:false });
}

function escapeHtml(s){
  return s.replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API + path, { ...opts, headers });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    throw new Error(json?.error || `Erreur API (${res.status})`);
  }
  return json;
}

/* -------- Loading animation then login/app -------- */
const phases = [
  { at: 6,  status: "DÉMARRAGE",     trace: "/boot/secure/handshake" },
  { at: 18, status: "NÉGOCIATION",   trace: "/net/tunnel/etablissement" },
  { at: 40, status: "DÉCHIFFREMENT", trace: "/db/crypto/dechiffrement" },
  { at: 62, status: "VÉRIFICATION",  trace: "/db/checksum/verification" },
  { at: 82, status: "FINALISATION",  trace: "/ui/preparation/connexion" },
  { at: 100,status: "PRÊT",          trace: "/ui/connexion" },
];

function repeatLog(base){
  const chunk = ` ${base} :: ${randHex(8)} :: ${randHex(8)} :: `;
  return (chunk.repeat(10)).trim();
}
$("#load-log").textContent = repeatLog("INTÉGRITÉ OK / ÉCHANGE CLÉS / SYNCHRO / AUDIT");

let p = 0;
const t = setInterval(async () => {
  p += 1 + (Math.random()*3|0);
  if (p > 100) p = 100;

  $("#load-fill").style.width = `${p}%`;
  $("#load-pct").textContent = `${p}`;

  const ph = [...phases].reverse().find(x => p >= x.at);
  if (ph) {
    $("#load-state").textContent = ph.status;
    $("#load-trace").textContent = ph.trace;
  }

  if (p === 100) {
    clearInterval(t);
    setTimeout(async () => {
      // attempt restore session
      try {
        if (token) {
          me = await api("/api/me");
          await bootApp();
          setScreen("#screen-app");
        } else {
          setScreen("#screen-login");
        }
      } catch {
        token = "";
        localStorage.removeItem("token");
        setScreen("#screen-login");
      }
    }, 450);
  }
}, 70);

/* -------- Time + Geo HUD -------- */
function startClock() {
  const tick = () => {
    const s = new Date().toLocaleTimeString("fr-FR", { hour12:false });
    $("#hud-time") && ($("#hud-time").textContent = s);
    $("#app-time") && ($("#app-time").textContent = s);
  };
  tick();
  setInterval(tick, 500);
}

async function setGeoHud() {
  // IP-based (server side)
  try {
    const r = await fetch("/api/geo");
    const j = await r.json();
    const label = j?.geo
      ? `${j.geo.city || "Ville inconnue"}${j.geo.region ? ", " + j.geo.region : ""}${j.geo.country ? " ("+j.geo.country+")" : ""}`
      : "Localisation (IP) indisponible";
    $("#hud-city") && ($("#hud-city").textContent = label);
    $("#app-city") && ($("#app-city").textContent = label);
  } catch {}

  // Fallback browser geo (if user accepts)
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try {
        const { latitude, longitude } = pos.coords;
        // reverse lookup via a free endpoint (best-effort)
        const rr = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${latitude}&lon=${longitude}`);
        const jj = await rr.json();
        const city = jj?.address?.city || jj?.address?.town || jj?.address?.village || "Ville";
        const country = jj?.address?.country || "";
        const label = `${city}${country ? " ("+country+")" : ""}`;
        $("#hud-city") && ($("#hud-city").textContent = label);
        $("#app-city") && ($("#app-city").textContent = label);
      } catch {}
    }, () => {}, { enableHighAccuracy:false, timeout:2500 });
  }
}

startClock();
setGeoHud();

/* -------- Login -------- */
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#login-error").textContent = "";

  const fd = new FormData(e.currentTarget);
  const username = (fd.get("username") || "").toString().trim();
  const password = (fd.get("password") || "").toString();

  try {
    const r = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password })
    });
    token = r.token;
    localStorage.setItem("token", token);
    me = r.user;
    await bootApp();
    setScreen("#screen-app");
  } catch (err) {
    $("#login-error").textContent = err.message;
  }
});

$("#btn-logout").addEventListener("click", () => {
  token = "";
  localStorage.removeItem("token");
  if (socket) socket.disconnect();
  socket = null;
  me = null;
  activeUserId = null;
  setScreen("#screen-login");
});

/* -------- App boot -------- */
async function bootApp() {
  // me
  me = await api("/api/me");
  $("#me-line").textContent = `SESSION: ${me.username} // ID: ${me.id.slice(0, 10)}…`;
  $("#me-name").textContent = me.displayName;
  $("#me-user").textContent = me.username;
  $("#me-avatar").src = me.avatarUrl || defaultAvatar();

  // fill profile inputs
  $("#pf-display").value = me.displayName || "";
  $("#pf-username").value = me.username || "";

  // users
  users = await api("/api/users");
  renderUsers();

  // tabs
  for (const btn of document.querySelectorAll(".tab")) {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const tab = btn.dataset.tab;
      showPane(tab);
    });
  }

  // socket
  connectSocket();

  // files & notes initial load
  await refreshFiles();
  await refreshNotes();
}

function defaultAvatar() {
  // inline SVG
  const svg = encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="80" height="80">
      <rect width="100%" height="100%" fill="#06110f"/>
      <text x="50%" y="54%" text-anchor="middle" fill="#7fffe0" font-family="monospace" font-size="14">AGENT</text>
    </svg>`);
  return `data:image/svg+xml,${svg}`;
}

function showPane(tab) {
  const map = { chat: "#pane-chat", files: "#pane-files", notes: "#pane-notes" };
  for (const k of Object.keys(map)) $(map[k]).dataset.visible = "false";
  $(map[tab]).dataset.visible = "true";
}

/* -------- Users sidebar -------- */
function renderUsers() {
  const root = $("#users-list");
  root.innerHTML = "";
  for (const u of users) {
    if (u.id === me.id) continue;
    const el = document.createElement("div");
    el.className = "user" + (u.id === activeUserId ? " active" : "");
    el.innerHTML = `
      <img class="uavatar" src="${u.avatarUrl || defaultAvatar()}" alt="avatar">
      <div>
        <div class="uname">${escapeHtml(u.displayName)}</div>
        <div class="uuser dim">${escapeHtml(u.username)}</div>
      </div>
    `;
    el.addEventListener("click", async () => {
      activeUserId = u.id;
      renderUsers();
      $("#chat-with").textContent = `Avec: ${u.displayName} (${u.username})`;
      await loadMessages(activeUserId);
    });
    root.appendChild(el);
  }
}

/* -------- Chat -------- */
async function loadMessages(otherId) {
  const r = await api(`/api/conversations/${otherId}/messages`);
  const msgs = r.messages || [];
  renderMessages(msgs);
}

function renderMessages(msgs) {
  const root = $("#messages");
  root.innerHTML = "";
  for (const m of msgs) {
    const el = document.createElement("div");
    el.className = "msg" + (m.sender_id === me.id ? " me" : "");
    const from = m.sender_id === me.id ? "MOI" : "AGENT";
    el.innerHTML = `
      <div class="meta">
        <span>${from}</span>
        <span>${fmtTime(m.created_at)}</span>
      </div>
      <div class="body">${escapeHtml(m.body || "")}</div>
    `;
    root.appendChild(el);
  }
  root.scrollTop = root.scrollHeight;
}

$("#composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!activeUserId) return;

  const input = $("#msg-input");
  const text = input.value.trim();
  if (!text) return;

  socket.emit("dm:send", { toUserId: activeUserId, text }, (ack) => {
    if (!ack?.ok) console.error(ack?.error);
  });

  input.value = "";
});

function connectSocket() {
  if (socket) socket.disconnect();
  socket = io({ auth: { token } });

  socket.on("connect_error", () => {
    // token maybe expired
  });

  socket.on("dm:new", async (msg) => {
    // if current chat matches convo participant, reload messages
    if (!activeUserId) return;

    // naive approach: reload thread from API
    // (simple and reliable for demo; can be optimized)
    await loadMessages(activeUserId);
  });
}

/* -------- Profile update -------- */
$("#btn-save-profile").addEventListener("click", async () => {
  $("#profile-msg").textContent = "";
  try {
    const displayName = $("#pf-display").value.trim();
    const username = $("#pf-username").value.trim();
    const password = $("#pf-password").value;

    await api("/api/me/profile", {
      method: "POST",
      body: JSON.stringify({ displayName, username, password })
    });

    // avatar optional
    const file = $("#pf-avatar").files?.[0];
    if (file) {
      const b64 = await fileToB64(file);
      await api("/api/me/avatar", {
        method: "POST",
        body: JSON.stringify({ filename: file.name, mime: file.type || "application/octet-stream", b64 })
      });
    }

    // refresh me & users
    me = await api("/api/me");
    $("#me-name").textContent = me.displayName;
    $("#me-user").textContent = me.username;
    $("#me-avatar").src = me.avatarUrl || defaultAvatar();

    users = await api("/api/users");
    renderUsers();

    $("#pf-password").value = "";
    $("#profile-msg").textContent = "PROFIL MIS À JOUR.";
  } catch (e) {
    $("#profile-msg").textContent = e.message;
  }
});

/* -------- Files -------- */
async function refreshFiles() {
  try {
    const rows = await api("/api/files/my");
    const root = $("#files-list");
    root.innerHTML = "";
    for (const f of rows) {
      const el = document.createElement("div");
      el.className = "fileRow";
      el.innerHTML = `
        <div>
          <div class="fn">${escapeHtml(f.original_name)}</div>
          <div class="fm dim">${escapeHtml(f.mime)} • ${Math.round(f.size_bytes/1024)}KB • ${new Date(f.created_at).toLocaleString("fr-FR")}</div>
        </div>
        <a class="btn" href="/api/files/${f.id}/download" target="_blank" rel="noopener">TÉLÉCHARGER</a>
      `;
      root.appendChild(el);
    }
  } catch (e) {
    $("#file-msg").textContent = e.message;
  }
}

$("#btn-upload").addEventListener("click", async () => {
  $("#file-msg").textContent = "";
  const file = $("#file-pick").files?.[0];
  if (!file) return;

  try {
    const b64 = await fileToB64(file);
    await api("/api/files/upload", {
      method: "POST",
      body: JSON.stringify({
        filename: file.name,
        mime: file.type || "application/octet-stream",
        b64
      })
    });
    $("#file-pick").value = "";
    $("#file-msg").textContent = "FICHIER CHIFFRÉ ET STOCKÉ.";
    await refreshFiles();
  } catch (e) {
    $("#file-msg").textContent = e.message;
  }
});

function fileToB64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result || "");
      const idx = s.indexOf("base64,");
      if (idx === -1) return reject(new Error("Conversion base64 échouée"));
      resolve(s.slice(idx + 7));
    };
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

/* -------- Notes -------- */
async function refreshNotes() {
  const rows = await api("/api/notes");
  const root = $("#note-list");
  root.innerHTML = "";
  for (const n of rows) {
    const el = document.createElement("div");
    el.className = "noteItem" + (n.id === activeNoteId ? " active" : "");
    el.innerHTML = `
      <div class="t">${escapeHtml(n.title)}</div>
      <div class="d dim">MAJ: ${new Date(n.updated_at).toLocaleString("fr-FR")}</div>
    `;
    el.addEventListener("click", () => {
      activeNoteId = n.id;
      $("#note-title").value = n.title;
      $("#note-content").value = n.content;
      refreshNotes();
    });
    root.appendChild(el);
  }

  if (!activeNoteId && rows[0]) {
    activeNoteId = rows[0].id;
    $("#note-title").value = rows[0].title;
    $("#note-content").value = rows[0].content;
    refreshNotes();
  }
}

$("#btn-new-note").addEventListener("click", async () => {
  $("#note-msg").textContent = "";
  const created = await api("/api/notes", {
    method: "POST",
    body: JSON.stringify({ title: "NOUVELLE NOTE", content: "" })
  });
  activeNoteId = created.id;
  await refreshNotes();
  $("#note-msg").textContent = "NOTE CRÉÉE.";
});

$("#btn-save-note").addEventListener("click", async () => {
  $("#note-msg").textContent = "";
  if (!activeNoteId) return;
  try {
    await api(`/api/notes/${activeNoteId}`, {
      method: "PUT",
      body: JSON.stringify({ title: $("#note-title").value, content: $("#note-content").value })
    });
    $("#note-msg").textContent = "ENREGISTRÉ.";
    await refreshNotes();
  } catch (e) {
    $("#note-msg").textContent = e.message;
  }
});

$("#btn-delete-note").addEventListener("click", async () => {
  $("#note-msg").textContent = "";
  if (!activeNoteId) return;
  if (!confirm("Supprimer cette note ?")) return;
  await api(`/api/notes/${activeNoteId}`, { method: "DELETE" });
  activeNoteId = null;
  $("#note-title").value = "";
  $("#note-content").value = "";
  $("#note-msg").textContent = "SUPPRIMÉE.";
  await refreshNotes();
});