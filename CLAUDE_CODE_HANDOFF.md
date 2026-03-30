# HairSnap GPU推論インフラ — Claude Code 引き継ぎプロンプト

このファイルを読ませて「残タスクを順番に実行して」と伝える。
クレデンシャルはローカルの `~/hairsnap-gemini-proxy/CLAUDE_CODE_HANDOFF_SECRETS.md` を参照。

## リポジトリ構成

```
hairsnap-gemini-proxy/
├── app/                    # Vercel Gemini互換プロキシ
├── lib/
│   ├── generate-content.ts  # BACKEND環境変数でRunPod/Modal切り替え
│   ├── runpod-client.ts / modal-client.ts
│   └── types.ts
├── runpod/                  # RunPod版（コールドスタート14秒で不採用）
├── modal/                   # Modal版（コールドスタート500ms）★メイン
│   ├── app.py
│   └── README.md
└── .github/workflows/modal-deploy.yml
```

## 完了済み

- Vercel Gemini互換プロキシ: デプロイ済み
- RunPod Serverless: デプロイ済み（コールドスタート14秒で不採用）
- Modal Serverless: デプロイ済み、Memory Snapshotでコールドスタート511ms確認
- gpu-mirror (REVOL Mirrorフォーク): Vercelデプロイ済み
- GitHub Actions CI/CD: modal/* push で自動デプロイ

## 残タスク（優先順）

1. **モデルダウンロード（最優先）**: `modal run modal/app.py::download_models`
2. **モデル読み込み確認**: echoモードで `models_ready: true` を確認
3. **ヘアスタイル生成テスト**: 日本人顔で品質検証（Bald Converter品質がリスク）
4. **Vercel環境変数切り替え**: `BACKEND=modal` + `MODAL_ENDPOINT_URL` 設定
5. **E2Eパイプラインテスト**: gpu-mirror → proxy → Modal
6. **コールドスタートベンチマーク**: モデル込みで目標2-3秒
7. **Stable-Hairライセンス確認**: 商用利用可否

## Modal エンドポイント

`https://nvidia-homeftp-net--hairsnap-stable-hair-stablehairinfer-2cbe68.modal.run`

## ハマりポイント

1. Modal API名変更頻繁（container_idle_timeout→scaledown_window、web_endpoint→fastapi_endpoint）
2. Vercel SSO認証はProtection Bypassシークレットでしか解除不可
3. RunPodワーカー固着はworkersMax=0→3でリセット
4. Google Driveダウンロード不安定、失敗したら個別ファイルIDで再試行

## ベンチマーク

| 計測 | Modal | RunPod |
|------|-------|--------|
| 初回コールドスタート | 14.4s | 14.5s |
| 2回目コールドスタート | **0.5s** | 14s+ |
| ウォーム | 0.6-0.9s | 0.9-1.2s |
