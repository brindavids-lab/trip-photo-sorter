@echo off
rem Double-click this file after plugging in your phone.
title Trip Photo Sorter
powershell -NoProfile -ExecutionPolicy Bypass -STA -File "%~dp0SortTrip.ps1" %*
echo.
pause
