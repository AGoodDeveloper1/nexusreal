// ═══════════════════════════════════════════════════════════
//  NEXUS — app.js
// ═══════════════════════════════════════════════════════════
let currentUser = null;
let currentChat = null;
let contacts    = [];
let socket      = null;
let lastMessages = {};
let liveEditActive = false;

const THEMES = [
  { name:'Violet', accent:'#7c5cfc', accent2:'#a48bff', glow:'rgba(124,92,252,0.3)', sent:'linear-gradient(135deg,#5540d4,#7c5cfc)' },
  { name:'Blue',   accent:'#3b82f6', accent2:'#60a5fa', glow:'rgba(59,130,246,0.3)',  sent:'linear-gradient(135deg,#1d4ed8,#3b82f6)' },
  { name:'Teal',   accent:'#14b8a6', accent2:'#2dd4bf', glow:'rgba(20,184,166,0.3)',  sent:'linear-gradient(135deg,#0d9488,#14b8a6)' },
  { name:'Rose',   accent:'#f43f5e', accent2:'#fb7185', glow:'rgba(244,63,94,0.3)',   sent:'linear-gradient(135deg,#e11d48,#f43f5e)' },
  { name:'Amber',  accent:'#f59e0b', accent2:'#fbbf24', glow:'rgba(245,158,11,0.3)',  sent:'linear-gradient(135deg,#d97706,#f59e0b)' },
  { name:'Green',  accent:'#22c55e', accent2:'#4ade80', glow:'rgba(34,197,94,0.3)',   sent:'linear-gradient(135deg,#16a34a,#22c55e)' },
  { name:'Pink',   accent:'#ec4899', accent2:'#f472b6', glow:'rgba(236,72,153,0.3)',  sent:'linear-gradient(135deg,#db2777,#ec4899)' },
];

// ── Bootstrap ───────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  initTheme();
  initThemeSwatches();
  const saved = localStorage.getItem("nexus_user");
  if (saved) {
    try { currentUser = JSON.parse(saved); launchApp(); }
    catch { localStorage.removeItem("nexus_user"); }
  }
});

// ═══════════════════════════════════════════════════════════
//  AUTH
// ═══════════════════════════════════════════════════════════
function authTab(tab) {
  document.getElementById("form-login").classList.toggle("hidden", tab !== "login");
  document.getElementById("form-register").classList.toggle("hidden", tab !== "register");
  document.querySelectorAll(".auth-tab").forEach((t,i) =>
    t.classList.toggle("active", i===0 ? tab==="login" : tab==="register"));
}

async function doLogin() {
  const username = val("l-user"), password = val("l-pass");
  const msgEl = document.getElementById("login-msg");
  if (!username) return showMsg(msgEl,"err","Enter your username.");
  showMsg(msgEl,"","Signing in…");
  try {
    const data = await post("/api/login", { username, password });
    if (data.success) {
      currentUser = data.user;
      localStorage.setItem("nexus_user", JSON.stringify(currentUser));
      launchApp();
    } else {
      showMsg(msgEl,"err", data.message || "Login failed.");
    }
  } catch { showMsg(msgEl,"err","Server unreachable. Is the server running?"); }
}

async function doRegister() {
  const display_name = val("r-name"), username = val("r-user"), password = val("r-pass");
  const msgEl = document.getElementById("register-msg");
  if (!display_name||!username||!password) return showMsg(msgEl,"err","All fields are required.");
  showMsg(msgEl,"","Creating account…");
  try {
    const data = await post("/api/register", { display_name, username, password });
    if (data.success) {
      window._nexusTutorialPending = true;
      showMsg(msgEl,"ok",`✓ Done! Your number:\n${data.phone_number}\n\nNow sign in.`);
      setTimeout(() => authTab("login"), 2800);
    } else {
      showMsg(msgEl,"err", data.message);
    }
  } catch { showMsg(msgEl,"err","Server unreachable. Is the server running?"); }
}

function logout() {
  localStorage.removeItem("nexus_user");
  currentUser = null; currentChat = null; contacts = [];
  if (socket) socket.disconnect();
  document.getElementById("app").classList.add("hidden");
  document.getElementById("auth-screen").style.display = "none";
  document.getElementById("auth-screen").classList.add("hidden");
  document.getElementById("landing").classList.remove("hidden");
  document.getElementById("l-user").value = "";
  document.getElementById("l-pass").value = "";
  closeAll();
}

// ═══════════════════════════════════════════════════════════
//  APP LAUNCH
// ═══════════════════════════════════════════════════════════
async function launchApp() {
  document.getElementById("auth-screen").style.display = "none";
  document.getElementById("app").classList.remove("hidden");
  refreshMeHeader();
  // Show dev mode button for admins
  if (currentUser.role === "admin") {
    document.getElementById("dev-mode-btn").classList.remove("hidden");
  }
  await loadContacts();
  connectSocket();
  if (window._nexusTutorialPending) {
    window._nexusTutorialPending = false;
    setTimeout(startTutorial, 600);
  }
}

function refreshMeHeader() {
  setAvatar("me-avatar", currentUser.avatar, currentUser.display_name, "sm");
  setText("me-name", currentUser.display_name);
  setText("me-phone", currentUser.phone_number);
}

// ═══════════════════════════════════════════════════════════
//  CONTACTS
// ═══════════════════════════════════════════════════════════
async function loadContacts() {
  try {
    contacts = await get(`/api/contacts/${currentUser.id}`);
    await loadLastMessages();
    renderContacts(contacts);
  } catch(e) { console.error("loadContacts:", e); }
}

async function loadLastMessages() {
  try {
    const rows = await get(`/api/lastmessages/${currentUser.id}`);
    lastMessages = {};
    rows.forEach(r => {
      const otherId = r.sender_id === currentUser.id ? r.receiver_id : r.sender_id;
      lastMessages[otherId] = r;
    });
  } catch{}
}

function renderContacts(list) {
  const el = document.getElementById("contacts-list");
  if (!list.length) {
    el.innerHTML = `<div class="empty-contacts">No contacts yet.<br/>Hit <b>Add Contact</b> below ↓</div>`;
    return;
  }
  // Sort by last message time, most recent first
  const sorted = [...list].sort((a,b) => {
    const ta = lastMessages[a.id]?.sent_at || "0";
    const tb = lastMessages[b.id]?.sent_at || "0";
    return tb.localeCompare(ta);
  });
  el.innerHTML = sorted.map(c => {
    const lm = lastMessages[c.id];
    const preview = lm ? escHtml(lm.content).slice(0,38) : "<em style='opacity:.5'>No messages yet</em>";
    const timeStr = lm ? fmtTime(lm.sent_at) : "";
    const isActive = currentChat?.id === c.id ? " active" : "";
    return `
      <div class="contact-item${isActive}" onclick="openChat(${c.id})" id="ci-${c.id}">
        <div class="avatar sm" id="ci-av-${c.id}" ${c.avatar ? `style="background-image:url('${c.avatar}');background-size:cover;background-position:center;font-size:0"` : `style="background:${avatarColor(c.display_name)}"`}>${c.avatar?"":initials(c.display_name)}</div>
        <div class="ci-info">
          <div class="ci-name">${escHtml(c.display_name)}</div>
          <div class="ci-last">${preview}</div>
        </div>
        <div class="ci-time">${timeStr}</div>
      </div>`;
  }).join("");
}

function filterContacts(q) {
  const filtered = contacts.filter(c =>
    c.display_name.toLowerCase().includes(q.toLowerCase()) || c.phone_number.includes(q));
  renderContacts(filtered);
}

// ═══════════════════════════════════════════════════════════
//  CHAT
// ═══════════════════════════════════════════════════════════
async function openChat(contactId) {
  currentChat = contacts.find(c => c.id === contactId);
  if (!currentChat) return;

  document.querySelectorAll(".contact-item").forEach(el => el.classList.remove("active"));
  const ci = document.getElementById(`ci-${contactId}`);
  if (ci) ci.classList.add("active");

  setAvatar("ch-avatar", currentChat.avatar, currentChat.display_name, "");
  setText("ch-name", currentChat.display_name);
  setText("ch-phone", currentChat.status || currentChat.phone_number);

  document.getElementById("chat-empty").classList.add("hidden");
  document.getElementById("chat-view").classList.remove("hidden");

  await loadMessages(contactId);
  document.getElementById("msg-input").focus();
}

async function loadMessages(contactId) {
  try {
    const msgs = await get(`/api/messages/${currentUser.id}/${contactId}`);
    renderMessages(msgs);
  } catch(e) { console.error("loadMessages:", e); }
}

function renderMessages(msgs) {
  const container = document.getElementById("messages-container");
  if (!msgs.length) {
    container.innerHTML = `<div style="text-align:center;color:var(--text-muted);font-size:13px;margin-top:40px">No messages yet. Say hi! 👋</div>`;
    return;
  }
  let lastDate = "";
  container.innerHTML = msgs.map(m => {
    const sent = m.sender_id === currentUser.id;
    const dateStr = fmtDate(m.sent_at);
    let divider = "";
    if (dateStr !== lastDate) {
      divider = `<div class="msg-date-divider">${dateStr}</div>`;
      lastDate = dateStr;
    }
    return `${divider}<div class="msg-bubble ${sent?"sent":"recv"}">${escHtml(m.content)}<div class="msg-time">${fmtTimeFull(m.sent_at)}</div></div>`;
  }).join("");
  scrollToBottom();
}

function appendMessage(msg) {
  const container = document.getElementById("messages-container");
  const placeholder = container.querySelector("div[style]");
  if (placeholder) placeholder.remove();
  const sent = msg.sender_id === currentUser.id;
  const div = document.createElement("div");
  div.className = `msg-bubble ${sent?"sent":"recv"}`;
  div.innerHTML = `${escHtml(msg.content)}<div class="msg-time">${fmtTimeFull(msg.sent_at)}</div>`;
  container.appendChild(div);
  scrollToBottom();
}

function scrollToBottom() {
  const c = document.getElementById("messages-container");
  c.scrollTop = c.scrollHeight;
}

function sendMessage() {
  const input = document.getElementById("msg-input");
  const content = input.value.trim();
  if (!content || !currentChat) return;
  input.value = "";
  // Try socket first, fall back to REST
  if (socket && socket.connected) {
    socket.emit("send_message", { sender_id: currentUser.id, receiver_id: currentChat.id, content });
  } else {
    // REST fallback
    post("/api/messages/send", { sender_id: currentUser.id, receiver_id: currentChat.id, content })
      .then(data => {
        if (data.success) {
          const msg = { id: data.id, sender_id: currentUser.id, receiver_id: currentChat.id, content, sent_at: data.sent_at };
          appendMessage(msg);
          updateContactPreview(msg);
        }
      });
  }
  input.focus();
}

function msgKeydown(e) {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
}

// ═══════════════════════════════════════════════════════════
//  SOCKET
// ═══════════════════════════════════════════════════════════
function connectSocket() {
  socket = io({ reconnection: true, reconnectionAttempts: 10, reconnectionDelay: 1500 });

  socket.on("connect", () => {
    socket.emit("user_online", currentUser.id);
  });

  socket.on("message_sent", (msg) => {
    if (currentChat && msg.receiver_id === currentChat.id) appendMessage(msg);
    updateContactPreview(msg);
  });

  socket.on("receive_message", (msg) => {
    if (currentChat && msg.sender_id === currentChat.id) appendMessage(msg);
    updateContactPreview(msg);
    // If sender is not in contacts yet, reload contacts
    if (!contacts.find(c => c.id === msg.sender_id)) loadContacts();
  });

  // Fired when someone adds us as a contact
  socket.on("contact_added", (newContact) => {
    if (!contacts.find(c => c.id === newContact.id)) {
      contacts.push(newContact);
      renderContacts(contacts);
    }
  });
}

function updateContactPreview(msg) {
  const otherId = msg.sender_id === currentUser.id ? msg.receiver_id : msg.sender_id;
  lastMessages[otherId] = msg;
  renderContacts(contacts);
  if (currentChat) {
    const ci = document.getElementById(`ci-${currentChat.id}`);
    if (ci) ci.classList.add("active");
  }
}

// ═══════════════════════════════════════════════════════════
//  ADD CONTACT
// ═══════════════════════════════════════════════════════════
function openAddPanel() {
  document.getElementById("add-panel").classList.remove("hidden");
  requestAnimationFrame(() => document.getElementById("add-panel").classList.add("open"));
  document.getElementById("overlay").classList.remove("hidden");
  document.getElementById("add-msg").textContent = "";
  document.getElementById("add-phone-input").value = "";
  setTimeout(() => document.getElementById("add-phone-input").focus(), 300);
}

function closeAddPanel() {
  document.getElementById("add-panel").classList.remove("open");
  setTimeout(() => document.getElementById("add-panel").classList.add("hidden"), 300);
  document.getElementById("overlay").classList.add("hidden");
}

function formatPhoneInput(input) {
  input.value = input.value.replace(/[^\d\s]/g,"");
}

async function doAddContact() {
  const raw = document.getElementById("add-phone-input").value.trim();
  const msgEl = document.getElementById("add-msg");
  if (!raw) return showMsg(msgEl,"err","Enter a phone number.");
  const phone_number = "+67 " + raw;
  try {
    const data = await post("/api/contacts/add", { user_id: currentUser.id, phone_number });
    if (data.success) {
      showMsg(msgEl,"ok",`✓ ${data.contact.display_name} added!`);
      if (!contacts.find(c => c.id === data.contact.id)) contacts.push(data.contact);
      renderContacts(contacts);
      setTimeout(closeAddPanel, 1400);
    } else {
      showMsg(msgEl,"err", data.message);
    }
  } catch { showMsg(msgEl,"err","Server error."); }
}

// ═══════════════════════════════════════════════════════════
//  SETTINGS
// ═══════════════════════════════════════════════════════════
async function openSettings() {
  const u = currentUser;
  document.getElementById("settings-name").value = u.display_name;
  document.getElementById("settings-status").value = u.status || "";
  document.getElementById("pw-old").value = "";
  document.getElementById("pw-new").value = "";
  setText("settings-phone", u.phone_number);
  setText("ai-username", u.username);
  setText("ai-since", fmtDate(u.created_at));
  setAvatar("settings-avatar", u.avatar, u.display_name, "lg");
  document.getElementById("settings-msg").textContent = "";
  // Load message count async
  try {
    const d = await get(`/api/msgcount/${u.id}`);
    setText("ai-msgcount", d.count);
  } catch { setText("ai-msgcount","—"); }
  document.getElementById("settings-panel").classList.remove("hidden");
  requestAnimationFrame(() => document.getElementById("settings-panel").classList.add("open"));
  document.getElementById("overlay").classList.remove("hidden");
}

function closeSettings() {
  document.getElementById("settings-panel").classList.remove("open");
  setTimeout(() => document.getElementById("settings-panel").classList.add("hidden"), 300);
  document.getElementById("overlay").classList.add("hidden");
}

async function saveName() {
  const name = document.getElementById("settings-name").value.trim();
  const msgEl = document.getElementById("settings-msg");
  if (!name) return showMsg(msgEl,"err","Name can't be empty.");
  try {
    const data = await post("/api/settings/name", { user_id: currentUser.id, display_name: name });
    if (data.success) {
      currentUser.display_name = name;
      localStorage.setItem("nexus_user", JSON.stringify(currentUser));
      refreshMeHeader(); renderContacts(contacts);
      showMsg(msgEl,"ok","✓ Name updated.");
    } else showMsg(msgEl,"err", data.message);
  } catch { showMsg(msgEl,"err","Error."); }
}

async function saveStatus() {
  const status = document.getElementById("settings-status").value.trim();
  const msgEl = document.getElementById("settings-msg");
  try {
    const data = await post("/api/settings/status", { user_id: currentUser.id, status });
    if (data.success) {
      currentUser.status = status || null;
      localStorage.setItem("nexus_user", JSON.stringify(currentUser));
      showMsg(msgEl,"ok","✓ Status updated.");
    } else showMsg(msgEl,"err", data.message);
  } catch { showMsg(msgEl,"err","Error."); }
}

async function changePassword() {
  const old_password = document.getElementById("pw-old").value;
  const new_password = document.getElementById("pw-new").value;
  const msgEl = document.getElementById("settings-msg");
  if (!old_password||!new_password) return showMsg(msgEl,"err","Fill both password fields.");
  try {
    const data = await post("/api/settings/password", { user_id: currentUser.id, old_password, new_password });
    if (data.success) {
      document.getElementById("pw-old").value = "";
      document.getElementById("pw-new").value = "";
      showMsg(msgEl,"ok","✓ Password changed.");
    } else showMsg(msgEl,"err", data.message);
  } catch { showMsg(msgEl,"err","Error."); }
}

function uploadAvatar(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (e) => {
    const avatar = e.target.result;
    try {
      const data = await post("/api/settings/avatar", { user_id: currentUser.id, avatar });
      if (data.success) {
        currentUser.avatar = avatar;
        localStorage.setItem("nexus_user", JSON.stringify(currentUser));
        refreshMeHeader();
        setAvatar("settings-avatar", avatar, currentUser.display_name, "lg");
        showMsg(document.getElementById("settings-msg"),"ok","✓ Photo updated.");
      }
    } catch { showMsg(document.getElementById("settings-msg"),"err","Upload failed."); }
  };
  reader.readAsDataURL(file);
}

function copyPhone() {
  navigator.clipboard.writeText(currentUser.phone_number).then(() => {
    showMsg(document.getElementById("settings-msg"),"ok","✓ Number copied to clipboard.");
  });
}

// ── Theme ───────────────────────────────────────────────────
function initThemeSwatches() {
  const container = document.getElementById("theme-swatches");
  if (!container) return;
  const saved = localStorage.getItem("nexus_theme") || "Violet";
  THEMES.forEach(t => {
    const sw = document.createElement("div");
    sw.className = "theme-swatch" + (t.name === saved ? " active" : "");
    sw.style.background = t.accent;
    sw.title = t.name;
    sw.onclick = () => {
      document.querySelectorAll(".theme-swatch").forEach(s => s.classList.remove("active"));
      sw.classList.add("active");
      applyTheme(t);
      localStorage.setItem("nexus_theme", t.name);
    };
    container.appendChild(sw);
  });
}

function initTheme() {
  const name = localStorage.getItem("nexus_theme") || "Violet";
  const t = THEMES.find(x => x.name === name) || THEMES[0];
  applyTheme(t);
}

function applyTheme(t) {
  const r = document.documentElement.style;
  r.setProperty("--accent", t.accent);
  r.setProperty("--accent-2", t.accent2);
  r.setProperty("--accent-glow", t.glow);
  r.setProperty("--sent-bg", t.sent);
}

// ═══════════════════════════════════════════════════════════
//  DELETE ACCOUNT
// ═══════════════════════════════════════════════════════════
function openDeleteConfirm() {
  document.getElementById("delete-confirm-input").value = "";
  document.getElementById("delete-msg").textContent = "";
  document.getElementById("delete-modal").classList.remove("hidden");
}
function closeDeleteConfirm() {
  document.getElementById("delete-modal").classList.add("hidden");
}
async function confirmDeleteAccount() {
  const username_confirm = document.getElementById("delete-confirm-input").value.trim();
  const msgEl = document.getElementById("delete-msg");
  if (!username_confirm) return showMsg(msgEl,"err","Type your username.");
  try {
    const res = await fetch(`/api/user/${currentUser.id}`, {
      method: "DELETE",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({ username_confirm })
    });
    const data = await res.json();
    if (data.success) {
      closeDeleteConfirm();
      logout();
    } else {
      showMsg(msgEl,"err", data.message);
    }
  } catch { showMsg(msgEl,"err","Server error."); }
}

// ═══════════════════════════════════════════════════════════
//  CREDITS
// ═══════════════════════════════════════════════════════════
function openCredits() {
  document.getElementById("credits-modal").classList.remove("hidden");
}
function closeCredits() {
  document.getElementById("credits-modal").classList.add("hidden");
}

// ═══════════════════════════════════════════════════════════
//  DEV MODE (admin only)
// ═══════════════════════════════════════════════════════════
function openDevPanel() {
  document.getElementById("dev-panel").classList.remove("hidden");
  loadDevUsers();
}
function closeDevPanel() {
  document.getElementById("dev-panel").classList.add("hidden");
  disableLiveEdit();
}

function devTab(name, btn) {
  ["users","css","edit","stats"].forEach(t => {
    document.getElementById(`dev-tab-${t}`).classList.toggle("hidden", t !== name);
  });
  document.querySelectorAll(".dev-tab").forEach(b => b.classList.remove("active"));
  if (btn) btn.classList.add("active");
  if (name === "stats") loadDevStats();
}

async function loadDevUsers() {
  const container = document.getElementById("dev-users-table");
  container.innerHTML = `<div style="color:#4a5568;font-family:monospace;font-size:13px">Loading…</div>`;
  try {
    const users = await get("/api/admin/users");
    if (!users.length) { container.innerHTML = `<div style="color:#4a5568">No users yet.</div>`; return; }
    container.innerHTML = `
      <table class="users-table">
        <thead><tr>
          <th>ID</th><th>Username</th><th>Password</th>
          <th>Display Name</th><th>Phone</th><th>Role</th><th>Joined</th>
        </tr></thead>
        <tbody>
          ${users.map(u => `<tr>
            <td>${u.id}</td>
            <td>${escHtml(u.username)}</td>
            <td class="pw-cell">${escHtml(u.password)}</td>
            <td>${escHtml(u.display_name)}</td>
            <td>${escHtml(u.phone_number)}</td>
            <td><span class="role-badge ${u.role}">${u.role}</span></td>
            <td>${fmtDate(u.created_at)}</td>
          </tr>`).join("")}
        </tbody>
      </table>`;
  } catch { container.innerHTML = `<div style="color:var(--danger)">Failed to load users.</div>`; }
}

// CSS injector
let injectedStyle = null;
function injectCSS(css) {
  if (!injectedStyle) {
    injectedStyle = document.createElement("style");
    injectedStyle.id = "dev-injected";
    document.head.appendChild(injectedStyle);
  }
  injectedStyle.textContent = css;
}
function clearCSS() {
  if (injectedStyle) injectedStyle.textContent = "";
  document.getElementById("css-injector").value = "";
}

const PRESETS = {
  red:   `:root{--accent:#ef4444;--accent-2:#f87171;--accent-glow:rgba(239,68,68,.3);--sent-bg:linear-gradient(135deg,#b91c1c,#ef4444)}`,
  blue:  `:root{--accent:#3b82f6;--accent-2:#60a5fa;--accent-glow:rgba(59,130,246,.3);--sent-bg:linear-gradient(135deg,#1d4ed8,#3b82f6)}`,
  green: `:root{--accent:#22c55e;--accent-2:#4ade80;--accent-glow:rgba(34,197,94,.3);--sent-bg:linear-gradient(135deg,#16a34a,#22c55e)}`,
  gold:  `:root{--accent:#f59e0b;--accent-2:#fbbf24;--accent-glow:rgba(245,158,11,.3);--sent-bg:linear-gradient(135deg,#b45309,#f59e0b)}`,
  pink:  `:root{--accent:#ec4899;--accent-2:#f472b6;--accent-glow:rgba(236,72,153,.3);--sent-bg:linear-gradient(135deg,#be185d,#ec4899)}`,
};
function applyPreset(name) {
  const css = PRESETS[name] || "";
  document.getElementById("css-injector").value = css;
  injectCSS(css);
}

// Live edit toggle
function toggleLiveEdit() {
  liveEditActive ? disableLiveEdit() : enableLiveEdit();
}
function enableLiveEdit() {
  liveEditActive = true;
  document.querySelectorAll("#app .ci-name,.ci-last,.app-brand,.brand-n,.brand-exus,.ch-name,.ch-sub,.me-name,.credits-title,.sidebar-btn,.btn-primary").forEach(el => {
    el.contentEditable = "true";
    el.style.outline = "1px dashed rgba(57,255,20,.4)";
    el.style.borderRadius = "3px";
  });
  const btn = document.getElementById("live-edit-btn");
  btn.classList.add("active");
  btn.textContent = "✏️ Disable Live Edit";
  setText("live-edit-status","Active — click any text to edit");
}
function disableLiveEdit() {
  liveEditActive = false;
  document.querySelectorAll("[contenteditable='true']").forEach(el => {
    el.contentEditable = "false";
    el.style.outline = "";
    el.style.borderRadius = "";
  });
  const btn = document.getElementById("live-edit-btn");
  if (btn) { btn.classList.remove("active"); btn.textContent = "✏️ Enable Live Edit"; }
  setText("live-edit-status","Off");
}

async function loadDevStats() {
  const grid = document.getElementById("dev-stats-grid");
  grid.innerHTML = `<div style="color:#4a5568;font-family:monospace;font-size:13px;grid-column:1/-1">Loading…</div>`;
  try {
    const s = await get("/api/admin/stats");
    grid.innerHTML = `
      <div class="stat-card"><div class="stat-number">${s.users}</div><div class="stat-label">Users</div></div>
      <div class="stat-card"><div class="stat-number">${s.messages}</div><div class="stat-label">Messages</div></div>
      <div class="stat-card"><div class="stat-number">${s.contacts}</div><div class="stat-label">Contacts</div></div>`;
  } catch { grid.innerHTML = `<div style="color:var(--danger);grid-column:1/-1">Failed to load.</div>`; }
}

// ═══════════════════════════════════════════════════════════
//  CLOSE ALL
// ═══════════════════════════════════════════════════════════
function closeAll() {
  ["add-panel","settings-panel"].forEach(id => {
    document.getElementById(id).classList.remove("open");
    setTimeout(() => document.getElementById(id).classList.add("hidden"), 300);
  });
  document.getElementById("overlay").classList.add("hidden");
}

// ═══════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════
function val(id) { return document.getElementById(id)?.value.trim() || ""; }
function setText(id, text) { const el=document.getElementById(id); if(el) el.textContent=text; }
function showMsg(el, cls, msg) {
  if (!el) return;
  el.className = (el.className.split(" ")[0] || "") + (cls ? " "+cls : "");
  el.textContent = msg;
}
function escHtml(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function initials(name) { return (name||"?").split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase(); }
const AV_COLORS=["#7c5cfc","#3b82f6","#ec4899","#f59e0b","#22c55e","#ef4444","#8b5cf6","#06b6d4"];
function avatarColor(name) {
  let h=0; for(let i=0;i<name.length;i++) h=(h*31+name.charCodeAt(i))&0xffffffff;
  return AV_COLORS[Math.abs(h)%AV_COLORS.length];
}
function setAvatar(elId, src, name, size) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.className = "avatar" + (size ? " "+size : "");
  if (src) {
    el.style.backgroundImage = `url('${src}')`;
    el.style.backgroundSize = "cover";
    el.style.backgroundPosition = "center";
    el.style.backgroundColor = "";
    el.textContent = "";
  } else {
    el.style.backgroundImage = "";
    el.style.backgroundColor = avatarColor(name||"?");
    el.textContent = initials(name);
  }
}
function fmtTime(iso) {
  if (!iso) return "";
  const d=new Date(iso), now=new Date();
  if (d.toDateString()===now.toDateString()) return d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
  if ((now-d)/86400000<7) return d.toLocaleDateString([],{weekday:"short"});
  return d.toLocaleDateString([],{day:"2-digit",month:"2-digit"});
}
function fmtTimeFull(iso) { if(!iso)return""; return new Date(iso).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}); }
function fmtDate(iso) {
  if (!iso) return "—";
  const d=new Date(iso), now=new Date(), yest=new Date();
  yest.setDate(yest.getDate()-1);
  if (d.toDateString()===now.toDateString()) return "Today";
  if (d.toDateString()===yest.toDateString()) return "Yesterday";
  return d.toLocaleDateString([],{day:"2-digit",month:"long",year:"numeric"});
}
async function get(url) { const r=await fetch(url); return r.json(); }
async function post(url,body) {
  const r=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  return r.json();
}

// Enter key on auth forms
document.addEventListener("keydown", e => {
  if (e.key !== "Enter") return;
  if (document.getElementById("auth-screen").style.display !== "none") {
    if (!document.getElementById("form-login").classList.contains("hidden")) doLogin();
    else doRegister();
  }
});

// ═══════════════════════════════════════════════════════════
//  LANDING PAGE
// ═══════════════════════════════════════════════════════════
function showAuth(tab) {
  document.getElementById("landing").classList.add("hidden");
  const authEl = document.getElementById("auth-screen");
  authEl.classList.remove("hidden");
  authEl.style.display = "flex";
  authTab(tab);
}

// Override bootstrap: if not logged in, show landing instead of auth
const _origBootstrap = window.addEventListener;
window.addEventListener("DOMContentLoaded", () => {
  if (!localStorage.getItem("nexus_user")) {
    // landing is visible by default, auth is hidden — nothing to do
  }
});

// ═══════════════════════════════════════════════════════════
//  TUTORIAL
// ═══════════════════════════════════════════════════════════
const TUT_STEPS = [
  {
    title: "Welcome to NEXUS! 👋",
    desc: "You just created your account. Let's take a 30-second tour so you know where everything is.",
    target: null,
    pos: "center"
  },
  {
    title: "Your Profile",
    desc: "This is you! Click here anytime to open Settings — change your name, photo, status, theme color, or password.",
    target: ".me-card",
    pos: "right"
  },
  {
    title: "Add Contacts",
    desc: "Hit 'Add' to add someone by their NEXUS number (like +67 60 1234 567). Share yours so people can find you!",
    target: ".sidebar-footer",
    pos: "right"
  },
  {
    title: "Your NEXUS Number",
    desc: "Your unique number is shown under your name. Go to Settings → copy it and share it with friends.",
    target: ".me-phone",
    pos: "right"
  },
  {
    title: "Search Contacts",
    desc: "Once you have contacts, search them by name or number right here.",
    target: ".search-wrap",
    pos: "right"
  },
  {
    title: "You're all set! 🚀",
    desc: "That's everything. Add your first contact and start chatting. Have fun!",
    target: null,
    pos: "center"
  }
];

let tutStep = 0;

function startTutorial() {
  tutStep = 0;
  document.getElementById("tutorial").classList.remove("hidden");
  renderTutStep();
}

function skipTutorial() {
  document.getElementById("tutorial").classList.add("hidden");
  document.getElementById("tut-highlight").style.display = "none";
}

function tutNext() {
  tutStep++;
  if (tutStep >= TUT_STEPS.length) { skipTutorial(); return; }
  renderTutStep();
}

function renderTutStep() {
  const step = TUT_STEPS[tutStep];
  const total = TUT_STEPS.length;
  const box = document.getElementById("tut-box");
  const hl  = document.getElementById("tut-highlight");

  setText("tut-step-label", `Step ${tutStep+1} of ${total}`);
  setText("tut-title", step.title);
  setText("tut-desc", step.desc);

  // Dots
  const dots = document.getElementById("tut-dots");
  dots.innerHTML = TUT_STEPS.map((_,i) =>
    `<div class="tut-dot${i===tutStep?" active":""}"></div>`).join("");

  // Last step: change button
  document.querySelector(".tut-next").textContent = tutStep === total-1 ? "Done ✓" : "Next →";
  // First/last: hide skip
  document.querySelector(".tut-skip").style.display = (tutStep===0||tutStep===total-1) ? "none":"inline-block";

  // Highlight target
  if (step.target && step.pos !== "center") {
    const el = document.querySelector(step.target);
    if (el) {
      const r = el.getBoundingClientRect();
      hl.style.cssText = `display:block;left:${r.left-4}px;top:${r.top-4}px;width:${r.width+8}px;height:${r.height+8}px`;
      // Position box
      const bw = 300, bh = 200, pad = 16;
      let left = r.right + pad;
      let top  = r.top;
      if (left + bw > window.innerWidth) left = r.left - bw - pad;
      if (top + bh > window.innerHeight) top = window.innerHeight - bh - pad;
      box.style.left = Math.max(pad, left) + "px";
      box.style.top  = Math.max(pad, top)  + "px";
      box.style.transform = "none";
    }
  } else {
    hl.style.display = "none";
    box.style.left   = "50%";
    box.style.top    = "50%";
    box.style.transform = "translate(-50%,-50%)";
  }
}

// Trigger tutorial after first-time register + login
const _origLaunchApp = launchApp;
// Patch doRegister success to set flag
const _origDoRegister = doRegister;
window._nexusTutorialPending = false;
