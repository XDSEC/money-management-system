const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA = path.join(__dirname, 'data');
const FILES = path.join(DATA, 'receipts');
fs.mkdirSync(FILES, { recursive: true });
const db = new DatabaseSync(path.join(DATA, 'ledger.sqlite'));
db.exec(`PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT UNIQUE NOT NULL,pass TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','viewer')));
CREATE TABLE IF NOT EXISTS entries(id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('income','expense')),amount_cents INTEGER NOT NULL CHECK(amount_cents>0),reason TEXT NOT NULL,date TEXT NOT NULL,note TEXT NOT NULL DEFAULT '',operator TEXT NOT NULL DEFAULT '',deleted INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,created_by TEXT NOT NULL,updated_at TEXT,updated_by TEXT,deleted_at TEXT,deleted_by TEXT,version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY,entry_id TEXT NOT NULL REFERENCES entries(id),name TEXT NOT NULL,file TEXT NOT NULL,mime TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,entry_id TEXT NOT NULL,action TEXT NOT NULL,by_user TEXT NOT NULL,at TEXT NOT NULL,before_state TEXT,after_state TEXT);
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
function cookie(req) { return (req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('sid='))?.slice(4); }
const sessions=new Map();
function send(res,status,data) { res.writeHead(status,{'content-type':'application/json; charset=utf-8','x-content-type-options':'nosniff'}); res.end(JSON.stringify(data)); }
function readBody(req) { return new Promise((resolve,reject)=>{let s='';req.on('data',c=>{s+=c;if(s.length>14e6)reject(Error('Request too large'));});req.on('end',()=>{try{resolve(JSON.parse(s||'{}'));}catch{reject(Error('Invalid JSON'));}});}); }
function cents(v) { const s=String(v); if(!/^\d{1,10}(\.\d{1,2})?$/.test(s)||Number(s)<=0)throw Error('Invalid amount'); const [a,b='']=s.split('.'); return Number(a)*100+Number((b+'00').slice(0,2)); }
function entry(id) { const e=db.prepare('SELECT * FROM entries WHERE id=?').get(id); if(!e)return null; return {id:e.id,kind:e.kind,amountCents:e.amount_cents,reason:e.reason,date:e.date,note:e.note,operator:e.operator,deleted:!!e.deleted,createdAt:e.created_at,createdBy:e.created_by,updatedAt:e.updated_at,updatedBy:e.updated_by,deletedAt:e.deleted_at,deletedBy:e.deleted_by,version:e.version,attachments:db.prepare('SELECT id,name,file,mime FROM attachments WHERE entry_id=?').all(id)}; }
function attMime(a) { if(a.mime&&a.mime!=='application/octet-stream')return a.mime; const ext=(String(a.file).split('.').pop()||'').toLowerCase(); return {pdf:'application/pdf',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp'}[ext]||'application/octet-stream'; }
function snap(e) { return JSON.stringify(e); }

const server=http.createServer(async(req,res)=>{
 try {
  const url=new URL(req.url,'http://localhost'),sid=cookie(req),uid=sessions.get(sid),user=uid?db.prepare('SELECT * FROM users WHERE id=?').get(uid):null;
  if(req.method==='GET'&&url.pathname==='/'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'});return res.end(fs.readFileSync(path.join(__dirname,'index.html')));}
  if(req.method==='GET'&&url.pathname==='/app.js'){res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-cache'});return fs.createReadStream(path.join(__dirname,'app.js')).pipe(res);}
  if(req.method==='GET'&&['/vendor/pdf.mjs','/vendor/pdf.worker.mjs'].includes(url.pathname)){
   const file=path.join(__dirname,'node_modules','pdfjs-dist','build',url.pathname.endsWith('worker.mjs')?'pdf.worker.mjs':'pdf.mjs');
   if(!fs.existsSync(file))return send(res,503,{error:'PDF viewer dependency missing; run pnpm install'});
   res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'public, max-age=3600'});return fs.createReadStream(file).pipe(res);
  }
  if(req.method==='GET'&&/^\/vendor\/(standard_fonts|cmaps)\/[\w.-]+$/.test(url.pathname)){
   const [,dir,name]=url.pathname.match(/^\/vendor\/(standard_fonts|cmaps)\/([\w.-]+)$/);
   const file=path.join(__dirname,'node_modules','pdfjs-dist',dir,name);
   if(!fs.existsSync(file))return send(res,404,{error:'Not found'});
   res.writeHead(200,{'content-type':'application/octet-stream','cache-control':'public, max-age=86400'});return fs.createReadStream(file).pipe(res);
  }
  if(req.method==='GET'&&url.pathname==='/api/setup-status')return send(res,200,{setup:db.prepare('SELECT count(*) n FROM users').get().n===0});
  if(req.method==='POST'&&url.pathname==='/api/setup'){
   if(db.prepare('SELECT count(*) n FROM users').get().n)return send(res,403,{error:'Setup complete'});
   const b=await readBody(req);if(!b.admin||!b.viewer||b.admin===b.viewer||String(b.adminPassword).length<10||String(b.viewerPassword).length<10)throw Error('Use distinct usernames and passwords of at least 10 characters');
   transaction(()=>{db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(crypto.randomUUID(),b.admin,hash(b.adminPassword),'admin');db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(crypto.randomUUID(),b.viewer,hash(b.viewerPassword),'viewer');});return send(res,200,{});
  }
  if(req.method==='POST'&&url.pathname==='/api/login'){const b=await readBody(req),u=db.prepare('SELECT * FROM users WHERE name=?').get(b.username);if(!u||!valid(String(b.password||''),u.pass))return send(res,401,{error:'Invalid username or password'});const token=crypto.randomBytes(32).toString('hex');sessions.set(token,u.id);res.setHeader('set-cookie',`sid=${token}; HttpOnly; SameSite=Strict; Path=/`);return send(res,200,{});}
  if(req.method==='POST'&&url.pathname==='/api/logout'){sessions.delete(sid);res.setHeader('set-cookie','sid=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/');return send(res,200,{});}
  if(!user)return send(res,401,{error:'Please log in'});
  if(req.method==='GET'&&url.pathname==='/api/me')return send(res,200,{role:user.role,name:user.name});
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
   const id=crypto.randomUUID(),at=new Date().toISOString(),files=[];
   for(const a of (b.attachments||[]).slice(0,5)){const m=String(a.data||'').match(/^data:(image\/(?:png|jpeg|webp)|application\/pdf);base64,([\s\S]+)$/);if(!m)continue;const buf=Buffer.from(m[2],'base64');if(buf.length>4e6)throw Error('Attachment exceeds 4MB');const ext=m[1].split('/')[1].replace('jpeg','jpg'),f=crypto.randomUUID()+'.'+ext;fs.writeFileSync(path.join(FILES,f),buf);files.push({name:String(a.name||f).slice(0,120),file:f,mime:m[1]});}
   transaction(()=>{db.prepare('INSERT INTO entries(id,kind,amount_cents,reason,date,note,operator,created_at,created_by) VALUES(?,?,?,?,?,?,?,?,?)').run(id,b.kind,cents(b.amount),String(b.reason).slice(0,160),b.date,String(b.note||'').slice(0,1000),String(b.operator||'').slice(0,120),at,user.name);for(const f of files)db.prepare('INSERT INTO attachments VALUES(?,?,?,?,?)').run(crypto.randomUUID(),id,f.name,f.file,f.mime);db.prepare('INSERT INTO audit(entry_id,action,by_user,at,after_state) VALUES(?,?,?,?,?)').run(id,'create',user.name,at,snap(entry(id)));});return send(res,200,entry(id));
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
   if(user.role!=='admin')return send(res,403,{error:'Admin required'});const b=await readBody(req),target=db.prepare('SELECT * FROM users WHERE role=?').get(b.role);if(!target||String(b.password||'').length<10)throw Error('Password must be at least 10 characters');db.prepare('UPDATE users SET pass=? WHERE id=?').run(hash(b.password),target.id);for(const [t,id] of sessions)if(id===target.id)sessions.delete(t);return send(res,200,{});
  }
  if(req.method==='GET'&&url.pathname==='/api/audit'){if(user.role!=='admin')return send(res,403,{error:'Admin required'});const entryId=url.searchParams.get('entryId');const rows=db.prepare('SELECT a.id,a.entry_id entryId,a.action,a.by_user by,a.at,a.before_state before_state,a.after_state after_state,e.reason,e.kind,e.amount_cents,e.date FROM audit a LEFT JOIN entries e ON e.id=a.entry_id'+(entryId?' WHERE a.entry_id=?':'')+' ORDER BY a.id DESC').all(...(entryId?[entryId]:[]));return send(res,200,rows.map(a=>({id:a.id,entryId:a.entryId,action:a.action,by:a.by,at:a.at,before:a.before_state?JSON.parse(a.before_state):null,after:a.after_state?JSON.parse(a.after_state):null,reason:a.reason,kind:a.kind,amountCents:a.amount_cents,date:a.date})));}
  return send(res,404,{error:'Not found'});
 }catch(e){if(!res.headersSent)send(res,400,{error:e.message||'Request failed'});}
});
const PORT=Number(process.env.PORT||3000);
server.listen(PORT,()=>console.log(`Ledger running at http://localhost:${PORT}`));
