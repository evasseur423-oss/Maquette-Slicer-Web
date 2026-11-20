@echo off
title Maquette Slicer Studio - Web Edition
cd /d "%~dp0"
set "PATH=C:\Program Files\nodejs;%PATH%"

echo ========================================================
echo     MAQUETTE SLICER STUDIO - EDITION WEB (NAVIGATEUR)
echo ========================================================

if exist "C:\Program Files\nodejs\node.exe" (
    echo Demarrage du serveur HTTP statique local...
    "C:\Program Files\nodejs\node.exe" "%~dp0scripts\serve-web.cjs" --open
) else (
    where node >nul 2>nul
    if %ERRORLEVEL% EQU 0 (
        echo Demarrage du serveur HTTP statique local...
        node "%~dp0scripts\serve-web.cjs" --open
    ) else (
        echo Ouverture directe de index.html dans le navigateur...
        start "" "%~dp0index.html"
        exit /b 0
    )
)

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Ouverture directe de index.html en mode autonome...
    start "" "%~dp0index.html"
)