@echo off
cd /d C:\Users\yang\Desktop\square\backend
start "Flask Server" python app.py
echo Waiting for server to start...
timeout /t 5 /nobreak >nul
echo Running game script...
python play_spy_game.py
