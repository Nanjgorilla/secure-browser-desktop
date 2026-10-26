// EasyList/EasyPrivacy を事前コンパイルして assets/engine.bin に保存（オフライン初回起動用）
const fs = require('fs'), path = require('path');
const { ElectronBlocker } = require('@ghostery/adblocker-electron');
const a = path.join(__dirname, '..', 'assets');
const lists = ['easylist.txt', 'easyprivacy.txt'].map(f => fs.readFileSync(path.join(a, f), 'utf8')).join('\n');
const blocker = ElectronBlocker.parse(lists, { loadCosmeticFilters: true, loadNetworkFilters: true });
fs.writeFileSync(path.join(a, 'engine.bin'), blocker.serialize());
console.log('engine.bin written', fs.statSync(path.join(a, 'engine.bin')).size);
