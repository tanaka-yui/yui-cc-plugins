# cmux-remote

[English](README.md)

[cmux](https://cmux.dev) のリモートターミナルビューア — iPhone PWA から cmux ワークスペースにアクセスできます。

## 概要

cmux-remote は、iPhone から cmux ターミナルワークスペースの監視・切り替えを行うための軽量ブリッジです。AI がコーディングを担当する前提で、外出先からの**ターミナル出力の確認**に特化しています。

```
iPhone PWA (React + xterm.js)
    ↕ WebSocket
Bridge Server (Bun + Hono)
    ↕ Unix Domain Socket
cmux (~/.../cmux.sock)
```

### 主な機能

- xterm.js による**リアルタイムターミナル表示**（1秒間隔ポーリング）
- **ジェスチャー操作** — 2本指スワイプでワークスペース（上下）・ペイン（左右）を切り替え
- **PWA** — ホーム画面に追加してネイティブアプリのように使用可能
- **軽量** — クライアント約144KB（gzip）、クラウドインフラ不要
- **セキュア** — Tailscale や Cloudflare Tunnel の背後にデプロイ

## 前提条件

- ローカルマシンで [cmux](https://cmux.dev) が動作していること
- [Bun](https://bun.sh) ランタイム
- リモートアクセス用のネットワークトンネル（[Tailscale](https://tailscale.com)、[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) 等）

## クイックスタート

### 1. クライアントのビルド

```bash
cd client
bun install
bun run build
```

### 2. ブリッジサーバーの起動

```bash
cd server
bun install
bun run start
```

デフォルトで `http://localhost:3456` で起動します。

### 3. iPhone からアクセス

Safari で `http://<ホスト>:3456` を開き、ホーム画面に追加してください。

## 設定

| 環境変数 | デフォルト | 説明 |
|---|---|---|
| `PORT` | `3456` | ブリッジサーバーのポート |
| `CMUX_SOCKET_PATH` | `~/Library/Application Support/cmux/cmux.sock` | cmux Unix ソケットのパス |
| `CMUX_BIN_PATH` | `/Applications/cmux.app/Contents/Resources/bin/cmux` | cmux バイナリのパス |

## 開発

```bash
# ターミナル1: サーバーをウォッチモードで起動
cd server && bun run dev

# ターミナル2: クライアント開発サーバーを起動（ブリッジサーバーへプロキシ）
cd client && bun run dev
```

Vite 開発サーバーが `/ws` と `/health` を `localhost:3456` にプロキシします。

### テスト実行

```bash
# クライアントテスト
cd client && bun run test

# サーバーテスト
cd server && bun test
```

## アーキテクチャ

### Bridge Server (`server/`)

Bun + Hono で構築。以下を担当:

- **WebSocket 中継** — PWA と cmux Unix ソケット間の透過的 JSON-RPC プロキシ
- **CLI フォールバック** — 一部メソッド（`surface.read_text` 等）は信頼性のため `cmux` CLI を使用
- **静的ファイル配信** — `client/dist/` のビルド済み PWA を配信
- **ヘルスチェック** — `GET /health` でサーバーと cmux ソケットの状態を返却

### PWA クライアント (`client/`)

React 19 + TypeScript + Vite で構築。

| コンポーネント | 役割 |
|---|---|
| `Terminal` | xterm.js ターミナルレンダラー |
| `Header` | ワークスペース名 + ハンバーガーメニュー |
| `Drawer` | ワークスペース一覧サイドバー（レスポンシブ対応） |
| `StatusBar` | 接続状態インジケーター |

| フック | 役割 |
|---|---|
| `useWebSocket` | 指数バックオフ再接続付き接続管理 |
| `useCmux` | cmux JSON-RPC ラッパー |
| `useGesture` | Hammer.js 2本指ジェスチャーハンドリング |

## ライセンス

[MIT](LICENSE)
