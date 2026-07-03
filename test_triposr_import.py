import sys
import os

# Add TripoSR to path
triposr_dir = os.path.join(os.path.dirname(__file__), "backend", "services", "TripoSR")
if triposr_dir not in sys.path:
    sys.path.insert(0, triposr_dir)

print("=" * 50)
print("Testing TripoSR imports...")
print("=" * 50)

# Test torch
print("\n[1/4] Testing torch...")
import torch
print(f"  torch version: {torch.__version__}")
print(f"  CUDA available: {torch.cuda.is_available()}")
if torch.cuda.is_available():
    print(f"  CUDA device: {torch.cuda.get_device_name(0)}")

# Test trimesh
print("\n[2/4] Testing trimesh...")
import trimesh
print(f"  trimesh version: {trimesh.__version__}")

# Test rembg
print("\n[3/4] Testing rembg...")
import rembg
print(f"  rembg imported OK")

# Test TSR
print("\n[4/4] Testing tsr.system (TripoSR)...")
from tsr.system import TSR
print(f"  TSR class imported OK")
from tsr.utils import remove_background, resize_foreground
print(f"  tsr.utils imported OK")

print("\n" + "=" * 50)
print("ALL IMPORTS OK - TripoSR is ready!")
print("=" * 50)
print("\nNote: Model weights will download from HuggingFace on first use (~1.8GB)")
