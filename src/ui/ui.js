const $ = (id) => document.getElementById(id);
let state = { tabs: [], activeId: null };
function render() {
  const box = $('tabs'); box.textContent = '';
  for (const t of state.tabs) {
    const d = document.createElement('div'); d.className = 'tab' + (t.id === state.activeId ? ' active' : '');
    const s = document.createElement('span'); s.textContent = (t.loading ? '⏳ ' : '') + t.title; s.title = t.title;
    const x = document.createElement('button'); x.textContent = '×'; x.title = 'タブを閉じる';
    x.onclick = (e) => { e.stopPropagation(); sb.send('close-tab', t.id); };
    d.onclick = () => sb.send('activate', t.id); d.onauxclick = (e) => { if (e.button === 1) sb.send('close-tab', t.id); };
    d.append(s, x); box.append(d);
  }
  const a = state.tabs.find((t) => t.id === state.activeId);
  if (a) {
    if (document.activeElement !== $('addr')) $('addr').value = a.url.startsWith('sb://') ? '' : a.url;
    $('back').disabled = !a.canBack; $('fwd').disabled = !a.canFwd;
    const secure = a.url.startsWith('https://'); $('lock').textContent = secure ? '🔒' : '⚠'; $('lock').title = secure ? '安全な接続 (HTTPS)' : '保護されていない接続';
    document.title = a.title + ' - セキュアブラウザ';
  }
}
function toast(m) { const t = $('toast'); t.textContent = m; t.style.display = 'block'; clearTimeout(toast.h); toast.h = setTimeout(() => (t.style.display = 'none'), 2500); }
$('f').onsubmit = (e) => { e.preventDefault(); sb.send('nav', $('addr').value); $('addr').blur(); };
$('addr').onfocus = () => $('addr').select();
$('back').onclick = () => sb.send('back'); $('fwd').onclick = () => sb.send('forward');
$('reload').onclick = () => sb.send('reload'); $('home').onclick = () => sb.send('home');
$('newtab').onclick = () => sb.send('new-tab'); $('clear').onclick = () => sb.send('clear-data');
sb.on('tabs', (s) => { state = s; render(); });
sb.on('blocked', (n) => ($('cnt').textContent = n));
sb.on('popup-blocked', () => toast('ポップアップをブロックしました'));
sb.on('download', (d) => toast(d.state === 'completed' ? `ダウンロード完了: ${d.name}` : `ダウンロード中止: ${d.name}`));
sb.on('toast', toast); sb.on('focus-address', () => $('addr').focus());
