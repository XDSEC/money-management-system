#!/usr/bin/env node
/**
 * 用 Bun 把后端编译成单文件可执行程序，并把前端文件、.env 模板和 PDF 预览依赖
 * 放到同一个输出目录中。
 *
 * 用法：
 *   node scripts/build-binary.mjs [target]
 *   target: linux-x64（默认）、linux-arm64、windows-x64、darwin-x64、darwin-arm64
 *
 * 需要：npm install 安装 pdfjs-dist；Bun 可通过 PATH 提供，或自动用 npx 下载 1.4.5。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = {
  'linux-x64': { bun: 'bun-linux-x64', bin: 'ledger' },
  'linux-arm64': { bun: 'bun-linux-arm64', bin: 'ledger' },
  'windows-x64': { bun: 'bun-windows-x64', bin: 'ledger.exe' },
  'darwin-x64': { bun: 'bun-darwin-x64', bin: 'ledger' },
  'darwin-arm64': { bun: 'bun-darwin-arm64', bin: 'ledger' },
};

const targetName = process.argv[2] || 'linux-x64';
const target = TARGETS[targetName];
if (!target) {
  console.error(`未知目标：${targetName}\n可选：${Object.keys(TARGETS).join('、')}`);
  process.exit(1);
}

function quoteWin(value) {
  return /[\s"]/.test(value) ? `"${String(value).replace(/"/g, '\\"')}"` : value;
}

function run(cmd, args, opts = {}) {
  const winShell = process.platform === 'win32' && /\.cmd$/i.test(cmd);
  const result = winShell
    ? spawnSync([cmd, ...args].map(quoteWin).join(' '), { ...opts, shell: true })
    : spawnSync(cmd, args, opts);
  if (result.error || result.status !== 0) {
    if (result.error) console.error(result.error.message);
    process.exit(result.status ?? 1);
  }
}

function versionAtLeast(version, minimum) {
  const a = String(version).split('.').map(Number);
  const b = String(minimum).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return true;
}

function detectBun() {
  if (process.env.BUN) return { cmd: process.env.BUN, prefix: [] };
  const candidates = process.platform === 'win32' ? ['bun.exe', 'bun.cmd', 'bun'] : ['bun'];
  for (const cmd of candidates) {
    const r = spawnSync(cmd, ['--version'], { encoding: 'utf8', shell: /\.cmd$/i.test(cmd) });
    if (r.error || r.status !== 0) continue;
    const version = String(r.stdout || '').trim();
    if (!versionAtLeast(version, '1.4.5')) {
      console.log(`检测到 Bun ${version}，低于 1.4.5，改用 npx 获取 bun@1.4.5…`);
      break;
    }
    return { cmd, prefix: [] };
  }
  console.log('未找到可用的 Bun，改用 npx 获取 bun@1.4.5（首次运行需要联网）…');
  return { cmd: process.platform === 'win32' ? 'npx.cmd' : 'npx', prefix: ['--yes', 'bun@1.4.5'] };
}

function copyFile(src, dst) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return true;
}

function copyDir(src, dst) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
  return true;
}

const outDir = path.join(root, 'dist', targetName);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const outfile = path.join(outDir, target.bin);

const bun = detectBun();
console.log(`\n编译 ${targetName} → ${path.relative(root, outfile)}`);
run(bun.cmd, [...bun.prefix, 'build', '--compile', `--target=${target.bun}`, path.join(root, 'server.js'), '--outfile', outfile], {
  cwd: root,
  stdio: 'inherit',
});

// 与二进制放在同一目录、由 server.js 在运行时读取的文件。
copyFile(path.join(root, 'index.html'), path.join(outDir, 'index.html'));
copyFile(path.join(root, 'app.js'), path.join(outDir, 'app.js'));
copyFile(path.join(root, '.env.example'), path.join(outDir, '.env.example'));

// PDF.js 静态资源（PDF 预览用）。服务端会依次查找 <BASE>/vendor 和 <BASE>/node_modules/pdfjs-dist。
const pdfRoot = path.join(root, 'node_modules', 'pdfjs-dist');
const vendorDir = path.join(outDir, 'vendor');
const copied = [
  copyFile(path.join(pdfRoot, 'build', 'pdf.mjs'), path.join(vendorDir, 'build', 'pdf.mjs')),
  copyFile(path.join(pdfRoot, 'build', 'pdf.worker.mjs'), path.join(vendorDir, 'build', 'pdf.worker.mjs')),
  copyDir(path.join(pdfRoot, 'standard_fonts'), path.join(vendorDir, 'standard_fonts')),
  copyDir(path.join(pdfRoot, 'cmaps'), path.join(vendorDir, 'cmaps')),
].filter(Boolean).length;
if (!copied) {
  console.warn('警告：未找到 node_modules/pdfjs-dist，PDF 预览将不可用（请先运行 npm install）。');
}

const isLinux = targetName.startsWith('linux');
console.log(`
输出目录：${path.relative(root, outDir)}

部署（Debian 13 等 Linux 服务器）：
  1. 把整个 ${targetName} 目录拷到服务器
  2. cd 到该目录，复制并修改配置：cp .env.example .env
  3. 启动：${isLinux ? `chmod +x ${target.bin} && ./${target.bin}` : target.bin}

数据默认写入二进制旁边的 data/ 目录；如果该位置不可写，可在 .env 中设置
LEDGER_DATA_DIR=/var/lib/ledger（或任意可写目录）。
`);
