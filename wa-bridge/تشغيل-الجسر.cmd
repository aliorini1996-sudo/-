@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Field Sales - WhatsApp Bridge
call npm start
echo.
echo ================================================
echo   The bridge has stopped. Close this window.
echo   -- Double-click this file again to restart.
echo ================================================
pause >nul
