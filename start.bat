@echo off
cd /d "%~dp0"
rem Which Node.js runs ModPacer: the one bundled in this folder (runtime\node.exe, shipped with the
rem release so a player installs nothing) first; a Node.js installed on the PC second (the dev repo case);
rem the "needs Node.js" message only when neither exists.
set "NODE_EXE=%~dp0runtime\node.exe"
set "NODE_IS_BUNDLED=1"
if exist "%NODE_EXE%" goto have_node
set "NODE_IS_BUNDLED="
where node >nul 2>nul
if errorlevel 1 goto no_node
set "NODE_EXE=node"
:have_node
rem Test hook: report the choice and stop (used by tests/test-release.js).
if defined MODPACER_START_DRYRUN (
    echo %NODE_EXE%
    exit /b 0
)
if not exist node_modules (
    if defined NODE_IS_BUNDLED (
        echo This copy is missing its node_modules folder. Download ModPacer again and unzip all of it.
        pause
        exit /b 1
    )
    echo Installing dependencies, one-time only...
    call npm install --omit=dev
)
rem server.js itself opens the browser once it's actually listening -- including when another
rem copy already has the port, in which case it opens THAT one and exits on its own (queue:
rem already-running-just-open-it, 2026-10-01). Only pause (keep the window open to read) on a
rem genuine problem -- something else entirely holding the port, or a real crash.
"%NODE_EXE%" server.js
if errorlevel 1 pause
exit /b 0
:no_node
echo.
echo ModPacer needs Node.js, and it isn't installed on this PC yet.
echo Get the LTS version from https://nodejs.org, install it, then double-click start.bat again.
echo.
pause
exit /b 1
