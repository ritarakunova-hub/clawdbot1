/**
 * TAINA Studio — мини-CRM для заявок с сайта.
 * Веб-приложение Google Apps Script, привязанное к Google Таблице.
 *
 * Действия (передаются как ?action=... в URL):
 *   addLead        (POST) — добавить новую заявку строкой в таблицу
 *   getUnanswered  (GET)  — вернуть список заявок без ответа (для напоминания)
 *
 * Как это работает с полями формы:
 *   Скрипт НЕ завязан на конкретные названия полей (name, email, phone...).
 *   Он берёт заголовки из первой строки листа и для каждого заголовка ищет
 *   значение с таким же именем (без учёта регистра) в данных, которые
 *   прислал n8n. Поэтому если поля вашей формы называются иначе — просто
 *   переименуйте заголовки в таблице, код менять не нужно.
 *
 * Настройка токена (обязательно, иначе Web App будет открыт всем в интернете):
 *   Extensions/Расширения → Apps Script → значок шестерёнки "Project Settings"
 *   → Script Properties → Add script property:
 *     Property: SHARED_TOKEN
 *     Value:    придумайте длинную случайную строку (это и есть ваш секрет)
 *   Этот же токен нужно будет вставить в n8n (в HTTP Request ноды), но НЕ
 *   в файлы репозитория.
 */

var SHEET_NAME = 'Заявки'; // название листа с заявками
var STATUS_HEADER = 'Статус';
var DATE_HEADER = 'Дата';
var ANSWERED_DATE_HEADER = 'Дата ответа';
var STATUS_NEW = 'Новая';
var STATUS_ANSWERED = 'Отвечено';

function doPost(e) {
  try {
    var action = e.parameter.action;
    if (action === 'addLead') {
      return handleAddLead(e);
    }
    return jsonOutput({ ok: false, error: 'Неизвестное действие: ' + action });
  } catch (err) {
    return jsonOutput({ ok: false, error: String(err) });
  }
}

function doGet(e) {
  try {
    var action = e.parameter.action;
    if (action === 'getUnanswered') {
      return handleGetUnanswered(e);
    }
    return jsonOutput({ ok: false, error: 'Неизвестное действие: ' + action });
  } catch (err) {
    return jsonOutput({ ok: false, error: String(err) });
  }
}

function handleAddLead(e) {
  if (!checkToken(e)) {
    return jsonOutput({ ok: false, error: 'Неверный или отсутствующий token' });
  }

  var payload = {};
  if (e.postData && e.postData.contents) {
    payload = JSON.parse(e.postData.contents);
  }

  var sheet = getSheet();
  var headers = getHeaders(sheet);

  // Строим карту "заголовок в нижнем регистре -> значение из payload"
  var payloadLower = {};
  for (var key in payload) {
    if (payload.hasOwnProperty(key)) {
      payloadLower[String(key).toLowerCase().trim()] = payload[key];
    }
  }

  var row = headers.map(function (header) {
    var h = String(header).trim();
    if (h === DATE_HEADER) {
      return new Date();
    }
    if (h === STATUS_HEADER) {
      return STATUS_NEW;
    }
    if (h === ANSWERED_DATE_HEADER) {
      return '';
    }
    var value = payloadLower[h.toLowerCase()];
    return value === undefined || value === null ? '' : value;
  });

  sheet.appendRow(row);

  return jsonOutput({ ok: true, row: sheet.getLastRow() });
}

function handleGetUnanswered(e) {
  if (!checkToken(e)) {
    return jsonOutput({ ok: false, error: 'Неверный или отсутствующий token' });
  }

  var sheet = getSheet();
  var headers = getHeaders(sheet);
  var statusCol = headers.indexOf(STATUS_HEADER);
  var dateCol = headers.indexOf(DATE_HEADER);

  var lastRow = sheet.getLastRow();
  var items = [];

  if (lastRow > 1) {
    var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
    for (var i = 0; i < values.length; i++) {
      var rowValues = values[i];
      var status = statusCol >= 0 ? String(rowValues[statusCol]).trim() : '';
      if (status.toLowerCase() === STATUS_ANSWERED.toLowerCase()) {
        continue; // уже отвечено — пропускаем
      }
      // Пропускаем полностью пустые строки
      var isEmpty = rowValues.every(function (v) { return v === '' || v === null; });
      if (isEmpty) {
        continue;
      }

      var summaryParts = [];
      for (var c = 0; c < headers.length; c++) {
        var h = String(headers[c]).trim();
        if (h === STATUS_HEADER || h === ANSWERED_DATE_HEADER || h === DATE_HEADER) {
          continue;
        }
        if (rowValues[c] !== '' && rowValues[c] !== null) {
          summaryParts.push(h + ': ' + rowValues[c]);
        }
      }

      items.push({
        row: i + 2, // номер строки в таблице (с учётом заголовка)
        date: dateCol >= 0 ? String(rowValues[dateCol]) : '',
        summary: summaryParts.join(', ')
      });
    }
  }

  return jsonOutput({ ok: true, count: items.length, items: items });
}

function getSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.getSheets()[0]; // если лист не переименован — берём первый
  }
  return sheet;
}

function getHeaders(sheet) {
  var lastCol = sheet.getLastColumn();
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0];
}

function checkToken(e) {
  var expected = PropertiesService.getScriptProperties().getProperty('SHARED_TOKEN');
  if (!expected) {
    // Токен не настроен в Script Properties — считаем это ошибкой конфигурации,
    // а не пропускаем проверку, чтобы Web App не остался открытым всем подряд.
    return false;
  }
  var given = e.parameter.token;
  return given === expected;
}

function jsonOutput(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}
