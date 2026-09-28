const express = require('express');
const path = require('path');
const fs = require('fs');

// Force puppeteer to use local cache directory for Render compatibility
process.env.PUPPETEER_CACHE_DIR = path.join(__dirname, '.cache', 'puppeteer');

const { Client, LocalAuth } = require('whatsapp-web.js');
const { LoadUtils } = require('whatsapp-web.js/src/util/Injected/Utils');
const qrcode = require('qrcode');
const axios = require('axios');
const cors = require('cors');

// Automatically load .env file into process.env if present
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const idx = trimmed.indexOf('=');
      const key = trimmed.substring(0, idx).trim();
      const val = trimmed.substring(idx + 1).trim();
      if (key && !process.env[key]) {
        process.env[key] = val;
      }
    }
  });
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const CONFIG = {
  port: process.env.PORT || 3000,
  whapiKey: process.env.WHATSAPP_GROUP_ID || '',
  marutiUsername: process.env.MARUTI_USERNAME || '',
  marutiPassword: process.env.MARUTI_PASSWORD || '',
  marutiBaseUrl: process.env.MARUTI_BASE_URL || 'https://pacc.marutisuzuki.com',
  googleSheetId: process.env.GOOGLE_SHEET_ID || '1OwGmD1feRrioI3gn7QQZ3CVU8_1y-0NN6AINQ7vBQaE',
  googleSheetWebhookUrl: process.env.GOOGLE_SHEET_WEBHOOK_URL || '',
  otpPatterns: [
    /\b(\d{6})\b/,
    /\b(\d{4,8})\b/,
    /\bOTP[:\s]*(\d{4,8})\b/i,
    /\bverification code[:\s]*(\d{4,8})\b/i,
    /\blogin[:\s]*(\d{4,8})\b/i,
  ],
};

let waClient = null;
let qrCodeData = null;
let isWaReady = false;
let waStatus = 'disconnected';
let lastOtp = '';
let lastOtpTime = 0;
let session = null;
let activeGroupId = process.env.WHATSAPP_GROUP_ID || '';

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    whatsapp: waStatus,
    qrAvailable: !!qrCodeData,
    lastOtp: lastOtp,
    lastOtpTime: lastOtpTime,
    session: session ? 'authenticated' : 'none',
  });
});

app.get('/qr', async (req, res) => {
  if (!qrCodeData) {
    return res.status(404).json({ error: 'No QR code available. Restart the service or wait.' });
  }
  try {
    const qrImage = await qrcode.toDataURL(qrCodeData);
    res.json({
      status: 'qr_available',
      qr: qrImage,
      message: 'Scan this QR code with WhatsApp on your phone',
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to generate QR image', details: e.message });
  }
});

app.get('/qr.png', async (req, res) => {
  if (!qrCodeData) {
    return res.status(404).send('No QR code available');
  }
  try {
    const qrBuffer = await qrcode.toBuffer(qrCodeData);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(qrBuffer);
  } catch (e) {
    res.status(500).send('Failed to generate QR image');
  }
});

app.get('/status', (req, res) => {
  res.json({
    whatsapp: waStatus,
    ready: isWaReady,
    qrAvailable: !!qrCodeData,
    lastOtp: lastOtp,
    lastOtpAge: lastOtpTime ? Math.floor((Date.now() - lastOtpTime) / 1000) : null,
    session: session ? { csrfToken: session.csrfToken ? 'present' : 'missing', hasCookies: !!session.cookie } : null,
  });
});

app.get('/api/otp', (req, res) => {
  if (!lastOtp) {
    return res.status(404).json({ error: 'No OTP available. Check if WhatsApp monitor is running and an OTP has been received.' });
  }
  res.json({ otp: lastOtp, receivedAt: new Date(lastOtpTime).toISOString() });
});

app.post('/api/otp', (req, res) => {
  const otp = String(req.body.otp || req.query.otp || '').trim();
  if (!otp) {
    return res.status(400).json({ error: 'No OTP provided in request body' });
  }
  lastOtp = otp;
  lastOtpTime = Date.now();
  console.log('Manual OTP set:', otp);
  res.json({ status: 'ok', otp: otp });
});

app.get('/api/status', (req, res) => {
  res.json({
    whatsapp: waStatus,
    ready: isWaReady,
    qrAvailable: !!qrCodeData,
    lastOtp: lastOtp,
    lastOtpAge: lastOtpTime ? Math.floor((Date.now() - lastOtpTime) / 1000) : null,
    session: session ? { csrfToken: session.csrfToken ? 'present' : 'missing', hasCookies: !!session.cookie } : null,
    activeGroupId: activeGroupId,
    marutiUsername: CONFIG.marutiUsername || process.env.MARUTI_USERNAME || '',
    marutiPassword: CONFIG.marutiPassword || process.env.MARUTI_PASSWORD || '',
    logs: backendLogs
  });
});

app.get('/api/groups', async (req, res) => {
  if (!waClient) {
    return res.status(400).json({ error: 'WhatsApp client not initialized. Scan QR code first.', status: waStatus });
  }

  let rawChats = [];
  let fetchError = null;

  // 1. Ensure WWebJS utils are injected on WhatsApp Web page
  if (waClient.pupPage) {
    try {
      const injected = await waClient.pupPage.evaluate(() => typeof window.WWebJS !== 'undefined' && typeof window.WWebJS.getChats === 'function');
      if (!injected) {
        console.log('WWebJS missing on page, re-injecting LoadUtils...');
        await waClient.pupPage.evaluate(LoadUtils);
      }
    } catch (e) {
      console.warn('WWebJS injection check warning:', e.message);
    }
  }

  // 2. Primary attempt using waClient.getChats()
  try {
    rawChats = await waClient.getChats();
  } catch (err1) {
    console.warn('waClient.getChats() primary call failed:', err1.message);
    fetchError = err1.message;

    // 3. Fallback: Direct WAWebCollections & Store extraction via Puppeteer page evaluate
    if (waClient.pupPage) {
      try {
        console.log('Attempting WAWebCollections direct store evaluation fallback...');
        rawChats = await waClient.pupPage.evaluate(() => {
          try {
            let chatModels = [];
            if (window.require && typeof window.require === 'function') {
              try {
                const col = window.require('WAWebCollections');
                if (col && col.Chat) {
                  chatModels = col.Chat.getModelsArray ? col.Chat.getModelsArray() : (col.Chat.models || []);
                }
              } catch (e) { }
            }
            if ((!chatModels || chatModels.length === 0) && window.Store && window.Store.Chat) {
              chatModels = window.Store.Chat.getModelsArray ? window.Store.Chat.getModelsArray() : (window.Store.Chat.models || []);
            }

            return Array.from(chatModels || []).map(c => {
              const serialized = (c.id && c.id._serialized) ? c.id._serialized : String(c.id || '');
              const name = c.name || c.formattedTitle || c.headerTitle || serialized;
              const isGroup = !!(c.isGroup || (c.id && c.id.server === 'g.us') || serialized.endsWith('@g.us') || (c.id && c.id.user && c.id.user.includes('-')));
              const count = (c.groupMetadata && c.groupMetadata.participants) ? c.groupMetadata.participants.length : 0;
              return { name, id: serialized, isGroup, participantCount: count };
            });
          } catch (e) {
            return [];
          }
        });
        if (rawChats && rawChats.length > 0) fetchError = null;
      } catch (err2) {
        console.error('Direct WAWebCollections evaluation fallback failed:', err2.message);
      }
    }
  }

  try {
    if ((!rawChats || rawChats.length === 0) && waClient && !fetchError) {
      console.log('Chats empty, waiting 1.5s for sync retry...');
      await new Promise(r => setTimeout(r, 1500));
      try {
        rawChats = await waClient.getChats();
      } catch (e) { }
    }

    console.log(`Fetched ${rawChats ? rawChats.length : 0} total chats from WhatsApp Web.`);

    let groups = (rawChats || []).filter(c => {
      if (!c) return false;
      if (c.isGroup) return true;
      if (c.id) {
        const idStr = typeof c.id === 'string' ? c.id : (c.id._serialized || '');
        if (idStr.endsWith('@g.us')) return true;
        if (c.id.server === 'g.us') return true;
        if (typeof c.id.user === 'string' && c.id.user.includes('-')) return true;
      }
      return false;
    }).map(g => ({
      name: g.name || (typeof g.id === 'string' ? g.id : (g.id ? g.id._serialized : 'WhatsApp Group')),
      id: typeof g.id === 'string' ? g.id : (g.id ? g.id._serialized : ''),
      participantCount: g.participants ? g.participants.length : (g.participantCount || 0),
    }));

    if (groups.length === 0 && rawChats && rawChats.length > 0) {
      console.log('No strict group chats filtered. Returning all chats as fallback.');
      groups = rawChats.map(c => ({
        name: (c.name || (typeof c.id === 'string' ? c.id : (c.id ? c.id._serialized : 'Chat'))) + (c.isGroup ? ' (Group)' : ''),
        id: typeof c.id === 'string' ? c.id : (c.id ? c.id._serialized : ''),
        participantCount: c.participants ? c.participants.length : (c.participantCount || 0),
      }));
    }

    res.json({
      groups: groups,
      activeGroupId: activeGroupId,
      totalChats: rawChats ? rawChats.length : 0
    });
  } catch (e) {
    console.error('Error processing /api/groups:', e);
    res.status(200).json({ groups: [], activeGroupId: activeGroupId, error: 'WhatsApp is syncing. Click Refresh Groups.', details: e.message });
  }
});

function updateEnvFile(key, value) {
  try {
    const envPath = path.join(__dirname, '.env');
    let content = '';
    if (fs.existsSync(envPath)) {
      content = fs.readFileSync(envPath, 'utf8');
    }
    const lineRegex = new RegExp(`^${key}=.*$`, 'm');
    if (lineRegex.test(content)) {
      content = content.replace(lineRegex, `${key}=${value}`);
    } else {
      content = content ? `${content.trim()}\n${key}=${value}` : `${key}=${value}`;
    }
    fs.writeFileSync(envPath, content, 'utf8');
    process.env[key] = value;
    console.log(`Successfully updated .env file: ${key}=${value}`);
    return true;
  } catch (e) {
    console.error(`Error updating .env file for ${key}:`, e.message);
    return false;
  }
}

app.post('/api/config/group', (req, res) => {
  const groupId = String(req.body.groupId || '').trim();
  if (!groupId) {
    return res.status(400).json({ error: 'groupId is required in request body' });
  }
  activeGroupId = groupId;
  CONFIG.whapiKey = groupId;
  const envSaved = updateEnvFile('WHATSAPP_GROUP_ID', groupId);
  console.log('Active group ID set to:', activeGroupId);
  res.json({ status: 'ok', activeGroupId: activeGroupId, envUpdated: envSaved });
});

app.get('/api/config/group', (req, res) => {
  res.json({ activeGroupId: activeGroupId, hasGroup: !!activeGroupId });
});

app.post('/api/logout', async (req, res) => {
  try {
    isWaReady = false;
    waStatus = 'initializing';
    qrCodeData = null;
    activeGroupId = '';

    if (waClient) {
      try { await waClient.logout(); } catch (e) { }
      try { await waClient.destroy(); } catch (e) { }
      waClient = null;
    }

    console.log('Resetting WhatsApp session...');
    initializeWhatsApp();
    res.json({ status: 'ok', message: 'WhatsApp session reset. Scan new QR code.' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to reset session', details: e.message });
  }
});

app.post('/api/fetch-report', async (req, res) => {
  try {
    const { startDate, endDate, reportType, marutiUsername, marutiPassword } = req.body;

    if ((marutiUsername && !marutiPassword) || (!marutiUsername && marutiPassword)) {
      return res.status(400).json({ error: 'Both username and password must be provided.' });
    }

    if (marutiUsername) {
      CONFIG.marutiUsername = marutiUsername;
      updateEnvFile('MARUTI_USERNAME', marutiUsername);
    }
    if (marutiPassword) {
      CONFIG.marutiPassword = marutiPassword;
      updateEnvFile('MARUTI_PASSWORD', marutiPassword);
    }

    if (!CONFIG.marutiUsername || !CONFIG.marutiPassword) {
      return res.status(401).json({ error: 'No credentials. Set env vars or pass via API body.' });
    }

    if (!activeGroupId) {
      return res.status(400).json({ error: 'No WhatsApp group selected. Call POST /api/config/group first.' });
    }

    // STEP 1 & 2: Login and Fetch OTP with Automatic Login Restart Retries
    const MAX_LOGIN_ATTEMPTS = 3;
    let loginAttempt = 0;
    let otp = null;
    let loginStartTime = 0;

    while (loginAttempt < MAX_LOGIN_ATTEMPTS && !otp) {
      loginAttempt++;
      console.log('==============================================');
      console.log(`LOGIN ATTEMPT ${loginAttempt}/${MAX_LOGIN_ATTEMPTS}: Initiating Maruti Dashboard Login...`);
      loginStartTime = Date.now();
      session = null;

      const loginResult = await loginAndGetSession();
      if (!loginResult || loginResult.error) {
        console.warn(`Login Attempt ${loginAttempt} failed:`, loginResult?.error);
        if (loginAttempt >= MAX_LOGIN_ATTEMPTS) {
          return res.status(401).json({ error: loginResult?.error || 'Login failed. Check Maruti credentials.' });
        }
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      session = loginResult;
      console.log(`Login Attempt ${loginAttempt} SUCCESS! Maruti Login completed. OTP triggered by server.`);

      console.log('Waiting for fresh OTP from WhatsApp group (up to 90s / 1.5 min)...');
      const waitStart = Date.now();
      const maxWaitMs = 90000;

      while (Date.now() - waitStart < maxWaitMs) {
        if (lastOtp && lastOtpTime >= loginStartTime - 5000) {
          otp = lastOtp;
          console.log('Fetched fresh OTP from WhatsApp event:', otp);
          break;
        }

        try {
          if (waClient && isWaReady && activeGroupId) {
            const chats = await waClient.getChats().catch(() => []);
            const cleanTarget = activeGroupId.split('@')[0].trim();
            const activeChat = (chats || []).find(c => {
              if (!c || !c.id) return false;
              const sId = typeof c.id === 'string' ? c.id : (c.id._serialized || '');
              return sId === activeGroupId || sId.includes(cleanTarget);
            });

            if (activeChat && typeof activeChat.fetchMessages === 'function') {
              const recentMsgs = await activeChat.fetchMessages({ limit: 15 }).catch(() => []);
              for (let i = recentMsgs.length - 1; i >= 0; i--) {
                const m = recentMsgs[i];
                if (!m || !m.body) continue;
                const extracted = extractOtp(m.body);
                if (extracted) {
                  const msgTime = (m.timestamp || 0) * 1000;
                  if (msgTime >= loginStartTime - 10000 || !lastOtpTime) {
                    otp = extracted;
                    lastOtp = extracted;
                    lastOtpTime = msgTime || Date.now();
                    console.log(`STEP 2 SUCCESS: Fetched fresh OTP strictly from SELECTED group (${activeChat.name || activeGroupId}):`, otp);
                    break;
                  }
                }
              }
            }
          }
        } catch (e) {
          console.warn('WhatsApp chat polling warning:', e.message);
        }

        if (otp) break;
        await new Promise(r => setTimeout(r, 2000));
      }

      if (!otp && loginAttempt < MAX_LOGIN_ATTEMPTS) {
        console.warn(`No fresh OTP received on attempt ${loginAttempt}. Restarting login process to re-trigger OTP...`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    if (!otp) {
      return res.status(404).json({
        error: `No fresh OTP received in WhatsApp after ${MAX_LOGIN_ATTEMPTS} login attempts. Please verify WhatsApp connection and group selection.`,
        action: 'request_otp',
      });
    }

    // STEP 3: Verify OTP
    console.log('STEP 3: Verifying OTP:', otp);
    const csrf = session.csrfToken || '';
    const verified = await verifyOtp(session, otp, csrf);
    if (!verified) {
      session = null;
      return res.status(401).json({ error: 'OTP verification failed. Please try again.' });
    }
    console.log('STEP 3 SUCCESS: OTP verified!');

    // STEP 4: Fetch Report Data
    console.log('STEP 4: Fetching Maruti report data...');
    const monthRange = getDateRange(startDate, endDate);
    const reportData = await fetchPartyVisitReport(session, monthRange.startDate, monthRange.endDate, reportType || 'party-visit');

    if (reportData && reportData.length > 0) {
      reportDataCache = {
        status: 'success',
        rows: reportData.length,
        startDate: monthRange.startDate,
        endDate: monthRange.endDate,
        data: reportData,
        fetchedAt: new Date().toISOString()
      };

      let sheetStatus = null;
      const targetWebhook = req.body.googleSheetWebhookUrl || CONFIG.googleSheetWebhookUrl || process.env.GOOGLE_SHEET_WEBHOOK_URL;
      if (targetWebhook) {
        console.log('Pushing/patching data to Google Sheet Webhook:', targetWebhook);
        sheetStatus = await sendDataToGoogleSheetWebhook(targetWebhook, reportData, monthRange.startDate, monthRange.endDate);
      }

      res.json({
        status: 'success',
        rows: reportData.length,
        startDate: monthRange.startDate,
        endDate: monthRange.endDate,
        data: reportData,
        sheetStatus: sheetStatus
      });
    } else {
      res.status(204).json({ status: 'no_data', message: 'No data found for the selected date range.' });
    }
  } catch (e) {
    console.error('Fetch report error:', e);
    res.status(500).json({ error: e.message || 'Internal server error' });
  }
});

async function sendDataToGoogleSheetWebhook(webhookUrl, data, startDate, endDate) {
  try {
    const payload = {
      data: data,
      startDate: startDate,
      endDate: endDate,
      sheetId: process.env.GOOGLE_SHEET_ID || CONFIG.googleSheetId
    };
    const response = await axios.post(webhookUrl, payload, {
      headers: { 'Content-Type': 'application/json' },
      maxRedirects: 5,
      timeout: 30000
    });
    console.log('Google Sheet Webhook success! Status:', response.status);
    return { success: true, message: 'Data patched to Google Sheet successfully', response: response.data };
  } catch (e) {
    console.error('Failed to send data to Google Sheet Webhook:', e.message);
    return { success: false, error: e.message };
  }
}

  let currentSchedule = null;
  app.post('/api/schedule', (req, res) => {
    const { time, startDate, endDate, reportType, marutiUsername, marutiPassword, googleSheetWebhookUrl } = req.body;
    if (!time) return res.status(400).json({ error: 'Time is required' });
    
    currentSchedule = { time, startDate, endDate, reportType, marutiUsername, marutiPassword, googleSheetWebhookUrl };
    console.log(`[SCHEDULE] Automation scheduled for ${time} IST`);
    res.json({ status: 'success', message: `Scheduled at ${time}` });
  });

  let backendLogs = [];
  let logIdCounter = 0;
  function addBackendLog(msg) {
    console.log(msg);
    logIdCounter++;
    backendLogs.push({ id: logIdCounter, msg });
    if (backendLogs.length > 30) backendLogs.shift();
  }

  setInterval(async () => {
    if (!currentSchedule) return;
    
    const now = new Date();
    const options = { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false };
    const formatter = new Intl.DateTimeFormat('en-US', options);
    const parts = formatter.formatToParts(now);
    let hr = parts.find(p => p.type === 'hour').value;
    let mn = parts.find(p => p.type === 'minute').value;
    if (hr === '24') hr = '00';
    const currentIst = `${hr}:${mn}`;

    if (currentIst === currentSchedule.time) {
      addBackendLog(`[SCHEDULE] Triggering automation at ${currentIst} IST!`);
      const s = { ...currentSchedule };
      currentSchedule = null;

      (async () => {
        let success = false;
        let attempt = 1;
        while (!success) {
          try {
            addBackendLog(`[SCHEDULE] (Attempt ${attempt}) Calling internal fetch-report endpoint to run full automation loop...`);
            const response = await axios.post('http://localhost:3000/api/fetch-report', {
              startDate: s.startDate,
              endDate: s.endDate,
              reportType: s.reportType,
              marutiUsername: s.marutiUsername,
              marutiPassword: s.marutiPassword,
              googleSheetWebhookUrl: s.googleSheetWebhookUrl
            });
            if (response.data && response.data.status === 'success') {
              addBackendLog(`[SCHEDULE] SUCCESS! Trigger completed successfully on attempt ${attempt}. Rows: ${response.data.rows}`);
              success = true;
            } else {
              addBackendLog(`[SCHEDULE] Attempt ${attempt} returned non-success. Retrying in 60s...`);
              await new Promise(r => setTimeout(r, 60000));
              attempt++;
            }
          } catch (e) {
            addBackendLog(`[SCHEDULE] Error on attempt ${attempt}: ${e.response?.data?.error || e.message}`);
            addBackendLog('[SCHEDULE] Retrying in 60 seconds...');
            await new Promise(r => setTimeout(r, 60000));
            attempt++;
          }
        }
      })();
    }
  }, 5000);

app.post('/api/patch-to-sheet', async (req, res) => {
  try {
    const webhookUrl = req.body.webhookUrl || CONFIG.googleSheetWebhookUrl || process.env.GOOGLE_SHEET_WEBHOOK_URL;
    const data = req.body.data || (reportDataCache ? reportDataCache.data : null);
    const startDate = req.body.startDate || (reportDataCache ? reportDataCache.startDate : '');
    const endDate = req.body.endDate || (reportDataCache ? reportDataCache.endDate : '');

    if (!webhookUrl) {
      return res.status(400).json({ error: 'Google Sheet Webhook URL is required. Provide it in body or set GOOGLE_SHEET_WEBHOOK_URL in .env' });
    }

    if (!data || !Array.isArray(data) || data.length === 0) {
      return res.status(400).json({ error: 'No report data available to send to Google Sheet. Fetch report data first.' });
    }

    if (req.body.webhookUrl) {
      CONFIG.googleSheetWebhookUrl = req.body.webhookUrl;
      updateEnvFile('GOOGLE_SHEET_WEBHOOK_URL', req.body.webhookUrl);
    }

    const result = await sendDataToGoogleSheetWebhook(webhookUrl, data, startDate, endDate);
    if (result.success) {
      res.json({ status: 'ok', message: 'Report data patched to Google Sheet successfully!', details: result });
    } else {
      res.status(500).json({ error: 'Failed to patch data to Google Sheet', details: result.error });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/config/sheet', (req, res) => {
  res.json({
    googleSheetId: process.env.GOOGLE_SHEET_ID || CONFIG.googleSheetId || '',
    googleSheetWebhookUrl: process.env.GOOGLE_SHEET_WEBHOOK_URL || CONFIG.googleSheetWebhookUrl || '',
  });
});

app.post('/api/config/sheet', (req, res) => {
  const { googleSheetId, googleSheetWebhookUrl } = req.body;
  if (googleSheetId) {
    CONFIG.googleSheetId = googleSheetId;
    updateEnvFile('GOOGLE_SHEET_ID', googleSheetId);
  }
  if (googleSheetWebhookUrl !== undefined) {
    CONFIG.googleSheetWebhookUrl = googleSheetWebhookUrl;
    updateEnvFile('GOOGLE_SHEET_WEBHOOK_URL', googleSheetWebhookUrl);
  }
  res.json({
    status: 'ok',
    googleSheetId: process.env.GOOGLE_SHEET_ID || CONFIG.googleSheetId,
    googleSheetWebhookUrl: process.env.GOOGLE_SHEET_WEBHOOK_URL || CONFIG.googleSheetWebhookUrl,
  });
});

app.post('/api/login', async (req, res) => {
  try {
    const result = await loginAndGetSession();
    if (result) {
      session = result;
      res.json({ status: 'ok', message: 'Login successful. OTP required.', csrfToken: result.csrfToken });
    } else {
      res.status(401).json({ error: 'Login failed' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/verify-otp', async (req, res) => {
  try {
    if (!session) {
      return res.status(400).json({ error: 'No active session. Call /api/login first.' });
    }
    const otp = String(req.body.otp || '').trim();
    if (!otp) {
      return res.status(400).json({ error: 'No OTP provided' });
    }
    const verified = await verifyOtp(session, otp, session.csrfToken || '');
    if (verified) {
      res.json({ status: 'ok', message: 'OTP verified. Session authenticated.' });
    } else {
      res.status(401).json({ error: 'OTP verification failed' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/report', (req, res) => {
  if (reportDataCache) {
    res.json(reportDataCache);
  } else {
    res.status(404).json({ error: 'No cached report data. Call POST /api/fetch-report first.' });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

let reportDataCache = null;

function getDateRange(startDate, endDate) {
  if (startDate && endDate) {
    return { startDate, endDate };
  }
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  return {
    startDate: formatDate(firstDay),
    endDate: formatDate(lastDay),
  };
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

function getPuppeteerModule() {
  try {
    return require('puppeteer');
  } catch (e) {
    try {
      return require('whatsapp-web.js/node_modules/puppeteer');
    } catch (e2) {
      try {
        return require('puppeteer-core');
      } catch (e3) {
        return null;
      }
    }
  }
}

let activeBrowser = null;

async function loginWithPuppeteerBrowser(username, password) {
  if (activeBrowser) {
    try {
      console.log('Closing previous open Chrome browser window before launching new one...');
      await activeBrowser.close();
    } catch (e) {}
    activeBrowser = null;
  }

  const puppeteer = getPuppeteerModule();
  if (!puppeteer) {
    console.error('Puppeteer module not found in environment.');
    return { error: 'Puppeteer module not found' };
  }

  console.log('Launching Puppeteer Chrome browser for Maruti portal login...');
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const launchOptions = {
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  };
  if (fs.existsSync(chromePath)) {
    launchOptions.executablePath = chromePath;
  }

  let browser;
  try {
    browser = await puppeteer.launch(launchOptions);
    activeBrowser = browser;
    const page = await browser.newPage();

    page.on('request', req => {
      const url = req.url();
      if (req.method() === 'POST' || url.includes('login') || url.includes('auth') || url.includes('api')) {
        console.log('🔥 [PUPPETEER REQUEST]', req.method(), url);
      }
    });

    page.on('response', async res => {
      const url = res.url();
      if (url.includes('login') || url.includes('auth') || url.includes('api')) {
        console.log('🔥 [PUPPETEER RESPONSE]', res.status(), url);
      }
    });

    console.log('Navigating to https://pacc.marutisuzuki.com/msil-dashboard/auth/login ...');
    await page.goto('https://pacc.marutisuzuki.com/msil-dashboard/auth/login', { waitUntil: 'networkidle2', timeout: 30000 });

    await new Promise(r => setTimeout(r, 2000));

    const emailInput = await page.$('#email, input[name="email"], input[type="email"], input[type="text"]');
    if (emailInput) {
      console.log('Typing username into login form...');
      await emailInput.type(username, { delay: 30 });
    }

    const passInput = await page.$('#password, input[name="password"], input[type="password"]');
    if (passInput) {
      console.log('Typing password into login form...');
      await passInput.type(password, { delay: 30 });
    }

    const loginBtn = await page.$('#btnID, button[type="submit"], input[type="submit"], button');
    if (loginBtn) {
      console.log('Clicking Login button to trigger OTP generation...');
      await loginBtn.click();
      await new Promise(r => setTimeout(r, 4000));
    }

    console.log('Page URL after login submit:', page.url());

    const cookies = await page.cookies();
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    return {
      browser: browser,
      page: page,
      cookie: cookieStr,
      puppeteerSuccess: true,
      otpRequired: true
    };
  } catch (err) {
    console.error('Puppeteer browser login error:', err.message);
    if (browser) try { await browser.close(); } catch (e) { }
    return { error: 'Browser login error: ' + err.message };
  }
}

async function loginAndGetSession() {
  const username = CONFIG.marutiUsername || process.env.MARUTI_USERNAME;
  const password = CONFIG.marutiPassword || process.env.MARUTI_PASSWORD;

  if (!username || !password) {
    console.error('Maruti credentials not set. Username:', username, 'Password set:', !!password);
    return { error: 'Maruti credentials missing. Please enter Username and Password.' };
  }

  console.log(`Starting Maruti Login via Chrome Browser for ${username}...`);
  const pupResult = await loginWithPuppeteerBrowser(username, password);
  if (pupResult && !pupResult.error) {
    return pupResult;
  }

  console.error('Puppeteer browser login failed, trying fallback endpoints:', pupResult?.error);

  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };

  const candidateEndpoints = [
    '/dashboard-api/api/user/login',
    '/msil-dashboard/auth/login'
  ];

  for (const path of candidateEndpoints) {
    const fullUrl = CONFIG.marutiBaseUrl + path;
    try {
      const loginResponse = await axios.post(
        fullUrl,
        { email: username, password: password },
        {
          headers: headers,
          maxRedirects: 0,
          validateStatus: () => true,
        }
      );
      if (loginResponse.status === 200 || loginResponse.status === 201) {
        return {
          cookie: (loginResponse.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; '),
          otpRequired: true
        };
      }
    } catch (e) { }
  }

  return { error: pupResult?.error || 'Login failed' };
}

async function verifyOtp(session, otp, csrf) {
  console.log(`Verifying OTP ${otp}...`);

  if (session && session.page) {
    try {
      console.log('Filling OTP into active Puppeteer Chrome form...');
      const page = session.page;

      try { await page.bringToFront(); } catch (e) {}
      await new Promise(r => setTimeout(r, 1500));

      const otpResult = await page.evaluate((otpCode) => {
        // Find Validate OTP modal container or heading
        const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6, div, span, p'));
        const otpHeading = headings.find(h => {
          const txt = (h.innerText || '').trim().toLowerCase();
          return txt === 'validate otp' || txt.includes('validate otp') || txt.includes('enter otp');
        });

        let modalContainer = otpHeading ? (otpHeading.closest('.modal, .card, .popup, div') || otpHeading.parentElement) : document.body;

        // Find input element inside modal
        let input = modalContainer.querySelector('input[type="text"], input[type="number"], input[name="otp"], #otp, input');
        if (!input) {
          input = document.querySelector('input[type="text"], input[type="number"], input[name="otp"], #otp, input');
        }

        if (input) {
          input.focus();
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
          if (nativeSetter) {
            nativeSetter.call(input, String(otpCode));
          } else {
            input.value = String(otpCode);
          }
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.dispatchEvent(new Event('blur', { bubbles: true }));
        }

        // Search specifically for the "Verify OTP" button by exact or partial text match
        const buttons = Array.from(modalContainer.querySelectorAll('button, a, input[type="button"], input[type="submit"], div[role="button"]'));
        let verifyBtn = buttons.find(b => {
          const txt = (b.innerText || b.value || '').trim().toLowerCase();
          return txt === 'verify otp' || txt.includes('verify otp');
        });

        if (!verifyBtn) {
          const allBtns = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"]'));
          verifyBtn = allBtns.find(b => {
            const txt = (b.innerText || b.value || '').trim().toLowerCase();
            return txt === 'verify otp' || txt.includes('verify otp');
          });
        }

        if (verifyBtn) {
          verifyBtn.click();
          return 'clicked_verify_otp';
        }

        return 'input_filled_no_button';
      }, otp);

      console.log('DOM OTP verify result:', otpResult);

      if (otpResult === 'input_filled_no_button' || !otpResult) {
        const otpInput = await page.$('input[type="text"], input[type="number"], input[name="otp"], #otp, input');
        if (otpInput) {
          await otpInput.click({ clickCount: 3 });
          await page.keyboard.press('Backspace');
          await otpInput.type(String(otp), { delay: 50 });
        }

        const clicked = await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button, a, input'));
          const target = btns.find(b => (b.innerText || b.value || '').toLowerCase().includes('verify otp'));
          if (target) { target.click(); return true; }
          return false;
        });
        console.log('Fallback Verify OTP button click:', clicked);
      }

      await new Promise(r => setTimeout(r, 4000));
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});

      console.log('Chrome Page URL after OTP verification:', page.url());

      let pageUrl = page.url();
      if (!pageUrl.includes('msil-dashboard') && !pageUrl.includes('dashboard')) {
        console.log('Navigating directly to Maruti dashboard: https://pacc.marutisuzuki.com/msil-dashboard');
        await page.goto('https://pacc.marutisuzuki.com/msil-dashboard', { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
      }

      const localStorageData = await page.evaluate(() => {
        const store = {};
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          store[k] = localStorage.getItem(k);
        }
        return store;
      }).catch(() => ({}));

      for (const [k, v] of Object.entries(localStorageData)) {
        if (v && (k.toLowerCase().includes('token') || k.toLowerCase().includes('auth') || k.toLowerCase().includes('jwt') || k.toLowerCase().includes('user'))) {
          if (!session.accessToken && typeof v === 'string' && (v.startsWith('eyJ') || v.length > 20)) {
            session.accessToken = v;
          }
        }
      }

      const cookies = await page.cookies();
      const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      if (cookieStr) session.cookie = cookieStr;

      session.authenticated = true;
      return true;
    } catch (e) {
      console.warn('Puppeteer OTP entry warning:', e.message);
    }
  }

  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Cookie': session.cookie || '',
    'X-CSRF-Token': csrf || session.csrfToken || '',
  };

  const endpoints = [
    CONFIG.marutiBaseUrl + '/dashboard-api/api/user/validate-otp',
    CONFIG.marutiBaseUrl + '/dashboard-api/api/user/verify-otp',
    CONFIG.marutiBaseUrl + '/dashboard-api/api/auth/validate-otp',
  ];

  const payloadVariants = [
    { otp: otp },
    { code: otp }
  ];

  for (const endpoint of endpoints) {
    for (const payload of payloadVariants) {
      try {
        const response = await axios.post(endpoint, payload, {
          headers: headers,
          maxRedirects: 0,
          validateStatus: () => true,
        });
        if (response.status === 200 || response.status === 201 || response.status === 302) {
          session.authenticated = true;
          return true;
        }
      } catch (e) { }
    }
  }

  return false;
}

function formatDateDDMMYYYY(dateStr) {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length === 3) {
    if (parts[0].length === 4) {
      return `${parts[2]}-${parts[1]}-${parts[0]}`;
    }
    return dateStr;
  }
  return dateStr;
}

function parseDownloadedFile(filePath) {
  try {
    const ext = path.extname(filePath).toLowerCase();
    let XLSX = null;
    try { XLSX = require('xlsx'); } catch (e) {}

    if (XLSX && (ext === '.xlsx' || ext === '.xls')) {
      console.log('Parsing Excel file using XLSX library:', filePath);
      const workbook = XLSX.readFile(filePath);
      
      let sheetName = workbook.SheetNames[0];
      if (workbook.SheetNames.length > 1) {
        const detailsSheet = workbook.SheetNames.find(n => n.toLowerCase().includes('details'));
        if (detailsSheet) {
          sheetName = detailsSheet;
        } else {
          sheetName = workbook.SheetNames[1];
        }
      }
      
      console.log('Extracting data from sheet:', sheetName);
      const worksheet = workbook.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json(worksheet);
      return data;
    }

    console.log('Parsing text/CSV file:', filePath);
    const content = fs.readFileSync(filePath, 'utf8');
    if (content.trim().startsWith('{') || content.trim().startsWith('[')) {
      const parsed = JSON.parse(content);
      return extractReportData(parsed);
    }
    return parseCsv(content);
  } catch (e) {
    console.error('Error parsing downloaded file:', e.message);
    return [];
  }
}

async function fetchPartyVisitReport(session, startDate, endDate, reportType) {
  let capturedApiRows = [];

  // Attempt 1: Fetch using active Puppeteer Chrome session (keep browser OPEN as requested)
  if (session && session.page) {
    try {
      const page = session.page;
      console.log('Using active Chrome browser to navigate and fetch Maruti report...');
      console.log('Current Chrome URL:', page.url());

      // 1. Setup CDP Download path
      const downloadsDir = path.resolve(__dirname, 'downloads');
      if (!fs.existsSync(downloadsDir)) {
        fs.mkdirSync(downloadsDir, { recursive: true });
      }

      try {
        fs.readdirSync(downloadsDir).forEach(f => {
          try { fs.unlinkSync(path.join(downloadsDir, f)); } catch (e) {}
        });
      } catch (e) {}

      try {
        const cdp = await page.target().createCDPSession();
        await cdp.send('Page.setDownloadBehavior', {
          behavior: 'allow',
          downloadPath: downloadsDir
        });
      } catch (e) {
        console.warn('Could not set CDP download behavior:', e.message);
      }

      // 2. Intercept network responses ONLY for actual report export/download endpoints (ignore background KPI widgets)
      page.on('response', async (res) => {
        const url = res.url();
        // Ignore ambient widget APIs like top-dse-parties-visited, noStock, etc.
        if (url.includes('top-dse') || url.includes('noStock') || url.includes('kpi=') || url.includes('dashboard-api/api/dashboard')) {
          return;
        }

        if (url.includes('party-visit') || url.includes('partyVisit') || url.includes('export') || url.includes('download') || url.includes('report-data')) {
          console.log('🔥 [CHROME REPORT API RESPONSE]', res.status(), url);
          try {
            const contentType = res.headers()['content-type'] || '';
            if (contentType.includes('json')) {
              const json = await res.json().catch(() => null);
              if (json) {
                const data = extractReportData(json);
                if (data && data.length > 0) {
                  console.log(`🔥 Captured ${data.length} report rows from export response:`, url);
                  capturedApiRows = data;
                }
              }
            } else if (contentType.includes('csv') || contentType.includes('text') || contentType.includes('spreadsheet') || contentType.includes('excel')) {
              const text = await res.text().catch(() => null);
              if (text && !text.includes('<!DOCTYPE') && !text.includes('<html')) {
                const data = parseCsv(text);
                if (data && data.length > 0) {
                  console.log(`🔥 Captured ${data.length} report rows from CSV export response:`, url);
                  capturedApiRows = data;
                }
              }
            }
          } catch (e) {}
        }
      });

      // 3. Ensure browser is on the Smart Analytics Portal main dashboard page (not auth/login/otp screen)
      let pageUrl = page.url();
      if (pageUrl.includes('auth') || pageUrl.includes('login') || pageUrl.includes('validate') || !pageUrl.includes('msil-dashboard')) {
        console.log(`Page is currently on auth/login screen (${pageUrl}). Navigating directly to Maruti dashboard: https://pacc.marutisuzuki.com/msil-dashboard`);
        await page.goto('https://pacc.marutisuzuki.com/msil-dashboard', { waitUntil: 'networkidle2', timeout: 25000 }).catch(() => {});
      }

      // Wait explicitly for Smart Analytics Portal dashboard elements to render
      console.log('Waiting for Smart Analytics Portal dashboard elements to render on page...');
      await page.waitForFunction(() => {
        const txt = (document.body ? document.body.innerText : '').toLowerCase();
        return txt.includes('party visit report') || txt.includes('intellisales') || txt.includes('welcome distributor') || txt.includes('smart analytics portal');
      }, { timeout: 20000 }).catch(e => console.warn('Dashboard element wait warning:', e.message));

      await new Promise(r => setTimeout(r, 2000));
      try { await page.bringToFront(); } catch (e) {}

      // 4. Update Date Filters on page as per date change request
      if (startDate && endDate) {
        const formattedStart = formatDateDDMMYYYY(startDate);
        const formattedEnd = formatDateDDMMYYYY(endDate);
        console.log(`Updating Date Filters on dashboard page: Start=${formattedStart} (${startDate}), End=${formattedEnd} (${endDate})`);

        await page.evaluate(({ startDDMM, endDDMM, startYYYY, endYYYY }) => {
          const inputs = Array.from(document.querySelectorAll('input'));
          
          function setVal(el, val) {
            if (!el) return;
            el.focus();
            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
            if (nativeSetter) {
              nativeSetter.call(el, val);
            } else {
              el.value = val;
            }
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('blur', { bubbles: true }));
          }

          let startInput = null;
          let endInput = null;

          inputs.forEach(inp => {
            const labelText = ((inp.parentElement ? inp.parentElement.innerText : '') + ' ' + (inp.placeholder || '') + ' ' + (inp.name || '') + ' ' + (inp.id || '')).toLowerCase();
            if (labelText.includes('start') || labelText.includes('from')) startInput = inp;
            if (labelText.includes('end') || labelText.includes('to')) endInput = inp;
          });

          const dateInputs = inputs.filter(i => {
            const v = i.value || i.placeholder || '';
            return i.type === 'date' || v.match(/\d{2}[-/]\d{2}[-/]\d{4}/) || v.match(/\d{4}[-/]\d{2}[-/]\d{2}/) || i.classList.contains('mat-input-element');
          });

          if (!startInput && dateInputs.length >= 1) startInput = dateInputs[0];
          if (!endInput && dateInputs.length >= 2) endInput = dateInputs[1];

          if (startInput) setVal(startInput, startInput.type === 'date' ? startYYYY : startDDMM);
          if (endInput) setVal(endInput, endInput.type === 'date' ? endYYYY : endDDMM);

          const buttons = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"]'));
          const applyBtn = buttons.find(b => {
            const txt = (b.innerText || b.value || '').toLowerCase();
            return txt.includes('apply') || txt.includes('search') || txt.includes('filter') || txt.includes('submit') || txt.includes('go');
          });
          if (applyBtn) applyBtn.click();

        }, {
          startDDMM: formattedStart,
          endDDMM: formattedEnd,
          startYYYY: startDate,
          endYYYY: endDate
        }).catch(e => console.warn('Date filter evaluate warning:', e.message));

        await new Promise(r => setTimeout(r, 2500));
      }

      // 5. LIVE DOM INSPECTION & LOGGING for Party Visit Report Card
      console.log('====================================================');
      console.log('=== LIVE DOM INSPECTION & CARD LOGGING FOR PARTY VISIT REPORT ===');
      console.log('====================================================');
      
      const domDetails = await page.evaluate(() => {
        const allElements = Array.from(document.querySelectorAll('*'));
        
        const cardTitles = allElements.filter(el => {
          const txt = (el.innerText || el.textContent || '').trim();
          return txt.length > 3 && txt.length < 50 && (txt.includes('Report') || txt.includes('Visit') || txt.includes('Order') || txt.includes('Performance'));
        }).map(el => ({ tagName: el.tagName, text: (el.innerText || '').trim(), className: el.className }));

        const partyVisitTitle = allElements.find(el => {
          const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
          return txt === 'party visit report' || txt.startsWith('party visit report');
        });

        if (!partyVisitTitle) {
          return { error: 'Party Visit Report title not found in DOM', cardTitles };
        }

        const titleRect = partyVisitTitle.getBoundingClientRect();
        
        let cardContainer = partyVisitTitle.parentElement;
        for (let i = 0; i < 5; i++) {
          if (!cardContainer || cardContainer === document.body) break;
          const txt = (cardContainer.innerText || cardContainer.textContent || '').toLowerCase();
          if (txt.includes('order collection report') || txt.includes('sales executives')) {
            break;
          }
          if (cardContainer.querySelectorAll('select, chart, canvas, svg, button').length > 0) {
            break;
          }
          cardContainer = cardContainer.parentElement;
        }

        if (!cardContainer) cardContainer = partyVisitTitle.parentElement;

        const cardRect = cardContainer.getBoundingClientRect();
        const allInCard = Array.from(cardContainer.querySelectorAll('*'));

        const elementsLog = allInCard.slice(0, 30).map(e => {
          const r = e.getBoundingClientRect();
          return {
            tagName: e.tagName,
            className: e.className,
            id: e.id,
            text: (e.innerText || e.textContent || '').substring(0, 40).trim(),
            outerHTML: e.outerHTML.substring(0, 150),
            rect: { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
          };
        });

        return {
          titleFound: true,
          titleTag: partyVisitTitle.tagName,
          titleRect: { left: Math.round(titleRect.left), top: Math.round(titleRect.top) },
          cardTag: cardContainer.tagName,
          cardClass: cardContainer.className,
          cardRect: { left: Math.round(cardRect.left), top: Math.round(cardRect.top), width: Math.round(cardRect.width), height: Math.round(cardRect.height) },
          cardTitles,
          elementsLog
        };
      }).catch(e => ({ error: e.message }));

      console.log('🔥 LIVE DOM INSPECTION REPORT:', JSON.stringify(domDetails, null, 2));

      // Reset capturedApiRows before clicking download button to prevent capturing ambient page API data
      capturedApiRows = [];

      // Click Download button on Party Visit Report card header
      const downloadResult = await page.evaluate((targetReportType) => {
        function triggerClick(el) {
          if (!el) return false;
          let clicked = false;
          try {
            if (typeof el.click === 'function') {
              el.click();
              clicked = true;
            }
          } catch (e) {}
          try {
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            clicked = true;
          } catch (e) {}
          
          const parentBtn = el.closest('button, a, [role="button"], div.download-btn, div');
          if (parentBtn && parentBtn !== el) {
            try {
              if (typeof parentBtn.click === 'function') {
                parentBtn.click();
                clicked = true;
              }
            } catch (e) {}
            try {
              parentBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
              clicked = true;
            } catch (e) {}
          }
          return clicked;
        }

        // Align page at top
        window.scrollTo(0, 0);

        // 1. Find the heading element for "Party Visit Report"
        const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6, span, div'));
        const partyVisitTitle = headings.find(el => {
          const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
          return txt === 'party visit report';
        });

        if (!partyVisitTitle) {
          return 'party_visit_title_element_not_found';
        }

        const titleRect = partyVisitTitle.getBoundingClientRect();
        console.log(`Found Party Visit Report title <${partyVisitTitle.tagName}> at (${Math.round(titleRect.left)}, ${Math.round(titleRect.top)})`);

        // 2. Find the .card-header or .card-box containing it
        let cardContainer = partyVisitTitle.closest('.card-header, .card-box, .card');
        
        // If closest() doesn't work, traverse up to 6 levels
        if (!cardContainer) {
          let curr = partyVisitTitle.parentElement;
          for (let i = 0; i < 6; i++) {
            if (!curr || curr === document.body) break;
            if (curr.classList && (curr.classList.contains('card-header') || curr.classList.contains('card-box') || curr.classList.contains('card'))) {
              cardContainer = curr;
              break;
            }
            curr = curr.parentElement;
          }
        }

        if (!cardContainer) {
           return 'party_visit_card_container_not_found';
        }

        const containerRect = cardContainer.getBoundingClientRect();
        console.log(`Party Visit Card bounds: left=${Math.round(containerRect.left)}, top=${Math.round(containerRect.top)}`);

        // 3. Search for download button strictly inside this specific container
        const clickables = Array.from(cardContainer.querySelectorAll('.download-btn, [title*="Download"], i.icon-download, i.fa-download, i.feather.icon-download, i[class*="download"]'));
        
        let downloadBtn = clickables[0];
        
        // If the icon was found, try to get its wrapper button
        if (downloadBtn && (downloadBtn.tagName === 'I' || downloadBtn.tagName === 'SVG')) {
           downloadBtn = downloadBtn.closest('.btn, .download-btn, a, span') || downloadBtn.parentElement;
        }

        if (downloadBtn) {
          const rect = downloadBtn.getBoundingClientRect();
          triggerClick(downloadBtn);
          return `clicked_party_visit_download_button_x_${Math.round(rect.left + rect.width / 2)}_y_${Math.round(rect.top + rect.height / 2)}`;
        }

        return 'no_download_button_found_in_card';
      }, reportType).catch(e => 'error_' + e.message);

      console.log('Download button click result:', downloadResult);

      if (typeof downloadResult === 'string' && downloadResult.includes('_x_') && downloadResult.includes('_y_')) {
        try {
          const matchX = downloadResult.match(/_x_(\d+)/);
          const matchY = downloadResult.match(/_y_(\d+)/);
          if (matchX && matchY) {
            const clickX = parseInt(matchX[1], 10);
            const clickY = parseInt(matchY[1], 10);
            console.log(`Executing Puppeteer physical mouse click at coordinates (${clickX}, ${clickY})...`);
            await page.mouse.click(clickX, clickY);
          }
        } catch (e) {
          console.warn('Puppeteer mouse click warning:', e.message);
        }
      }

      // Wait up to 10 seconds for file download
      console.log('Waiting for report file to download...');
      let downloadedFile = null;
      const downloadWaitStart = Date.now();
      while (Date.now() - downloadWaitStart < 10000) {
        try {
          const files = fs.readdirSync(downloadsDir).filter(f => !f.endsWith('.crdownload') && !f.endsWith('.tmp'));
          if (files.length > 0) {
            downloadedFile = path.join(downloadsDir, files[0]);
            console.log('Found downloaded report file:', downloadedFile);
            break;
          }
        } catch (e) {}
        await new Promise(r => setTimeout(r, 500));
      }

      if (downloadedFile && fs.existsSync(downloadedFile)) {
        const parsedRows = parseDownloadedFile(downloadedFile);
        if (parsedRows && parsedRows.length > 0) {
          console.log(`Successfully extracted ${parsedRows.length} rows from downloaded file: ${downloadedFile}`);
          capturedApiRows = parsedRows;
        }
      }

      if (!capturedApiRows || capturedApiRows.length === 0) {
        const domRows = await page.evaluate(() => {
          const table = document.querySelector('table');
          if (!table) return [];
          const headers = Array.from(table.querySelectorAll('th')).map(th => th.innerText.trim());
          const trs = Array.from(table.querySelectorAll('tbody tr'));
          return trs.map(tr => {
            const tds = Array.from(tr.querySelectorAll('td')).map(td => td.innerText.trim());
            const obj = {};
            headers.forEach((h, idx) => { obj[h || `col_${idx}`] = tds[idx] || ''; });
            return obj;
          });
        }).catch(() => []);

        if (domRows && domRows.length > 0) {
          console.log(`Extracted ${domRows.length} report rows directly from DOM table!`);
          capturedApiRows = domRows;
        }
      }

    } catch (e) {
      console.warn('Chrome report extraction warning:', e.message);
    }
    // IMPORTANT: DO NOT CLOSE BROWSER HERE! Keep browser open so user sees page after OTP verification.
  }

  if (capturedApiRows && capturedApiRows.length > 0) {
    return capturedApiRows;
  }

  // Attempt 2: Axios direct HTTP API fallback
  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Cookie': session.cookie,
  };

  if (session.accessToken) {
    headers.Authorization = 'Bearer ' + session.accessToken;
  }

  const apiEndpoints = [
    CONFIG.marutiBaseUrl + '/dashboard-api/api/report/party-visit?startDate=' + startDate + '&endDate=' + endDate + '&reportType=' + reportType,
    CONFIG.marutiBaseUrl + '/dashboard-api/api/report/party-visit?from=' + startDate + '&to=' + endDate,
    CONFIG.marutiBaseUrl + '/dashboard-api/api/reports/party-visit?from=' + startDate + '&to=' + endDate,
    CONFIG.marutiBaseUrl + '/dashboard-api/api/party-visit-report?from=' + startDate + '&to=' + endDate,
    CONFIG.marutiBaseUrl + '/msil-dashboard/api/report/party-visit?startDate=' + startDate + '&endDate=' + endDate + '&reportType=' + reportType,
    CONFIG.marutiBaseUrl + '/msil-dashboard/api/report/party-visit?from=' + startDate + '&to=' + endDate,
    CONFIG.marutiBaseUrl + '/msil-dashboard/api/report/party-visit?start_date=' + startDate + '&end_date=' + endDate,
    CONFIG.marutiBaseUrl + '/msil-dashboard/api/reports/party-visit?from=' + startDate + '&to=' + endDate,
    CONFIG.marutiBaseUrl + '/msil-dashboard/api/party-visit-report?from=' + startDate + '&to=' + endDate,
  ];

  const datePayload = JSON.stringify({
    startDate: startDate,
    endDate: endDate,
    reportType: 'party_visit',
    dateRange: 'month',
  });

  for (const endpoint of apiEndpoints) {
    try {
      const response = await axios.get(endpoint, {
        headers: headers,
        maxRedirects: 0,
        validateStatus: () => true,
      });

      if (response.status === 200) {
        const content = response.data;
        if (typeof content === 'object') {
          return extractReportData(content);
        }
        if (typeof content === 'string') {
          const trimmed = content.trim().toLowerCase();
          if (trimmed.startsWith('<!doctype') || trimmed.startsWith('<html') || trimmed.includes('<script')) {
            console.warn('Endpoint returned HTML page instead of API report data:', endpoint);
            continue;
          }
          return parseCsv(content);
        }
      }
    } catch (e) {
      console.error('Report fetch error at ' + endpoint + ':', e.message);
    }
  }

  try {
    const response = await axios.post(CONFIG.marutiBaseUrl + '/msil-dashboard/api/report/party-visit', datePayload, {
      headers: headers,
      maxRedirects: 0,
      validateStatus: () => true,
    });

    if (response.status === 200) {
      const content = response.data;
      if (typeof content === 'object') {
        return extractReportData(content);
      }
      if (typeof content === 'string') {
        const trimmed = content.trim().toLowerCase();
        if (!trimmed.startsWith('<!doctype') && !trimmed.startsWith('<html')) {
          return parseCsv(content);
        }
      }
    }
  } catch (e) {
    console.error('Report POST fetch error:', e.message);
  }

  return [];
}

function extractReportData(data) {
  if (Array.isArray(data)) return data;
  if (data.data && Array.isArray(data.data)) return data.data;
  if (data.partyVisit && Array.isArray(data.partyVisit)) return data.partyVisit;
  if (data.party_visit && Array.isArray(data.party_visit)) return data.party_visit;
  if (data.report && Array.isArray(data.report)) return data.report;
  if (data.result && Array.isArray(data.result)) return data.result;
  return [];
}

function parseCsv(csvText) {
  if (!csvText || typeof csvText !== 'string' || csvText.trim().length === 0) return [];
  const trimmed = csvText.trim();
  if (trimmed.toLowerCase().startsWith('<!doctype') || trimmed.toLowerCase().startsWith('<html') || trimmed.toLowerCase().includes('<script')) {
    console.error('parseCsv rejected HTML response string');
    return [];
  }
  const lines = csvText.split(/\r?\n/);
  if (lines.length === 0) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim().length === 0) continue;
    const values = lines[i].split(',').map(v => v.trim().replace(/"/g, ''));
    const row = {};
    headers.forEach((h, idx) => { row[h] = values[idx] || ''; });
    rows.push(row);
  }
  return rows;
}

function extractOtp(text) {
  if (!text) return null;
  for (const pattern of CONFIG.otpPatterns) {
    const match = text.match(pattern);
    if (match) {
      const otp = match[1];
      if (/^\d+$/.test(otp) && otp.length >= 4) return otp;
    }
  }
  return null;
}

async function initializeWhatsApp() {
  if (!activeGroupId) {
    console.warn('No WhatsApp group selected. OTP auto-extraction from WhatsApp is disabled until POST /api/config/group is called.');
    console.log('WhatsApp will still connect and you can select a group via /api/groups');
  }

  waStatus = 'initializing';

  let puppeteerExecutablePath = '';
  try {
    const puppeteerCore = require('puppeteer');
    const bundledPath = puppeteerCore.executablePath();
    puppeteerExecutablePath = bundledPath;
  } catch (e) { }

  if (!puppeteerExecutablePath || !require('fs').existsSync(puppeteerExecutablePath)) {
    const fallbackPaths = [
      process.env.PUPPETEER_EXECUTABLE_PATH,
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      require('os').homedir() + '\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser'
    ];
    for (const p of fallbackPaths) {
      if (p && require('fs').existsSync(p)) {
        puppeteerExecutablePath = p;
        break;
      }
    }

    if (!puppeteerExecutablePath) {
      try {
        const puppeteer = require('puppeteer');
        puppeteerExecutablePath = puppeteer.executablePath();
      } catch (e) {}
    }

    if (puppeteerExecutablePath) {
      console.log('Using system Chrome:', puppeteerExecutablePath);
    } else {
      console.warn('No Chrome found - WhatsApp automation may fail. Install Chrome or run: npx puppeteer browsers install chrome');
    }
  }

  waClient = new Client({
    authStrategy: new LocalAuth({ clientId: 'maruti-otp-monitor', dataPath: './whatsapp-session' }),
    puppeteer: {
      headless: true,
      executablePath: puppeteerExecutablePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-owned-memory',
        '--disable-dev-shm-usage',
        '--disable-web-security',
      ],
      timeout: 60000,
    },
  });

  waClient.on('qr', async (qr) => {
    qrCodeData = qr;
    waStatus = 'qr_ready';
    console.log('=== WhatsApp Web QR Code ===');
    try {
      const qrImage = await qrcode.toString(qr, { type: 'terminal', small: true });
      console.log(qrImage);
    } catch (e) {
      console.log('QR (raw):', qr);
    }
    console.log('Scan this QR code with your phone:');
  });

  waClient.on('authenticated', () => {
    waStatus = 'authenticated';
    isWaReady = true;
    console.log('WhatsApp authenticated successfully.');
  });

  waClient.on('auth_failure', (msg) => {
    waStatus = 'auth_failure';
    console.error('WhatsApp auth failure:', msg);
  });

  waClient.on('ready', () => {
    waStatus = 'ready';
    isWaReady = true;
    console.log('WhatsApp Web client is ready!');
    console.log('Active group ID:', activeGroupId || '(none selected)');
  });

  function isFromSelectedGroup(message, targetGroupId) {
    if (!targetGroupId) return false;
    const cleanTarget = targetGroupId.split('@')[0].trim();
    const from = String(message.from || '');
    const to = String(message.to || '');
    const author = String(message.author || '');

    return (
      from === targetGroupId ||
      to === targetGroupId ||
      author === targetGroupId ||
      (cleanTarget.length > 5 && (from.includes(cleanTarget) || to.includes(cleanTarget) || author.includes(cleanTarget)))
    );
  }

  waClient.on('message_create', async (message) => {
    if (!isWaReady || !activeGroupId) return;
    try {
      if (isFromSelectedGroup(message, activeGroupId)) {
        const body = message.body || '';
        const otp = extractOtp(body);
        if (otp) {
          lastOtp = otp;
          lastOtpTime = Date.now();
          console.log(`🔥 Detected fresh OTP from SELECTED WhatsApp group (${activeGroupId}):`, otp);
        }
      }
    } catch (e) {}
  });

  try {
    await waClient.initialize();
  } catch (e) {
    console.error('Failed to initialize WhatsApp client:', e.message);
    waStatus = 'error';
  }
}

async function checkExistingMessages() {
  if (!waClient || !isWaReady) {
    console.log('WhatsApp client is not ready. Use --check after the client is connected.');
    return;
  }
  const chats = await waClient.getChats();
  const group = chats.find(c => c.id._serialized === activeGroupId);
  if (!group) {
    console.log('Group not found. Available groups:');
    chats.filter(c => c.isGroup).forEach(g => {
      console.log('  ' + g.name + ' -> ' + g.id._serialized);
    });
    return;
  }
  const messages = await group.fetchMessages({ limit: 50 });
  const otpMessages = messages
    .filter(m => m.body && extractOtp(m.body))
    .map(m => ({ body: m.body, otp: extractOtp(m.body), timestamp: m.timestamp }));
  if (otpMessages.length > 0) {
    const latest = otpMessages[otpMessages.length - 1];
    console.log('Latest OTP found:', latest.otp);
    lastOtp = latest.otp;
    lastOtpTime = latest.timestamp * 1000;
  } else {
    console.log('No OTP messages found in recent history.');
  }
}

const PORT = CONFIG.port;
app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
  console.log('Health check: http://localhost:' + PORT + '/health');
  console.log('QR code: http://localhost:' + PORT + '/qr');
  initializeWhatsApp();
});

module.exports = { app, extractOtp, fetchPartyVisitReport, loginAndGetSession };
