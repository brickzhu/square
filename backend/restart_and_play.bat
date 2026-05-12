@echo off
taskkill /F /IM python.exe 2>nul
timeout /t 3 /nobreak >nul
cd /d C:\Users\yang\Desktop\square\backend
start /b python app.py
timeout /t 3 /nobreak >nul
python play_spy_game.py
