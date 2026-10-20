@echo off
chcp 65001 >nul
title LITTLE COSMOS - 微光星球
cd /d "%~dp0"
where node >nul 2>nul
if %errorlevel%==0 (
  echo 正在启动本地服务器 ... 浏览器将自动打开游戏。
  start "" http://127.0.0.1:8090/
  node tools\serve.mjs 8090
) else (
  echo 未检测到 Node.js，使用系统浏览器直接打开游戏文件 ...
  start "" "index.html"
)
