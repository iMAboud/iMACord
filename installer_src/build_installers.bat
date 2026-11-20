@echo off
setlocal enabledelayedexpansion

set "ROOT_DIR=%~dp0.."
cd /d "%ROOT_DIR%"

echo ===================================================
echo Compiling Standalone iMACord CLI and GUI Installers
echo ===================================================

:: 1. Locate csc.exe and node.exe
set "DOTNET_DIR=C:\Windows\Microsoft.NET\Framework64\v4.0.30319"
if not exist "%DOTNET_DIR%\csc.exe" (
    set "DOTNET_DIR=C:\Windows\Microsoft.NET\Framework\v4.0.30319"
)
if not exist "%DOTNET_DIR%\csc.exe" (
    echo [ERROR] csc.exe was not found in %DOTNET_DIR%
    exit /b 1
)

where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] node.exe was not found in PATH.
    exit /b 1
)

set "CSC=%DOTNET_DIR%\csc.exe"
set "WPF_DIR=%DOTNET_DIR%\WPF"

:: 2. Prepare GZip compressed payload resources & BuildInfo.cs
echo [0/2] Preparing GZip payload resources and BuildInfo...
call node scripts\prepare_installer_build.mjs
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Failed to prepare installer build resources.
    exit /b %ERRORLEVEL%
)

:: 3. Verify Icon
set "ICON_PARAM="
set "ICO_RES="
if exist "iMCord.ico" (
    set "ICON_PARAM=/win32icon:iMCord.ico"
    set "ICO_RES=/resource:iMCord.ico,iMCord.ico"
) else if exist "installer_src\iMCord.ico" (
    set "ICON_PARAM=/win32icon:installer_src\iMCord.ico"
    set "ICO_RES=/resource:installer_src\iMCord.ico,iMCord.ico"
) else if exist "vencord.ico" (
    set "ICON_PARAM=/win32icon:vencord.ico"
)

echo.
echo [1/2] Building iMCordCLI.exe (Console)...
"%CSC%" /nologo /target:exe /optimize+ /platform:anycpu ^
    /reference:System.dll /reference:System.Core.dll /reference:"%DOTNET_DIR%\System.Web.Extensions.dll" ^
    %ICON_PARAM% %ICO_RES% ^
    @installer_src\.build\csc_resources.rsp ^
    /out:iMCordCLI.exe ^
    installer_src\.build\BuildInfo.cs installer_src\UpdaterCore.cs installer_src\InstallerCore.cs installer_src\ProgramCli.cs

if %ERRORLEVEL% neq 0 (
    echo [ERROR] Failed to compile iMCordCLI.exe
    exit /b %ERRORLEVEL%
)
echo [OK] iMCordCLI.exe compiled successfully!

echo.
echo [2/2] Building iMCord.exe (WPF GUI)...
"%CSC%" /nologo /target:winexe /optimize+ /platform:anycpu ^
    /reference:"%WPF_DIR%\PresentationCore.dll" ^
    /reference:"%WPF_DIR%\PresentationFramework.dll" ^
    /reference:"%WPF_DIR%\WindowsBase.dll" ^
    /reference:System.Xaml.dll ^
    /reference:System.dll ^
    /reference:System.Core.dll ^
    /reference:System.Drawing.dll ^
    /reference:System.Windows.Forms.dll ^
    /reference:"%DOTNET_DIR%\System.Web.Extensions.dll" ^
    %ICON_PARAM% %ICO_RES% ^
    @installer_src\.build\csc_resources.rsp ^
    /out:iMCord.exe ^
    installer_src\.build\BuildInfo.cs installer_src\UpdaterCore.cs installer_src\InstallerCore.cs installer_src\ProgramGui.cs

if %ERRORLEVEL% neq 0 (
    echo [ERROR] Failed to compile iMCord.exe
    exit /b %ERRORLEVEL%
)
echo [OK] iMCord.exe compiled successfully!

:: Mirror to Vencord-main\dist\Installer
if not exist "Vencord-main\dist\Installer" mkdir "Vencord-main\dist\Installer"
copy /y "iMCordCLI.exe" "Vencord-main\dist\Installer\iMCordCLI.exe" >nul
copy /y "iMCord.exe" "Vencord-main\dist\Installer\iMCord.exe" >nul

echo.
echo ===================================================
echo [SUCCESS] Standalone Installers Built:
echo   - %ROOT_DIR%\iMCord.exe (GUI)
echo   - %ROOT_DIR%\iMCordCLI.exe (CLI)
echo ===================================================
