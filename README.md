# HairSnap Gemini Proxy

**Gemini API 互換プロキシサーバー** — Stable-Hair (RunPod Serverless) をバックエンドとして、`@google/genai` SDK からそのまま呼べる API を提供。

## アーキテクチャ

```
REVOL Mirror (既存)                    HairSnap Gemini Proxy (このリポジトリ)
┌──────────────────────┐              ┌──────────────────────────────────┐
│ gemini.ts            │              │                                  │
│                      │   HTTP POST  │  /v1beta/models/{model}          │
│ GoogleGenAI({        │ ──────────→  │  :generateContent                │
│   apiKey: "xxx",     │              │                                  │
│   httpOptions: {     │              │  ① リクエスト解析                  │
│     baseUrl: "..."   │              │  ② 画像 + プロンプト 抽出         │
│   }                  │              │  ③ RunPod Serverless に転送       │
│ })                   │              │  ④ Geminiフォーマットで返却        │
│                      │  ← JSON ──  │                                  │
└──────────────────────┘              └──────────────┬───────────────────┘
                                                     │
                                                     │ HTTP POST /runsync
                                                     ▼
                                      ┌──────────────────────────────────┐
                                      │  RunPod Serverless               │
                                      │  (RTX 4090, Stable-Hair v1)     │
                                      │                                  │
                                      │  handler.py:                     │
                                      │  ① Bald変換 (キャッシュ対応)      │
                                      │  ② Hair Transfer (参照画像ベース) │
                                      │  ③ base64画像を返却              │
                                      └──────────────────────────────────┘
```

## REVOL Mirror 側の変更点

**gemini.ts の変更 (2行):**

```diff
  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY environment variable is not set');
    }
-   this.client = new GoogleGenAI({ apiKey });
+   this.client = new GoogleGenAI({
+     apiKey,
+     ...(process.env.GEMINI_BASE_URL && {
+       httpOptions: { baseUrl: process.env.GEMINI_BASE_URL },
+     }),
+   });
    this.model = process.env.GEMINI_MODEL ?? 'gemini-3.1-flash-image-preview';
  }
```

**環境変数の変更:**

```env
# .env.local
GEMINI_API_KEY=hairsnap-your-secret-key     # プロキシの認証キー
GEMINI_BASE_URL=https://your-proxy.vercel.app  # このプロキシのURL
GEMINI_MODEL=stable-hair-v1                 # モデル名（任意、ログ用）
```

## セットアップ

### 1. プロキシサーバー (Vercel)

```bash
cd hairsnap-gemini-proxy
cp .env.example .env.local
# .env.local を編集

npm install
npm run dev        # ローカル開発
vercel deploy      # Vercel にデプロイ
```

### 2. RunPod Serverless

```bash
cd runpod

# Docker イメージをビルド
docker build -t hairsnap-stable-hair .

# DockerHub にプッシュ
docker tag hairsnap-stable-hair your-dockerhub/hairsnap-stable-hair:latest
docker push your-dockerhub/hairsnap-stable-hair:latest

# RunPod ダッシュボードで:
# 1. Serverless → New Endpoint
# 2. Docker Image: your-dockerhub/hairsnap-stable-hair:latest
# 3. GPU: RTX 4090 (24GB)
# 4. Workers: Min=0, Max=10 (FlashBoot有効)
# 5. Endpoint URL をメモ → RUNPOD_ENDPOINT_URL に設定
```

### 3. モデルのデプロイ (推奨: Network Volume)

RunPod Network Volume にモデルを配置すると、コールドスタートが大幅に短縮:

```bash
# RunPod Pod (一時的) でモデルをダウンロード
git clone https://github.com/Xiaojiu-z/Stable-Hair.git
# Google Drive からモデルをダウンロード → /models/stable-hair/
# Network Volume に保存
```

## コスト比較

| | Gemini API (現在) | このプロキシ |
|--|-------------------|------------|
| 1枚あたり | 5.85円 ($0.039) | **0.063円** ($0.00042) |
| DAU 2,000 (12万枚/日) | 月210万円 | **月2.3万円** |
| DAU 50,000 (300万枚/日) | 月5,250万円 | **月57万円** |

## ファイル構成

```
hairsnap-gemini-proxy/
├── app/
│   ├── api/
│   │   ├── health/route.ts             # ヘルスチェック
│   │   └── v1beta/models/[...path]/
│   │       └── route.ts                # Gemini互換エンドポイント
│   └── layout.tsx
├── lib/
│   ├── auth.ts                         # API キー認証
│   ├── generate-content.ts             # リクエスト解析 → RunPod転送
│   └── runpod-client.ts                # RunPod Serverless クライアント
├── runpod/
│   ├── handler.py                      # Stable-Hair 推論ハンドラー
│   ├── Dockerfile                      # RunPod用コンテナ
│   └── requirements.txt
├── .env.example
├── next.config.ts
├── package.json
├── tsconfig.json
└── vercel.json
```

## TODO

- [ ] `runpod/handler.py` のプレースホルダーを実際の Stable-Hair 推論コードに置き換え
- [ ] Stable-Hair v1 のモデルウェイトを RunPod Network Volume に配置
- [ ] 本番環境でのE2Eテスト
- [ ] Bald キャッシュの永続化 (現在は RunPod コンテナ内の /tmp)
- [ ] 角度変更対応 (Stable-Hair v2 統合 or 代替手法)
- [ ] カタログ DB + CLIP ベクトル検索 (プロンプトからの参照画像マッチング)
- [ ] レート制限・利用量トラッキング
