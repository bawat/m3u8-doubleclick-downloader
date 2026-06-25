@echo off
title Convert M3U8 to MP4
"X:\Program Files\nodejs\node.exe" "X:\Users\bawat\Documents\MarkMacheta M3U8 Downloader\fix_m3u8.mjs" "%~1"
echo.
echo ===== Finished. Press any key to close. =====
pause >nul
