@echo off
rem Double-click this file (or the "Sort My Trip" shortcut). Everything happens in your browser;
rem the helper runs minimized in the taskbar and closes itself when you press Done.
start "Trip Photo Sorter" /min powershell -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Minimized -File "%~dp0SortTrip.ps1" %*
