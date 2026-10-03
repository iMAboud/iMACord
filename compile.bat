@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ===================================================
echo Building Custom iMACord with Embedded Plugins...
echo ===================================================

:: 1. Check for Node.js / pnpm
where pnpm >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [INFO] pnpm not found in PATH. Checking for node...
    where node >nul 2>&1
    if %ERRORLEVEL% neq 0 (
        echo [ERROR] Neither pnpm nor node was found in your PATH.
        echo Please install Node.js and pnpm to compile iMACord.
        goto :EXIT
    )
    echo [INFO] Building iMACord using node...
    cd Vencord-main
    call node scripts/build/build.mjs --standalone
    cd /d "%~dp0"
) else (
    echo [INFO] Building iMACord using pnpm...
    cd Vencord-main
    call pnpm buildStandalone
    cd /d "%~dp0"
)

if %ERRORLEVEL% neq 0 (
    echo [ERROR] iMACord build failed with code %ERRORLEVEL%.
    goto :EXIT
)

echo.
echo ===================================================
echo Compiling Standalone CLI and GUI Installers...
echo ===================================================

call "installer_src\build_installers.bat"

if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Installer compilation failed.
    goto :EXIT
)

echo.
echo ===================================================
echo Generating Release Manifest & Checksums...
echo ===================================================
call node scripts\generate_manifest.mjs

echo.
echo ===================================================
echo [SUCCESS] Compilation Complete!
echo Standalone Executables:
echo   - %~dp0iMCord.exe    (GUI)
echo   - %~dp0iMCordCLI.exe (CLI)
echo ===================================================
echo Both executables embed your custom iMCord files and
echo custom plugins (iMAMenu, MultiStreamPopout, amongick)
echo and can be distributed standalone with zero dependencies.
echo.

set /p "LAUNCH_CHOICE=Launch installer now? [G]ui, [C]li, or [N]o (default: G): "
if /i "%LAUNCH_CHOICE%"=="C" (
    start "" "%~dp0iMCordCLI.exe"
) else if /i "%LAUNCH_CHOICE%"=="N" (
    goto :EXIT
) else (
    start "" "%~dp0iMCord.exe"
)

:EXIT
echo.
echo Press any key to exit...
pause >nul
