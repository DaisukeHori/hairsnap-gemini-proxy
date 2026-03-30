#!/usr/bin/env python3
"""
Stable-Hair モデルウェイトのダウンロードスクリプト。

使い方:
  1. Docker ビルド中に自動実行 (Dockerfile)
  2. RunPod Pod 上で手動実行 → Network Volume に保存
     python3 download_models.py --output /runpod-volume/models

Google Drive フォルダ:
  https://drive.google.com/drive/folders/1E-8Udfw8S8IorCWhBgS4FajIbqlrWRbQ

モデル構成:
  /models/
  ├── stable-diffusion-v1-5/   # HuggingFace から (~5GB)
  └── stable-hair/
      ├── stage1/
      │   └── pytorch_model.bin   # Bald Converter
      └── stage2/
          ├── pytorch_model.bin   # Hair Encoder
          ├── pytorch_model_1.bin # Adapter
          └── pytorch_model_2.bin # ControlNet
"""

import os
import sys
import argparse


def download_sd15(output_dir: str):
    """Stable Diffusion v1-5 をHuggingFaceからダウンロード"""
    from huggingface_hub import snapshot_download

    sd_path = os.path.join(output_dir, "stable-diffusion-v1-5")
    if os.path.exists(os.path.join(sd_path, "unet", "config.json")):
        print(f"[SD1.5] Already exists at {sd_path}, skipping.")
        return

    print("[SD1.5] Downloading from HuggingFace...")
    snapshot_download(
        "runwayml/stable-diffusion-v1-5",
        local_dir=sd_path,
        allow_patterns=["*.json", "*.txt", "*.bin", "*.safetensors", "*.fp16.*"],
        ignore_patterns=["*.ckpt", "*.msgpack", "logs/*"],
    )
    print(f"[SD1.5] Downloaded to {sd_path}")


def download_stable_hair(output_dir: str):
    """Stable-Hair ウェイトをGoogle Driveからダウンロード"""
    import gdown

    sh_dir = os.path.join(output_dir, "stable-hair")
    stage1_dir = os.path.join(sh_dir, "stage1")
    stage2_dir = os.path.join(sh_dir, "stage2")
    os.makedirs(stage1_dir, exist_ok=True)
    os.makedirs(stage2_dir, exist_ok=True)

    # チェック: 既にダウンロード済みか
    expected_files = [
        os.path.join(stage1_dir, "pytorch_model.bin"),
        os.path.join(stage2_dir, "pytorch_model.bin"),
        os.path.join(stage2_dir, "pytorch_model_1.bin"),
        os.path.join(stage2_dir, "pytorch_model_2.bin"),
    ]
    if all(os.path.exists(f) for f in expected_files):
        print("[Stable-Hair] All model files already exist, skipping.")
        return

    # Google Drive フォルダからダウンロード
    folder_url = "https://drive.google.com/drive/folders/1E-8Udfw8S8IorCWhBgS4FajIbqlrWRbQ"
    print(f"[Stable-Hair] Downloading from {folder_url}")

    try:
        gdown.download_folder(folder_url, output=sh_dir, quiet=False)
        print("[Stable-Hair] Folder download completed.")
    except Exception as e:
        print(f"[Stable-Hair] Folder download failed: {e}")
        print("[Stable-Hair] Please download manually from:")
        print(f"  {folder_url}")
        print(f"  and place files in: {sh_dir}/stage1/ and {sh_dir}/stage2/")
        sys.exit(1)

    # ダウンロード後の検証
    missing = [f for f in expected_files if not os.path.exists(f)]
    if missing:
        print("[Stable-Hair] WARNING: Missing files after download:")
        for f in missing:
            print(f"  - {f}")
        print("[Stable-Hair] The Google Drive folder structure may differ.")
        print("[Stable-Hair] Please check and move files manually.")
    else:
        print("[Stable-Hair] All model files verified.")


def main():
    parser = argparse.ArgumentParser(description="Download Stable-Hair models")
    parser.add_argument(
        "--output", default="/models",
        help="Output directory for models (default: /models)",
    )
    parser.add_argument(
        "--skip-sd15", action="store_true",
        help="Skip Stable Diffusion v1-5 download",
    )
    parser.add_argument(
        "--skip-stable-hair", action="store_true",
        help="Skip Stable-Hair weights download",
    )
    args = parser.parse_args()

    os.makedirs(args.output, exist_ok=True)

    if not args.skip_sd15:
        download_sd15(args.output)

    if not args.skip_stable_hair:
        download_stable_hair(args.output)

    print(f"\n[Done] All models saved to {args.output}")
    print("Model directory structure:")
    for root, dirs, files in os.walk(args.output):
        level = root.replace(args.output, "").count(os.sep)
        indent = "  " * level
        print(f"{indent}{os.path.basename(root)}/")
        if level < 2:  # 深すぎるディレクトリは省略
            sub_indent = "  " * (level + 1)
            for f in files[:5]:
                size_mb = os.path.getsize(os.path.join(root, f)) / (1024 * 1024)
                print(f"{sub_indent}{f} ({size_mb:.1f} MB)")
            if len(files) > 5:
                print(f"{sub_indent}... and {len(files) - 5} more files")


if __name__ == "__main__":
    main()
