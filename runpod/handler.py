"""
RunPod Serverless Handler — Stable-Hair v1 推論エンジン

RunPod GitHub Integration でデプロイ:
  GitHub push → RunPod が自動ビルド → Endpoint 自動更新

入力 (JSON):
  customer_photo:      base64 (必須) — 顧客の顔写真
  reference_photo:     base64 (任意) — ヘアスタイル参照画像
  bald_cache_key:      string (任意) — Bald画像キャッシュキー
  seed:                int    (任意) — 乱数シード (-1=ランダム)
  num_inference_steps:  int   (任意) — 推論ステップ数 (default: 30)
  guidance_scale:      float  (任意) — ガイダンススケール (default: 1.5)
  hair_scale:          float  (任意) — Hair Encoder スケール (default: 1.0)
  controlnet_scale:    float  (任意) — ControlNet スケール (default: 1.0)
  size:                int    (任意) — 出力サイズ (default: 512)

出力 (JSON):
  image:       base64 — 生成された画像
  model:       string — "stable-hair-v1"
  gpu_time_ms: int    — GPU処理時間 (ms)
  cached_bald: bool   — Baldキャッシュヒットしたか
"""

import runpod
import numpy as np
import base64
import time
import os
import random
import sys
from io import BytesIO
from PIL import Image

# GPU依存ライブラリは遅延インポート (ビルドテスト時はなくてもOK)
try:
    import torch
    HAS_TORCH = True
except ImportError:
    HAS_TORCH = False

# Stable-Hair のコードパスを追加
if os.path.exists("/app/Stable-Hair"):
    sys.path.insert(0, "/app/Stable-Hair")

# ---------------------------------------------------------------------------
# グローバル変数: モデルはコンテナ起動時に1回だけロード
# ---------------------------------------------------------------------------
stable_hair_engine = None
CACHE_DIR = "/tmp/bald_cache"
MODEL_BASE = os.environ.get("MODEL_PATH", "/models")


def decode_image(b64_string: str) -> Image.Image:
    """Base64 → PIL Image"""
    return Image.open(BytesIO(base64.b64decode(b64_string))).convert("RGB")


def encode_image(image: Image.Image, quality: int = 92) -> str:
    """PIL Image → Base64 JPEG"""
    buf = BytesIO()
    image.save(buf, format="JPEG", quality=quality)
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def encode_ndarray(arr: np.ndarray, quality: int = 92) -> str:
    """numpy array (H,W,C) uint8 or float[0-1] → Base64 JPEG"""
    if arr.dtype != np.uint8:
        arr = (arr * 255.0).clip(0, 255).astype(np.uint8)
    return encode_image(Image.fromarray(arr), quality)


# ---------------------------------------------------------------------------
# Stable-Hair 推論エンジン (infer_full.py の StableHair をベースに改良)
# ---------------------------------------------------------------------------
class StableHairEngine:
    """Stable-Hair v1 推論エンジン (RunPod Serverless 用)"""

    def __init__(self, model_base: str, device: str = "cuda", dtype=torch.float16):
        print("[init] Loading Stable-Hair models...")
        t0 = time.time()

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

        sd_path = os.path.join(model_base, "stable-diffusion-v1-5")
        stage1_path = os.path.join(model_base, "stable-hair", "stage1", "pytorch_model.bin")
        stage2_dir = os.path.join(model_base, "stable-hair", "stage2")

        # --- Stage 2: Hair Transfer Pipeline ---
        print("[init]  Loading UNet...")
        unet = UNet2DConditionModel.from_pretrained(sd_path, subfolder="unet").to(device)

        print("[init]  Loading Stage2 ControlNet...")
        controlnet = ControlNetModel.from_unet(unet).to(device)
        state_dict = torch.load(
            os.path.join(stage2_dir, "pytorch_model_2.bin"),
            map_location=device, weights_only=True,
        )
        controlnet.load_state_dict(state_dict, strict=False)
        controlnet.to(dtype)

        print("[init]  Building Hair Transfer Pipeline...")
        self.pipeline = StableHairPipeline.from_pretrained(
            sd_path,
            controlnet=controlnet,
            safety_checker=None,
            torch_dtype=dtype,
        ).to(device)
        self.pipeline.scheduler = UniPCMultistepScheduler.from_config(
            self.pipeline.scheduler.config
        )

        print("[init]  Loading Hair Encoder...")
        self.hair_encoder = ref_unet.from_pretrained(
            sd_path, subfolder="unet"
        ).to(device)
        state_dict = torch.load(
            os.path.join(stage2_dir, "pytorch_model.bin"),
            map_location=device, weights_only=True,
        )
        self.hair_encoder.load_state_dict(state_dict, strict=False)
        self.hair_encoder.to(dtype)

        print("[init]  Loading Hair Adapter...")
        self.hair_adapter = adapter_injection(
            self.pipeline.unet, device=device, dtype=dtype, use_resampler=False,
        )
        state_dict = torch.load(
            os.path.join(stage2_dir, "pytorch_model_1.bin"),
            map_location=device, weights_only=True,
        )
        self.hair_adapter.load_state_dict(state_dict, strict=False)
        self.hair_adapter.to(dtype)

        # --- Stage 1: Bald Converter ---
        print("[init]  Loading Bald Converter...")
        bald_controlnet = ControlNetModel.from_unet(unet).to(device)
        state_dict = torch.load(stage1_path, map_location=device, weights_only=True)
        bald_controlnet.load_state_dict(state_dict, strict=False)
        bald_controlnet.to(dtype)
        del unet  # VRAM 解放

        self.remove_hair_pipeline = StableDiffusionControlNetPipeline.from_pretrained(
            sd_path,
            controlnet=bald_controlnet,
            safety_checker=None,
            torch_dtype=dtype,
        ).to(device)
        self.remove_hair_pipeline.scheduler = UniPCMultistepScheduler.from_config(
            self.remove_hair_pipeline.scheduler.config
        )

        os.makedirs(CACHE_DIR, exist_ok=True)

        elapsed = time.time() - t0
        print(f"[init] All models loaded in {elapsed:.1f}s")

    @torch.inference_mode()
    def get_bald(self, id_image: Image.Image, scale: float = 0.9) -> Image.Image:
        """Stage 1: 顧客写真 → Bald画像"""
        W, H = id_image.size
        image = self.remove_hair_pipeline(
            prompt="",
            negative_prompt="",
            num_inference_steps=30,
            guidance_scale=1.5,
            width=W,
            height=H,
            image=id_image,
            controlnet_conditioning_scale=scale,
            generator=None,
        ).images[0]
        return image

    @torch.inference_mode()
    def transfer(
        self,
        customer: Image.Image,
        reference: Image.Image,
        seed: int = -1,
        steps: int = 30,
        guidance_scale: float = 1.5,
        hair_scale: float = 1.0,
        controlnet_scale: float = 1.0,
        size: int = 512,
        bald_cache_key: str = "",
    ) -> tuple:
        """
        Stage 1 + Stage 2: 顧客写真 + 参照ヘアスタイル → 合成画像

        Returns: (result_ndarray, cached_bald)
        """
        customer_resized = customer.resize((size, size))
        reference_np = np.array(reference.resize((size, size)))

        # --- Stage 1: Bald変換 (キャッシュ対応) ---
        cached_bald = False
        cache_path = os.path.join(CACHE_DIR, f"{bald_cache_key}.jpg") if bald_cache_key else ""

        if cache_path and os.path.exists(cache_path):
            bald_np = np.array(Image.open(cache_path).convert("RGB").resize((size, size)))
            cached_bald = True
            print(f"[bald] Cache HIT: {bald_cache_key}")
        else:
            bald_image = self.get_bald(customer_resized, scale=0.9)
            bald_np = np.array(bald_image)
            if cache_path:
                bald_image.save(cache_path, quality=95)
                print(f"[bald] Cache MISS → saved: {bald_cache_key}")

        # --- Stage 2: Hair Transfer ---
        if seed < 0:
            seed = random.randint(0, 2**32 - 1)

        self.set_scale(self.pipeline.unet, hair_scale)
        generator = torch.Generator(device=self.device).manual_seed(seed)

        result = self.pipeline(
            prompt="",
            negative_prompt="",
            num_inference_steps=steps,
            guidance_scale=guidance_scale,
            width=size,
            height=size,
            controlnet_condition=bald_np,
            controlnet_conditioning_scale=controlnet_scale,
            generator=generator,
            reference_encoder=self.hair_encoder,
            ref_image=reference_np,
        ).samples  # numpy array (H, W, C) float

        return result, cached_bald


# ---------------------------------------------------------------------------
# RunPod Handler
# ---------------------------------------------------------------------------
def check_models_available():
    """モデルファイルとGPUライブラリが存在するか確認"""
    if not HAS_TORCH:
        return False
    sd_path = os.path.join(MODEL_BASE, "stable-diffusion-v1-5", "unet", "config.json")
    stage1_path = os.path.join(MODEL_BASE, "stable-hair", "stage1", "pytorch_model.bin")
    return os.path.exists(sd_path) and os.path.exists(stage1_path)


def handler(job):
    global stable_hair_engine

    inp = job["input"]
    gpu_start = time.time()

    # --- エコーモード: モデルなしでもテスト可能 ---
    if inp.get("echo") or not check_models_available():
        model_status = "available" if check_models_available() else "not_found"
        return {
            "status": "echo_mode",
            "model_path": MODEL_BASE,
            "models_available": model_status,
            "message": "Handler is running. Models not loaded yet — mount Network Volume with models.",
            "gpu_time_ms": int((time.time() - gpu_start) * 1000),
            "input_keys": list(inp.keys()),
        }

    # --- 通常モード: Stable-Hair推論 ---
    if stable_hair_engine is None:
        stable_hair_engine = StableHairEngine(model_base=MODEL_BASE)

    # --- 入力バリデーション ---
    if "customer_photo" not in inp:
        return {"error": "customer_photo is required"}

    customer = decode_image(inp["customer_photo"])

    reference = None
    if inp.get("reference_photo"):
        reference = decode_image(inp["reference_photo"])

    # パラメータ
    seed = int(inp.get("seed", -1))
    steps = int(inp.get("num_inference_steps", 30))
    guidance_scale = float(inp.get("guidance_scale", 1.5))
    hair_scale = float(inp.get("hair_scale", 1.0))
    controlnet_scale = float(inp.get("controlnet_scale", 1.0))
    size = int(inp.get("size", 512))
    bald_cache_key = inp.get("bald_cache_key", "")

    # --- 推論 ---
    if reference is not None:
        result_np, cached_bald = stable_hair_engine.transfer(
            customer=customer,
            reference=reference,
            seed=seed,
            steps=steps,
            guidance_scale=guidance_scale,
            hair_scale=hair_scale,
            controlnet_scale=controlnet_scale,
            size=size,
            bald_cache_key=bald_cache_key,
        )
        result_b64 = encode_ndarray(result_np)
    else:
        bald = stable_hair_engine.get_bald(customer.resize((size, size)))
        result_b64 = encode_image(bald)
        cached_bald = False

    gpu_time_ms = int((time.time() - gpu_start) * 1000)

    return {
        "image": result_b64,
        "model": "stable-hair-v1",
        "gpu_time_ms": gpu_time_ms,
        "cached_bald": cached_bald,
    }


# ---------------------------------------------------------------------------
runpod.serverless.start({"handler": handler})
