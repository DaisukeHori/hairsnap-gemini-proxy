"""
RunPod Serverless Handler for Stable-Hair.

RunPod にデプロイして、Gemini互換プロキシから呼ばれる。
Docker イメージとしてビルドし、RunPod の Serverless Endpoint として登録。

入力:
  - customer_photo: base64エンコードされた顧客写真
  - reference_photo: base64エンコードされたヘアスタイル参照画像 (オプション)
  - additional_images: base64エンコードされた追加画像リスト (オプション)
  - prompt: テキストプロンプト (カタログ検索用、Stable-Hairでは直接使用しない)
  - bald_cache_key: Bald画像のキャッシュキー

出力:
  - image: base64エンコードされた生成画像
  - model: "stable-hair-v1"
  - gpu_time_ms: GPU処理時間 (ms)
"""

import runpod
import torch
import base64
import time
import hashlib
import os
from io import BytesIO
from PIL import Image

# ---------------------------------------------------------------------------
# グローバル変数: モデルはコンテナ起動時に1回だけロード (コールドスタート)
# ---------------------------------------------------------------------------
bald_pipeline = None
hair_pipeline = None
CACHE_DIR = "/tmp/bald_cache"


def load_models():
    """Stable-Hair のモデルをロード。コールドスタート時に1回だけ呼ばれる。"""
    global bald_pipeline, hair_pipeline

    if bald_pipeline is not None:
        return  # 既にロード済み

    print("[init] Loading Stable-Hair models...")
    start = time.time()

    # TODO: 実際の Stable-Hair モデルロードコード
    # git clone https://github.com/Xiaojiu-z/Stable-Hair.git
    # Stage 1: Bald Converter
    # Stage 2: Hair Transfer Pipeline
    #
    # 以下はプレースホルダー。実際のモデルパスに合わせて変更する。
    # ------------------------------------------------------------------
    from diffusers import StableDiffusionPipeline, UniPCMultistepScheduler

    model_path = os.environ.get("MODEL_PATH", "/models/stable-hair")
    device = "cuda" if torch.cuda.is_available() else "cpu"

    # Stage 1: Bald Converter (ControlNet ベース)
    # bald_pipeline = load_bald_converter(model_path + "/stage1")

    # Stage 2: Hair Transfer
    # hair_pipeline = load_hair_transfer(model_path + "/stage2")

    print(f"[init] Models loaded in {time.time() - start:.1f}s")
    os.makedirs(CACHE_DIR, exist_ok=True)


def decode_image(b64_string: str) -> Image.Image:
    """Base64文字列をPIL Imageに変換"""
    img_bytes = base64.b64decode(b64_string)
    return Image.open(BytesIO(img_bytes)).convert("RGB")


def encode_image(image: Image.Image, quality: int = 90) -> str:
    """PIL ImageをBase64 JPEG文字列に変換"""
    buffer = BytesIO()
    image.save(buffer, format="JPEG", quality=quality)
    return base64.b64encode(buffer.getvalue()).decode("utf-8")


def get_cached_bald(cache_key: str):
    """Bald画像のキャッシュを取得"""
    cache_path = os.path.join(CACHE_DIR, f"{cache_key}.jpg")
    if os.path.exists(cache_path):
        return Image.open(cache_path).convert("RGB")
    return None


def save_bald_cache(cache_key: str, image: Image.Image):
    """Bald画像をキャッシュに保存"""
    cache_path = os.path.join(CACHE_DIR, f"{cache_key}.jpg")
    image.save(cache_path, format="JPEG", quality=95)


def handler(job):
    """
    RunPod Serverless のメインハンドラー。
    各リクエストでこの関数が呼ばれる。
    """
    load_models()

    job_input = job["input"]
    gpu_start = time.time()

    # --- 入力の取得 ---
    customer_photo = decode_image(job_input["customer_photo"])
    reference_photo = None
    if job_input.get("reference_photo"):
        reference_photo = decode_image(job_input["reference_photo"])

    additional_images = []
    if job_input.get("additional_images"):
        additional_images = [decode_image(img) for img in job_input["additional_images"]]

    bald_cache_key = job_input.get("bald_cache_key", "")
    prompt = job_input.get("prompt", "")

    # --- Stage 1: Bald 変換 (キャッシュ対応) ---
    bald_image = get_cached_bald(bald_cache_key) if bald_cache_key else None

    if bald_image is None:
        # TODO: 実際の Bald Converter 推論
        # bald_image = bald_pipeline(customer_photo)
        # -----------------------------------------------
        # プレースホルダー: 顧客写真をそのまま返す
        bald_image = customer_photo
        # -----------------------------------------------
        if bald_cache_key:
            save_bald_cache(bald_cache_key, bald_image)
        print(f"[bald] Generated new bald image (cache_key={bald_cache_key})")
    else:
        print(f"[bald] Cache hit (cache_key={bald_cache_key})")

    # --- Stage 2: Hair Transfer ---
    if reference_photo is not None:
        # TODO: 実際の Hair Transfer 推論
        # result_image = hair_pipeline(
        #     source=bald_image,
        #     reference=reference_photo,
        # )
        # -----------------------------------------------
        # プレースホルダー: 顧客写真をそのまま返す
        result_image = customer_photo
        # -----------------------------------------------
    else:
        # 参照画像がない場合はBald画像をそのまま返す
        result_image = bald_image

    gpu_time_ms = int((time.time() - gpu_start) * 1000)

    return {
        "image": encode_image(result_image),
        "model": "stable-hair-v1",
        "gpu_time_ms": gpu_time_ms,
    }


# --- RunPod Serverless 起動 ---
runpod.serverless.start({"handler": handler})
