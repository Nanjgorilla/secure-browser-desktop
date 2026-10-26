'use strict';
const { app, BrowserWindow, WebContentsView, session, ipcMain, dialog, protocol, net, webContents, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { getDomain } = require('tldts');
const { ElectronBlocker } = require('@ghostery/adblocker-electron');

// ---- グローバルなセキュリティ設定 ----
app.enableSandbox();                       // 全レンダラーをサンドボックス化
app.commandLine.appendSwitch('disable-features', 'MediaRouter,OptimizationHints,Translate,InterestFeedContentSuggestions');
app.commandLine.appendSwitch('no-pings');  // <a ping> を無効化
protocol.registerSchemesAsPrivileged([{ scheme: 'sb', privileges: { standard: true, secure: true } }]);

const SEARCH = 'https://duckduckgo.com/?q=';
const HOME = 'https://duckduckgo.com/';
const TOOLBAR_H = 84;
const DANGEROUS_EXT = /\.(exe|msi|bat|cmd|com|scr|ps1|vbs|js|jar|hta|lnk|dmg|pkg|app|sh|run|appimage|deb|rpm)$/i;
const SMOKE = process.env.SB_SMOKE_URL || '';

let win, blocker, web;
const tabs = new Map(); let activeId = null, nextId = 1;
const httpAllowed = new Set();                 // ユーザーがHTTP続行を許可したホスト
const permGrants = new Map();                  // origin|permission -> bool（セッション中のみ）
let blockedCount = 0;

function siteOf(u) { try { const h = new URL(u).hostname; return getDomain(h) || h; } catch { return null; } }
function topUrlFor(details) {
  try { if (details.resourceType === 'mainFrame') return details.url; const wc = webContents.fromId(details.webContentsId); return wc ? wc.getURL() : null; } catch { return null; }
}
function isThirdParty(details) {
  const top = topUrlFor(details); if (!top) return false;
  const a = siteOf(top), b = siteOf(details.url); return a && b && a !== b;
}
function isAllowedScheme(u) {
  try { const p = new URL(u).protocol; return p === 'https:' || p === 'http:' || p === 'sb:' || u === 'about:blank'; } catch { return false; }
}

async function setupWebSession() {
  web = session.fromPartition('persist:web');
  web.setSpellCheckerEnabled(false);
  web.setUserAgent(web.getUserAgent().replace(/ Electron\/\S+/, '').replace(/ secure-browser\/\S+/, ''));
  web.protocol.handle('sb', (req) => {
    const u = new URL(req.url);
    if (u.hostname === 'warning') {
      const esc = (x) => String(x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      const target = u.searchParams.get('u') || '';
      if (!target.startsWith('http://')) return new Response('bad', { status: 400 });
      const html = fs.readFileSync(path.join(__dirname, 'ui', 'warning.html'), 'utf8')
        .replace('{{U}}', esc(target)).replace('{{E}}', esc(u.searchParams.get('e') || '')).replace('{{HREF}}', esc('sb://allow-http/?u=' + encodeURIComponent(target)));
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    return new Response('not found', { status: 404 });
  });

  const buf = fs.readFileSync(path.join(__dirname, '..', 'assets', 'engine.bin'));
  blocker = ElectronBlocker.deserialize(new Uint8Array(buf));
  blocker.enableBlockingInSession(web);        // コスメティックフィルタ用preload/IPCを登録
  if (SMOKE) { blocker.on('style-injected', (st, url) => console.log('[style-injected]', url, st.length)); blocker.on('script-injected', (sc, url) => console.log('[script-injected]', url)); }
  blocker.on('request-blocked', (r) => { blockedCount++; if (SMOKE) console.log('[blocked]', r.url); sendUI('blocked', blockedCount); });

  // webRequest は1イベント1リスナーのため、ブロッカー処理をラップして独自処理を追加
  web.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, cb) => {
    if (details.resourceType === 'mainFrame' && details.url.startsWith('http://')) {
      const host = new URL(details.url).host;
      if (!httpAllowed.has(host) && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) return cb({ redirectURL: 'https://' + details.url.slice(7) }); // HTTPS-only 昇格
    }
    blocker.onBeforeRequest(details, cb);
  });
  web.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, cb) => {
    const h = details.requestHeaders;
    h['DNT'] = '1'; h['Sec-GPC'] = '1';
    if (isThirdParty(details)) delete h['Cookie'];   // サードパーティCookie送信禁止
    cb({ requestHeaders: h });
  });
  web.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, cb) => {
    blocker.onHeadersReceived(details, (res) => {
      if (isThirdParty(details)) {
        const rh = res.responseHeaders || { ...details.responseHeaders };
        for (const k of Object.keys(rh)) if (k.toLowerCase() === 'set-cookie') delete rh[k];
        return cb({ ...res, responseHeaders: rh });
      }
      cb(res);
    });
  });

  // 権限要求：既定は拒否、ユーザーに確認
  const NAMES = { media: 'カメラ/マイク', geolocation: '位置情報', notifications: '通知', 'clipboard-read': 'クリップボード読み取り', midi: 'MIDI', midiSysex: 'MIDI', pointerLock: 'ポインタロック', fullscreen: '全画面表示', openExternal: '外部アプリを開く', 'display-capture': '画面共有', hid: 'HIDデバイス', serial: 'シリアルポート', usb: 'USBデバイス' };
  web.setPermissionRequestHandler(async (wc, permission, cb, details) => {
    if (permission === 'fullscreen') return cb(true);
    let origin = 'unknown'; try { origin = new URL(details.requestingUrl || wc.getURL()).origin; } catch {}
    const key = origin + '|' + permission;
    if (permGrants.has(key)) return cb(permGrants.get(key));
    if (SMOKE || !win) return cb(false);
    const r = await dialog.showMessageBox(win, { type: 'question', buttons: ['拒否', '今回のみ許可'], defaultId: 0, cancelId: 0,
      title: '権限の要求', message: `${origin} が「${NAMES[permission] || permission}」へのアクセスを求めています。`, detail: '許可しない場合は「拒否」を選んでください。（既定：拒否）' });
    const ok = r.response === 1; permGrants.set(key, ok); cb(ok);
  });
  web.setPermissionCheckHandler((wc, permission, origin) => permission === 'fullscreen' || permGrants.get(origin + '|' + permission) === true);
  web.setDevicePermissionHandler(() => false);

  // 安全なダウンロード
  web.on('will-download', async (e, item) => {
    const name = item.getFilename();
    if (DANGEROUS_EXT.test(name) && win) {
      const r = dialog.showMessageBoxSync(win, { type: 'warning', buttons: ['キャンセル', '保存する'], defaultId: 0, cancelId: 0,
        title: '危険な可能性のあるファイル', message: `「${name}」は実行可能なファイルです。`, detail: `配布元: ${item.getURL()}\n信頼できる提供元からのファイルでない限り保存しないでください。` });
      if (r !== 1) return item.cancel();
    }
    item.setSaveDialogOptions({ title: '名前を付けて保存', defaultPath: path.join(app.getPath('downloads'), name) });
    item.once('done', (_e, state) => sendUI('download', { name, state }));
  });
}

function sendUI(ch, payload) { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); }
function tabInfo(t) { const wc = t.view.webContents; return { id: t.id, title: wc.getTitle() || '新しいタブ', url: wc.getURL(), canBack: wc.navigationHistory.canGoBack(), canFwd: wc.navigationHistory.canGoForward(), loading: wc.isLoading() }; }
function pushTabs() { sendUI('tabs', { tabs: [...tabs.values()].map(tabInfo), activeId }); }
function layout() {
  if (!win) return; const [w, h] = win.getContentSize();
  for (const t of tabs.values()) t.view.setBounds(t.id === activeId ? { x: 0, y: TOOLBAR_H, width: w, height: Math.max(0, h - TOOLBAR_H) } : { x: 0, y: 0, width: 0, height: 0 });
}

function toUrl(input) {
  const s = (input || '').trim(); if (!s) return HOME;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[^\s]+\.[^\s]{2,}(\/.*)?$/.test(s) && !s.includes(' ')) return 'https://' + s;
  if (/^localhost(:\d+)?(\/.*)?$/.test(s)) return 'http://' + s;
  return SEARCH + encodeURIComponent(s);
}

function createTab(url = HOME) {
  const id = nextId++;
  const view = new WebContentsView({ webPreferences: {
    session: web, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false,
    webSecurity: true, allowRunningInsecureContent: false, experimentalFeatures: false, webviewTag: false,
    navigateOnDragDrop: false, spellcheck: false, safeDialogs: true, enableWebSQL: false } });
  const t = { id, view, upgraded: null }; tabs.set(id, t);
  win.contentView.addChildView(view);
  const wc = view.webContents;
  if (SMOKE) { wc.on('console-message', (e) => console.log('[console]', e.message)); wc.on('preload-error', (_e, p, err) => console.log('[preload-error]', p, err)); }
  const guard = (e, u) => { if (!isAllowedScheme(u)) { e.preventDefault(); return; }
    const m = u.match(/^sb:\/\/allow-http\/?\?u=(.+)$/);
    if (m) { e.preventDefault(); const target = decodeURIComponent(m[1]); if (target.startsWith('http://')) { httpAllowed.add(new URL(target).host); wc.loadURL(target); } } };
  wc.on('will-navigate', guard); wc.on('will-redirect', guard); wc.on('will-frame-navigate', (e) => { if (!isAllowedScheme(e.url)) e.preventDefault(); });
  wc.setWindowOpenHandler(({ url, disposition }) => {
    if ((disposition === 'foreground-tab' || disposition === 'background-tab') && isAllowedScheme(url)) { createTab(url); }
    else sendUI('popup-blocked', url);
    return { action: 'deny' };                   // ポップアップウィンドウは常にブロック
  });
  wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (!isMain || code === -3) return;
    // HTTPS昇格に失敗 → 警告ページ
    if (url.startsWith('https://') && t.lastRequestedHttp && t.lastRequestedHttp.slice(7) === url.slice(8)) {
      const http = t.lastRequestedHttp; t.lastRequestedHttp = null;
      wc.loadURL('sb://warning/?u=' + encodeURIComponent(http) + '&e=' + encodeURIComponent(desc));
    }
  });
  wc.on('context-menu', (_e, p) => {
    const items = [];
    if (p.linkURL && isAllowedScheme(p.linkURL)) items.push({ label: 'リンクを新しいタブで開く', click: () => createTab(p.linkURL) });
    if (p.selectionText) items.push({ label: 'コピー', role: 'copy' }, { label: `DuckDuckGoで「${p.selectionText.slice(0, 20)}」を検索`, click: () => createTab(SEARCH + encodeURIComponent(p.selectionText)) });
    if (p.isEditable) items.push({ label: '切り取り', role: 'cut' }, { label: '貼り付け', role: 'paste' });
    items.push({ label: '戻る', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() }, { label: '再読み込み', click: () => wc.reload() });
    Menu.buildFromTemplate(items).popup({ window: win });
  });
  for (const ev of ['page-title-updated', 'did-navigate', 'did-navigate-in-page', 'did-start-loading', 'did-stop-loading']) wc.on(ev, pushTabs);
  navigate(t, url);
  activate(id);
  return id;
}
function navigate(t, url) {
  if (!isAllowedScheme(url)) return;
  if (url.startsWith('http://') && !httpAllowed.has(new URL(url).host)) t.lastRequestedHttp = url;
  t.view.webContents.loadURL(url).catch(() => {});
}
function activate(id) { if (!tabs.has(id)) return; activeId = id; layout(); pushTabs(); }
function closeTab(id) {
  const t = tabs.get(id); if (!t) return;
  win.contentView.removeChildView(t.view); t.view.webContents.close(); tabs.delete(id);
  if (activeId === id) { const rest = [...tabs.keys()]; if (rest.length) activate(rest[rest.length - 1]); else createTab(); }
  else pushTabs();
}

function createWindow() {
  win = new BrowserWindow({ width: 1280, height: 860, title: 'セキュアブラウザ', backgroundColor: '#1e1f24', show: !SMOKE || true,
    webPreferences: { preload: path.join(__dirname, 'ui-preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, spellcheck: false } });
  win.removeMenu();
  win.webContents.on('will-navigate', (e) => e.preventDefault());     // UIは移動させない
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.on('resize', layout);
  win.webContents.once('did-finish-load', () => { createTab(SMOKE || HOME); if (SMOKE) runSmoke(); });
  win.webContents.on('before-input-event', (_e, i) => {
    if (i.type !== 'keyDown' || !(i.control || i.meta)) return;
    const k = i.key.toLowerCase();
    if (k === 't') createTab(); else if (k === 'w') closeTab(activeId); else if (k === 'l') sendUI('focus-address');
    else if (k === 'r') tabs.get(activeId)?.view.webContents.reload();
  });
}

function runSmoke() {
  const t = tabs.get(activeId);
  t.view.webContents.once('did-finish-load', () => setTimeout(async () => {
    const title = t.view.webContents.getTitle();
    console.log(`SMOKE_RESULT url=${t.view.webContents.getURL()} title="${title}" blocked=${blockedCount}`);
    try { const s = await t.view.webContents.executeJavaScript("(document.getElementById('ad1')?'ad1.display='+getComputedStyle(document.getElementById('ad1')).display+' | ':'')+document.body.innerText.slice(0,600)"); console.log('PAGE_TEXT:', s.replace(/\s+/g, ' ')); } catch {}
    const img = await win.webContents.capturePage().catch(() => null);
    const img2 = await t.view.webContents.capturePage().catch(() => null);
    if (img && process.env.SB_SMOKE_UISHOT) fs.writeFileSync(process.env.SB_SMOKE_UISHOT, img.toPNG());
    if (img2) fs.writeFileSync(process.env.SB_SMOKE_SHOT || '/tmp/sb-smoke.png', img2.toPNG());
    app.quit();
  }, 8000));
}

// UI からの IPC（送信元を検証）
function fromUI(e) { return win && e.sender === win.webContents; }
ipcMain.on('nav', (e, input) => { if (!fromUI(e)) return; const t = tabs.get(activeId); if (t) navigate(t, toUrl(input)); });
ipcMain.on('back', (e) => { if (fromUI(e)) tabs.get(activeId)?.view.webContents.navigationHistory.goBack(); });
ipcMain.on('forward', (e) => { if (fromUI(e)) tabs.get(activeId)?.view.webContents.navigationHistory.goForward(); });
ipcMain.on('reload', (e) => { if (fromUI(e)) tabs.get(activeId)?.view.webContents.reload(); });
ipcMain.on('stop', (e) => { if (fromUI(e)) tabs.get(activeId)?.view.webContents.stop(); });
ipcMain.on('home', (e) => { if (fromUI(e)) { const t = tabs.get(activeId); if (t) navigate(t, HOME); } });
ipcMain.on('new-tab', (e) => { if (fromUI(e)) createTab(); });
ipcMain.on('close-tab', (e, id) => { if (fromUI(e)) closeTab(Number(id)); });
ipcMain.on('activate', (e, id) => { if (fromUI(e)) activate(Number(id)); });
ipcMain.on('clear-data', async (e) => { if (!fromUI(e)) return; await web.clearStorageData(); await web.clearCache(); permGrants.clear(); httpAllowed.clear(); sendUI('toast', '閲覧データを削除しました'); });

// どのwebContentsでも remote/webview の付加を防止
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());
});

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_w, _p, cb) => cb(false));
  session.defaultSession.webRequest.onHeadersReceived((d, cb) => cb({ responseHeaders: { ...d.responseHeaders,
    'Content-Security-Policy': ["default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"] } }));
  await setupWebSession();
  createWindow();
});
app.on('window-all-closed', () => app.quit());
