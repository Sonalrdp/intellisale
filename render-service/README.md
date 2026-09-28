# Render.com - WhatsApp + Maruti Dashboard Automation

## Overview

This service runs on Render.com and provides:
1. **WhatsApp Web** connection (via QR code) for OTP monitoring
2. **Maruti Dashboard** login and OTP verification
3. **Party Visit Report** fetching API

## Deploy to Render

1. Create a GitHub repository and push this folder
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect your GitHub repo
4. Set these **Environment Variables**:
   - `WHATSAPP_GROUP_ID` — from WhatsApp group info (e.g., `123456789-987654321@g.us`)
   - `MARUTI_USERNAME` — your Maruti Dashboard username
   - `MARUTI_PASSWORD` — your Maruti Dashboard password
   - `PORT` — automatically set by Render (default: 10000)

## Local Testing

```bash
npm install
node app.js
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check + service status |
| GET | `/qr` | Get QR code as base64 image |
| GET | `/status` | Full status (WhatsApp, OTP, session) |
| GET | `/api/otp` | Get latest OTP from WhatsApp |
| POST | `/api/otp` | Manually set OTP |
| POST | `/api/login` | Login to Maruti Dashboard |
| POST | `/api/verify-otp` | Verify OTP |
| POST | `/api/fetch-report` | Full flow: login + OTP + fetch report |
| GET | `/api/report` | Get last fetched report |

## Google Sheets Integration

The `.gs` file in this directory is the Google Apps Script that:
1. Calls `/api/fetch-report` to trigger the automation on Render
2. Receives report data as JSON
3. Writes data to the "Party Visit Report" sheet

## WhatsApp Setup

1. Start the service on Render (or locally)
2. Visit `https://your-service.onrender.com/qr` in a browser
3. Scan the QR code with your phone's WhatsApp app
4. The service will monitor your group for OTP messages
