const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
// 用 bun build --compile 打成单文件后，__dirname 是构建时的源码目录而不是可执行文件所在目录。
// 因此编译版本改用 process.execPath 的目录作为 BASE，这样 index.html、app.js、.env、data/
// 等外部文件都能放在二进制文件旁边。普通 node/bun 运行仍使用源码目录。
const BASE = process.env.LEDGER_BASE_DIR
  ? path.resolve(process.env.LEDGER_BASE_DIR)
  : (typeof Bun !== 'undefined' && Bun.isStandaloneExecutable ? path.dirname(process.execPath) : __dirname);
// 读取 .env（已存在的环境变量优先，不会被覆盖）。
try { process.loadEnvFile(path.join(BASE, '.env')); } catch {}
// Ory Kratos 统一账号登录（可选）。未开启时不影响任何既有行为。
// 需要同时提供 KRATOS_PUBLIC_URL（服务端访问）与 PUBLIC_URL（对外地址，用于拼接登录回调）。
const KRATOS_ENABLE = String(process.env.KRATOS_ENABLE ?? '0') !== '0';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const KRATOS_PUBLIC_URL = (process.env.KRATOS_PUBLIC_URL || '').replace(/\/+$/, '');
// 默认同源反向代理模式：浏览器在账务域名下访问被代理的 Kratos 路径。
const KRATOS_BROWSER_URL = (process.env.KRATOS_BROWSER_URL || PUBLIC_URL).replace(/\/+$/, '');
const KRATOS_SESSION_COOKIE = process.env.KRATOS_SESSION_COOKIE || 'ory_kratos_session';
// Kratos v0.5.x 的浏览器登出端点是 /self-service/browser/flows/logout，
// v0.6+ 改为 /self-service/logout/browser；登录与 /sessions/whoami 路径各版本一致。
const KRATOS_LOGOUT_PATH = process.env.KRATOS_LOGOUT_PATH || '/self-service/logout/browser';
const KRATOS_ENABLED = KRATOS_ENABLE && !!KRATOS_PUBLIC_URL && !!PUBLIC_URL;
const KRATOS_TIMEOUT_MS = 5000;
const KRATOS_NEGATIVE_TTL_MS = 60 * 1000;
const KRATOS_DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;
const KRATOS_MAX_INFLIGHT = 32;
if (KRATOS_ENABLE && !KRATOS_ENABLED) console.warn('[kratos] 缺少 KRATOS_PUBLIC_URL 或 PUBLIC_URL，统一账号登录已禁用');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const startBot = require('./bot');

// PDF 预览依赖：优先使用二进制旁边的 vendor/，其次 node_modules/pdfjs-dist。
const VENDOR_ROOTS = [path.join(BASE, 'vendor'), path.join(BASE, 'node_modules', 'pdfjs-dist')];
function vendorFile(rel) { for (const root of VENDOR_ROOTS) { const f = path.join(root, rel); if (fs.existsSync(f)) return f; } return null; }
const DATA = process.env.LEDGER_DATA_DIR ? path.resolve(process.env.LEDGER_DATA_DIR) : path.join(BASE, 'data');
const FILES = path.join(DATA, 'receipts');
fs.mkdirSync(FILES, { recursive: true });
const db = new DatabaseSync(path.join(DATA, 'ledger.sqlite'));
db.exec(`PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT UNIQUE NOT NULL,pass TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','viewer')));
CREATE TABLE IF NOT EXISTS entries(id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('income','expense')),amount_cents INTEGER NOT NULL CHECK(amount_cents>0),reason TEXT NOT NULL,date TEXT NOT NULL,note TEXT NOT NULL DEFAULT '',operator TEXT NOT NULL DEFAULT '',deleted INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,created_by TEXT NOT NULL,updated_at TEXT,updated_by TEXT,deleted_at TEXT,deleted_by TEXT,version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY,entry_id TEXT NOT NULL REFERENCES entries(id),name TEXT NOT NULL,file TEXT NOT NULL,mime TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,entry_id TEXT NOT NULL,action TEXT NOT NULL,by_user TEXT NOT NULL,at TEXT NOT NULL,before_state TEXT,after_state TEXT);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS entries_date_idx ON entries(date);`);
function transaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const v=fn(); db.exec('COMMIT'); return v; } catch(e) { db.exec('ROLLBACK'); throw e; } }
const jsonPath = path.join(DATA, 'ledger.json');
if (fs.existsSync(jsonPath) && db.prepare('SELECT count(*) n FROM users').get().n === 0) {
  try {
    const old=JSON.parse(fs.readFileSync(jsonPath,'utf8'));
    transaction(()=>{
      for(const u of old.users||[]) db.prepare('INSERT OR IGNORE INTO users VALUES(?,?,?,?)').run(u.id,u.name,u.pass,u.role);
      for(const e of old.entries||[]) {
        db.prepare('INSERT OR IGNORE INTO entries(id,kind,amount_cents,reason,date,note,deleted,created_at,created_by,updated_at,updated_by,deleted_at,deleted_by,version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(e.id,e.kind,e.amountCents,e.reason,e.date,e.note||'',e.deleted?1:0,e.createdAt,e.createdBy,e.updatedAt||null,e.updatedBy||null,e.deletedAt||null,e.deletedBy||null,e.version||1);
        for(const a of e.attachments||[]) db.prepare('INSERT INTO attachments VALUES(?,?,?,?,?)').run(crypto.randomUUID(),e.id,a.name,a.file,'application/octet-stream');
      }
      for(const a of old.audit||[]) db.prepare('INSERT INTO audit(entry_id,action,by_user,at,before_state,after_state) VALUES(?,?,?,?,?,?)').run(a.entryId,a.action,a.by,a.at,a.before?JSON.stringify(a.before):null,a.after?JSON.stringify(a.after):null);
    });
    console.log('Imported old ledger data into SQLite.');
  } catch(e) { console.error('Could not import old ledger:',e.message); }
}
function hash(p,s=crypto.randomBytes(16).toString('hex')) { return s+':'+crypto.scryptSync(p,s,64).toString('hex'); }
function valid(p,h) { const [s,v]=h.split(':'); const a=Buffer.from(v||'','hex'),b=crypto.scryptSync(p,s,64); return a.length===b.length&&crypto.timingSafeEqual(a,b); }
function readCookie(req,name) { for(const part of (req.headers.cookie||'').split(';')){ const s=part.trim(); if(s.startsWith(name+'=')) return s.slice(name.length+1); } return null; }
function cookie(req) { return readCookie(req,'sid'); }
// 本地会话：{userId} 或 Kratos 会话：{kratos:{id,name,expiresAt}}。
const sessions=new Map();
const kratosInvalid=new Map();
let kratosInflight=0;
function sessionUser(sess) {
  if(!sess) return null;
  if(sess.userId){ const u=db.prepare('SELECT * FROM users WHERE id=?').get(sess.userId); return u?{id:u.id,name:u.name,role:u.role,via:'local'}:null; }
  if(sess.kratos){ if(sess.kratos.expiresAt&&Date.now()>sess.kratos.expiresAt)return null; return {id:null,name:sess.kratos.name,role:'viewer',via:'kratos'}; }
  return null;
}
function issueSession(res,payload) {
  const token=crypto.randomBytes(32).toString('hex');
  sessions.set(token,payload);
  res.setHeader('set-cookie',`sid=${token}; HttpOnly; SameSite=Strict; Path=/`);
  return token;
}
function kratosName(identity) {
  const t=(identity&&typeof identity.traits==='object'&&identity.traits)||{};
  const clean=s=>String(s).replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,120);
  for(const v of [t.display_name,t.username,t.preferred_username,t.email]) if(typeof v==='string'&&v.trim())return clean(v);
  if(typeof t.name==='string'&&t.name.trim())return clean(t.name);
  if(t.name&&typeof t.name==='object'){ const n=[t.name.first,t.name.last].filter(x=>typeof x==='string'&&x.trim()).join(' ').trim(); if(n)return clean(n); }
  return '成员 '+String(identity&&identity.id||'').slice(0,8);
}
// 返回 {state:'valid',who} / {state:'invalid'} / {state:'error'}。
// 只有明确无效（401/403 或 active===false）才做短暂负缓存；网络错误不缓存，避免 Kratos 抖动导致静默失效。
async function kratosWhoami(token) {
  const miss=kratosInvalid.get(token);
  if(miss&&miss>Date.now())return {state:'invalid'};
  if(kratosInvalid.size>1000)kratosInvalid.clear();
  if(kratosInflight>=KRATOS_MAX_INFLIGHT)return {state:'error'};
  kratosInflight++;
  try {
    const r=await fetch(KRATOS_PUBLIC_URL+'/sessions/whoami',{
      headers:{accept:'application/json',cookie:KRATOS_SESSION_COOKIE+'='+token},
      redirect:'manual',signal:AbortSignal.timeout(KRATOS_TIMEOUT_MS)
    });
    if(r.status===401||r.status===403){ kratosInvalid.set(token,Date.now()+KRATOS_NEGATIVE_TTL_MS); return {state:'invalid'}; }
    if(!r.ok)return {state:'error'};
    const s=await r.json().catch(()=>null),identity=s&&s.identity;
    const invalid=()=>{ kratosInvalid.set(token,Date.now()+KRATOS_NEGATIVE_TTL_MS); return {state:'invalid'}; };
    if(!s||s.active===false||!identity||!identity.id)return invalid();
    if(identity.state&&identity.state!=='active')return invalid();
    const exp=s.expires_at?Date.parse(s.expires_at):NaN;
    if(Number.isFinite(exp)&&exp<=Date.now())return invalid();
    return {state:'valid',who:{id:String(identity.id),name:kratosName(identity),expiresAt:Number.isFinite(exp)?exp:Date.now()+KRATOS_DEFAULT_TTL_MS}};
  } catch { return {state:'error'}; }
  finally { kratosInflight--; }
}
// 尚未初始化（没有本地账号）时不允许走 Kratos，避免绕过初始化页。
function kratosReady() { return db.prepare('SELECT count(*) n FROM users').get().n>0; }
async function kratosAutoLogin(req,res) {
  if(!KRATOS_ENABLED||!kratosReady())return null;
  const token=readCookie(req,KRATOS_SESSION_COOKIE);
  if(!token)return null;
  const r=await kratosWhoami(token);
  if(r.state!=='valid')return null;
  issueSession(res,{kratos:r.who});
  return {id:null,name:r.who.name,role:'viewer',via:'kratos'};
}
// v0.5.x 的登出不读 return_to，落点由 kratos.yml 的 logout.after.default_browser_return_url 决定。
function kratosLogoutUrl() { return KRATOS_BROWSER_URL+KRATOS_LOGOUT_PATH+'?return_to='+encodeURIComponent(PUBLIC_URL+'/'); }
function send(res,status,data) { res.writeHead(status,{'content-type':'application/json; charset=utf-8','x-content-type-options':'nosniff'}); res.end(JSON.stringify(data)); }
function readBody(req) { return new Promise((resolve,reject)=>{let s='';req.on('data',c=>{s+=c;if(s.length>14e6)reject(Error('Request too large'));});req.on('end',()=>{try{resolve(JSON.parse(s||'{}'));}catch{reject(Error('Invalid JSON'));}});}); }
function cents(v) { const s=String(v); if(!/^\d{1,10}(\.\d{1,2})?$/.test(s)||Number(s)<=0)throw Error('Invalid amount'); const [a,b='']=s.split('.'); return Number(a)*100+Number((b+'00').slice(0,2)); }
function entry(id) { const e=db.prepare('SELECT * FROM entries WHERE id=?').get(id); if(!e)return null; return {id:e.id,kind:e.kind,amountCents:e.amount_cents,reason:e.reason,date:e.date,note:e.note,operator:e.operator,deleted:!!e.deleted,createdAt:e.created_at,createdBy:e.created_by,updatedAt:e.updated_at,updatedBy:e.updated_by,deletedAt:e.deleted_at,deletedBy:e.deleted_by,version:e.version,attachments:db.prepare('SELECT id,name,file,mime FROM attachments WHERE entry_id=?').all(id)}; }
function attMime(a) { if(a.mime&&a.mime!=='application/octet-stream')return a.mime; const ext=(String(a.file).split('.').pop()||'').toLowerCase(); return {pdf:'application/pdf',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp'}[ext]||'application/octet-stream'; }
function snap(e) { return JSON.stringify(e); }
function getSetting(k,d) { const r=db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r?r.value:d; }
function setSetting(k,v) { db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k,v); }
function getBotAdmins() { try { const v=JSON.parse(getSetting('bot.adminQqs','[]')); return Array.isArray(v)?v.map(String):[]; } catch { return []; } }
function parseAttachment(a) { const m=String(a.data||'').match(/^data:(image\/(?:png|jpeg|webp)|application\/pdf);base64,([\s\S]+)$/); if(!m)return null; const buf=Buffer.from(m[2],'base64'); if(buf.length>4e6)throw Error('Attachment exceeds 4MB'); return {name:String(a.name||'').slice(0,120),buf,mime:m[1]}; }
function storeUploads(uploads) { const files=[]; for(const u of uploads.slice(0,5)){ const ext=u.mime.split('/')[1].replace('jpeg','jpg'),f=crypto.randomUUID()+'.'+ext; fs.writeFileSync(path.join(FILES,f),u.buf); files.push({name:String(u.name||f).slice(0,120),file:f,mime:u.mime}); } return files; }
function createEntryRecord(d,uploads) { const id=crypto.randomUUID(),at=new Date().toISOString(),files=storeUploads(uploads||[]); transaction(()=>{ db.prepare('INSERT INTO entries(id,kind,amount_cents,reason,date,note,operator,created_at,created_by) VALUES(?,?,?,?,?,?,?,?,?)').run(id,d.kind,d.amountCents,String(d.reason).slice(0,160),d.date,String(d.note||'').slice(0,1000),String(d.operator||'').slice(0,120),at,d.createdBy); for(const f of files)db.prepare('INSERT INTO attachments VALUES(?,?,?,?,?)').run(crypto.randomUUID(),id,f.name,f.file,f.mime); db.prepare('INSERT INTO audit(entry_id,action,by_user,at,after_state) VALUES(?,?,?,?,?)').run(id,'create',d.createdBy,at,snap(entry(id))); }); return id; }

const server=http.createServer(async(req,res)=>{
 try {
  const url=new URL(req.url,'http://localhost'),sid=cookie(req);
  let user=sessionUser(sessions.get(sid));
  if(!user&&sid)sessions.delete(sid);
  // 已登录 Kratos 的成员访问首页或 /api/me 时自动建立本地会话（其余请求不触发 whoami）。
  if(!user&&req.method==='GET'&&KRATOS_ENABLED&&(url.pathname==='/'||url.pathname==='/api/me'))user=await kratosAutoLogin(req,res);
  if(req.method==='GET'&&url.pathname==='/'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'});return res.end(fs.readFileSync(path.join(BASE,'index.html')));}
  if(req.method==='GET'&&url.pathname==='/app.js'){res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-cache'});return fs.createReadStream(path.join(BASE,'app.js')).pipe(res);}
  if(req.method==='GET'&&['/vendor/pdf.mjs','/vendor/pdf.worker.mjs'].includes(url.pathname)){
   const file=vendorFile(path.join('build',url.pathname.endsWith('worker.mjs')?'pdf.worker.mjs':'pdf.mjs'));
   if(!file)return send(res,503,{error:'PDF viewer dependency missing; place vendor/ or node_modules/pdfjs-dist next to the binary'});
   res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'public, max-age=3600'});return fs.createReadStream(file).pipe(res);
  }
  if(req.method==='GET'&&/^\/vendor\/(standard_fonts|cmaps)\/[\w.-]+$/.test(url.pathname)){
   const [,dir,name]=url.pathname.match(/^\/vendor\/(standard_fonts|cmaps)\/([\w.-]+)$/);
   const file=vendorFile(path.join(dir,name));
   if(!file)return send(res,404,{error:'Not found'});
   res.writeHead(200,{'content-type':'application/octet-stream','cache-control':'public, max-age=86400'});return fs.createReadStream(file).pipe(res);
  }
  if(req.method==='GET'&&url.pathname==='/api/setup-status')return send(res,200,{setup:db.prepare('SELECT count(*) n FROM users').get().n===0});
  if(req.method==='GET'&&url.pathname==='/api/config'){res.setHeader('cache-control','no-store');return send(res,200,{kratos:{enabled:KRATOS_ENABLED}});}
  if(req.method==='GET'&&url.pathname==='/api/kratos/login'){
   if(!KRATOS_ENABLED)return send(res,404,{error:'Kratos SSO not enabled'});
   if(!kratosReady()){res.writeHead(302,{location:'/'});return res.end();}
   const to=encodeURIComponent(PUBLIC_URL+'/api/kratos/callback');
   res.writeHead(302,{location:`${KRATOS_BROWSER_URL}/self-service/login/browser?return_to=${to}`,'cache-control':'no-store'});return res.end();
  }
  if(req.method==='GET'&&url.pathname==='/api/kratos/callback'){
   if(!KRATOS_ENABLED)return send(res,404,{error:'Kratos SSO not enabled'});
   if(!kratosReady()){res.writeHead(302,{location:'/'});return res.end();}
   const token=readCookie(req,KRATOS_SESSION_COOKIE),r=token?await kratosWhoami(token):{state:'invalid'};
   if(r.state!=='valid'){res.writeHead(302,{location:'/?kratos_error=1','cache-control':'no-store'});return res.end();}
   sessions.delete(sid);
   issueSession(res,{kratos:r.who});
   res.writeHead(302,{location:'/','cache-control':'no-store'});return res.end();
  }
  if(req.method==='POST'&&url.pathname==='/api/setup'){
   if(db.prepare('SELECT count(*) n FROM users').get().n)return send(res,403,{error:'Setup complete'});
   const b=await readBody(req);if(!b.admin||!b.viewer||b.admin===b.viewer||String(b.adminPassword).length<10||String(b.viewerPassword).length<10)throw Error('Use distinct usernames and passwords of at least 10 characters');
   transaction(()=>{db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(crypto.randomUUID(),b.admin,hash(b.adminPassword),'admin');db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(crypto.randomUUID(),b.viewer,hash(b.viewerPassword),'viewer');});return send(res,200,{});
  }
  if(req.method==='POST'&&url.pathname==='/api/login'){const b=await readBody(req),u=db.prepare('SELECT * FROM users WHERE name=?').get(b.username);if(!u||!valid(String(b.password||''),u.pass))return send(res,401,{error:'Invalid username or password'});issueSession(res,{userId:u.id});return send(res,200,{});}
  if(req.method==='POST'&&url.pathname==='/api/logout'){
   sessions.delete(sid);res.setHeader('set-cookie','sid=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/');
   // 浏览器仍持有 Kratos 会话时，前端需一并跳转 Kratos 登出，否则自动识别会立刻重新登录。
   const kc=KRATOS_ENABLED?readCookie(req,KRATOS_SESSION_COOKIE):null;
   return send(res,200,kc?{kratosLogoutUrl:kratosLogoutUrl()}:{});
  }
  if(!user)return send(res,401,{error:'Please log in'});
  if(req.method==='GET'&&url.pathname==='/api/me'){res.setHeader('cache-control','no-store');return send(res,200,{role:user.role,name:user.name,via:user.via||'local'});}
  if(req.method==='GET'&&url.pathname==='/api/bot/settings'){if(user.role!=='admin')return send(res,403,{error:'Admin required'});return send(res,200,{adminQqs:getBotAdmins(),connected:bot.isConnected()});}
  if(req.method==='PUT'&&url.pathname==='/api/bot/settings'){if(user.role!=='admin')return send(res,403,{error:'Admin required'});const b=await readBody(req);const list=[...new Set((Array.isArray(b.adminQqs)?b.adminQqs:[]).map(x=>String(x).trim()).filter(x=>/^\d{5,12}$/.test(x)))].slice(0,100);setSetting('bot.adminQqs',JSON.stringify(list));return send(res,200,{adminQqs:list});}
  if(req.method==='GET'&&url.pathname==='/api/ledger'){
   const from=url.searchParams.get('from')||'0000',to=url.searchParams.get('to')||'9999';
   const rows=db.prepare('SELECT id FROM entries WHERE deleted=0 AND date>=? AND date<=? ORDER BY date DESC,created_at DESC').all(from,to).map(x=>entry(x.id));
   const p=db.prepare("SELECT COALESCE(SUM(CASE WHEN kind='income' THEN amount_cents ELSE 0 END),0) income,COALESCE(SUM(CASE WHEN kind='expense' THEN amount_cents ELSE 0 END),0) expense FROM entries WHERE deleted=0 AND date>=? AND date<=?").get(from,to);
   const balance=db.prepare("SELECT COALESCE(SUM(CASE WHEN kind='income' THEN amount_cents ELSE -amount_cents END),0) n FROM entries WHERE deleted=0").get().n;
   return send(res,200,{rows,balanceCents:balance,incomeCents:p.income,expenseCents:p.expense});
  }
  if(req.method==='POST'&&url.pathname==='/api/entries'){
   if(user.role!=='admin')return send(res,403,{error:'Admin required'});const b=await readBody(req);
   if(!['income','expense'].includes(b.kind)||!b.reason||!/^\d{4}-\d{2}-\d{2}$/.test(b.date))throw Error('Complete entry fields');if(b.kind==='expense'&&!String(b.operator||'').trim())throw Error('Expense operator required');
   const uploads=(b.attachments||[]).slice(0,5).map(parseAttachment).filter(Boolean);
   const id=createEntryRecord({kind:b.kind,amountCents:cents(b.amount),reason:b.reason,date:b.date,note:b.note,operator:b.operator,createdBy:user.name},uploads);
   return send(res,200,entry(id));
  }
  const m=url.pathname.match(/^\/api\/entries\/([\w-]+)(?:\/receipt\/([\w-]+))?$/);
  if(m&&req.method==='GET'){
   const e=entry(m[1]);if(!e||e.deleted)return send(res,404,{error:'Entry not found'});
   if(m[2]){const a=e.attachments.find(x=>x.id===m[2]);if(!a)return send(res,404,{error:'Receipt not found'});const file=path.join(FILES,a.file);if(!fs.existsSync(file))return send(res,404,{error:'Receipt file missing'});res.setHeader('cache-control','private, no-store');return send(res,200,{name:a.name,mime:attMime(a),data:fs.readFileSync(file).toString('base64')});}
   const history=db.prepare('SELECT action,by_user by,at,before_state,after_state FROM audit WHERE entry_id=? ORDER BY id').all(e.id).map(a=>({action:a.action,by:a.by,at:a.at,before:a.before_state?JSON.parse(a.before_state):null,after:a.after_state?JSON.parse(a.after_state):null}));return send(res,200,{...e,history});
  }
  if(m&&req.method==='PATCH'){
   if(user.role!=='admin')return send(res,403,{error:'Admin required'});const old=entry(m[1]);if(!old)return send(res,404,{error:'Entry not found'});const b=await readBody(req),n={...old,...b};
   if(!['income','expense'].includes(n.kind)||!n.reason||!/^\d{4}-\d{2}-\d{2}$/.test(n.date)||n.kind==='expense'&&!String(n.operator||'').trim())throw Error('Check type, date, reason and operator');const at=new Date().toISOString();
   transaction(()=>{db.prepare('UPDATE entries SET kind=?,amount_cents=?,reason=?,date=?,note=?,operator=?,updated_at=?,updated_by=?,version=version+1 WHERE id=?').run(n.kind,b.amount===undefined?old.amountCents:cents(b.amount),String(n.reason).slice(0,160),n.date,String(n.note||'').slice(0,1000),String(n.operator||'').slice(0,120),at,user.name,old.id);db.prepare('INSERT INTO audit(entry_id,action,by_user,at,before_state,after_state) VALUES(?,?,?,?,?,?)').run(old.id,'update',user.name,at,snap(old),snap(entry(old.id)));});return send(res,200,entry(old.id));
  }
  if(m&&req.method==='DELETE'){
   if(user.role!=='admin')return send(res,403,{error:'Admin required'});const old=entry(m[1]);if(!old)return send(res,404,{error:'Entry not found'});const at=new Date().toISOString();
   transaction(()=>{db.prepare('UPDATE entries SET deleted=1,deleted_at=?,deleted_by=? WHERE id=?').run(at,user.name,old.id);db.prepare('INSERT INTO audit(entry_id,action,by_user,at,before_state,after_state) VALUES(?,?,?,?,?,?)').run(old.id,'delete',user.name,at,snap(old),snap(entry(old.id)));});return send(res,200,{});
  }
  if(req.method==='POST'&&url.pathname==='/api/password'){
   if(user.role!=='admin')return send(res,403,{error:'Admin required'});const b=await readBody(req),target=db.prepare('SELECT * FROM users WHERE role=?').get(b.role);if(!target||String(b.password||'').length<10)throw Error('Password must be at least 10 characters');db.prepare('UPDATE users SET pass=? WHERE id=?').run(hash(b.password),target.id);for(const [t,s] of sessions)if(s&&s.userId===target.id)sessions.delete(t);return send(res,200,{});
  }
  if(req.method==='GET'&&url.pathname==='/api/audit'){const entryId=url.searchParams.get('entryId');const rows=db.prepare('SELECT a.id,a.entry_id entryId,a.action,a.by_user by,a.at,a.before_state before_state,a.after_state after_state,e.reason,e.kind,e.amount_cents,e.date FROM audit a LEFT JOIN entries e ON e.id=a.entry_id'+(entryId?' WHERE a.entry_id=?':'')+' ORDER BY a.id DESC').all(...(entryId?[entryId]:[]));return send(res,200,rows.map(a=>({id:a.id,entryId:a.entryId,action:a.action,by:a.by,at:a.at,before:a.before_state?JSON.parse(a.before_state):null,after:a.after_state?JSON.parse(a.after_state):null,reason:a.reason,kind:a.kind,amountCents:a.amount_cents,date:a.date})));}
  return send(res,404,{error:'Not found'});
 }catch(e){if(!res.headersSent)send(res,400,{error:e.message||'Request failed'});}
});
const bot=startBot({getAdmins:getBotAdmins,createEntryRecord,cents});
const PORT=Number(process.env.PORT||3000);
// 可选：HOST=127.0.0.1（只监听本机，配合反向代理）或 HOST=0.0.0.0（仅 IPv4）等。
const HOST=process.env.HOST;
const onListen=()=>console.log(`Ledger running at http://${HOST||'localhost'}:${PORT}`);
if(HOST)server.listen(PORT,HOST,onListen);else server.listen(PORT,onListen);
