# =============================================================================
# RunPod Serverless — Stable-Hair v1
# Phase 1: まずビルドを通す。モデルは Network Volume から読む。
# =============================================================================

FROM python:3.10-slim

ENV PYTHONUNBUFFERED=1
ENV MODEL_PATH=/runpod-volume/models

WORKDIR /app

# --- 依存 ---
RUN pip install --no-cache-dir \
    runpod>=1.7.0 \
    numpy>=1.26.0 \
    Pillow>=10.0.0

# --- ハンドラー ---
COPY handler.py .

CMD ["python3", "-u", "handler.py"]
