# cmux-remote 要件定義書

## 1. プロジェクト概要

cmux-remote は、iPhone から外部ネットワーク経由でローカル PC 上の cmux ターミナルマルチプレクサを操作するためのシステムである。

### 1.1 目的
- 外出先や移動中に iPhone から自宅/オフィスの開発環境（cmux）をリアルタイム監視・操作する
- AI がコーディングを行う前提で、ターミナル出力の確認とワークスペース/ペインの切り替えに特化する

### 1.2 対象ユーザー
- ローカル PC で cmux を使用している開発者
- iPhone から開発環境を監視・操作したいユーザー

## 2. システム構成

### 2.1 コンポーネント

| コンポーネント | 技術スタック | 役割 |
|---|---|---|
| Local Bridge Server | Bun + Hono | Unix Domain Socket (cmux.sock) と WebSocket の中継 |
| iPhone PWA | TypeScript + React + xterm.js + Hammer.js | モバイル最適化ターミナル UI |

### 2.2 ネットワーク構成
- Tailscale P2P または Cloudflare Tunnel で接続（どちらでも動く設計）
- クラウドインフラ不要（ローカル PC 上で Bridge Server を起動するだけ）

### 2.3 通信フロー
```
iPhone PWA <--WebSocket--> Bridge Server <--Unix Domain Socket--> cmux
```

## 3. 機能要件

### 3.1 Bridge Server

#### 3.1.1 WebSocket エンドポイント
- WebSocket 接続を受け付け、cmux の Unix Domain Socket と双方向に中継する
- JSON RPC メッセージをそのまま透過的に転送する

#### 3.1.2 静的ファイル配信
- PWA のビルド済みファイルを配信する
- Service Worker のキャッシュ制御に対応する

#### 3.1.3 ヘルスチェック
- `/health` エンドポイントで Bridge Server の稼働状況と cmux ソケットの接続状態を返す

### 3.2 iPhone PWA

#### 3.2.1 ターミナル表示
- xterm.js でターミナル出力をレンダリングする
- フォーカス中のペインの内容をリアルタイム表示する

#### 3.2.2 ジェスチャー操作
| ジェスチャー | 動作 |
|---|---|
| 上下2本指スワイプ | ワークスペース移動 |
| 左右2本指スワイプ | スプリット（ペイン）移動 |

#### 3.2.3 ハンバーガーメニュー
- ワークスペース一覧をドロワーで表示する
- タップでワークスペースを切り替える

#### 3.2.4 入力
- 基本的な入力は限定的（AI がコーディングを担当する前提）
- 必要最低限のテキスト送信機能は提供する

#### 3.2.5 PWA 要件
- ホーム画面に追加してネイティブアプリのように使用できる
- manifest.json を提供する
- Service Worker でオフラインキャッシュに対応する

## 4. cmux API 仕様

### 4.1 接続情報
- ソケットパス: `~/Library/Application Support/cmux/cmux.sock`
- プロトコル: cmux-socket v2
- フォーマット: newline 区切り JSON

### 4.2 リクエスト形式
```json
{"id": "1", "method": "workspace.list", "params": {}}
```

### 4.3 主要メソッド

| メソッド | 説明 |
|---|---|
| `workspace.list` | ワークスペース一覧を取得 |
| `workspace.select` | ワークスペースを選択・切り替え |
| `pane.list` | ペイン一覧を取得 |
| `surface.focus` | 指定サーフェスにフォーカス |
| `surface.read_text` | サーフェスのテキスト内容を読み取り |
| `surface.send_text` | サーフェスにテキストを送信 |
| `system.tree` | システムツリー構造を取得 |
| `notification.list` | 通知一覧を取得 |

## 5. 非機能要件

### 5.1 パフォーマンス
- ターミナル表示の遅延は 100ms 以内を目標とする
- WebSocket 接続のキープアライブを実装し、不安定なモバイル回線でも自動再接続する

### 5.2 セキュリティ
- Tailscale / Cloudflare Tunnel のネットワーク層で認証・暗号化する
- Bridge Server 自体は信頼されたネットワーク内で動作する前提とする

### 5.3 可用性
- Bridge Server が起動していれば iPhone からいつでもアクセスできる
- cmux ソケットが利用不可の場合は適切なエラーメッセージを表示する

### 5.4 互換性
- iPhone Safari (iOS 16+) で動作する
- PWA としてホーム画面に追加できる
