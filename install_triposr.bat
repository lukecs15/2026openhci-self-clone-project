@echo off
echo ========================================
echo  Installing TripoSR dependencies
echo ========================================

set PIP=C:\Users\User\Desktop\drawing_to_3d\venv\Scripts\pip.exe

echo.
echo [1/3] Installing PyTorch (CUDA 12.1)...
%PIP% install torch torchvision --index-url https://download.pytorch.org/whl/cu121

echo.
echo [2/3] Installing TripoSR core deps...
%PIP% install trimesh==4.0.5 einops==0.7.0 omegaconf==2.3.0 transformers==4.35.0

echo.
echo [3/3] Installing background removal + utils...
%PIP% install rembg "imageio[ffmpeg]"

echo.
echo ========================================
echo  ALL DONE! Press any key to close.
echo ========================================
pause
