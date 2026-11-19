@echo off
title UserSync
cd /d "%~dp0"

echo.
echo  UserSync - Gestion de Usuarios Empresariales
echo  =============================================
echo.

python --version >nul 2>&1
if errorlevel 1 (
    echo  ERROR: Python no esta instalado.
    echo  Descargalo en: https://www.python.org/downloads/
    echo  IMPORTANTE: marcar "Add Python to PATH" al instalar.
    echo.
    pause
    exit /b 1
)

REM Modo supervisado: la aplicacion puede pedir un reinicio (codigo de salida 3)
set USERSYNC_SUPERVISED=1

:inicio
echo  Verificando dependencias...
pip install -r requirements.txt --quiet --disable-pip-version-check
echo.
echo  Iniciando UserSync... (para detenerlo cierra esta ventana)
echo.
python app.py
if %errorlevel%==3 (
    echo.
    echo  Reiniciando UserSync...
    ping -n 3 127.0.0.1 >nul
    set USERSYNC_RESTARTED=1
    goto inicio
)

echo.
echo  UserSync se detuvo. Revisa los mensajes anteriores.
pause
