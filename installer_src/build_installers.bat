@echo off
setlocal enabledelayedexpansion

set "ROOT_DIR=%~dp0.."
cd /d "%ROOT_DIR%"

echo ===================================================
echo Compiling Standalone iMACord CLI and GUI Installers
echo ===================================================

:: 1. Locate csc.exe
set "DOTNET_DIR=C:\Windows\Microsoft.NET\Framework64\v4.0.30319"
if not exist "%DOTNET_DIR%\csc.exe" (
    set "DOTNET_DIR=C:\Windows\Microsoft.NET\Framework\v4.0.30319"
)
if not exist "%DOTNET_DIR%\csc.exe" (
    echo [ERROR] csc.exe was not found in %DOTNET_DIR%
    exit /b 1
)

set "CSC=%DOTNET_DIR%\csc.exe"
set "WPF_DIR=%DOTNET_DIR%\WPF"

:: 2. Verify Vencord dist artifacts
if not exist "Vencord-main\dist\patcher.js" (
    echo [ERROR] Vencord-main\dist\patcher.js not found.
    echo Please compile Vencord first.
    exit /b 1
)
if not exist "Vencord-main\dist\renderer.js" (
    echo [ERROR] Vencord-main\dist\renderer.js not found.
    echo Please compile Vencord first.
    exit /b 1
)

:: 3. Verify custom plugins
if not exist "userplugins\iMAMenu.js" (
    echo [ERROR] userplugins\iMAMenu.js not found in %ROOT_DIR%
    exit /b 1
)
if not exist "userplugins\MultiStreamPopout.js" (
    echo [ERROR] userplugins\MultiStreamPopout.js not found in %ROOT_DIR%
    exit /b 1
)
if not exist "userplugins\amongick.js" (
    echo [ERROR] userplugins\amongick.js not found in %ROOT_DIR%
    exit /b 1
)
if not exist "userplugins\DiscordDebloater.js" (
    echo [ERROR] userplugins\DiscordDebloater.js not found in %ROOT_DIR%
    exit /b 1
)

:: 4. Verify Icon
set "ICON_PARAM="
if exist "vencord.ico" (
    set "ICON_PARAM=/win32icon:vencord.ico /resource:vencord.ico,vencord.ico"
)

echo.
echo [1/2] Building VencordInstallerCli.exe (Console)...
"%CSC%" /nologo /target:exe /optimize+ /platform:anycpu ^
    /reference:System.dll /reference:System.Core.dll ^
    %ICON_PARAM% ^
    /resource:Vencord-main\dist\patcher.js,patcher.js ^
    /resource:Vencord-main\dist\preload.js,preload.js ^
    /resource:Vencord-main\dist\renderer.js,renderer.js ^
    /resource:Vencord-main\dist\renderer.css,renderer.css ^
    /resource:userplugins\iMAMenu.js,iMAMenu.js ^
    /resource:userplugins\MultiStreamPopout.js,MultiStreamPopout.js ^
    /resource:userplugins\amongick.js,amongick.js ^
    /resource:userplugins\DiscordDebloater.js,DiscordDebloater.js ^
    /out:VencordInstallerCli.exe ^
    installer_src\InstallerCore.cs installer_src\ProgramCli.cs

if %ERRORLEVEL% neq 0 (
    echo [ERROR] Failed to compile VencordInstallerCli.exe
    exit /b %ERRORLEVEL%
)
echo [OK] VencordInstallerCli.exe compiled successfully!

echo.
echo [2/2] Building VencordInstaller.exe (WPF GUI)...
"%CSC%" /nologo /target:winexe /optimize+ /platform:anycpu ^
    /reference:"%WPF_DIR%\PresentationCore.dll" ^
    /reference:"%WPF_DIR%\PresentationFramework.dll" ^
    /reference:"%WPF_DIR%\WindowsBase.dll" ^
    /reference:System.Xaml.dll ^
    /reference:System.dll ^
    /reference:System.Core.dll ^
    /reference:System.Drawing.dll ^
    /reference:System.Windows.Forms.dll ^
    %ICON_PARAM% ^
    /resource:Vencord-main\dist\patcher.js,patcher.js ^
    /resource:Vencord-main\dist\preload.js,preload.js ^
    /resource:Vencord-main\dist\renderer.js,renderer.js ^
    /resource:Vencord-main\dist\renderer.css,renderer.css ^
    /resource:userplugins\iMAMenu.js,iMAMenu.js ^
    /resource:userplugins\MultiStreamPopout.js,MultiStreamPopout.js ^
    /resource:userplugins\amongick.js,amongick.js ^
    /resource:userplugins\DiscordDebloater.js,DiscordDebloater.js ^
    /out:VencordInstaller.exe ^
    installer_src\InstallerCore.cs installer_src\ProgramGui.cs

if %ERRORLEVEL% neq 0 (
    echo [ERROR] Failed to compile VencordInstaller.exe
    exit /b %ERRORLEVEL%
)
echo [OK] VencordInstaller.exe compiled successfully!

:: Mirror to Vencord-main\dist\Installer
if not exist "Vencord-main\dist\Installer" mkdir "Vencord-main\dist\Installer"
copy /y "VencordInstallerCli.exe" "Vencord-main\dist\Installer\VencordInstallerCli.exe" >nul
copy /y "VencordInstaller.exe" "Vencord-main\dist\Installer\VencordInstaller.exe" >nul

echo.
echo ===================================================
echo [SUCCESS] Standalone Installers Built:
echo   - %ROOT_DIR%\VencordInstaller.exe (GUI)
echo   - %ROOT_DIR%\VencordInstallerCli.exe (CLI)
echo ===================================================
