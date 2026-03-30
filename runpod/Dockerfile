# =============================================================================
# RunPod Serverless — Stable-Hair v1 (CUDA + Network Volume)
#
# モデルは Network Volume (/runpod-volume) に保存。
# 初回リクエスト時に handler.py が自動ダウンロード。
#
# ⚠️ ベースイメージのタグは DockerHub で確認:
#    https://hub.docker.com/r/runpod/pytorch/tags
#    存在しないタグ (例: cuda12.1.1) を指定するとビルドが即失敗する。
# =============================================================================

FROM runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04

ENV PYTHONUNBUFFERED=1
ENV MODEL_PATH=/runpod-volume/models
ENV HF_HOME=/runpod-volume/hf_cache

WORKDIR /app

# --- Stable-Hair 依存 ---
RUN pip install --no-cache-dir \
    runpod>=1.7.0 \
    diffusers==0.31.0 \
    transformers==4.45.2 \
    accelerate>=0.33.0 \
    safetensors>=0.4.0 \
    omegaconf>=2.3.0 \
    einops>=0.4.1 \
    kornia>=0.7.0 \
    opencv-python-headless>=4.9.0 \
    gdown>=5.0.0 \
    huggingface_hub>=0.25.0

# --- Stable-Hair コードのクローン ---
RUN git clone --depth 1 https://github.com/Xiaojiu-z/Stable-Hair.git /app/Stable-Hair

# --- ハンドラー ---
COPY handler.py .

CMD ["python3", "-u", "handler.py"]
