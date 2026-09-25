@echo off
cd /d "%~dp0"
if not exist .env copy .env.example .env >nul
where node >nul 2>nul || (echo [ERROR] Node.js not found. && pause && exit /b 1)
echo [1/2] Installing packages...
npm.cmd install
if errorlevel 1 (echo [ERROR] npm install failed. && pause && exit /b 1)
echo [2/2] Installation complete.
echo Edit .env and put your ReefAPI key in REEF_API_KEY.
pause
