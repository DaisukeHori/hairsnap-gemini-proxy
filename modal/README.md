# Modal版 Stable-Hair (GPU Memory Snapshots)

RunPodの代替バックエンド。GPU Memory Snapshotsによりコールドスタート2〜3秒を目指す。

## セットアップ

### 1. Modalアカウント作成

```bash
pip install modal
modal setup  # ブラウザが開いて認証
```

認証後、`~/.modal.toml` にトークンが保存される。
CI/CD環境では環境変数を使う:

```bash
export MODAL_TOKEN_ID=ak-xxxxx
export MODAL_TOKEN_SECRET=as-xxxxx
```

### 2. モデルダウンロード（初回のみ、5〜10分）

```bash
modal run modal/app.py::download_models
```

SD1.5 + Stable-Hair のウェイトがModalのVolumeに保存される。

### 3. デプロイ

```bash
modal deploy modal/app.py
```

デプロイ後のURLが表示される:
```
https://YOUR_WORKSPACE--hairsnap-stable-hair-stable-hair-inference-generate.modal.run
```

### 4. テスト

```bash
# エコーモード
curl -X POST "https://YOUR_URL/generate" \
  -H "Content-Type: application/json" \
  -d '{"echo": true}'

# 画像テスト（RunPodと同じフォーマット）
curl -X POST "https://YOUR_URL/generate" \
  -H "Content-Type: application/json" \
  -d '{
    "customer_photo": "<base64>",
    "reference_photo": "<base64>",
    "seed": 42,
    "num_inference_steps": 30
  }'
```

### 5. Vercelプロキシとの接続

`lib/runpod-client.ts` の代わりにModal URLを使うだけ。
環境変数:

```env
# hairsnap-gemini-proxy のVercel環境変数
MODAL_ENDPOINT_URL=https://YOUR_URL/generate
BACKEND=modal  # "runpod" or "modal"
```

## アーキテクチャ

```
Vercel (Gemini互換プロキシ)
    │
    ├── BACKEND=runpod → RunPod Serverless (既存)
    │
    └── BACKEND=modal → Modal (GPU Memory Snapshots)
                          ├── @modal.enter(snap=True)  : CPU上にモデル読み込み → スナップショット保存
                          └── @modal.enter(snap=False) : GPUに転送 (復元時は2-3秒)
```

## GPU Memory Snapshots の仕組み

1. 初回デプロイ時: モデルをCPUメモリに読み込んだ状態でスナップショットを作成
2. コールドスタート時: スナップショットから復元（CPUメモリはすでにモデルが入った状態）→ GPUに転送
3. GPUスナップショット (alpha): GPUメモリも含めてスナップショット → 復元は更に高速

## コスト

Modal は GPU秒 + CPU秒 + メモリ で課金。
A10G (24GB) の場合:

| 項目 | 単価 |
|------|------|
| GPU | ~$0.000306/秒 (~$1.10/hr) |
| CPU (8 core) | ~$0.000028/秒 |
| メモリ (32GB) | ~$0.000008/秒 |
| **合計** | **~$0.000342/秒 (~$1.23/hr)** |

1枚あたり (推論6.5秒): **~$0.0022 (0.33円)**
RunPodとほぼ同等のコスト、コールドスタートが大幅に短い。

## GPU選択

```python
# modal/app.py の gpu= を変更
gpu="A10G"   # 24GB, $1.10/hr (推奨: コスパ最良)
gpu="T4"     # 16GB, $0.59/hr (安い、SD1.5なら十分)
gpu="A100"   # 40GB, $2.78/hr (高速だが高い)
```
