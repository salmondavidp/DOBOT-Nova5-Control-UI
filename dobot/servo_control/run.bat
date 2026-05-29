@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"
set "EXE=%~dp0MotorControl\MotorControl.exe"
if not exist "%EXE%" (
  echo ============================================================
  echo  ERROR: "%EXE%" not found
  echo ============================================================
  pause
  exit /b 1
)

rem ============================================================
rem Dependency checks
rem ============================================================
net session >nul 2>&1
if not "%ERRORLEVEL%"=="0" echo [WARN] Run as Administrator to install dependencies.
call :check_vcredist
if errorlevel 1 exit /b 1
call :check_npcap
if errorlevel 1 exit /b 1

============================================
 Starting MotorControl Server...
============================================

start "" "%EXE%"

Waiting for server to start...
timeout /t 4 /nobreak >nul

Opening browser...
start http://localhost:8000

============================================
 Server is running at http://localhost:8000
 Close this window to stop the server.
============================================
exit /b 0

:check_vcredist
set "VCR1=%SystemRoot%\System32\vcruntime140.dll"
set "VCR2=%SystemRoot%\System32\vcruntime140_1.dll"
set "MSVCP=%SystemRoot%\System32\msvcp140.dll"
if exist "%VCR1%" if exist "%VCR2%" if exist "%MSVCP%" exit /b 0
echo [INFO] Visual C++ Runtime missing. Installing...
set "VC_URL=https://aka.ms/vs/17/release/vc_redist.x64.exe"
set "VC_EXE=%TEMP%\vc_redist.x64.exe"
if exist "%~dp0deps\vc_redist.x64.exe" set "VC_EXE=%~dp0deps\vc_redist.x64.exe"
if not exist "%VC_EXE%" (
  powershell -NoProfile -Command "try { Invoke-WebRequest -Uri '%VC_URL%' -OutFile '%VC_EXE%' } catch { exit 1 }"
  if not exist "%VC_EXE%" (
    echo [ERROR] Failed to download Visual C++ runtime.
    exit /b 1
  )
)
"%VC_EXE%" /install /quiet /norestart
timeout /t 5 /nobreak >nul
if exist "%VCR1%" if exist "%VCR2%" if exist "%MSVCP%" exit /b 0
echo [ERROR] Visual C++ runtime install failed. Run as Administrator.
exit /b 1

:check_npcap
set "NPCAP1=%SystemRoot%\System32\Npcap\wpcap.dll"
set "NPCAP2=%SystemRoot%\System32\wpcap.dll"
if exist "%NPCAP1%" exit /b 0
if exist "%NPCAP2%" exit /b 0
echo [INFO] Npcap missing. Installing...
set "NPCAP_URL=https://npcap.com/dist/npcap-1.80.exe"
set "NPCAP_EXE=%TEMP%\npcap-installer.exe"
if exist "%~dp0deps\npcap.exe" set "NPCAP_EXE=%~dp0deps\npcap.exe"
if not exist "%NPCAP_EXE%" (
  powershell -NoProfile -Command "try { Invoke-WebRequest -Uri '%NPCAP_URL%' -OutFile '%NPCAP_EXE%' } catch { exit 1 }"
  if not exist "%NPCAP_EXE%" (
    echo [ERROR] Failed to download Npcap installer.
    exit /b 1
  )
)
"%NPCAP_EXE%" /S
timeout /t 8 /nobreak >nul
if exist "%NPCAP1%" exit /b 0
if exist "%NPCAP2%" exit /b 0
echo [ERROR] Npcap install failed. Run as Administrator.
exit /b 1
