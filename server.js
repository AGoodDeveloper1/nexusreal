const express = require("express");
const http    = require("http");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const path = require("path");

const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 6767;
const io     = new Server(server, { cors: { origin: "*", methods: ["GET","POST","DELETE"] } });

// PostgreSQL pool - Render sets DATABASE_URL automatically
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function query(sql, params = []) {
  const client = await pool.connect();
  try { return await client.query(sql, params); }
  finally { client.release(); }
}

// Init tables
async function initDB() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id           SERIAL PRIMARY KEY,
      username     TEXT NOT NULL UNIQUE,
      password     TEXT NOT NULL,
      display_name TEXT NOT NULL,
      phone_number TEXT NOT NULL UNIQUE,
      avatar       TEXT DEFAULT NULL,
      status       TEXT DEFAULT NULL,
      role         TEXT NOT NULL DEFAULT 'user',
      created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS contacts (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      contact_id INTEGER NOT NULL REFERENCES users(id),
      UNIQUE(user_id, contact_id)
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS messages (
      id          SERIAL PRIMARY KEY,
      sender_id   INTEGER NOT NULL REFERENCES users(id),
      receiver_id INTEGER NOT NULL REFERENCES users(id),
      content     TEXT NOT NULL,
      sent_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Seed admin
  const existing = await query("SELECT id FROM users WHERE username = $1", ["admin"]);
  if (existing.rows.length === 0) {
    await query(
      "INSERT INTO users (username, password, display_name, phone_number, role) VALUES ($1,$2,$3,$4,$5)",
      ["admin", "J17K27j31", "Admin", "+67 60 2412 711", "admin"]
    );
    console.log("[NEXUS] Admin created");
  } else {
    await query("UPDATE users SET password=$1 WHERE username='admin'", ["J17K27j31"]);
  }
  console.log("[NEXUS] DB ready");
}

// Phone generator
function genPhone() {
  const pad = (n, l) => String(Math.floor(Math.random() * n)).padStart(l, "0");
  return Math.random() < 0.5
    ? `+67 60 ${pad(10000,4)} ${pad(1000,3)}`
    : `+67 60 ${pad(1000,3)} ${pad(10000,4)}`;
}
async function uniquePhone() {
  for (let i = 0; i < 200; i++) {
    const p = genPhone();
    const r = await query("SELECT id FROM users WHERE phone_number=$1", [p]);
    if (r.rows.length === 0) return p;
  }
  throw new Error("Phone gen failed");
}

app.use((req,res,next) => {
  res.header("Access-Control-Allow-Origin","*");
  res.header("Access-Control-Allow-Methods","GET,POST,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers","Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

// AUTH
app.post("/api/login", async (req, res) => {
  try {
    const { username = "", password = "" } = req.body;
    const r = await query("SELECT * FROM users WHERE username=$1 AND password=$2", [username, password]);
    if (r.rows.length > 0) {
      const u = r.rows[0];
      res.json({ success: true, user: { id: u.id, username: u.username, display_name: u.display_name, phone_number: u.phone_number, avatar: u.avatar, status: u.status, role: u.role, created_at: u.created_at } });
    } else {
      res.json({ success: false, message: "Wrong username or password." });
    }
  } catch(e) { res.json({ success: false, message: e.message }); }
});

app.post("/api/register", async (req, res) => {
  const { username, password, display_name } = req.body;
  if (!username||!password||!display_name) return res.json({ success:false, message:"All fields required." });
  if (username.length < 3) return res.json({ success:false, message:"Username >= 3 chars." });
  if (password.length < 4) return res.json({ success:false, message:"Password >= 4 chars." });
  try {
    const phone = await uniquePhone();
    await query("INSERT INTO users (username,password,display_name,phone_number,role) VALUES ($1,$2,$3,$4,'user')", [username,password,display_name,phone]);
    res.json({ success: true, phone_number: phone });
  } catch(e) {
    res.json({ success:false, message: e.message.includes("unique") ? "Username already taken." : e.message });
  }
});

// USERS
app.get("/api/user/:id", async (req, res) => {
  const r = await query("SELECT id,username,display_name,phone_number,avatar,status,role,created_at FROM users WHERE id=$1", [req.params.id]);
  r.rows[0] ? res.json(r.rows[0]) : res.status(404).json({ error:"Not found" });
});

app.delete("/api/user/:id", async (req, res) => {
  const { username_confirm } = req.body;
  const r = await query("SELECT * FROM users WHERE id=$1", [req.params.id]);
  const u = r.rows[0];
  if (!u) return res.json({ success:false, message:"Not found." });
  if (u.username !== username_confirm) return res.json({ success:false, message:"Username does not match." });
  await query("DELETE FROM messages WHERE sender_id=$1 OR receiver_id=$1", [u.id]);
  await query("DELETE FROM contacts WHERE user_id=$1 OR contact_id=$1", [u.id]);
  await query("DELETE FROM users WHERE id=$1", [u.id]);
  res.json({ success: true });
});

// CONTACTS
app.get("/api/contacts/:userId", async (req, res) => {
  const r = await query(`SELECT u.id,u.display_name,u.phone_number,u.avatar,u.status FROM contacts c JOIN users u ON u.id=c.contact_id WHERE c.user_id=$1`, [req.params.userId]);
  res.json(r.rows);
});

app.post("/api/contacts/add", async (req, res) => {
  const { user_id, phone_number } = req.body;
  const cr = await query("SELECT id,display_name,phone_number,avatar,status FROM users WHERE phone_number=$1", [phone_number]);
  const contact = cr.rows[0];
  if (!contact) return res.json({ success:false, message:"No user with that number." });
  if (String(contact.id) === String(user_id)) return res.json({ success:false, message:"That's your own number!" });
  try {
    await query("INSERT INTO contacts (user_id,contact_id) VALUES ($1,$2)", [user_id, contact.id]);
  } catch(e) {
    if (e.message.includes("unique")) return res.json({ success:false, message:"Already in your contacts." });
    return res.json({ success:false, message:e.message });
  }
  try { await query("INSERT INTO contacts (user_id,contact_id) VALUES ($1,$2)", [contact.id, user_id]); } catch{}
  const adder = await query("SELECT id,display_name,phone_number,avatar,status FROM users WHERE id=$1", [user_id]);
  const recvSocket = onlineUsers.get(String(contact.id));
  if (recvSocket) io.to(recvSocket).emit("contact_added", adder.rows[0]);
  res.json({ success:true, contact });
});

// MESSAGES
app.get("/api/messages/:userId/:contactId", async (req, res) => {
  const r = await query(`SELECT m.id,m.sender_id,m.receiver_id,m.content,m.sent_at,u.display_name AS sender_name FROM messages m JOIN users u ON u.id=m.sender_id WHERE (m.sender_id=$1 AND m.receiver_id=$2) OR (m.sender_id=$2 AND m.receiver_id=$1) ORDER BY m.sent_at ASC`, [req.params.userId, req.params.contactId]);
  res.json(r.rows);
});

app.post("/api/messages/send", async (req, res) => {
  const { sender_id, receiver_id, content } = req.body;
  if (!content?.trim()) return res.json({ success:false });
  const r = await query("INSERT INTO messages (sender_id,receiver_id,content) VALUES ($1,$2,$3) RETURNING id,sent_at", [sender_id, receiver_id, content.trim()]);
  res.json({ success:true, id: r.rows[0].id, sent_at: r.rows[0].sent_at });
});

app.get("/api/lastmessages/:userId", async (req, res) => {
  const uid = req.params.userId;
  const r = await query(`
    SELECT DISTINCT ON (LEAST(sender_id,receiver_id), GREATEST(sender_id,receiver_id))
      sender_id, receiver_id, content, sent_at
    FROM messages
    WHERE sender_id=$1 OR receiver_id=$1
    ORDER BY LEAST(sender_id,receiver_id), GREATEST(sender_id,receiver_id), sent_at DESC
  `, [uid]);
  res.json(r.rows);
});

app.get("/api/msgcount/:userId", async (req, res) => {
  const r = await query("SELECT COUNT(*) as c FROM messages WHERE sender_id=$1", [req.params.userId]);
  res.json({ count: parseInt(r.rows[0].c) });
});

// SETTINGS
app.post("/api/settings/name", async (req, res) => {
  const { user_id, display_name } = req.body;
  if (!display_name) return res.json({ success:false, message:"Name required." });
  await query("UPDATE users SET display_name=$1 WHERE id=$2", [display_name.trim(), user_id]);
  res.json({ success:true });
});
app.post("/api/settings/status", async (req, res) => {
  const { user_id, status } = req.body;
  await query("UPDATE users SET status=$1 WHERE id=$2", [status||null, user_id]);
  res.json({ success:true });
});
app.post("/api/settings/avatar", async (req, res) => {
  const { user_id, avatar } = req.body;
  await query("UPDATE users SET avatar=$1 WHERE id=$2", [avatar, user_id]);
  res.json({ success:true });
});
app.post("/api/settings/password", async (req, res) => {
  const { user_id, old_password, new_password } = req.body;
  const r = await query("SELECT * FROM users WHERE id=$1", [user_id]);
  const u = r.rows[0];
  if (!u) return res.json({ success:false, message:"Not found." });
  if (u.password !== old_password) return res.json({ success:false, message:"Current password is wrong." });
  if (!new_password || new_password.length < 4) return res.json({ success:false, message:"New password >= 4 chars." });
  await query("UPDATE users SET password=$1 WHERE id=$2", [new_password, user_id]);
  res.json({ success:true });
});

// ADMIN
app.post("/api/admin/setrole", async (req, res) => {
  const { user_id, role } = req.body;
  if (!["admin","user"].includes(role)) return res.json({ success:false, message:"Invalid role." });
  await query("UPDATE users SET role=$1 WHERE id=$2", [role, user_id]);
  res.json({ success:true });
});
app.get("/api/admin/users", async (req, res) => {
  const r = await query("SELECT id,username,password,display_name,phone_number,role,status,created_at FROM users ORDER BY id");
  res.json(r.rows);
});
app.get("/api/admin/stats", async (req, res) => {
  const [u,m,c] = await Promise.all([
    query("SELECT COUNT(*) as c FROM users"),
    query("SELECT COUNT(*) as c FROM messages"),
    query("SELECT COUNT(*) as c FROM contacts")
  ]);
  res.json({ users: parseInt(u.rows[0].c), messages: parseInt(m.rows[0].c), contacts: parseInt(c.rows[0].c) });
});

// WEBSOCKET
const onlineUsers = new Map();
io.on("connection", (socket) => {
  socket.on("user_online", (userId) => onlineUsers.set(String(userId), socket.id));

  socket.on("send_message", async ({ sender_id, receiver_id, content }) => {
    if (!content?.trim()) return;
    const r = await query("INSERT INTO messages (sender_id,receiver_id,content) VALUES ($1,$2,$3) RETURNING id,sent_at", [sender_id, receiver_id, content.trim()]);
    const msg = { id: r.rows[0].id, sender_id, receiver_id, content: content.trim(), sent_at: r.rows[0].sent_at };
    const recvSocket = onlineUsers.get(String(receiver_id));
    if (recvSocket) io.to(recvSocket).emit("receive_message", msg);
    socket.emit("message_sent", msg);
  });

  // Call signaling
  socket.on("call-offer", ({from,to,from_name,from_avatar,offer}) => {
    const s = onlineUsers.get(String(to));
    if (s) io.to(s).emit("call-offer", {from,from_name,from_avatar,offer});
    else socket.emit("call-missed", { reason:"User is offline" });
  });
  socket.on("call-answer", ({from,to,answer}) => {
    const s = onlineUsers.get(String(to)); if(s) io.to(s).emit("call-answer",{from,answer});
  });
  socket.on("call-reject", ({from,to}) => {
    const s = onlineUsers.get(String(to)); if(s) io.to(s).emit("call-reject",{from});
  });
  socket.on("call-end", ({from,to}) => {
    const s = onlineUsers.get(String(to)); if(s) io.to(s).emit("call-end",{from});
  });
  socket.on("call-ice", ({from,to,candidate}) => {
    const s = onlineUsers.get(String(to)); if(s) io.to(s).emit("call-ice",{from,candidate});
  });

  socket.on("disconnect", () => {
    for (const [uid,sid] of onlineUsers) { if(sid===socket.id){onlineUsers.delete(uid);break;} }
  });
});

// Start
initDB().then(() => {
  server.listen(PORT, () => console.log(`\n  NEXUS -> http://localhost:${PORT}\n`));
}).catch(err => {
  console.error("DB init failed:", err.message);
  process.exit(1);
});
