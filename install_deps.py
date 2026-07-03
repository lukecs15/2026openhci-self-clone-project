"""安裝 TripoSR 所需套件到 venv"""
import subprocess
import sys

pip = r"C:\Users\User\Desktop\drawing_to_3d\venv\Scripts\pip.exe"

steps = [
    {
        "name": "PyTorch (CUDA 12.1)",
        "pkgs": ["torch", "torchvision",
                 "--index-url", "https://download.pytorch.org/whl/cu121"],
    },
    {
        "name": "TripoSR core (trimesh, einops, omegaconf, transformers)",
        "pkgs": ["trimesh==4.0.5", "einops==0.7.0",
                 "omegaconf==2.3.0", "transformers==4.35.0"],
    },
    {
        "name": "Background removal (rembg, imageio)",
        "pkgs": ["rembg", "imageio[ffmpeg]"],
    },
]

for i, step in enumerate(steps, 1):
    print(f"\n[{i}/{len(steps)}] Installing: {step['name']}")
    cmd = [pip, "install"] + step["pkgs"]
    print(f"  $ {' '.join(cmd)}\n")
    result = subprocess.run(cmd)
    if result.returncode != 0:
        print(f"\nERROR in step {i}: {step['name']}")
        sys.exit(1)

print("\n" + "=" * 40)
print("All TripoSR dependencies installed!")
print("=" * 40)
input("\nPress Enter to close...")
