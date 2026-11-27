/**
 * TAINA — единый веб-скрипт для таблицы "TAINA — Воронка" (первый лист).
 * Обслуживает и мини-CRM (заявки с сайта), и Sales Engine (лиды с Google Maps).
 *
 * Действия:
 *   doPost  { token, source, ... }                      — добавить строку (лид)
 *   doGet   ?action=overdue&token=...                   — заявки/лиды без действия в срок
 *   doGet   ?action=checkExists&company=...&site=...&token=...  — проверка дублей
 *   doPost  { action:'updateStatus', ... }                    — сменить статус безопасно
 *   doPost  { action:'receiveSignedNetlifyLead', ... }        — принять подписанную заявку
 *
 * Настройка токена (обязательно):
 *   Расширения → Apps Script → шестерёнка "Настройки проекта" → "Свойства скрипта"
 *   → добавить свойства:
 *     WEBHOOK_TOKEN = длинная случайная строка для внутренних n8n → Apps Script вызовов;
 *     TELEGRAM_APPROVER_USER_ID = numeric Telegram user ID владельца;
 *     TELEGRAM_CHAT_ID = numeric private chat ID владельца;
 *     NETLIFY_JWS_SECRET = JWS secret из Netlify form notification.
 *   Эти значения не хранить в Git и не отправлять в чат.
 *
 * Столбцы (первая строка листа, порядок не важен — скрипт ищет по названию):
 *   ID, Дата добавления, Компания, Сайт, Отрасль, Источник, Контакт (ЛПР),
 *   Канал связи, Score (0-100), Возможная проблема (гипотеза), Что предложить,
 *   Статус, Дата первого контакта, Дата последнего контакта, Следующее действие,
 *   Дата следующего действия, Ответ клиента, Продукт, Сумма (₽), Комментарий,
 *   Telegram Chat ID, Telegram Message ID, Netlify Submission ID
 */

var TIMEZONE = 'Europe/Moscow';
var OVERDUE_STATUSES = ['Новый', 'Написали', 'Ответил', 'Созвон', 'КП отправлено'];

function doPost(e) {
  var payload;
  try {
    payload = JSON.parse((e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return jsonOutput({ ok: false, error: 'Некорректный JSON в теле запроса' });
  }

  if (!checkToken(payload.token)) {
    return jsonOutput({ ok: false, error: 'Неверный или отсутствующий token' });
  }

  try {
    if (payload.action === 'receiveSignedNetlifyLead') {
      return receiveSignedNetlifyLead(payload);
    }
    if (payload.action === 'saveApprovalMessage') {
      return saveApprovalMessage(payload.id, payload.chatId, payload.messageId);
    }
    if (payload.action === 'updateStatus') {
      return updateStatus(
        payload.id, payload.status, payload.approverId, payload.chatId, payload.messageId
      );
    }

    var source = payload.source || 'netlify';
    if (source === 'netlify') {
      return jsonOutput({ ok: false, error: 'signed_netlify_action_required' });
    }
    if (source === 'sales-engine') {
      return addSalesEngineLead(payload);
    }
    return jsonOutput({ ok: false, error: 'Неизвестный source: ' + source });
  } catch (err) {
    return jsonOutput({ ok: false, error: String(err) });
  }
}

function doGet(e) {
  var action = e.parameter.action;

  if (!checkToken(e.parameter.token)) {
    return jsonOutput({ ok: false, error: 'Неверный или отсутствующий token' });
  }

  try {
    if (action === 'overdue') {
      return getOverdue();
    }
    if (action === 'checkExists') {
      return checkExists(e.parameter.company || '', e.parameter.site || '');
    }
    if (action === 'updateStatus') {
      return jsonOutput({ ok: false, error: 'status_update_requires_post' });
    }
    return jsonOutput({ ok: false, error: 'Неизвестное действие: ' + action });
  } catch (err) {
    return jsonOutput({ ok: false, error: String(err) });
  }
}

// ---------- signed Netlify intake ----------

function receiveSignedNetlifyLead(request) {
  var verified;
  try {
    verified = verifyNetlifyJws(request.signature, request.rawBodyBase64);
  } catch (err) {
    return jsonOutput({ ok: false, error: 'invalid_netlify_signature' });
  }
  if (!verified || !verified.ok) {
    return jsonOutput({ ok: false, error: 'invalid_netlify_signature' });
  }

  var root;
  try {
    root = JSON.parse(verified.rawBody);
  } catch (err) {
    return jsonOutput({ ok: false, error: 'invalid_netlify_payload' });
  }

  var payload = root && root.payload && typeof root.payload === 'object' &&
    !Array.isArray(root.payload) ? root.payload : root;
  var data = payload && payload.data && typeof payload.data === 'object' &&
    !Array.isArray(payload.data) ? payload.data : {};

  var formName = String(payload.form_name || root.form_name || '').trim();
  if (formName !== 'taina-diagnostic') {
    return jsonOutput({ ok: false, error: 'unexpected_form' });
  }

  var consent = pickNetlifyValue(data, [
    'consent',
    'personal_data_consent',
    'consent_to_processing',
    'data_processing_consent',
    'Согласие на обработку персональных данных',
    'согласие'
  ]).toLowerCase();
  if (['1', 'true', 'yes', 'on', 'accepted', 'согласен', 'согласна', 'да'].indexOf(consent) === -1) {
    return jsonOutput({ ok: false, error: 'consent_required' });
  }

  var name = pickNetlifyValue(data, ['name', 'Name', 'имя', 'Имя', 'full_name', 'fullname']);
  var company = pickNetlifyValue(data, ['company', 'Company', 'компания', 'Компания', 'organization']);
  var email = pickNetlifyValue(data, ['email', 'Email', 'почта', 'Почта']);
  var phone = pickNetlifyValue(data, ['phone', 'Phone', 'телефон', 'Телефон', 'tel']);
  var contact = pickNetlifyValue(data, ['contact', 'Contact', 'контакт', 'Контакт']);
  var message = pickNetlifyValue(data, ['message', 'Message', 'сообщение', 'Сообщение', 'comment', 'комментарий', 'текст']);

  if (!email && !phone && !contact) {
    return jsonOutput({ ok: false, error: 'contact_required' });
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonOutput({ ok: false, error: 'invalid_email' });
  }
  if (phone && phone.replace(/\D/g, '').length < 7) {
    return jsonOutput({ ok: false, error: 'invalid_phone' });
  }
  if (name.length > 120 || company.length > 120 || email.length > 254 ||
      phone.length > 48 || contact.length > 254 || message.length > 2000) {
    return jsonOutput({ ok: false, error: 'field_too_long' });
  }

  var generalContact = contact;
  var channel = '';
  if (email) {
    channel = 'Email: ' + email;
  } else if (phone) {
    channel = 'Тел.: ' + phone;
  } else if (/^@|t\.me\//i.test(generalContact)) {
    channel = 'Telegram: ' + generalContact;
  } else if (generalContact.indexOf('@') !== -1) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(generalContact)) {
      return jsonOutput({ ok: false, error: 'invalid_contact' });
    }
    channel = 'Email: ' + generalContact;
  } else {
    channel = 'Контакт: ' + generalContact;
  }

  var createdAtValue = payload.created_at || root.created_at || new Date().toISOString();
  var createdAt = new Date(createdAtValue);
  if (isNaN(createdAt.getTime())) {
    return jsonOutput({ ok: false, error: 'invalid_created_at' });
  }

  // Netlify form notification examples do not always expose an explicit submission ID.
  // The signed SHA-256 body digest is stable across retries of the same exact event.
  var submissionId = String(
    payload.id || payload.submission_id || root.id || ('sha256:' + verified.sha256)
  ).trim();
  if (!submissionId || submissionId.length > 128) {
    return jsonOutput({ ok: false, error: 'invalid_submission_id' });
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = getSheet();
    var headers = getHeaders(sheet);
    var submissionCol = headers.indexOf('Netlify Submission ID');
    var idCol = headers.indexOf('ID');
    if (submissionCol < 0 || idCol < 0) {
      return jsonOutput({ ok: false, error: 'netlify_dedup_column_missing' });
    }

    var lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      var existingRows = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
      for (var i = 0; i < existingRows.length; i++) {
        if (String(existingRows[i][submissionCol] || '') === submissionId) {
          return jsonOutput({
            ok: true,
            duplicate: true,
            id: String(existingRows[i][idCol]),
            form_name: formName
          });
        }
      }
    }

    var id = sheet.getLastRow();
    var row = new Array(headers.length).fill('');
    setCol(row, headers, 'ID', id);
    setCol(row, headers, 'Дата добавления', createdAt);
    setCol(row, headers, 'Компания', safeSheetText(company || '—'));
    setCol(row, headers, 'Контакт (ЛПР)', safeSheetText(name || '—'));
    setCol(row, headers, 'Канал связи', safeSheetText(channel));
    setCol(row, headers, 'Источник', 'Заявка с сайта');
    setCol(row, headers, 'Статус', 'Новый');
    setCol(row, headers, 'Следующее действие', 'Ответить на заявку');
    setCol(row, headers, 'Дата следующего действия', addDays(createdAt, 1));
    setCol(row, headers, 'Комментарий', safeSheetText(message));
    setCol(row, headers, 'Netlify Submission ID', submissionId);

    sheet.appendRow(row);
    SpreadsheetApp.flush();
    return jsonOutput({
      ok: true,
      duplicate: false,
      id: String(id),
      form_name: formName
    });
  } finally {
    lock.releaseLock();
  }
}

function verifyNetlifyJws(token, rawBodyBase64) {
  var secret = PropertiesService.getScriptProperties().getProperty('NETLIFY_JWS_SECRET');
  if (!secret || typeof token !== 'string' || token.length > 8192 ||
      typeof rawBodyBase64 !== 'string' || !rawBodyBase64 || rawBodyBase64.length > 180000) {
    return { ok: false };
  }

  var parts = token.split('.');
  if (parts.length !== 3 || parts.some(function (part) { return !part; })) {
    return { ok: false };
  }

  var header;
  var claims;
  var rawBytes;
  try {
    header = JSON.parse(Utilities.newBlob(
      Utilities.base64DecodeWebSafe(parts[0])
    ).getDataAsString('UTF-8'));
    claims = JSON.parse(Utilities.newBlob(
      Utilities.base64DecodeWebSafe(parts[1])
    ).getDataAsString('UTF-8'));
    rawBytes = Utilities.base64Decode(rawBodyBase64);
  } catch (err) {
    return { ok: false };
  }

  if (!header || header.alg !== 'HS256' ||
      !claims || claims.iss !== 'netlify' || typeof claims.sha256 !== 'string') {
    return { ok: false };
  }

  var actualHash = bytesToHex(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, rawBytes)
  );
  if (!constantTimeTextEquals(claims.sha256.toLowerCase(), actualHash)) {
    return { ok: false };
  }

  var expectedSignature = Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(parts[0] + '.' + parts[1], secret)
  ).replace(/=+$/, '');
  if (!constantTimeTextEquals(parts[2], expectedSignature)) {
    return { ok: false };
  }

  return {
    ok: true,
    rawBody: Utilities.newBlob(rawBytes).getDataAsString('UTF-8'),
    sha256: actualHash
  };
}

function pickNetlifyValue(data, names) {
  for (var i = 0; i < names.length; i++) {
    var value = data[names[i]];
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      value = value.filter(function (item) {
        return ['string', 'number', 'boolean'].indexOf(typeof item) !== -1;
      }).map(function (item) { return String(item).trim(); }).filter(Boolean).join(', ');
    } else if (['string', 'number', 'boolean'].indexOf(typeof value) !== -1) {
      value = String(value).trim();
    } else {
      continue;
    }
    if (value) return String(value);
  }
  return '';
}

function safeSheetText(value) {
  var text = String(value === undefined || value === null ? '' : value);
  // Prevent untrusted form text from becoming a spreadsheet formula.
  return /^[\s]*[=+\-@]/.test(text) ? "'" + text : text;
}

function bytesToHex(bytes) {
  return bytes.map(function (byte) {
    var value = byte < 0 ? byte + 256 : byte;
    return (value < 16 ? '0' : '') + value.toString(16);
  }).join('');
}

function constantTimeTextEquals(left, right) {
  left = String(left || '');
  right = String(right || '');
  if (left.length !== right.length) return false;
  var mismatch = 0;
  for (var i = 0; i < left.length; i++) {
    mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return mismatch === 0;
}

// ---------- doPost: добавление лидов ----------

function addNetlifyLead(payload) {
  var sheet = getSheet();
  var headers = getHeaders(sheet);
  var id = sheet.getLastRow(); // до вставки: getLastRow()=1 (только заголовок) -> первый ID = 1

  var row = new Array(headers.length).fill('');
  setCol(row, headers, 'ID', id);
  setCol(row, headers, 'Дата добавления', new Date());
  setCol(row, headers, 'Компания', payload.company || '—');
  setCol(row, headers, 'Контакт (ЛПР)', payload.name || '—');
  setCol(row, headers, 'Канал связи', payload.channel || '—');
  setCol(row, headers, 'Источник', 'Заявка с сайта');
  setCol(row, headers, 'Статус', 'Новый');
  setCol(row, headers, 'Следующее действие', 'Ответить на заявку');
  setCol(row, headers, 'Дата следующего действия', addDays(new Date(), 1));
  setCol(row, headers, 'Комментарий', payload.message || '');

  sheet.appendRow(row);
  return jsonOutput({ ok: true, id: id, row: sheet.getLastRow() });
}

function addSalesEngineLead(payload) {
  var sheet = getSheet();
  var headers = getHeaders(sheet);
  var id = sheet.getLastRow();

  var row = new Array(headers.length).fill('');
  setCol(row, headers, 'ID', id);
  setCol(row, headers, 'Дата добавления', new Date());
  setCol(row, headers, 'Компания', payload.company || '—');
  setCol(row, headers, 'Сайт', payload.site || '');
  setCol(row, headers, 'Отрасль', payload.industry || '');
  setCol(row, headers, 'Источник', 'Google Maps');
  setCol(row, headers, 'Score (0-100)', payload.score !== undefined ? payload.score : '');
  setCol(row, headers, 'Возможная проблема (гипотеза)', payload.hypothesis || '');
  setCol(row, headers, 'Что предложить', payload.solution || '');
  setCol(row, headers, 'Статус', 'На рассмотрении');
  setCol(row, headers, 'Telegram Chat ID', '');
  setCol(row, headers, 'Telegram Message ID', '');

  sheet.appendRow(row);
  return jsonOutput({ ok: true, id: id, row: sheet.getLastRow() });
}

// ---------- doGet: чтение и обновление ----------

function getOverdue() {
  var sheet = getSheet();
  var headers = getHeaders(sheet);
  var idCol = headers.indexOf('ID');
  var companyCol = headers.indexOf('Компания');
  var statusCol = headers.indexOf('Статус');
  var nextActionCol = headers.indexOf('Следующее действие');
  var nextDateCol = headers.indexOf('Дата следующего действия');

  var todayStr = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd');
  var lastRow = sheet.getLastRow();
  var items = [];

  if (lastRow > 1) {
    var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
    for (var i = 0; i < values.length; i++) {
      var r = values[i];
      var status = statusCol >= 0 ? String(r[statusCol]).trim() : '';
      if (OVERDUE_STATUSES.indexOf(status) === -1) continue;

      var nextDateStr = nextDateCol >= 0 ? dateToStr(r[nextDateCol]) : '';
      if (!nextDateStr || nextDateStr > todayStr) continue;

      items.push({
        id: idCol >= 0 ? r[idCol] : '',
        company: companyCol >= 0 ? r[companyCol] : '',
        status: status,
        nextAction: nextActionCol >= 0 ? r[nextActionCol] : '',
        nextActionDate: nextDateStr
      });
    }
  }

  return jsonOutput({ ok: true, count: items.length, items: items });
}

function checkExists(company, site) {
  var sheet = getSheet();
  var headers = getHeaders(sheet);
  var companyCol = headers.indexOf('Компания');
  var siteCol = headers.indexOf('Сайт');

  var companyNorm = normalizeText(company);
  var siteNorm = normalizeSite(site);

  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
    for (var i = 0; i < values.length; i++) {
      var r = values[i];
      if (companyNorm && companyCol >= 0 && normalizeText(r[companyCol]) === companyNorm) {
        return jsonOutput({ ok: true, exists: true });
      }
      if (siteNorm && siteCol >= 0 && normalizeSite(r[siteCol]) === siteNorm) {
        return jsonOutput({ ok: true, exists: true });
      }
    }
  }

  return jsonOutput({ ok: true, exists: false });
}

function saveApprovalMessage(id, chatId, messageId) {
  if (!/^\d+$/.test(String(id || '')) ||
      !/^\d+$/.test(String(chatId || '')) ||
      !/^\d+$/.test(String(messageId || ''))) {
    return jsonOutput({ ok: false, error: 'invalid_approval_message_fields' });
  }

  var expectedChatId = PropertiesService.getScriptProperties().getProperty('TELEGRAM_CHAT_ID');
  if (!expectedChatId || String(chatId) !== String(expectedChatId)) {
    return jsonOutput({ ok: false, error: 'approval_chat_not_allowed' });
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = getSheet();
    var headers = getHeaders(sheet);
    var idCol = headers.indexOf('ID');
    var statusCol = headers.indexOf('Статус');
    var chatCol = headers.indexOf('Telegram Chat ID');
    var messageCol = headers.indexOf('Telegram Message ID');
    if ([idCol, statusCol, chatCol, messageCol].some(function (i) { return i < 0; })) {
      return jsonOutput({ ok: false, error: 'approval_columns_missing' });
    }

    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) return jsonOutput({ ok: false, error: 'lead_not_found' });

    var rows = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][idCol]) !== String(id)) continue;

      var rowNumber = i + 2;
      var currentStatus = String(rows[i][statusCol] || '');
      var savedChatId = String(rows[i][chatCol] || '');
      var savedMessageId = String(rows[i][messageCol] || '');

      if (currentStatus !== 'На рассмотрении') {
        return jsonOutput({ ok: false, error: 'lead_not_awaiting_approval' });
      }

      if (savedMessageId || savedChatId) {
        if (savedMessageId === String(messageId) && savedChatId === String(chatId)) {
          return jsonOutput({ ok: true, already_saved: true });
        }
        return jsonOutput({ ok: false, error: 'approval_message_already_bound' });
      }

      sheet.getRange(rowNumber, chatCol + 1).setValue(String(chatId));
      sheet.getRange(rowNumber, messageCol + 1).setValue(String(messageId));
      SpreadsheetApp.flush();
      return jsonOutput({ ok: true, id: String(id), message_id: String(messageId) });
    }

    return jsonOutput({ ok: false, error: 'lead_not_found' });
  } finally {
    lock.releaseLock();
  }
}

function updateStatus(id, status, approverId, chatId, messageId) {
  var allowedStatuses = ['Одобрено', 'Отклонено'];
  if (!/^\d+$/.test(String(id || '')) ||
      allowedStatuses.indexOf(String(status || '')) === -1 ||
      !/^\d+$/.test(String(approverId || '')) ||
      !/^\d+$/.test(String(chatId || '')) ||
      !/^\d+$/.test(String(messageId || ''))) {
    return jsonOutput({ ok: false, error: 'invalid_approval_fields' });
  }

  var properties = PropertiesService.getScriptProperties();
  var expectedApproverId = properties.getProperty('TELEGRAM_APPROVER_USER_ID');
  var expectedChatId = properties.getProperty('TELEGRAM_CHAT_ID');
  if (!expectedApproverId || !expectedChatId ||
      String(approverId) !== String(expectedApproverId) ||
      String(chatId) !== String(expectedChatId)) {
    return jsonOutput({ ok: false, error: 'approval_actor_not_allowed' });
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = getSheet();
    var headers = getHeaders(sheet);
    var idCol = headers.indexOf('ID');
    var statusCol = headers.indexOf('Статус');
    var chatCol = headers.indexOf('Telegram Chat ID');
    var messageCol = headers.indexOf('Telegram Message ID');
    if ([idCol, statusCol, chatCol, messageCol].some(function (i) { return i < 0; })) {
      return jsonOutput({ ok: false, error: 'approval_columns_missing' });
    }

    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) return jsonOutput({ ok: false, error: 'lead_not_found' });

    var rows = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][idCol]) !== String(id)) continue;

      var currentStatus = String(rows[i][statusCol] || '');
      var storedChatId = String(rows[i][chatCol] || '');
      var storedMessageId = String(rows[i][messageCol] || '');

      if (storedChatId !== String(chatId) || storedMessageId !== String(messageId) ||
          !storedChatId || !storedMessageId) {
        return jsonOutput({ ok: false, error: 'approval_card_mismatch' });
      }

      if (currentStatus === String(status)) {
        return jsonOutput({ ok: true, already_applied: true });
      }
      if (currentStatus !== 'На рассмотрении') {
        return jsonOutput({ ok: false, error: 'invalid_status_transition' });
      }

      sheet.getRange(i + 2, statusCol + 1).setValue(String(status));
      SpreadsheetApp.flush();
      return jsonOutput({ ok: true, status: String(status) });
    }

    return jsonOutput({ ok: false, error: 'lead_not_found' });
  } finally {
    lock.releaseLock();
  }
}

// ---------- вспомогательные функции ----------

function getSheet() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
}

function getHeaders(sheet) {
  var lastCol = sheet.getLastColumn();
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) {
    return String(h).trim();
  });
}

function setCol(row, headers, headerName, value) {
  var idx = headers.indexOf(headerName);
  if (idx !== -1) {
    row[idx] = value;
  }
}

function addDays(date, days) {
  var d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

function dateToStr(value) {
  if (!value) return '';
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return Utilities.formatDate(value, TIMEZONE, 'yyyy-MM-dd');
  }
  return String(value).trim();
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeSite(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
}

function checkToken(token) {
  var expected = PropertiesService.getScriptProperties().getProperty('WEBHOOK_TOKEN');
  if (!expected) {
    // Токен не настроен — считаем это ошибкой конфигурации, а не пропускаем проверку.
    return false;
  }
  return token === expected;
}

function jsonOutput(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}
