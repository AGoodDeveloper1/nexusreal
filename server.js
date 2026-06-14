const express  = require("express");
const Database = require("better-sqlite3");
const http     = require("http");
const { Server } = require("socket.io");
const path     = require("path");

const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 6767;
const io     = new Server(server, { cors: { origin: "*", methods: ["GET","POST","DELETE"] } });
const db     = new Database(process.env.DB_PATH || "nexus.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    username     TEXT NOT NULL UNIQUE,
    password     TEXT NOT NULL,
    display_name TEXT NOT NULL,
    phone_number TEXT NOT NULL UNIQUE,
    avatar       TEXT DEFAULT NULL,
    status       TEXT DEFAULT NULL,
    role         TEXT NOT NULL DEFAULT 'user',
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL, contact_id INTEGER NOT NULL,
    UNIQUE(user_id, contact_id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (contact_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER NOT NULL, receiver_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (sender_id) REFERENCES users(id),
    FOREIGN KEY (receiver_id) REFERENCES users(id)
  );
`);
try { db.exec("ALTER TABLE users ADD COLUMN status TEXT DEFAULT NULL"); } catch {}

// ── Seed admin ─────────────────────────────────────────────
const existing = db.prepare("SELECT id,password FROM users WHERE username='admin'").get();
if (!existing) {
  db.prepare("INSERT INTO users (username,password,display_name,phone_number,role) VALUES (?,?,?,?,?)")
    .run("admin","J17K27j31","Admin","+67 60 2412 711","admin");
  console.log("[NEXUS] Admin created → admin / J17K27j31");
} else if (existing.password !== "J17K27j31") {
  db.prepare("UPDATE users SET password=? WHERE username='admin'").run("J17K27j31");
  console.log("[NEXUS] Admin password updated");
}

app.use((req,res,next)=>{
  res.header("Access-Control-Allow-Origin","*");
  res.header("Access-Control-Allow-Methods","GET,POST,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers","Content-Type");
  if(req.method==="OPTIONS") return res.sendStatus(200);
  next();
});
app.use(express.json({ limit:"10mb" }));
app.use(express.static(path.join(__dirname,"public")));

// Phone generator
function genPhone() {
  const pad=(n,l)=>String(Math.floor(Math.random()*n)).padStart(l,"0");
  return Math.random()<0.5 ? `+67 60 ${pad(10000,4)} ${pad(1000,3)}` : `+67 60 ${pad(1000,3)} ${pad(10000,4)}`;
}
function uniquePhone() {
  for(let i=0;i<200;i++){const p=genPhone();if(!db.prepare("SELECT id FROM users WHERE phone_number=?").get(p))return p;}
  throw new Error("Phone gen failed");
}

// ── Auth ───────────────────────────────────────────────────
app.post("/api/login",(req,res)=>{
  const {username="",password=""}=req.body;
  const u=db.prepare("SELECT * FROM users WHERE username=? AND password=?").get(username,password);
  if(u) res.json({success:true,user:{id:u.id,username:u.username,display_name:u.display_name,phone_number:u.phone_number,avatar:u.avatar,status:u.status,role:u.role,created_at:u.created_at}});
  else   res.json({success:false,message:"Wrong username or password."});
});

app.post("/api/register",(req,res)=>{
  const {username,password,display_name}=req.body;
  if(!username||!password||!display_name) return res.json({success:false,message:"All fields required."});
  if(username.length<3) return res.json({success:false,message:"Username ≥ 3 chars."});
  if(password.length<4) return res.json({success:false,message:"Password ≥ 4 chars."});
  try {
    const phone=uniquePhone();
    db.prepare("INSERT INTO users (username,password,display_name,phone_number) VALUES (?,?,?,?)").run(username,password,display_name,phone);
    res.json({success:true,phone_number:phone});
  } catch(err) {
    res.json({success:false,message:err.message.includes("UNIQUE")?"Username already taken.":err.message});
  }
});

// ── Users ──────────────────────────────────────────────────
app.get("/api/user/:id",(req,res)=>{
  const u=db.prepare("SELECT id,username,display_name,phone_number,avatar,status,role,created_at FROM users WHERE id=?").get(req.params.id);
  u?res.json(u):res.status(404).json({error:"Not found"});
});

app.delete("/api/user/:id",(req,res)=>{
  const {username_confirm}=req.body;
  const u=db.prepare("SELECT * FROM users WHERE id=?").get(req.params.id);
  if(!u) return res.json({success:false,message:"User not found."});
  if(u.username!==username_confirm) return res.json({success:false,message:"Username does not match."});
  db.prepare("DELETE FROM messages WHERE sender_id=? OR receiver_id=?").run(u.id,u.id);
  db.prepare("DELETE FROM contacts WHERE user_id=? OR contact_id=?").run(u.id,u.id);
  db.prepare("DELETE FROM users WHERE id=?").run(u.id);
  res.json({success:true});
});

// ── Contacts ───────────────────────────────────────────────
app.get("/api/contacts/:userId",(req,res)=>{
  const rows=db.prepare(`SELECT u.id,u.display_name,u.phone_number,u.avatar,u.status FROM contacts c JOIN users u ON u.id=c.contact_id WHERE c.user_id=?`).all(req.params.userId);
  res.json(rows);
});

app.post("/api/contacts/add",(req,res)=>{
  const {user_id,phone_number}=req.body;
  const contact=db.prepare("SELECT id,display_name,phone_number,avatar,status FROM users WHERE phone_number=?").get(phone_number);
  if(!contact) return res.json({success:false,message:"No user with that number."});
  if(String(contact.id)===String(user_id)) return res.json({success:false,message:"That's your own number!"});
  try {
    db.prepare("INSERT INTO contacts (user_id,contact_id) VALUES (?,?)").run(user_id,contact.id);
  } catch(err) {
    if(err.message.includes("UNIQUE")) return res.json({success:false,message:"Already in your contacts."});
    return res.json({success:false,message:err.message});
  }
  // ── Mutual: also add reverse so both sides see each other ──
  try { db.prepare("INSERT INTO contacts (user_id,contact_id) VALUES (?,?)").run(contact.id,user_id); } catch{}
  // Notify the other user if they're online
  const adderInfo=db.prepare("SELECT id,display_name,phone_number,avatar,status FROM users WHERE id=?").get(user_id);
  const recvSocket=onlineUsers.get(String(contact.id));
  if(recvSocket) io.to(recvSocket).emit("contact_added",adderInfo);
  res.json({success:true,contact});
});

// ── Messages ───────────────────────────────────────────────
app.get("/api/messages/:userId/:contactId",(req,res)=>{
  const msgs=db.prepare(`SELECT m.id,m.sender_id,m.receiver_id,m.content,m.sent_at,u.display_name AS sender_name FROM messages m JOIN users u ON u.id=m.sender_id WHERE (m.sender_id=? AND m.receiver_id=?) OR (m.sender_id=? AND m.receiver_id=?) ORDER BY m.sent_at ASC`).all(req.params.userId,req.params.contactId,req.params.contactId,req.params.userId);
  res.json(msgs);
});

app.post("/api/messages/send",(req,res)=>{
  const {sender_id,receiver_id,content}=req.body;
  if(!content?.trim()) return res.json({success:false});
  const result=db.prepare("INSERT INTO messages (sender_id,receiver_id,content) VALUES (?,?,?)").run(sender_id,receiver_id,content.trim());
  res.json({success:true,id:result.lastInsertRowid,sent_at:new Date().toISOString()});
});

app.get("/api/lastmessages/:userId",(req,res)=>{
  const uid=req.params.userId;
  const rows=db.prepare(`SELECT m.sender_id,m.receiver_id,m.content,m.sent_at FROM messages m WHERE m.id IN (SELECT MAX(id) FROM messages WHERE sender_id=? OR receiver_id=? GROUP BY CASE WHEN sender_id=? THEN receiver_id ELSE sender_id END)`).all(uid,uid,uid);
  res.json(rows);
});

app.get("/api/msgcount/:userId",(req,res)=>{
  const c=db.prepare("SELECT COUNT(*) as c FROM messages WHERE sender_id=?").get(req.params.userId);
  res.json({count:c.c});
});

// ── Settings ───────────────────────────────────────────────
app.post("/api/settings/name",(req,res)=>{
  const {user_id,display_name}=req.body;
  if(!display_name) return res.json({success:false,message:"Name required."});
  db.prepare("UPDATE users SET display_name=? WHERE id=?").run(display_name.trim(),user_id);
  res.json({success:true});
});
app.post("/api/settings/status",(req,res)=>{
  const {user_id,status}=req.body;
  db.prepare("UPDATE users SET status=? WHERE id=?").run(status||null,user_id);
  res.json({success:true});
});
app.post("/api/settings/avatar",(req,res)=>{
  const {user_id,avatar}=req.body;
  db.prepare("UPDATE users SET avatar=? WHERE id=?").run(avatar,user_id);
  res.json({success:true});
});
app.post("/api/settings/password",(req,res)=>{
  const {user_id,old_password,new_password}=req.body;
  const u=db.prepare("SELECT * FROM users WHERE id=?").get(user_id);
  if(!u) return res.json({success:false,message:"Not found."});
  if(u.password!==old_password) return res.json({success:false,message:"Current password is wrong."});
  if(!new_password||new_password.length<4) return res.json({success:false,message:"New password ≥ 4 chars."});
  db.prepare("UPDATE users SET password=? WHERE id=?").run(new_password,user_id);
  res.json({success:true});
});

// ── Admin ──────────────────────────────────────────────────
app.get("/api/admin/users",(req,res)=>{
  res.json(db.prepare("SELECT id,username,password,display_name,phone_number,role,status,created_at FROM users ORDER BY id").all());
});
app.get("/api/admin/stats",(req,res)=>{
  res.json({
    users:    db.prepare("SELECT COUNT(*) as c FROM users").get().c,
    messages: db.prepare("SELECT COUNT(*) as c FROM messages").get().c,
    contacts: db.prepare("SELECT COUNT(*) as c FROM contacts").get().c,
  });
});

// ── WebSocket ──────────────────────────────────────────────
const onlineUsers=new Map();
io.on("connection",(socket)=>{
  socket.on("user_online",(userId)=>onlineUsers.set(String(userId),socket.id));
  socket.on("send_message",({sender_id,receiver_id,content})=>{
    if(!content?.trim()) return;
    const result=db.prepare("INSERT INTO messages (sender_id,receiver_id,content) VALUES (?,?,?)").run(sender_id,receiver_id,content.trim());
    const msg={id:result.lastInsertRowid,sender_id,receiver_id,content:content.trim(),sent_at:new Date().toISOString()};
    const recvSocket=onlineUsers.get(String(receiver_id));
    if(recvSocket) io.to(recvSocket).emit("receive_message",msg);
    socket.emit("message_sent",msg);
  });
  socket.on("disconnect",()=>{
    for(const [uid,sid] of onlineUsers){if(sid===socket.id){onlineUsers.delete(uid);break;}}
  });
});

server.listen(PORT,()=>console.log(`\n  NEXUS → http://localhost:${PORT}\n`));
