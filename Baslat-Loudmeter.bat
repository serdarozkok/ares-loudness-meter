@echo off
title ARES Loudness Meter
cd /d "%~dp0"
if exist "%~dp0ARES-Loudness-Meter.exe" (
    start "" "%~dp0ARES-Loudness-Meter.exe"
) else (
    start "" "%~dp0LoudmeterPro.exe"
)
