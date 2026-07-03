@echo off
echo Downgrading NumPy to 1.x for trimesh 4.0.5 compatibility...
set PIP=C:\Users\User\Desktop\drawing_to_3d\venv\Scripts\pip.exe
%PIP% install "numpy<2.0"
echo.
echo Done! Restart the backend for changes to take effect.
pause
