"""
Modal Serverless — Stable-Hair v1 with GPU Memory Snapshots

デプロイ:
  modal deploy modal/app.py

テスト:
  curl -X POST https://YOUR_APP--stable-hair-generate.modal.run \
    -H "Content-Type: application/json" \
    -d '{"echo": true}'
"""

import modal
import os
import sys
import time
import base64
import random
from io import BytesIO

# ---------------------------------------------------------------------------
# Modal App定義
# ---------------------------------------------------------------------------
app = modal.App("hairsnap-stable-hair")

# モデル保存用 Volume
model_vol = modal.Volume.from_name("stable-hair-models", create_if_missing=True)
MODEL_DIR = "/models"
CACHE_DIR = "/tmp/bald_cache"

# Stable-Hair コード用 Volume (git clone結果をキャッシュ)
code_vol = modal.Volume.from_name("stable-hair-code", create_if_missing=True)
CODE_DIR = "/stable-hair-code"

# ---------------------------------------------------------------------------
# コンテナイメージ定義
# ---------------------------------------------------------------------------
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "libgl1-mesa-glx", "libglib2.0-0")
    .pip_install(
        "torch==2.4.0",
        "torchvision==0.19.0",
        "diffusers==0.31.0",
        "transformers==4.45.2",
        "accelerate>=0.33.0",
        "safetensors>=0.4.0",
        "omegaconf>=2.3.0",
        "einops>=0.4.1",
        "kornia>=0.7.0",
        "opencv-python-headless>=4.9.0",
        "gdown>=5.0.0",
        "huggingface_hub[hf_transfer]>=0.25.0",
        "numpy<2",
        "Pillow>=10.0.0",
        "fastapi[standard]",
    )
    .env({"HF_HUB_ENABLE_HF_TRANSFER": "1"})
)


# ---------------------------------------------------------------------------
# モデルダウンロード (別Function、Volume に保存)
# ---------------------------------------------------------------------------
@app.function(
    image=image,
    volumes={MODEL_DIR: model_vol, CODE_DIR: code_vol},
    timeout=30 * 60,
)
def download_models():
    """SD1.5 + Stable-Hair モデルをVolumeにダウンロード"""
    import subprocess

    # Stable-Hair コード
    sh_code = os.path.join(CODE_DIR, "Stable-Hair")
    if not os.path.exists(os.path.join(sh_code, "utils", "pipeline.py")):
        print("[DL] Cloning Stable-Hair...")
        subprocess.run(
            ["git", "clone", "--depth", "1",
             "https://github.com/Xiaojiu-z/Stable-Hair.git", sh_code],
            check=True,
        )
        code_vol.commit()
        print("[DL] Stable-Hair code cloned.")
    else:
        print("[DL] Stable-Hair code exists.")

    # SD1.5
    sd_path = os.path.join(MODEL_DIR, "stable-diffusion-v1-5")
    if not os.path.exists(os.path.join(sd_path, "unet", "config.json")):
        print("[DL] Downloading SD1.5...")
        from huggingface_hub import snapshot_download
        snapshot_download(
            "runwayml/stable-diffusion-v1-5",
            local_dir=sd_path,
            allow_patterns=["*.json", "*.txt", "*.bin", "*.safetensors"],
            ignore_patterns=["*.ckpt", "*.msgpack", "logs/*", "*.fp16.*"],
        )
        model_vol.commit()
        print("[DL] SD1.5 done.")
    else:
        print("[DL] SD1.5 exists.")

    # Stable-Hair weights
    sh_dir = os.path.join(MODEL_DIR, "stable-hair")
    stage1 = os.path.join(sh_dir, "stage1", "pytorch_model.bin")
    if not os.path.exists(stage1):
        print("[DL] Downloading Stable-Hair weights from Google Drive...")
        import gdown
        os.makedirs(sh_dir, exist_ok=True)
        try:
            gdown.download_folder(
                "https://drive.google.com/drive/folders/1E-8Udfw8S8IorCWhBgS4FajIbqlrWRbQ",
                output=sh_dir,
                quiet=False,
            )
        except Exception as e:
            print(f"[DL] Folder download failed: {e}")

        model_vol.commit()

        # 検証
        expected = [
            stage1,
            os.path.join(sh_dir, "stage2", "pytorch_model.bin"),
            os.path.join(sh_dir, "stage2", "pytorch_model_1.bin"),
            os.path.join(sh_dir, "stage2", "pytorch_model_2.bin"),
        ]
        missing = [f for f in expected if not os.path.exists(f)]
        if missing:
            print(f"[DL] WARNING: missing files: {missing}")
        else:
            print("[DL] All Stable-Hair files verified.")
    else:
        print("[DL] Stable-Hair weights exist.")

    return {"status": "done"}


# ---------------------------------------------------------------------------
# ユーティリティ
# ---------------------------------------------------------------------------
def _models_ready():
    sd = os.path.join(MODEL_DIR, "stable-diffusion-v1-5", "unet", "config.json")
    s1 = os.path.join(MODEL_DIR, "stable-hair", "stage1", "pytorch_model.bin")
    s2 = os.path.join(MODEL_DIR, "stable-hair", "stage2", "pytorch_model.bin")
    return os.path.exists(sd) and os.path.exists(s1) and os.path.exists(s2)


def _decode_image(b64: str):
    from PIL import Image
    return Image.open(BytesIO(base64.b64decode(b64))).convert("RGB")


def _encode_image(img, q: int = 92) -> str:
    buf = BytesIO()
    img.save(buf, format="JPEG", quality=q)
    return base64.b64encode(buf.getvalue()).decode()


def _encode_ndarray(arr, q: int = 92) -> str:
    from PIL import Image
    import numpy as np
    if arr.dtype != np.uint8:
        arr = (arr * 255.0).clip(0, 255).astype(np.uint8)
    return _encode_image(Image.fromarray(arr), q)


# ---------------------------------------------------------------------------
# 推論クラス (GPU Memory Snapshots 対応)
# ---------------------------------------------------------------------------
@app.cls(
    image=image,
    gpu="A10G",  # 24GB, RTX 4090相当。T4/L4/A100に変更可
    volumes={MODEL_DIR: model_vol, CODE_DIR: code_vol},
    timeout=300,
    scaledown_window=30,  # 30秒アイドルでコンテナ停止
    enable_memory_snapshot=True,
    memory=8192,  # 8GB RAM for model loading
)
class StableHairInference:
    """Stable-Hair 推論エンドポイント"""

    @modal.enter(snap=True)
    def load_to_cpu(self):
        """スナップショット作成前: モデルをCPUメモリに読み込む"""
        import torch

        # Stable-Hair コードパス追加
        sh_code = os.path.join(CODE_DIR, "Stable-Hair")
        if os.path.exists(sh_code) and sh_code not in sys.path:
            sys.path.insert(0, sh_code)

        self.models_available = _models_ready()
        if not self.models_available:
            print("[init] Models not found. Passthrough mode.")
            return

        print("[init] Loading models to CPU...")
        t0 = time.time()
        dtype = torch.float16
        device = "cpu"
        sd = os.path.join(MODEL_DIR, "stable-diffusion-v1-5")
        s1 = os.path.join(MODEL_DIR, "stable-hair", "stage1", "pytorch_model.bin")
        s2 = os.path.join(MODEL_DIR, "stable-hair", "stage2")

        from diffusers import UniPCMultistepScheduler
        from diffusers.models import UNet2DConditionModel
        from ref_encoder.latent_controlnet import ControlNetModel
        from ref_encoder.adapter import adapter_injection, set_scale
        from ref_encoder.reference_unet import ref_unet
        from utils.pipeline import StableHairPipeline
        from utils.pipeline_cn import StableDiffusionControlNetPipeline

        self.set_scale = set_scale
        self.dtype = dtype

        # Stage 2
        unet = UNet2DConditionModel.from_pretrained(sd, subfolder="unet").to(device)
        controlnet = ControlNetModel.from_unet(unet).to(device)
        controlnet.load_state_dict(
            torch.load(os.path.join(s2, "pytorch_model_2.bin"), map_location=device, weights_only=True),
            strict=False,
        )
        controlnet.to(dtype)

        self.pipeline = StableHairPipeline.from_pretrained(
            sd, controlnet=controlnet, safety_checker=None, torch_dtype=dtype
        )
        self.pipeline.scheduler = UniPCMultistepScheduler.from_config(
            self.pipeline.scheduler.config
        )

        self.hair_encoder = ref_unet.from_pretrained(sd, subfolder="unet").to(device)
        self.hair_encoder.load_state_dict(
            torch.load(os.path.join(s2, "pytorch_model.bin"), map_location=device, weights_only=True),
            strict=False,
        )
        self.hair_encoder.to(dtype)

        self.hair_adapter = adapter_injection(
            self.pipeline.unet, device=device, dtype=dtype, use_resampler=False
        )
        self.hair_adapter.load_state_dict(
            torch.load(os.path.join(s2, "pytorch_model_1.bin"), map_location=device, weights_only=True),
            strict=False,
        )
        self.hair_adapter.to(dtype)

        # Stage 1 (Bald Converter)
        bald_cn = ControlNetModel.from_unet(unet).to(device)
        bald_cn.load_state_dict(
            torch.load(s1, map_location=device, weights_only=True),
            strict=False,
        )
        bald_cn.to(dtype)
        del unet

        self.bald_pipe = StableDiffusionControlNetPipeline.from_pretrained(
            sd, controlnet=bald_cn, safety_checker=None, torch_dtype=dtype
        )
        self.bald_pipe.scheduler = UniPCMultistepScheduler.from_config(
            self.bald_pipe.scheduler.config
        )

        os.makedirs(CACHE_DIR, exist_ok=True)
        print(f"[init] CPU load done in {time.time()-t0:.1f}s")

    @modal.enter(snap=False)
    def move_to_gpu(self):
        """スナップショット復元後: GPUに移動"""
        if not getattr(self, "models_available", False):
            return

        import torch
        print("[init] Moving models to GPU...")
        t0 = time.time()
        self.device = "cuda"
        self.pipeline.to(self.device)
        self.hair_encoder.to(self.device)
        self.bald_pipe.to(self.device)
        print(f"[init] GPU transfer done in {time.time()-t0:.1f}s")

    @modal.web_endpoint(method="POST", docs=True)
    def generate(self, request: dict):
        """
        Stable-Hair 推論エンドポイント

        RunPodハンドラーと同じJSON形式:
        {
            "customer_photo": "<base64>",
            "reference_photo": "<base64>",
            "bald_cache_key": "xxx",
            "seed": -1,
            "num_inference_steps": 30,
            "echo": true/false
        }
        """
        import torch
        import numpy as np
        t0 = time.time()

        # エコーモード
        if request.get("echo"):
            return {
                "status": "echo",
                "models_ready": getattr(self, "models_available", False),
                "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "none",
                "backend": "modal",
            }

        # パススルーモード (モデル未配置)
        if not getattr(self, "models_available", False):
            if "customer_photo" in request:
                return {
                    "image": request["customer_photo"],
                    "model": "passthrough (models not loaded)",
                    "gpu_time_ms": int((time.time() - t0) * 1000),
                    "cached_bald": False,
                    "backend": "modal",
                }
            return {"error": "Models not available", "backend": "modal"}

        # 推論
        if "customer_photo" not in request:
            return {"error": "customer_photo is required"}

        customer = _decode_image(request["customer_photo"])
        reference = (
            _decode_image(request["reference_photo"])
            if request.get("reference_photo")
            else None
        )
        size = int(request.get("size", 512))
        steps = int(request.get("num_inference_steps", 30))
        guidance = float(request.get("guidance_scale", 1.5))
        hair_scale = float(request.get("hair_scale", 1.0))
        cn_scale = float(request.get("controlnet_scale", 1.0))
        seed = int(request.get("seed", -1))
        bald_cache_key = request.get("bald_cache_key", "")

        cust = customer.resize((size, size))

        if reference:
            ref_np = np.array(reference.resize((size, size)))

            # Bald (cache)
            cached = False
            cp = os.path.join(CACHE_DIR, f"{bald_cache_key}.jpg") if bald_cache_key else ""
            if cp and os.path.exists(cp):
                from PIL import Image
                bald_np = np.array(Image.open(cp).convert("RGB").resize((size, size)))
                cached = True
            else:
                with torch.inference_mode():
                    bald = self.bald_pipe(
                        prompt="", negative_prompt="",
                        num_inference_steps=steps, guidance_scale=guidance,
                        width=size, height=size, image=cust,
                        controlnet_conditioning_scale=0.9,
                    ).images[0]
                bald_np = np.array(bald)
                if cp:
                    from PIL import Image
                    Image.fromarray(bald_np).save(cp, quality=95)

            # Transfer
            if seed < 0:
                seed = random.randint(0, 2**32 - 1)
            self.set_scale(self.pipeline.unet, hair_scale)
            gen = torch.Generator(device=self.device).manual_seed(seed)
            with torch.inference_mode():
                result = self.pipeline(
                    prompt="", negative_prompt="",
                    num_inference_steps=steps, guidance_scale=guidance,
                    width=size, height=size,
                    controlnet_condition=bald_np,
                    controlnet_conditioning_scale=cn_scale,
                    generator=gen,
                    reference_encoder=self.hair_encoder,
                    ref_image=ref_np,
                ).samples
            img_b64 = _encode_ndarray(result)
        else:
            with torch.inference_mode():
                bald = self.bald_pipe(
                    prompt="", negative_prompt="",
                    num_inference_steps=steps, guidance_scale=guidance,
                    width=size, height=size, image=cust.resize((size, size)),
                    controlnet_conditioning_scale=0.9,
                ).images[0]
            img_b64 = _encode_image(bald)
            cached = False

        return {
            "image": img_b64,
            "model": "stable-hair-v1",
            "gpu_time_ms": int((time.time() - t0) * 1000),
            "cached_bald": cached,
            "backend": "modal",
        }
