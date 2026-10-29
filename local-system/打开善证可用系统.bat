@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "NODE_EXE=%~dp0runtime\node.exe"
if not exist "%NODE_EXE%" (
  where node >nul 2>nul
  if errorlevel 1 (
    echo 未检测到随包运行环境或 Node.js 22 以上版本。
    pause
    exit /b 1
  )
  set "NODE_EXE=node"
)
echo 正在启动善证 TrustAid 本地可用系统...
"%NODE_EXE%" --no-warnings server.mjs
if errorlevel 1 (
  echo.
  echo 系统启动失败，请将本窗口截图发给开发人员。
  pause
)
