# cmux-remote 設計書

## 1. アーキテクチャ概要

```
┌─────────────────┐     ┌──────────────────────┐     ┌──────────┐
│   iPhone PWA    │────▶│  Local Bridge Server  │────▶│   cmux   │
│                 │ WS  │   (Bun + Hono)        │ UDS │  (.sock) │
│  React+xterm.js│◀────│                       │◀────│          │
└─────────────────┘     └──────────────────────┘     └──────────┘
   Tailscale /             localhost:3456
   Cloudflare Tunnel
```

## 2. Bridge Server 設計

### 2.1 技術選定
- **ランタイム**: Bun (高速な起動、ネイティブ WebSocket サポート)
- **フレームワーク**: Hono (軽量、Bun ネイティブ対応)
- **TypeScript**: 型安全な実装

### 2.2 ディレクトリ構成
```
server/
├── src/
│   ├── index.ts          # エントリポイント、サーバー起動
│   ├── ws.ts             # WebSocket ハンドラ
│   ├── cmux-client.ts    # cmux UDS クライアント
│   └── health.ts         # ヘルスチェック
├── package.json
└── tsconfig.json
```

### 2.3 WebSocket 中継の設計

```typescript
// 接続フロー
// 1. iPhone PWA が ws://host:3456/ws に接続
// 2. Bridge Server が cmux.sock に接続
// 3. 双方向メッセージ転送開始

// メッセージフロー
iPhone -> WS -> Bridge -> UDS -> cmux
iPhone <- WS <- Bridge <- UDS <- cmux
```

#### 2.3.1 接続管理
- WebSocket 接続ごとに独立した cmux UDS 接続を作成する
- WebSocket 切断時に対応する UDS 接続をクリーンアップする
- UDS 接続エラー時に WebSocket 側にエラーを通知する

#### 2.3.2 メッセージプロトコル
- cmux-socket v2 プロトコル（newline 区切り JSON）をそのまま WebSocket メッセージとして転送する
- Bridge Server はメッセージの内容を解析せず、透過的に中継する

### 2.4 静的ファイル配信
- Hono の `serveStatic` で PWA のビルド済みファイルを配信する
- パス: `/` 以下で `client/dist/` のファイルを返す

### 2.5 ヘルスチェック API
```
GET /health
Response: { "status": "ok", "cmux": "connected" | "disconnected" }
```

### 2.6 設定
- ポート: 環境変数 `PORT` (デフォルト: 3456)
- cmux ソケットパス: 環境変数 `CMUX_SOCKET` (デフォルト: `~/Library/Application Support/cmux/cmux.sock`)

## 3. iPhone PWA 設計

### 3.1 技術選定
- **ビルドツール**: Vite
- **UI フレームワーク**: React 19
- **ターミナル**: xterm.js + @xterm/addon-fit
- **ジェスチャー**: Hammer.js
- **状態管理**: React hooks (useState/useReducer)
- **スタイリング**: CSS Modules

### 3.2 ディレクトリ構成
```
client/
├── src/
│   ├── main.tsx             # エントリポイント
│   ├── App.tsx              # ルートコンポーネント
│   ├── components/
│   │   ├── Terminal.tsx      # xterm.js ターミナル表示
│   │   ├── Drawer.tsx        # ワークスペース一覧ドロワー
│   │   ├── Header.tsx        # ヘッダー（ハンバーガーメニュー）
│   │   └── StatusBar.tsx     # 接続状態表示
│   ├── hooks/
│   │   ├── useWebSocket.ts   # WebSocket 接続管理
│   │   ├── useCmux.ts        # cmux API ラッパー
│   │   └── useGesture.ts     # ジェスチャーハンドリング
│   ├── lib/
│   │   └── cmux-rpc.ts       # JSON RPC ヘルパー
│   └── styles/
│       └── global.css        # グローバルスタイル
├── public/
│   ├── manifest.json         # PWA マニフェスト
│   └── sw.js                 # Service Worker
├── index.html
├── package.json
├── tsconfig.json
└── vite.config.ts
```

### 3.3 コンポーネント設計

#### 3.3.1 App (ルート)
```
┌────────────────────────────┐
│ Header (☰ ワークスペース名) │
├────────────────────────────┤
│                            │
│     Terminal (xterm.js)    │
│     ジェスチャー検知領域     │
│                            │
├────────────────────────────┤
│ StatusBar (接続状態)        │
└────────────────────────────┘

┌──────────┐
│ Drawer   │ (ハンバーガーメニューで表示)
│ WS1 ✓   │
│ WS2      │
│ WS3      │
└──────────┘
```

#### 3.3.2 Terminal コンポーネント
- xterm.js インスタンスを管理する
- `@xterm/addon-fit` でコンテナサイズに自動フィットする
- `surface.read_text` のレスポンスをターミナルに書き込む
- ポーリング (1秒間隔) でフォーカス中のペインの内容を更新する

#### 3.3.3 ジェスチャーハンドリング
```typescript
// Hammer.js 設定
const mc = new Hammer.Manager(element);
mc.add(new Hammer.Pan({ direction: Hammer.DIRECTION_ALL, pointers: 2 }));

// 上下スワイプ → ワークスペース移動
// 左右スワイプ → スプリット移動
```

- 2本指パンのしきい値: 50px
- 方向判定: X/Y の移動量の絶対値で判定する
- スワイプ完了後にフィードバック (触覚フィードバック) を返す

### 3.4 WebSocket 接続管理

#### 3.4.1 接続ライフサイクル
1. PWA 起動時に `ws://host:port/ws` に接続
2. 接続成功後、`workspace.list` で初期データ取得
3. 切断時に自動再接続 (指数バックオフ: 1s, 2s, 4s, 最大 30s)

#### 3.4.2 RPC 管理
```typescript
// リクエスト/レスポンスの対応付け
interface PendingRequest {
  resolve: (result: any) => void;
  reject: (error: any) => void;
  timeout: Timer;
}

// id で管理する Map
const pending = new Map<string, PendingRequest>();
```

### 3.5 cmux RPC ラッパー

```typescript
class CmuxRPC {
  // ワークスペース操作
  async listWorkspaces(): Promise<Workspace[]>
  async selectWorkspace(id: string): Promise<void>

  // ペイン操作
  async listPanes(): Promise<Pane[]>
  async focusSurface(id: string): Promise<void>
  async readText(surfaceId: string): Promise<string>
  async sendText(surfaceId: string, text: string): Promise<void>

  // システム情報
  async getTree(): Promise<TreeNode>
  async listNotifications(): Promise<Notification[]>
}
```

### 3.6 PWA 設定

#### manifest.json
```json
{
  "name": "cmux Remote",
  "short_name": "cmux",
  "start_url": "/",
  "display": "standalone",
  "orientation": "portrait",
  "theme_color": "#1a1a2e",
  "background_color": "#1a1a2e"
}
```

#### Service Worker
- App Shell キャッシュ戦略: HTML, CSS, JS をキャッシュ
- Network First: API リクエストはネットワーク優先

## 4. 状態管理設計

```typescript
interface AppState {
  // 接続
  connected: boolean;
  reconnecting: boolean;

  // ワークスペース
  workspaces: Workspace[];
  currentWorkspace: string | null;

  // ペイン
  panes: Pane[];
  currentPane: string | null;

  // UI
  drawerOpen: boolean;
}
```

## 5. エラーハンドリング

| エラー | 表示 | 動作 |
|---|---|---|
| WebSocket 切断 | StatusBar に「再接続中...」 | 指数バックオフで自動再接続 |
| cmux ソケット未接続 | 画面中央にエラー表示 | 5秒間隔でヘルスチェック |
| RPC タイムアウト | トースト通知 | 10秒でタイムアウト |
| 不明なエラー | トースト通知 | ログ出力 |
