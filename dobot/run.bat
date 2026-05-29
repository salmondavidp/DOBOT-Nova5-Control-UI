@echo off
setlocal EnableExtensions

set "SCRIPT_DIR=%~dp0"

where py >nul 2>nul
if not errorlevel 1 goto use_py

where python >nul 2>nul
if not errorlevel 1 goto use_python

echo Python 3.10 or newer was not found.
echo.
echo This app needs Python for the local control server.
echo The browser UI and other assets are already included in this folder.
echo.

where winget >nul 2>nul
if errorlevel 1 goto no_winget

set /p INSTALL_PYTHON="Install Python 3.12 now using winget? [Y/N] "
if /I not "%INSTALL_PYTHON%"=="Y" goto no_python

winget install -e --id Python.Python.3.12 --scope user --accept-package-agreements --accept-source-agreements
if errorlevel 1 (
  echo.
  echo Python install did not complete.
  echo Install Python 3.10 or newer, then run this launcher again.
  pause
  exit /b 1
)

where py >nul 2>nul
if not errorlevel 1 goto use_py

where python >nul 2>nul
if not errorlevel 1 goto use_python

echo.
echo Python installed, but this command window cannot find it yet.
echo Close this window and run DOBOT UI Launcher.bat again.
pause
exit /b 1

:no_winget
echo Windows Package Manager winget was not found.
echo Install Python 3.10 or newer from:
echo https://www.python.org/downloads/windows/
pause
exit /b 1

:no_python
echo Install Python 3.10 or newer, then run this launcher again.
pause
exit /b 1

:use_py
py -3 "%SCRIPT_DIR%bootstrap.py" --open-browser %*
if errorlevel 1 pause
exit /b %errorlevel%

:use_python
python "%SCRIPT_DIR%bootstrap.py" --open-browser %*
if errorlevel 1 pause
exit /b %errorlevel%
