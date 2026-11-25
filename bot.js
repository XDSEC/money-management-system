'use strict';

const fs = require('node:fs');

// OneBot v11 (正向 WebSocket) 客户端：接收管理员 QQ 的记账指令，写入账本。
// 连接配置通过环境变量提供：
//   BOT_WS_URL  默认 ws://127.0.0.1:3001
//   BOT_TOKEN   与 OneBot 的 access_token 一致
//   BOT_ENABLE  设为 0 可关闭

const MAX_FILES = 5;
const MAX_BYTES = 4e6;
const SESSION_TTL = 15 * 60 * 1000;
const END_WORDS = ['完成', '结束', '好了', 'ok', 'done', 'finish'];
const CANCEL_WORDS = ['取消', '放弃', 'cancel'];

// BOT_WS_URL 留空时自动判断：容器内用 host.docker.internal，本机用 127.0.0.1。
const DEFAULT_WS_URL = fs.existsSync('/.dockerenv') ? 'ws://host.docker.internal:3001' : 'ws://127.0.0.1:3001';
const WS_URL = process.env.BOT_WS_URL || DEFAULT_WS_URL;
const TOKEN = process.env.BOT_TOKEN || '';
const ENABLED = String(process.env.BOT_ENABLE ?? '1') !== '0';
const RECONNECT_MAX = 30000;

function log(...args) { console.log('[bot]', ...args); }

function today() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function dirKind(v) {
  if (['o', 'out', 'expense', '支', '支出', '付', '-'].includes(v)) return 'expense';
  if (['i', 'in', 'income', '收', '收入', '+'].includes(v)) return 'income';
  return null;
}

// 命令：记 <o|i> <金额> <事由> <经办人(支出必填)> [1]
// 方向支持 o/out/支出 与 i/in/收入；末尾 1 表示随后发送凭据。
function parseCommand(text, cents) {
  const parts = text.replace(/^[!！/]+/, '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length || !['记账', 'jz'].includes(parts[0].toLowerCase())) return null;
  parts.shift();
  if (parts.length < 2) return { error: '命令不完整' };
  const kind = dirKind(parts.shift().toLowerCase());
  if (!kind) return { error: '方向应为 o/支出 或 i/收入' };
  let amountCents;
  try { amountCents = cents(parts.shift()); } catch { return { error: '金额格式不正确' }; }
  let receipts = false;
  const flag = parts.length ? parts[parts.length - 1] : '';
  if (flag === '0' || flag === '1') { receipts = flag === '1'; parts.pop(); }
  let operator = '';
  if (kind === 'expense') {
    if (parts.length < 2) return { error: '支出需要「事由 经办人」' };
    operator = parts.pop();
  }
  const reason = parts.join(' ').trim();
  if (!reason) return { error: '缺少事由' };
  return { receipts, data: { kind, amountCents, reason, operator, date: today(), note: '' } };
}

function extractText(ev, segs) {
  const parts = [];
  for (const s of segs) if (s && s.type === 'text' && s.data && typeof s.data.text === 'string') parts.push(s.data.text);
  const t = parts.join(' ').trim();
  if (t) return t;
  if (!segs.length && typeof ev.raw_message === 'string' && !ev.raw_message.includes('[CQ:')) return ev.raw_message.trim();
  return '';
}

function extractFiles(segs) {
  const out = [];
  for (const s of segs) {
    if (!s || !s.data) continue;
    if (s.type === 'image' || s.type === 'file') out.push({ type: s.type, data: s.data });
  }
  return out;
}

function normalizeMime(mime, name) {
  if (['image/png', 'image/jpeg', 'image/webp', 'application/pdf'].includes(mime)) return mime;
  const ext = (String(name).split('.').pop() || '').toLowerCase();
  return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', pdf: 'application/pdf' }[ext] || null;
}

module.exports = function startBot(services) {
  const sessions = new Map();
  const pending = new Map();
  let ws = null, connected = false, stopped = false, retry = 0, echoSeq = 0;

  const isConnected = () => !!(connected && ws && ws.readyState === 1);

  function withToken(url) {
    if (!TOKEN) return url;
    try { const u = new URL(url); u.searchParams.set('access_token', TOKEN); return u.toString(); } catch { return url; }
  }

  function connect() {
    if (stopped || !ENABLED) return;
    let socket;
    try { socket = new WebSocket(withToken(WS_URL)); } catch { scheduleReconnect(); return; }
    ws = socket;
    socket.addEventListener('open', () => { connected = true; retry = 0; log('已连接 OneBot:', WS_URL); });
    socket.addEventListener('message', ev => {
      let raw = ev.data;
      if (typeof raw !== 'string') { try { raw = Buffer.from(raw).toString('utf8'); } catch { return; } }
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      handle(msg);
    });
    socket.addEventListener('close', () => {
      connected = false;
      if (!stopped) log('OneBot 连接断开，准备重连');
      scheduleReconnect();
    });
    socket.addEventListener('error', () => {});
  }

  function scheduleReconnect() {
    if (stopped || !ENABLED) return;
    const ms = Math.min(RECONNECT_MAX, 1000 * Math.pow(2, Math.min(retry++, 4)));
    setTimeout(connect, ms);
  }

  function call(action, params) {
    return new Promise((resolve, reject) => {
      if (!isConnected()) return reject(Error('OneBot 未连接'));
      const echo = String(++echoSeq);
      const timer = setTimeout(() => { pending.delete(echo); reject(Error('OneBot 请求超时')); }, 15000);
      pending.set(echo, { resolve, reject, timer });
      try { ws.send(JSON.stringify({ action, params, echo })); }
      catch (e) { clearTimeout(timer); pending.delete(echo); reject(e); }
    });
  }

  async function reply(ev, text) {
    const message = [{ type: 'text', data: { text } }];
    try {
      if (ev.message_type === 'group') await call('send_group_msg', { group_id: ev.group_id, message });
      else await call('send_private_msg', { user_id: ev.user_id, message });
    } catch (e) { log('发送消息失败:', e.message); }
  }

  function handle(ev) {
    if (ev && ev.echo !== undefined) {
      const p = pending.get(String(ev.echo));
      if (p) {
        pending.delete(String(ev.echo)); clearTimeout(p.timer);
        if (ev.status === 'ok' || ev.retcode === 0) p.resolve(ev.data);
        else p.reject(Error(ev.wording || ev.message || 'OneBot 调用失败'));
      }
      return;
    }
    if (!ev || ev.post_type !== 'message') return;
    if (ev.message_type !== 'private' && ev.message_type !== 'group') return;
    handleMessage(ev).catch(e => log('处理消息出错:', e.message));
  }

  async function handleMessage(ev) {
    const qq = String(ev.user_id);
    const admins = services.getAdmins().map(String);
    if (!admins.includes(qq)) return;

    const isGroup = ev.message_type === 'group';
    const key = (isGroup ? 'g:' : 'p:') + (isGroup ? ev.group_id : qq);
    const segs = Array.isArray(ev.message) ? ev.message : [];
    const text = extractText(ev, segs).trim();
    const files = extractFiles(segs);

    const session = sessions.get(key);
    if (session) {
      if (session.owner !== qq) return;
      if (files.length) { await addFiles(session, ev, files); return; }
      if (!text) return;
      const low = text.toLowerCase();
      if (END_WORDS.includes(low)) { await finishSession(key, session, ev); return; }
      if (CANCEL_WORDS.includes(low)) { clearSession(key, session); await reply(ev, '已取消，账单未保存。'); return; }
      await reply(ev, '正在收集凭据：请发送图片或 PDF，发送「完成」结束，发送「取消」放弃。');
      return;
    }

    const cmd = parseCommand(text, services.cents);
    if (!cmd) return;
    if (cmd.error) { await reply(ev, `${cmd.error}。用法：记账 o 100 团建 林林 [1] / 记账 i 100 会费 [1]`); return; }
    cmd.data.createdBy = 'QQ:' + qq;

    if (!cmd.receipts) {
      try {
        services.createEntryRecord(cmd.data, []);
        await reply(ev, `已记账：${fmt(cmd.data)}`);
      } catch (e) { await reply(ev, '记账失败：' + e.message); }
      return;
    }

    const s = { owner: qq, data: cmd.data, uploads: [], timer: null, isGroup, groupId: ev.group_id, userId: ev.user_id };
    s.timer = setTimeout(() => finishSession(key, s, null), SESSION_TTL);
    sessions.set(key, s);
    await reply(ev, '请发送凭据（图片或 PDF，最多 5 份），发送「完成」结束，发送「取消」放弃。');
  }

  function fmt(d) {
    const kind = d.kind === 'income' ? '收入' : '支出';
    return `${kind} ¥${(d.amountCents / 100).toFixed(2)} ${d.reason}${d.operator ? '（经办：' + d.operator + '）' : ''}`;
  }

  function clearSession(key, session) {
    if (session.timer) clearTimeout(session.timer);
    sessions.delete(key);
  }

  async function addFiles(session, ev, files) {
    let added = 0; const errors = [];
    for (const f of files) {
      if (session.uploads.length >= MAX_FILES) { errors.push('最多 5 份凭据'); break; }
      try { session.uploads.push(await download(f)); added++; }
      catch (e) { errors.push(e.message); }
    }
    if (added) await reply(ev, `已收到 ${added} 份凭据（共 ${session.uploads.length} 份）。发送「完成」结束。`);
    if (errors.length) await reply(ev, '部分文件未保存：' + errors.join('；'));
  }

  async function download(seg) {
    const d = seg.data || {};
    const url = d.url || (/^https?:\/\//i.test(String(d.file || '')) ? d.file : '');
    if (!url || !/^https?:\/\//i.test(url)) throw Error('无法获取文件地址');
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw Error('文件下载失败');
    if (Number(res.headers.get('content-length') || 0) > MAX_BYTES) throw Error('单个文件超过 4MB');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw Error('单个文件超过 4MB');
    const name = String(d.name || d.file || 'receipt').split(/[\\/]/).pop().slice(0, 120);
    const mime = normalizeMime((res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(), name);
    if (!mime) throw Error('仅支持图片（PNG/JPEG/WebP）或 PDF');
    return { buf, mime, name };
  }

  async function finishSession(key, session, ev) {
    clearSession(key, session);
    const target = ev || { message_type: session.isGroup ? 'group' : 'private', group_id: session.groupId, user_id: session.userId };
    try {
      services.createEntryRecord(session.data, session.uploads);
      await reply(target, `已记账：${fmt(session.data)}，凭据 ${session.uploads.length} 份`);
    } catch (e) {
      await reply(target, '记账失败：' + e.message);
    }
  }

  if (ENABLED) connect(); else log('已通过 BOT_ENABLE=0 关闭');

  return {
    isConnected,
    stop() { stopped = true; try { ws && ws.close(); } catch {} }
  };
};

module.exports.parseCommand = parseCommand;
