# HairSnap Gemini Proxy

**Gemini API 互換プロキシ** — `@google/genai` SDK からそのまま呼べる API。
バックエンドは Stable-Hair v1 on RunPod Serverless (RTX 4090)。

---

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

## セットアップ手順

### 1. RunPod GitHub 連携 (推論エンジン)

#### a. GitHub 接続（ダッシュボード、初回1回のみ）

RunPod の GitHub 連携はOAuth認証のため、**初回だけダッシュボードが必要**。API経由では不可。

1. [RunPod Console](https://www.runpod.io/console) → Settings → Connections
2. 「GitHub」の「Connect」をクリック
3. GitHub認証 → リポジトリへのアクセス許可

#### b. Serverless Endpoint 作成（ダッシュボード、初回1回のみ）

GitHub連携の Endpoint 作成も**ダッシュボードのみ**。REST API の `POST /v1/endpoints` は `templateId` が必須で、GitHub Repo 指定ができない。

1. Serverless → 「+ New Endpoint」 → **「GitHub Repo」を選択**（「Docker Registry」ではない）
2. 設定値:

| 設定 | 値 | 備考 |
|------|---|------|
| Repository | `DaisukeHori/hairsnap-gemini-proxy` | |
| Branch | `main` | |
| **Dockerfile path** | **`runpod/Dockerfile`** | |
| **Build context** | **`runpod`** | ⚠️ これを忘れるとCOPYが失敗する |
| GPU | 24 GB (RTX 4090) を1st | |
| **Container disk** | **20 GB** | ⚠️ デフォルト5GBでは足りない（SD1.5+Stable-Hair+Python環境で~15GB） |
| Min Workers | 0 | |
| Max Workers | 3 | |
| Model | 空欄 | Dockerfile内で自前管理 |
| Container start command | 空欄 | DockerfileのCMDが使われる |
| Environment variables | なし | Dockerfile内で設定済み |

> ⚠️ `runpod.serverless.start()` が見つからないという警告が出るが**無視してOK**。handler.py がサブディレクトリにあるだけで、ビルド時にCOPYされる。

#### c. Endpoint作成後の設定変更（API経由で可能）

一度作成すれば、以降の設定変更は全てAPI経由:

```bash
# ワーカー数変更
curl -X PATCH "https://rest.runpod.io/v1/endpoints/{ENDPOINT_ID}" \
  -H "Authorization: Bearer {RUNPOD_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"workersMax": 5}'

# ヘルスチェック
curl "https://api.runpod.ai/v2/{ENDPOINT_ID}/health" \
  -H "Authorization: Bearer {RUNPOD_API_KEY}"

# キュー掃除
curl -X POST "https://api.runpod.ai/v2/{ENDPOINT_ID}/purge-queue" \
  -H "Authorization: Bearer {RUNPOD_API_KEY}"
```

### 2. Vercel デプロイ (プロキシサーバー)

#### a. プロジェクト作成（API経由で可能）

```bash
# REST API でGitHubリポからプロジェクト作成
curl -X POST "https://api.vercel.com/v10/projects?teamId={TEAM_ID}" \
  -H "Authorization: Bearer {VERCEL_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "hairsnap-gemini-proxy",
    "framework": "nextjs",
    "gitRepository": {
      "repo": "DaisukeHori/hairsnap-gemini-proxy",
      "type": "github"
    }
  }'
```

#### b. 環境変数設定（API経由）

```bash
# 各環境変数を設定
curl -X POST "https://api.vercel.com/v10/projects/{PROJECT_ID}/env?teamId={TEAM_ID}" \
  -H "Authorization: Bearer {VERCEL_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"key":"PROXY_API_KEY","value":"your-secret","type":"encrypted","target":["production","preview"]}'

# 同様に RUNPOD_ENDPOINT_URL, RUNPOD_API_KEY も設定
```

#### c. ⚠️ Vercel SSO/チーム認証の問題

**Vercel のチーム（Pro/Enterprise）では、デプロイメントにSSO認証がデフォルトで有効になる。** これが API 呼び出しをブロックする最大のハマりポイント。

症状: curlで叩くと `Authentication Required` のHTMLが返る

##### 解決方法: Protection Bypass シークレットの発行

```bash
# Bypassシークレットを生成
curl -X PATCH "https://api.vercel.com/v1/projects/{PROJECT_ID}/protection-bypass?teamId={TEAM_ID}" \
  -H "Authorization: Bearer {VERCEL_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"generate": {"note": "API server-to-server bypass"}}'

# レスポンスからシークレットを取得
# → "I0ffFmAtxshQotOcsiQ4W77PeeBQ6I6M" のような文字列
```

**全てのAPIリクエストにこのヘッダーを付ける:**
```
x-vercel-protection-bypass: {BYPASS_SECRET}
```

> ⚠️ `vercelAuthentication: {"deploymentType": "none"}` を PATCH しても**チームレベルのSSOは解除されない**。project-level API では上書き不可。Protection Bypass が唯一の正解。

### 3. REVOL Mirror 側の変更

gemini.ts に2行追加 + 環境変数:

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
GEMINI_API_KEY=your-proxy-api-key
GEMINI_BASE_URL=https://hairsnap-gemini-proxy-xxx.vercel.app
GEMINI_MODEL=stable-hair-v1
```

> `@google/genai` SDK は `httpOptions.baseUrl` をサポートしている（Cloudflare AI Gateway等でも使われている公式機能）。

---

## ⚠️ ハマりポイントまとめ

### 1. RunPod: handler.py で `torch` を参照するとCPUイメージでクラッシュ

**症状:** worker exited with exit code 1, `NameError: name 'torch' is not defined`

**原因:** 軽量Dockerfile (`python:3.10-slim`) では `torch` がインストールされていない。以下の箇所がクラス定義時（モジュールロード時）に評価されてクラッシュする:

```python
# ❌ これはモジュールロード時にtorchを参照する
class StableHairEngine:
    def __init__(self, dtype=torch.float16):  # ← ここ
        ...

    @torch.inference_mode()  # ← ここも
    def get_bald(self):
        ...
```

**解決策:** ダミーtorchモジュールを用意する:

```python
try:
    import torch
    HAS_TORCH = True
except ImportError:
    HAS_TORCH = False
    class _DummyTorch:
        float16 = None
        @staticmethod
        def inference_mode():
            return lambda fn: fn  # no-op decorator
    torch = _DummyTorch()
```

### 2. RunPod: ビルド成功してもワーカーがジョブを拾わない

**症状:** health API で `idle: N, ready: N` だが `running: 0`、ジョブが永遠に `IN_QUEUE`

**原因:** 古いビルド（FAILEDを含む）のワーカーが残っていて、新しいビルドのワーカーに切り替わっていない。

**解決策:** ワーカーを完全リセットする:

```bash
# ① 全ワーカー停止
curl -X PATCH "https://rest.runpod.io/v1/endpoints/{ID}" \
  -H "Authorization: Bearer {KEY}" \
  -d '{"workersMax": 0}'

# ② 30秒待つ（ワーカーが完全に終了するまで）
sleep 30

# ③ ワーカー復活
curl -X PATCH "https://rest.runpod.io/v1/endpoints/{ID}" \
  -H "Authorization: Bearer {KEY}" \
  -d '{"workersMax": 3}'
```

### 3. RunPod: Container disk のデフォルト5GBは足りない

デフォルトの5GBではPython依存関係だけで溢れる。**最低20GB**に設定する。Stable-Hairモデル込みなら30GB推奨。

### 4. RunPod: Build context を `runpod` に設定する

Dockerfile が `runpod/Dockerfile` にある場合、Build context も `runpod` に設定しないと `COPY handler.py .` が失敗する。

### 5. Vercel: Next.js のインポートパスの深さに注意

`app/api/v1beta/models/[...path]/route.ts` からルートの `lib/` を参照するには **5階層上**:

```typescript
// ❌ 4階層だと app/lib/ を探してしまう
import { auth } from '../../../../lib/auth';

// ✅ 5階層で正しくルートの lib/ に到達
import { auth } from '../../../../../lib/auth';
```

**より安全な方法:** 型定義を `lib/types.ts` に集約し、循環参照を避ける。

### 6. Vercel: SSO認証が外部APIリクエストをブロックする

**症状:** curl でアクセスすると `Authentication Required` のHTMLが返る

上記「Vercel SSO/チーム認証の問題」セクションを参照。`x-vercel-protection-bypass` ヘッダーが必須。

### 7. RunPod: GitHub連携の初回ビルド失敗は正常

最初のpush時のコードにバグがあると、そのビルドはFAILEDになる。修正してpushすれば新しいビルドが走る。**FAILEDビルドのワーカーが残っている場合は上記のリセット手順を実行**。

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
│   ├── auth.ts                      # API キー認証 (x-goog-api-key)
│   ├── generate-content.ts          # リクエスト解析→RunPod転送
│   ├── runpod-client.ts             # RunPod Serverless クライアント
│   └── types.ts                     # Gemini API 型定義
├── runpod/                           # RunPod (推論エンジン)
│   ├── Dockerfile                   # 軽量: python:3.10-slim
│   ├── handler.py                   # Stable-Hair推論 + エコーモード
│   ├── download_models.py           # Network Volume用モデルDL
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
# ヘルスチェック（Vercel認証バイパス付き）
curl https://your-proxy.vercel.app/api/health \
  -H "x-vercel-protection-bypass: {BYPASS_SECRET}"

# RunPod直接テスト（エコーモード）
curl -X POST "https://api.runpod.ai/v2/{ENDPOINT_ID}/runsync" \
  -H "Authorization: Bearer {RUNPOD_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"input": {"echo": true}}'

# E2Eテスト（Vercel → RunPod、Geminiフォーマット）
curl -X POST https://your-proxy.vercel.app/api/v1beta/models/stable-hair-v1:generateContent \
  -H "x-goog-api-key: {PROXY_API_KEY}" \
  -H "x-vercel-protection-bypass: {BYPASS_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [{"role": "user", "parts": [
      {"inlineData": {"mimeType": "image/jpeg", "data": "<base64>"}},
      {"text": "test"}
    ]}]
  }'
```

---

## TODO

- [x] RunPod GitHub連携設定 & 初回デプロイ
- [x] Vercel デプロイ
- [x] E2Eテスト（エコーモード）
- [ ] Stable-Hair モデルを Network Volume に配置
- [ ] GPU付きDockerfileでの本番推論テスト
- [ ] REVOL Mirror の gemini.ts 変更
- [ ] 日本人顔での品質検証
- [ ] Bald キャッシュ永続化 (Network Volume)
- [ ] Stable-Hair ライセンス確認 (著者問い合わせ)
