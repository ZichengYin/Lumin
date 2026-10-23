@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem ---------------------------------------------------------------
rem  This file is INTENTIONALLY pure ASCII. Do not put Chinese in it.
rem
rem  cmd.exe reads batch files by byte offset using the console code
rem  page. After `chcp 65001` a UTF-8 batch file can be mis-parsed:
rem  the parser loses its place, splits a line in half, and Windows
rem  ends up handing a source file to its default program (which is
rem  how you get serve.mjs opened in a browser instead of the game).
rem
rem  Every Chinese message is printed by tools/serve.mjs instead --
rem  Node writes proper UTF-8 and the console renders it correctly
rem  because of the `chcp 65001` above.
rem ---------------------------------------------------------------

where node >nul 2>nul
if errorlevel 1 (
  type "tools\node-missing.txt"
  echo.
  pause
  exit /b 1
)

node "tools\serve.mjs"

echo.
pause
