@echo off
rem Starts ThemeBot in its own windows (API on 8787, app on 5173) and opens it in the browser.
rem Running it yourself (not from inside Claude Code) means low-memory clean-ups won't stop it.
cd /d "%~dp0"
start "ThemeBot server" cmd /k "set TERMINAL_ENABLED=false&& node --import tsx server/index.ts"
start "ThemeBot app" cmd /k "npx vite --port 5173 --strictPort"
timeout /t 8 /nobreak >nul
start "" http://localhost:5173
