@echo off
setlocal EnableExtensions

set "SCRIPT_DIR=%~dp0"
set "OUT_DIR=%SCRIPT_DIR%..\bin"
set "SRC=%SCRIPT_DIR%main.cpp"
set "EXE=%OUT_DIR%\audio-capture.exe"

if not exist "%OUT_DIR%" mkdir "%OUT_DIR%"

set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
  echo [error] vswhere.exe not found. Install Visual Studio Build Tools with C++ workload.
  exit /b 1
)

for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSINSTALL=%%i"

if not defined VSINSTALL (
  echo [error] Visual Studio C++ tools not found.
  exit /b 1
)

call "%VSINSTALL%\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 (
  echo [error] Failed to load vcvars64.bat
  exit /b 1
)

echo Building audio-capture.exe ...
cl /nologo /EHsc /O2 /W3 /utf-8 /DUNICODE /D_UNICODE "%SRC%" /Fe"%EXE%" /link ole32.lib avrt.lib
if errorlevel 1 (
  echo [error] Build failed
  exit /b 1
)

echo Built: %EXE%
exit /b 0
