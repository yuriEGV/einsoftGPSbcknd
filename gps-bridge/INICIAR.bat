@echo off
title Einsoft GPS — Bridge TCP Profesional
color 0A

echo.
echo  ================================================
echo   Einsoft GPS — Servidor de Protocolos GPS
echo  ================================================
echo.

:: Check if Node.js is installed
node --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js no esta instalado.
    echo Descargalo de: https://nodejs.org
    pause
    exit /b 1
)

:: Install dependencies if needed
if not exist node_modules (
    echo [INFO] Instalando dependencias...
    npm install
    echo.
)

echo [INFO] Iniciando servidor GPS Bridge...
echo [INFO] Presiona Ctrl+C para detener
echo.

node server.js

pause
