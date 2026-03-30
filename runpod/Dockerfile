FROM nvidia/cuda:12.1.0-cudnn8-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y \
    python3.10 python3-pip git git-lfs wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python 依存関係のインストール
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Stable-Hair コードのクローン
RUN git clone https://github.com/Xiaojiu-z/Stable-Hair.git /app/Stable-Hair

# 事前学習モデルのダウンロード (Google Driveから)
# NOTE: 実際のデプロイ時は RunPod Network Volume にモデルを配置して
#       /models にマウントする方がコールドスタートが速い
# RUN gdown --folder <google_drive_folder_id> -O /models/stable-hair/

COPY handler.py .

CMD ["python3", "handler.py"]
