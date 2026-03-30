# =============================================================================
# RunPod Serverless — Stable-Hair v1 推論コンテナ
#
# RunPod GitHub Integration:
#   GitHub push (main) → RunPod 自動ビルド → Endpoint 自動更新
#
# ビルド方法 (ローカルテスト):
#   docker build -t hairsnap-stable-hair .
#   docker run --gpus all -p 8000:8000 hairsnap-stable-hair
#
# モデルサイズ合計: ~8GB (SD1.5: ~5GB + Stable-Hair: ~3GB)
# 推奨GPU: RTX 4090 (24GB VRAM)
# =============================================================================

FROM nvidia/cuda:12.1.0-cudnn8-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1
ENV MODEL_PATH=/models

WORKDIR /app

# --- システム依存 ---
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.10 python3-pip python3.10-venv \
    git git-lfs wget curl \
    libgl1-mesa-glx libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# pip のアップグレード
RUN pip install --no-cache-dir --upgrade pip setuptools wheel

# --- Python 依存関係 (レイヤーキャッシュ用に先にインストール) ---
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# --- Stable-Hair コードのクローン ---
RUN git clone --depth 1 https://github.com/Xiaojiu-z/Stable-Hair.git /app/Stable-Hair

# --- Stable Diffusion v1-5 ベースモデルのダウンロード ---
# HuggingFace から必要なサブフォルダのみ取得 (全体だと大きすぎる)
RUN pip install --no-cache-dir huggingface_hub && \
    python3 -c " \
from huggingface_hub import snapshot_download; \
snapshot_download( \
    'runwayml/stable-diffusion-v1-5', \
    local_dir='/models/stable-diffusion-v1-5', \
    allow_patterns=['*.json', '*.txt', '*.bin', '*.safetensors', '*.fp16.*'], \
    ignore_patterns=['*.ckpt', '*.msgpack', 'logs/*'], \
)"

# --- Stable-Hair モデルウェイトのダウンロード (Google Drive) ---
RUN pip install --no-cache-dir gdown && \
    mkdir -p /models/stable-hair/stage1 /models/stable-hair/stage2

# Google Drive フォルダ ID: 1E-8Udfw8S8IorCWhBgS4FajIbqlrWRbQ
# Stage 1: Bald Converter
RUN gdown --fuzzy "https://drive.google.com/drive/folders/1E-8Udfw8S8IorCWhBgS4FajIbqlrWRbQ" \
    -O /models/stable-hair/ --folder || \
    echo "[WARN] gdown folder download failed. Will retry with individual files."

# フォルダダウンロードが失敗した場合の個別ダウンロード用フォールバック
# (Google Driveのフォルダ構成に依存するため、実際のファイルIDで調整が必要)
RUN if [ ! -f /models/stable-hair/stage1/pytorch_model.bin ]; then \
        echo "[INFO] Attempting individual file downloads..."; \
        echo "[WARN] Google Drive file IDs need to be configured."; \
        echo "[WARN] See README for manual model setup instructions."; \
    fi

# --- ハンドラーのコピー ---
COPY handler.py .

# --- ヘルスチェック用 ---
EXPOSE 8000

# --- RunPod Serverless 起動 ---
CMD ["python3", "-u", "handler.py"]
