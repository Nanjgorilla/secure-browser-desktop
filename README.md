# SecureBrowser（セキュアブラウザ）

広告なし・セキュリティ重視のデスクトップブラウザです（Electron製、テレメトリーなし）。

## 主な機能
- タブ、アドレスバー（URLまたは検索語。検索は DuckDuckGo）、戻る／進む／再読み込み／ホーム
- 広告・トラッカーブロック（EasyList + EasyPrivacy を同梱。初回起動からオフラインで有効）。🛡 の数字がブロック数
- HTTPS 自動切り替え。HTTPS 非対応サイトは警告ページを表示し、同意した場合のみ HTTP で表示
- サードパーティ Cookie の送受信をブロック
- カメラ・マイク・位置情報・通知などの権限要求は「既定で拒否」、確認ダイアログで許可したときだけ（その起動中のみ）有効
- ポップアップウィンドウをブロック（Ctrl+クリック等は新しいタブで開く）
- Do Not Track / Global Privacy Control ヘッダーを送信
- 実行ファイル（.exe 等）のダウンロード時に警告。保存先は必ず確認
- 🧹 ボタンで Cookie・キャッシュなど閲覧データを一括削除
- 全ページをサンドボックス化（contextIsolation 有効、nodeIntegration 無効、webview 不使用、UI は厳格な CSP）
- ショートカット：Ctrl+T 新規タブ／Ctrl+W 閉じる／Ctrl+L アドレスバー／Ctrl+R 再読み込み

## インストール
### Windows
1. `SecureBrowser-Setup-1.0.0.exe` を実行します。
2. 署名なしのため「Windows によって PC が保護されました」と表示されたら、「詳細情報」→「実行」を押します。
3. インストール先を選んで完了。スタートメニューから起動できます。アンインストールは「設定 → アプリ」から。

### Linux
```
chmod +x SecureBrowser-1.0.0.AppImage
./SecureBrowser-1.0.0.AppImage
```
（FUSE がない環境では `--appimage-extract-and-run` を付けて起動）

## 開発者向け
```
npm install
npm run build:engine   # assets/easylist.txt, easyprivacy.txt からフィルタを再生成
npm start
npm run dist           # Windows(NSIS) と Linux(AppImage) をビルド
```
フィルタを最新にするには、assets の txt を EasyList 公式から取り直して `build:engine` → 再ビルドしてください（自動更新はしません）。

## 制限事項
- コード署名なし（Windows SmartScreen の警告が出ます）。自動アップデートなし。
- Mac 版は未提供。
- 拡張機能、ブックマーク、同期機能はありません。
