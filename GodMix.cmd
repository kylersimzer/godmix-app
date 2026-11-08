@echo off
title GODMIX (close this window to stop)
echo Starting GODMIX...
echo Keep this window open while you use it. Close it to stop.
echo.
node "%~dp0app\server.js" 8333 --open
pause
