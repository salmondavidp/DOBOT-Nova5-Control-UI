@echo off
setlocal EnableExtensions

set "ROOT_DIR=%~dp0"
set "APP_DIR=%ROOT_DIR%dobot"

if not exist "%APP_DIR%\run.bat" (
  echo Could not find "%APP_DIR%\run.bat".
  echo Make sure the downloaded folder was extracted completely.
  pause
  exit /b 1
)

call "%APP_DIR%\run.bat" %*
exit /b %errorlevel%
