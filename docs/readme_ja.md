# Terminal Sidebar

[English](https://github.com/Photonico/terminal_sidebar/blob/main/README.md) · [简体中文](https://github.com/Photonico/terminal_sidebar/blob/main/docs/readme_zh.md) · **日本語**

[![CI](https://github.com/Photonico/terminal_sidebar/actions/workflows/ci.yml/badge.svg)](https://github.com/Photonico/terminal_sidebar/actions/workflows/ci.yml) [![Marketplace](https://img.shields.io/visual-studio-marketplace/v/ConAntares.terminal-sidebar)](https://marketplace.visualstudio.com/items?itemName=ConAntares.terminal-sidebar) [![Installs](https://img.shields.io/visual-studio-marketplace/i/ConAntares.terminal-sidebar)](https://marketplace.visualstudio.com/items?itemName=ConAntares.terminal-sidebar) [![MIT](https://img.shields.io/github/license/Photonico/terminal_sidebar)](https://github.com/Photonico/terminal_sidebar/blob/main/LICENSE)

VS Code のサイドバーで、独立したターミナルとドキュメントのプレビューを使えます。**Primary Side Bar（プライマリ サイド バー）**は折りたたみ式、**Secondary Side Bar（セカンダリ サイド バー）**はコンパクトなタブ形式です。Vim や Neovim などのコマンドラインツールと、実行結果やプレビューを並べて作業できます。

**0.10.0 は開発中です。** VS Code **1.106 以降**と、デスクトップまたはリモートの Node.js 拡張機能ホストが必要です。

## はじめに

1. **Extensions: Install from VSIX…** から、拡張機能ホストの環境に合った VSIX をインストールします。[Marketplace](https://marketplace.visualstudio.com/items?itemName=ConAntares.terminal-sidebar) では公開済みのバージョンも入手できます。
2. **Side Terminals** を開き、**+** でターミナルを作成します。矢印ボタンで反対側のビューを開けます。
3. 歯車ボタンで起動時のターミナルを設定します。ターミナルを閉じても、その起動プロファイルは削除されません。
4. エディターのタイトルバーにある **Preview in Sidebar Terminal** で PDF、Markdown、LaTeX、HTML、CSS、JSON、JSONC をプレビューできます。LaTeX はコンパイル済みの PDF を表示するため、先に普段のツールでビルドしてください。

## エディターと並べて使う

- Vim などでドキュメントを保存すると、プレビューが自動更新されます。PDF は連続スクロール、単ページ／見開き、ズーム、閲覧位置の保存に対応しています。
- Markdown は一般的な構文、タスクリスト、脚注、KaTeX 数式に対応しています。**Change preview font** の初期値は **Default**。フォントの選択は VS Code Settings Sync で同期できます。
- HTML はローカルの画像やスタイルを使う静的ページとして表示し、CSS・JSON・JSONC はソースを整形して表示します。HTML のスクリプトやフォームは動作しません。
- **Cmd+F / Ctrl+F** でターミナルのバッファとドキュメントの文字を検索できます。大文字と小文字の区別、単語単位の検索、正規表現、件数表示、ハイライトに対応しています。検索ボタンの右クリックで、両側の開いているタブをまとめて検索できます。PDF の検索にはテキスト層が必要です。
- PDF 内をダブルクリックすると、**SyncTeX** で LaTeX ソースの対応箇所に戻れます。`-synctex=1` を付けてコンパイルし、`synctex` 実行ファイルをインストールしてください。
- タブをドラッグして並べ替え、右クリックで操作メニューを開けます。ターミナルの出力は HTML、PDF、Markdown、プレーンテキストに書き出せます。
- **Change tab marker** で、テーマに連動するタブアイコンを選べます。同じ起動プロファイルのアイコンは別のリポジトリでも引き継がれます。ドキュメントのアイコンは同じファイルに引き継がれます。一時的なターミナルのアイコンはワークスペースごとに保存されます。

## ご利用にあたって

VS Code を再読み込みすると、シェルは新しいプロセスとして起動します。作業ディレクトリの復元とコマンドの状態検出はシェル統合に依存し、常に取得できるとは限りません。起動設定は同期される場合があります。**コマンド、引数、環境変数に認証情報を保存しないでください。**

[使い方・開発ガイド（英語）](https://github.com/Photonico/terminal_sidebar/blob/main/docs/guide.md) · [変更履歴](https://github.com/Photonico/terminal_sidebar/blob/main/CHANGELOG.md) · [問題を報告](https://github.com/Photonico/terminal_sidebar/issues)

設計・メンテナンス：[Lu Niu (Photonico)](https://github.com/Photonico)。実装・テスト・ドキュメント作成支援：**OpenAI Codex**。

[MIT](https://github.com/Photonico/terminal_sidebar/blob/main/LICENSE) © 2026 Lu Niu (Photonico)。同梱の Codicons は Microsoft によるもので、[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) ライセンスが適用されます。
