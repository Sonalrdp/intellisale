@echo off
setlocal EnableDelayedExpansion
title Maruti Dashboard Setup - Get Group ID

echo ========================================
echo Step 1: Find your WhatsApp Group ID
echo ========================================
echo.
echo This script will list your WhatsApp groups.
echo You need to scan the QR code and enter the group ID.
echo.

cd /d "%~dp0"
set "PATH=%PATH%;C:\Program Files\nodejs;C:\Program Files (x86)\nodejs"

:CHECK_NODE
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo Node.js not found. Installing Node.js...
    echo.

    echo Trying winget...
    where winget >nul 2>&1
    if !errorlevel! equ 0 (
        winget install OpenJS.NodeJS --accept-package-agreements --accept-source-agreements --silent
        if !errorlevel! equ 0 (
            set "PATH=%PATH%;C:\Program Files\nodejs"
            goto NODE_CHECK
        )
    )

    echo Trying direct MSI download...
    set "INSTALL_SCRIPT=%TEMP%\install_nodejs.ps1"
    > "!INSTALL_SCRIPT!" echo $ErrorActionPreference = "Stop"
    >>"!INSTALL_SCRIPT!" echo [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
    >>"!INSTALL_SCRIPT!" echo $url = "https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi"
    >>"!INSTALL_SCRIPT!" echo $output = "$env:TEMP\nodejs.msi"
    >>"!INSTALL_SCRIPT!" echo Write-Host "Downloading Node.js MSI..."
    >>"!INSTALL_SCRIPT!" echo Invoke-WebRequest -Uri $url -OutFile $output
    >>"!INSTALL_SCRIPT!" echo Write-Host "Installing (this may take a minute)..."
    >>"!INSTALL_SCRIPT!" echo Start-Process msiexec.exe -ArgumentList "/i", $output, "/quiet", "/norestart" -Wait
    >>"!INSTALL_SCRIPT!" echo Remove-Item $output -ErrorAction SilentlyContinue
    powershell -ExecutionPolicy Bypass -File "!INSTALL_SCRIPT!"
    del "!INSTALL_SCRIPT!" 2>nul
    set "PATH=%PATH%;C:\Program Files\nodejs"

    :NODE_CHECK
    where node >nul 2>&1
    if !errorlevel! neq 0 (
        echo ERROR: Failed to install Node.js automatically.
        echo Please restart your computer and run this script again.
        echo Or install manually from https://nodejs.org
        echo.
        pause
        exit /b 1
    )
)

echo Node.js found:
node --version
echo.

where npm >nul 2>&1
if %errorlevel% neq 0 (
    set "PATH=%PATH%;C:\Program Files\nodejs"
)

if not exist "node_modules\xlsx\" (
    echo Installing dependencies and xlsx package...
    call npm install
) else (
    echo Dependencies already installed.
)
echo.
echo Starting service...
echo After the QR code appears, scan it with your phone.
echo Then a list of your groups will be shown.
echo.

node -e "
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');

const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'group-finder', dataPath: './whatsapp-session' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    timeout: 60000,
  },
});

client.on('qr', async (qr) => {
  console.log('=== SCAN THIS QR CODE WITH YOUR PHONE ===');
  try {
    const qrImage = await qrcode.toString(qr, { type: 'terminal', small: true });
    console.log(qrImage);
  } catch(e) { console.log('QR:', qr); }
  console.log('\\nWaiting for phone to scan...');
});

client.on('authenticated', () => {
  console.log('WhatsApp authenticated!');
});

client.on('ready', async () => {
  console.log('WhatsApp ready! Fetching groups...');
  const chats = await client.getChats();
  const groups = chats.filter(c => c.isGroup);
  console.log('\\n=== YOUR WHATSAPP GROUPS ===\\n');
  groups.forEach(g => {
    console.log('Group Name: ' + g.name);
    console.log('Group ID:   ' + g.id._serialized);
    console.log('Members:    ' + (g.participantCount || 'unknown'));
    console.log('---');
  });
  console.log('\\n=== Copy the Group ID of the OTP group ===');
  console.log('Paste it into your .env file:');
  console.log('  WHATSAPP_GROUP_ID=PASTE_ID_HERE');
  console.log('\\nOr paste it in your Google Sheet Credentials sheet (cell B10).');
  console.log('\\nPress Ctrl+C to exit.');
  
  client.destroy();
  process.exit(0);
});

client.on('auth_failure', (msg) => {
  console.error('Auth failure:', msg);
  process.exit(1);
});

client.initialize();
"

pause
