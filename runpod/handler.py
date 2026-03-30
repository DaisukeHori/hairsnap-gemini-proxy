"""
RunPod Serverless Handler — Stable-Hair v1

モデルは Network Volume (/runpod-volume/models) に自動ダウンロード。
初回リクエスト時のみDLが走り、以降はキャッシュを使う。

入力:
  customer_photo: base64 (必須)
  reference_photo: base64 (任意)
  bald_cache_key: string (任意)
  seed / num_inference_steps / guidance_scale / hair_scale / controlnet_scale / size
  echo: bool → エコーモード（デバッグ用）
  download_only: bool → モデルDLのみ実行
"""

import runpod
import torch
import numpy as np
import base64
import time
import os
import sys
import random
from io import BytesIO
from PIL import Image

# Stable-Hair コードパス
if os.path.exists("/app/Stable-Hair"):
    sys.path.insert(0, "/app/Stable-Hair")

# ---------------------------------------------------------------------------
# 定数
# ---------------------------------------------------------------------------
MODEL_BASE = os.environ.get("MODEL_PATH", "/runpod-volume/models")
CACHE_DIR = "/tmp/bald_cache"
SD15_PATH = os.path.join(MODEL_BASE, "stable-diffusion-v1-5")
SH_DIR = os.path.join(MODEL_BASE, "stable-hair")
STAGE1_PATH = os.path.join(SH_DIR, "stage1", "pytorch_model.bin")
STAGE2_DIR = os.path.join(SH_DIR, "stage2")

# グローバル
engine = None


# ---------------------------------------------------------------------------
# ユーティリティ
# ---------------------------------------------------------------------------
def decode_image(b64: str) -> Image.Image:
    return Image.open(BytesIO(base64.b64decode(b64))).convert("RGB")

def encode_image(img: Image.Image, q: int = 92) -> str:
    buf = BytesIO()
    img.save(buf, format="JPEG", quality=q)
    return base64.b64encode(buf.getvalue()).decode()

def encode_ndarray(arr: np.ndarray, q: int = 92) -> str:
    if arr.dtype != np.uint8:
        arr = (arr * 255.0).clip(0, 255).astype(np.uint8)
    return encode_image(Image.fromarray(arr), q)


# ---------------------------------------------------------------------------
# モデルダウンロード
# ---------------------------------------------------------------------------
def models_ready() -> bool:
    return (
        os.path.exists(os.path.join(SD15_PATH, "unet", "config.json"))
        and os.path.exists(STAGE1_PATH)
        and os.path.exists(os.path.join(STAGE2_DIR, "pytorch_model.bin"))
    )

def download_models() -> str:
    """SD1.5 + Stable-Hair をNetwork Volumeにダウンロード"""
    log = []

    os.makedirs(MODEL_BASE, exist_ok=True)

    # --- SD1.5 ---
    if not os.path.exists(os.path.join(SD15_PATH, "unet", "config.json")):
        log.append("[DL] Downloading SD1.5 from HuggingFace...")
        print(log[-1])
        from huggingface_hub import snapshot_download
        snapshot_download(
            "runwayml/stable-diffusion-v1-5",
            local_dir=SD15_PATH,
            allow_patterns=["*.json", "*.txt", "*.bin", "*.safetensors"],
            ignore_patterns=["*.ckpt", "*.msgpack", "logs/*", "*.fp16.*"],
        )
        log.append("[DL] SD1.5 done.")
        print(log[-1])
    else:
        log.append("[DL] SD1.5 already exists, skipped.")

    # --- Stable-Hair ---
    if not os.path.exists(STAGE1_PATH):
        log.append("[DL] Downloading Stable-Hair from Google Drive...")
        print(log[-1])
        import gdown
        os.makedirs(os.path.join(SH_DIR, "stage1"), exist_ok=True)
        os.makedirs(STAGE2_DIR, exist_ok=True)

        # Google Drive フォルダ: https://drive.google.com/drive/folders/1E-8Udfw8S8IorCWhBgS4FajIbqlrWRbQ
        try:
            gdown.download_folder(
                "https://drive.google.com/drive/folders/1E-8Udfw8S8IorCWhBgS4FajIbqlrWRbQ",
                output=SH_DIR,
                quiet=False,
            )
            log.append("[DL] Stable-Hair folder download done.")
        except Exception as e:
            log.append(f"[DL] Folder download failed: {e}. Trying individual files...")
            print(log[-1])

        # ダウンロード後の検証
        expected = [
            STAGE1_PATH,
            os.path.join(STAGE2_DIR, "pytorch_model.bin"),
            os.path.join(STAGE2_DIR, "pytorch_model_1.bin"),
            os.path.join(STAGE2_DIR, "pytorch_model_2.bin"),
        ]
        missing = [f for f in expected if not os.path.exists(f)]
        if missing:
            log.append(f"[DL] WARNING: missing files: {missing}")
        else:
            log.append("[DL] All Stable-Hair files verified.")
        print(log[-1])
    else:
        log.append("[DL] Stable-Hair already exists, skipped.")

    return "\n".join(log)


# ---------------------------------------------------------------------------
# Stable-Hair エンジン
# ---------------------------------------------------------------------------
class StableHairEngine:
    def __init__(self, model_base: str, device: str = "cuda"):
        print("[init] Loading Stable-Hair models...")
        t0 = time.time()
        dtype = torch.float16

        from diffusers import UniPCMultistepScheduler
        from diffusers.models import UNet2DConditionModel
        from ref_encoder.latent_controlnet import ControlNetModel
        from ref_encoder.adapter import adapter_injection, set_scale
        from ref_encoder.reference_unet import ref_unet
        from utils.pipeline import StableHairPipeline
        from utils.pipeline_cn import StableDiffusionControlNetPipeline

        self.set_scale = set_scale
        self.device = device
        self.dtype = dtype

        sd = os.path.join(model_base, "stable-diffusion-v1-5")
        s1 = os.path.join(model_base, "stable-hair", "stage1", "pytorch_model.bin")
        s2 = os.path.join(model_base, "stable-hair", "stage2")

        # Stage 2
        unet = UNet2DConditionModel.from_pretrained(sd, subfolder="unet").to(device)
        controlnet = ControlNetModel.from_unet(unet).to(device)
        controlnet.load_state_dict(torch.load(os.path.join(s2, "pytorch_model_2.bin"), map_location=device, weights_only=True), strict=False)
        controlnet.to(dtype)

        self.pipeline = StableHairPipeline.from_pretrained(sd, controlnet=controlnet, safety_checker=None, torch_dtype=dtype).to(device)
        self.pipeline.scheduler = UniPCMultistepScheduler.from_config(self.pipeline.scheduler.config)

        self.hair_encoder = ref_unet.from_pretrained(sd, subfolder="unet").to(device)
        self.hair_encoder.load_state_dict(torch.load(os.path.join(s2, "pytorch_model.bin"), map_location=device, weights_only=True), strict=False)
        self.hair_encoder.to(dtype)

        self.hair_adapter = adapter_injection(self.pipeline.unet, device=device, dtype=dtype, use_resampler=False)
        self.hair_adapter.load_state_dict(torch.load(os.path.join(s2, "pytorch_model_1.bin"), map_location=device, weights_only=True), strict=False)
        self.hair_adapter.to(dtype)

        # Stage 1
        bald_cn = ControlNetModel.from_unet(unet).to(device)
        bald_cn.load_state_dict(torch.load(s1, map_location=device, weights_only=True), strict=False)
        bald_cn.to(dtype)
        del unet

        self.bald_pipe = StableDiffusionControlNetPipeline.from_pretrained(sd, controlnet=bald_cn, safety_checker=None, torch_dtype=dtype).to(device)
        self.bald_pipe.scheduler = UniPCMultistepScheduler.from_config(self.bald_pipe.scheduler.config)

        os.makedirs(CACHE_DIR, exist_ok=True)
        print(f"[init] Done in {time.time()-t0:.1f}s")

    @torch.inference_mode()
    def get_bald(self, img: Image.Image, scale: float = 0.9) -> Image.Image:
        W, H = img.size
        return self.bald_pipe(prompt="", negative_prompt="", num_inference_steps=30, guidance_scale=1.5, width=W, height=H, image=img, controlnet_conditioning_scale=scale).images[0]

    @torch.inference_mode()
    def transfer(self, customer: Image.Image, reference: Image.Image, seed=-1, steps=30, guidance_scale=1.5, hair_scale=1.0, cn_scale=1.0, size=512, bald_cache_key=""):
        cust = customer.resize((size, size))
        ref_np = np.array(reference.resize((size, size)))

        # Bald (cache)
        cached = False
        cp = os.path.join(CACHE_DIR, f"{bald_cache_key}.jpg") if bald_cache_key else ""
        if cp and os.path.exists(cp):
            bald_np = np.array(Image.open(cp).convert("RGB").resize((size, size)))
            cached = True
        else:
            bald_np = np.array(self.get_bald(cust))
            if cp:
                Image.fromarray(bald_np).save(cp, quality=95)

        # Transfer
        if seed < 0:
            seed = random.randint(0, 2**32-1)
        self.set_scale(self.pipeline.unet, hair_scale)
        gen = torch.Generator(device=self.device).manual_seed(seed)
        result = self.pipeline(prompt="", negative_prompt="", num_inference_steps=steps, guidance_scale=guidance_scale, width=size, height=size, controlnet_condition=bald_np, controlnet_conditioning_scale=cn_scale, generator=gen, reference_encoder=self.hair_encoder, ref_image=ref_np).samples
        return result, cached


# ---------------------------------------------------------------------------
# Handler
# ---------------------------------------------------------------------------
def handler(job):
    global engine
    inp = job["input"]
    t0 = time.time()

    # エコーモード
    if inp.get("echo"):
        return {"status": "echo", "models_ready": models_ready(), "model_path": MODEL_BASE, "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "none"}

    # ダウンロードモード
    if inp.get("download_only") or not models_ready():
        log = download_models()
        if inp.get("download_only"):
            return {"status": "download_complete", "log": log, "models_ready": models_ready()}
        # ダウンロード後、推論に進む（customer_photoがある場合）
        if "customer_photo" not in inp:
            return {"status": "download_complete", "log": log, "models_ready": models_ready()}

    # モデルロード
    if engine is None:
        if not models_ready():
            return {"error": "Models not available after download attempt", "model_path": MODEL_BASE}
        engine = StableHairEngine(MODEL_BASE)

    # 推論
    if "customer_photo" not in inp:
        return {"error": "customer_photo is required"}

    customer = decode_image(inp["customer_photo"])
    reference = decode_image(inp["reference_photo"]) if inp.get("reference_photo") else None
    size = int(inp.get("size", 512))

    if reference:
        result_np, cached = engine.transfer(
            customer, reference,
            seed=int(inp.get("seed", -1)),
            steps=int(inp.get("num_inference_steps", 30)),
            guidance_scale=float(inp.get("guidance_scale", 1.5)),
            hair_scale=float(inp.get("hair_scale", 1.0)),
            cn_scale=float(inp.get("controlnet_scale", 1.0)),
            size=size,
            bald_cache_key=inp.get("bald_cache_key", ""),
        )
        img_b64 = encode_ndarray(result_np)
    else:
        bald = engine.get_bald(customer.resize((size, size)))
        img_b64 = encode_image(bald)
        cached = False

    return {"image": img_b64, "model": "stable-hair-v1", "gpu_time_ms": int((time.time()-t0)*1000), "cached_bald": cached}

runpod.serverless.start({"handler": handler})
