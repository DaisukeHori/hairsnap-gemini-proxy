# HairSnap Gemini Proxy

**Gemini API 互換プロキシ** — `@google/genai` SDK からそのまま呼べる API。
バックエンドは Stable-Hair v1 on RunPod Serverless (RTX 4090)。

## アーキテクチャ

```
REVOL Mirror (既存)                    このリポジトリ
┌──────────────────┐                  ┌──────────────────────────────┐
│ gemini.ts         │   HTTP POST     │ Vercel (Next.js)             │
│ GoogleGenAI({     │ ──────────────→ │ /v1beta/models/{m}           │
│   apiKey,         │                 │   :generateContent           │
│   httpOptions: {  │                 │                              │
│     baseUrl       │                 │ ① Geminiリクエスト解析         │
│   }               │                 │ ② 画像+プロンプト抽出          │
│ })                │  ←── JSON ───── │ ③ RunPod Serverless に転送    │
└──────────────────┘                  │ ④ Gemini形式で返却            │
                                      └──────────────┬───────────────┘
                                                      │ /runsync
                                                      ▼
                                      ┌──────────────────────────────┐
                                      │ RunPod Serverless (RTX 4090) │
                                      │                              │
                                      │ handler.py:                  │
                                      │ Stage 1: Bald Converter      │
                                      │ Stage 2: Hair Transfer       │
                                      │                              │
                                      │ ~1.2秒/枚 (キャッシュ時)      │
                                      │ ~4.2秒/枚 (初回)             │
                                      └──────────────────────────────┘
```

## CI/CD: GitHub Push → 自動デプロイ

```
git push (main)
    │
    ├── runpod/* 変更 → RunPod GitHub連携が自動ビルド&デプロイ
    │                    (Stable-Hair推論エンジン)
    │
    └── app/*,lib/* 変更 → Vercel が自動ビルド&デプロイ
                           (Gemini互換プロキシ)
```

**コードを変更して push するだけで、推論エンジンもプロキシも自動更新。**

---

## セットアップ

### 1. RunPod GitHub 連携 (推論エンジン)

#### a. GitHub 接続
1. [RunPod Console](https://www.runpod.io/console) → Settings → Connections
2. 「GitHub」の「Connect」をクリック
3. GitHub認証 → `DaisukeHori/hairsnap-gemini-proxy` にアクセス許可

#### b. Serverless Endpoint 作成
1. Serverless → 「+ New Endpoint」 → 「GitHub Repo」
2. リポジトリ: `hairsnap-gemini-proxy`
3. Branch: `main`
4. **Dockerfile path: `runpod/Dockerfile`**
5. GPU: **RTX 4090 (24GB)**
6. Workers: Min=0, Max=5
7. 「Deploy」

#### c. 環境変数 (RunPod Endpoint Settings)
```
MODEL_PATH=/models
```

> **Note**: 初回ビルドはモデルダウンロード含め20-30分かかります。
> 2回目以降はレイヤーキャッシュで数分。

#### d. (推奨) Network Volume でモデル管理
大きなモデルファイルを毎回ダウンロードしたくない場合:

```bash
# RunPod Pod (一時的) を起動 → Network Volume にモデルを保存
pip install gdown huggingface_hub
python3 download_models.py --output /runpod-volume/models
```

その後、Endpoint の環境変数を変更:
```
MODEL_PATH=/runpod-volume/models
```

### 2. Vercel デプロイ (プロキシサーバー)

```bash
# Vercel にインポート (GitHub連携)
# Root Directory: . (ルート)
# Build Command: npm run build
# Output Directory: .next

# 環境変数:
PROXY_API_KEY=your-secret-key
RUNPOD_ENDPOINT_URL=https://api.runpod.ai/v2/{your-endpoint-id}
RUNPOD_API_KEY=your-runpod-api-key
```

### 3. REVOL Mirror 側の変更 (2行 + 環境変数)

```diff
// apps/api/lib/ai-providers/gemini.ts
- this.client = new GoogleGenAI({ apiKey });
+ this.client = new GoogleGenAI({
+   apiKey,
+   ...(process.env.GEMINI_BASE_URL && {
+     httpOptions: { baseUrl: process.env.GEMINI_BASE_URL },
+   }),
+ });
```

```env
# apps/api/.env.local
GEMINI_API_KEY=your-secret-key           # PROXY_API_KEY と同じ値
GEMINI_BASE_URL=https://your-proxy.vercel.app  # Vercel の URL
GEMINI_MODEL=stable-hair-v1
```

---

## コスト比較

| | Gemini API | Stable-Hair (RunPod) |
|--|-----------|---------------------|
| 1枚あたり | 5.85円 | **0.063円** |
| DAU 2,000 | 月210万円 | **月2.3万円** |
| DAU 50,000 | 月5,250万円 | **月57万円** |

---

## ファイル構成

```
hairsnap-gemini-proxy/
├── app/                              # Vercel (Next.js プロキシ)
│   ├── api/
│   │   ├── health/route.ts
│   │   └── v1beta/models/[...path]/
│   │       └── route.ts             # Gemini互換エンドポイント
│   ├── layout.tsx
│   └── page.tsx
├── lib/
│   ├── auth.ts                      # API キー認証
│   ├── generate-content.ts          # リクエスト解析→RunPod転送
│   └── runpod-client.ts             # RunPod Serverless クライアント
├── runpod/                           # RunPod (推論エンジン)
│   ├── Dockerfile                   # RunPod GitHub連携用
│   ├── handler.py                   # Stable-Hair 推論ハンドラー
│   ├── download_models.py           # モデルダウンロードスクリプト
│   ├── requirements.txt
│   └── test_input.json
├── .env.example
├── package.json
├── tsconfig.json
└── vercel.json
```

---

## API テスト

```bash
# ヘルスチェック
curl https://your-proxy.vercel.app/api/health

# 生成テスト (Gemini SDK と同じフォーマット)
curl -X POST https://your-proxy.vercel.app/api/v1beta/models/stable-hair-v1:generateContent \
  -H "x-goog-api-key: your-secret-key" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [{
      "role": "user",
      "parts": [
        {"inlineData": {"mimeType": "image/jpeg", "data": "<customer_base64>"}},
        {"inlineData": {"mimeType": "image/jpeg", "data": "<reference_base64>"}},
        {"text": "Apply hairstyle"}
      ]
    }],
    "generationConfig": {"responseModalities": ["Text", "Image"]}
  }'
```

---

## TODO

- [ ] RunPod GitHub連携設定 & 初回デプロイ
- [ ] Vercel デプロイ
- [ ] E2Eテスト (日本人顔での品質検証)
- [ ] Bald キャッシュ永続化 (Network Volume)
- [ ] REVOL Mirror 側の gemini.ts 変更
- [ ] Google Drive モデルの個別ファイルID確認
- [ ] Stable-Hair ライセンス確認 (著者問い合わせ)
