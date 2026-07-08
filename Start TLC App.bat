@echo off
REM ===================================================================
REM  Genius Premium Tuition - TLC Slip Hand-in
REM  Double-click this file to run the app locally.
REM  It starts a small web server in THIS folder and opens your browser.
REM  (The app must be served over http:// - opening index.html directly
REM   as a file will not work, because the browser blocks loading the
REM   cover template.)
REM  Leave this black window open while you use the app. Close it when done.
REM ===================================================================

cd /d "%~dp0"

REM Open the browser first, then start the server (which keeps this window running).
start "" "http://localhost:8000/index.html"

echo.
echo  Genius Premium Tuition - TLC Slip Hand-in is now running.
echo  Your browser should open at:  http://localhost:8000
echo.
echo  Keep this window open while using the app.
echo  Close this window (or press Ctrl+C) to stop the server.
echo.

python -m http.server 8000
