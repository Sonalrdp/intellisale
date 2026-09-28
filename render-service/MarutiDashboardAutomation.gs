/**
 * Maruti Dashboard Automation - Google Apps Script Webhook & Sheet Sync
 * Target Google Sheet ID: 1OwGmD1feRrioI3gn7QQZ3CVU8_1y-0NN6AINQ7vBQaE
 */

const CONFIG = {
  dataSheetName: 'Party Visit Report',
  logsSheetName: 'Logs',
  headerColor: '#4285f4', // Google Blue
  headerTextColor: '#ffffff',
};

/**
 * Handle incoming Webhook POST requests from Node.js backend
 */
function doPost(e) {
  try {
    let payload = {};
    if (e && e.postData && e.postData.contents) {
      payload = JSON.parse(e.postData.contents);
    } else {
      throw new Error('No post content received');
    }

    const data = payload.data || payload.rows || [];
    const startDate = payload.startDate || payload.from_date || '';
    const endDate = payload.endDate || payload.to_date || '';
    const reportType = payload.reportType || payload.type || 'Party Visit Report';

    if (!data || !Array.isArray(data)) {
      const errMessage = 'Invalid data format. Expected an array of objects under "data".';
      logAction('Webhook POST - ERROR', errMessage, 0);
      return ContentService.createTextOutput(JSON.stringify({
        status: 'error',
        message: errMessage
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // Write data to "Party Visit Report" sheet
    const rowCount = writeDataToSheet(data, startDate, endDate, reportType);

    // Log action to "Logs" sheet
    const logDetails = 'Successfully patched ' + rowCount + ' rows (' + (startDate ? startDate + ' to ' + endDate : 'Full Report') + ')';
    logAction('Webhook POST - SUCCESS', logDetails, rowCount);

    return ContentService.createTextOutput(JSON.stringify({
      status: 'success',
      message: 'Successfully updated Google Sheet data and logs',
      rows: rowCount,
      startDate: startDate,
      endDate: endDate,
      timestamp: new Date().toISOString()
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    logAction('Webhook POST - EXCEPTION', err.message, 0);
    return ContentService.createTextOutput(JSON.stringify({
      status: 'error',
      message: err.message
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * Handle Webhook GET health check requests
 */
function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({
    status: 'ok',
    service: 'Maruti Dashboard Google Apps Script Webhook',
    timestamp: new Date().toISOString()
  })).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Write report data array into the "Party Visit Report" sheet
 */
function writeDataToSheet(data, startDate, endDate, reportType) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.dataSheetName);

  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.dataSheetName);
  } else {
    sheet.clear();
  }

  // Header banner info
  sheet.getRange('A1').setValue(reportType || 'Party Visit Report');
  sheet.getRange('A1').setFontWeight('bold').setFontSize(14).setFontColor('#1a73e8');
  
  if (startDate && endDate) {
    sheet.getRange('A2').setValue('Date Range: ' + startDate + ' to ' + endDate);
  } else {
    sheet.getRange('A2').setValue('Date Range: All Available Data');
  }
  
  sheet.getRange('A3').setValue('Last Updated: ' + new Date().toLocaleString());
  sheet.getRange('A2:A3').setFontSize(9).setFontColor('#5f6368');

  if (!data || data.length === 0) {
    sheet.getRange('A5').setValue('No data available for the selected period.').setFontItalic(true);
    return 0;
  }

  // Extract Column Headers from the first data object
  const headers = Object.keys(data[0]);

  if (headers.length > 0 && typeof headers[0] === 'string' && (headers[0].trim().toLowerCase().startsWith('<!doctype') || headers[0].trim().toLowerCase().startsWith('<html') || headers[0].includes('<script'))) {
    throw new Error('Received HTML response payload instead of tabular data. Please check Maruti credentials and report endpoints.');
  }

  // Set Table Column Headers at Row 5
  sheet.getRange(5, 1, 1, headers.length).setValues([headers]);
  
  // Format Headers
  const headerRange = sheet.getRange(5, 1, 1, headers.length);
  headerRange.setFontWeight('bold');
  headerRange.setBackground(CONFIG.headerColor);
  headerRange.setFontColor(CONFIG.headerTextColor);
  headerRange.setVerticalAlignment('middle');

  // Convert objects to rows 2D array
  const rows = data.map(item => headers.map(h => (item[h] !== undefined && item[h] !== null) ? item[h] : ''));

  // Write Data Rows starting from Row 6
  if (rows.length > 0) {
    sheet.getRange(6, 1, rows.length, headers.length).setValues(rows);
    
    // Add subtle grid borders
    const dataRange = sheet.getRange(5, 1, rows.length + 1, headers.length);
    dataRange.setBorder(true, true, true, true, true, true, '#dadce0', SpreadsheetApp.BorderStyle.SOLID);
  }

  // Auto-fit column widths
  for (let c = 1; c <= headers.length; c++) {
    sheet.autoResizeColumn(c);
  }

  return rows.length;
}

/**
 * Log actions and errors into the "Logs" sheet
 */
function logAction(status, details, rowCount) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(CONFIG.logsSheetName);

    if (!sheet) {
      sheet = ss.insertSheet(CONFIG.logsSheetName);
      sheet.getRange('A1:D1').setValues([['Timestamp', 'Status', 'Details', 'Row Count']]);
      sheet.getRange('A1:D1').setFontWeight('bold').setBackground('#3c4043').setFontColor('#ffffff');
    }

    const nextRow = Math.max(sheet.getLastRow() + 1, 2);
    sheet.getRange(nextRow, 1).setValue(new Date().toLocaleString());
    sheet.getRange(nextRow, 2).setValue(status);
    sheet.getRange(nextRow, 3).setValue(details || '');
    sheet.getRange(nextRow, 4).setValue(rowCount || 0);

    if (status.includes('SUCCESS')) {
      sheet.getRange(nextRow, 2).setFontColor('#137333').setFontWeight('bold');
    } else if (status.includes('ERROR') || status.includes('EXCEPTION')) {
      sheet.getRange(nextRow, 2).setFontColor('#c5221f').setFontWeight('bold');
    }
  } catch (err) {
    Logger.log('Error writing log: ' + err.message);
  }
}

/**
 * Create custom spreadsheet menu on open
 */
function onOpen() {
  try {
    const ui = SpreadsheetApp.getUi();
    ui.createMenu('Maruti Automation')
      .addItem('Setup Required Sheets', 'createRequiredSheets')
      .addItem('Clear Log Sheet', 'clearLogs')
      .addToUi();
  } catch (e) {
    Logger.log('onOpen error: ' + e.message);
  }
}

/**
 * Helper to setup all required sheets automatically
 */
function createRequiredSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  // Data Sheet
  let dataSheet = ss.getSheetByName(CONFIG.dataSheetName);
  if (!dataSheet) {
    dataSheet = ss.insertSheet(CONFIG.dataSheetName);
    dataSheet.getRange('A1').setValue('Party Visit Report').setFontWeight('bold').setFontSize(14);
    dataSheet.getRange('A2').setValue('Waiting for data push from automation server...').setFontItalic(true);
  }

  // Logs Sheet
  let logsSheet = ss.getSheetByName(CONFIG.logsSheetName);
  if (!logsSheet) {
    logsSheet = ss.insertSheet(CONFIG.logsSheetName);
    logsSheet.getRange('A1:D1').setValues([['Timestamp', 'Status', 'Details', 'Row Count']]);
    logsSheet.getRange('A1:D1').setFontWeight('bold').setBackground('#3c4043').setFontColor('#ffffff');
  }

  SpreadsheetApp.getUi().alert('Success', 'Required sheets ("' + CONFIG.dataSheetName + '" and "' + CONFIG.logsSheetName + '") are ready!', SpreadsheetApp.getUi().ButtonSet.OK);
}

/**
 * Helper to clear logs
 */
function clearLogs() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.logsSheetName);
  if (sheet) {
    sheet.clear();
    sheet.getRange('A1:D1').setValues([['Timestamp', 'Status', 'Details', 'Row Count']]);
    sheet.getRange('A1:D1').setFontWeight('bold').setBackground('#3c4043').setFontColor('#ffffff');
  }
}
