const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const scriptPath = path.join(__dirname, '..', 'apps-script', 'Code.gs');
const scriptSource = fs.readFileSync(scriptPath, 'utf8');

const workflow3 = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'sales-engine', 'workflow-3-lead-finder.json'), 'utf8'
));
const workflow4 = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'sales-engine', 'workflow-4-approval-handler.json'), 'utf8'
));

function makeHarness(initialStatus = 'На рассмотрении', includeSeedLead = true) {
  const headers = [
    'ID',
    'Статус',
    'Telegram Chat ID',
    'Telegram Message ID',
    'Дата добавления',
    'Компания',
    'Сайт',
    'Отрасль',
    'Источник',
    'Контакт (ЛПР)',
    'Канал связи',
    'Score (0-100)',
    'Возможная проблема (гипотеза)',
    'Что предложить',
    'Дата первого контакта',
    'Дата последнего контакта',
    'Следующее действие',
    'Дата следующего действия',
    'Ответ клиента',
    'Продукт',
    'Сумма (₽)',
    'Комментарий',
    'Согласие на обработку ПДн',
    'Netlify Submission ID'
  ];
  const rows = includeSeedLead
    ? [headers, [42, initialStatus, '', '']]
    : [headers];
  const scriptProperties = {
    WEBHOOK_TOKEN: 'synthetic-test-token',
    TELEGRAM_APPROVER_USER_ID: '777',
    TELEGRAM_CHAT_ID: '123456',
    NETLIFY_JWS_SECRET: 'synthetic-netlify-jws-secret'
  };
  let lockDepth = 0;
  let lockReleases = 0;

  const sheet = {
    getLastRow() { return rows.length; },
    getLastColumn() { return headers.length; },
    getRange(row, column, numRows, numColumns) {
      return {
        getValues() {
          const result = [];
          for (let r = 0; r < (numRows || 1); r++) {
            const sourceRow = rows[row - 1 + r] || [];
            result.push(sourceRow.slice(column - 1, column - 1 + (numColumns || 1)));
          }
          return result;
        },
        setValue(value) {
          if (!rows[row - 1]) rows[row - 1] = [];
          rows[row - 1][column - 1] = value;
        }
      };
    },
    appendRow(row) { rows.push(row.slice()); }
  };

  const context = {
    SpreadsheetApp: {
      getActiveSpreadsheet() {
        return { getSheets: () => [sheet] };
      },
      flush() {}
    },
    PropertiesService: {
      getScriptProperties() {
        return { getProperty: (key) => scriptProperties[key] || null };
      }
    },
    LockService: {
      getScriptLock() {
        return {
          waitLock() { lockDepth += 1; },
          releaseLock() { lockDepth -= 1; lockReleases += 1; }
        };
      }
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput(text) {
        return {
          text,
          mimeType: null,
          setMimeType(mimeType) {
            this.mimeType = mimeType;
            return this;
          }
        };
      }
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA-256' },
      formatDate(date, _timezone, pattern) {
        if (pattern === 'yyyy-MM-dd') return date.toISOString().slice(0, 10);
        return date.toISOString();
      },
      base64Decode(value) {
        return Array.from(Buffer.from(String(value), 'base64'), (byte) => byte > 127 ? byte - 256 : byte);
      },
      base64DecodeWebSafe(value) {
        return Array.from(Buffer.from(String(value), 'base64url'), (byte) => byte > 127 ? byte - 256 : byte);
      },
      base64EncodeWebSafe(bytes) {
        return Buffer.from(bytes.map((byte) => byte & 255)).toString('base64url');
      },
      computeDigest(_algorithm, bytes) {
        return Array.from(
          crypto.createHash('sha256').update(Buffer.from(bytes.map((byte) => byte & 255))).digest(),
          (byte) => byte > 127 ? byte - 256 : byte
        );
      },
      computeHmacSha256Signature(value, key) {
        return Array.from(
          crypto.createHmac('sha256', key).update(value).digest(),
          (byte) => byte > 127 ? byte - 256 : byte
        );
      },
      newBlob(bytes) {
        const buffer = Buffer.from(bytes.map((byte) => byte & 255));
        return { getDataAsString: (encoding) => buffer.toString(encoding || 'utf8') };
      }
    },
    console
  };
  vm.createContext(context);
  vm.runInContext(scriptSource, context, { filename: 'Code.gs' });

  return {
    context,
    rows,
    sheet,
    lockState: () => ({ lockDepth, lockReleases }),
    properties: scriptProperties
  };
}

function output(result) {
  assert.ok(result && typeof result.text === 'string', 'Apps Script should return JSON output');
  return JSON.parse(result.text);
}

function makeNetlifyJws(rawBody, secret = 'synthetic-netlify-jws-secret') {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({
    iss: 'netlify',
    sha256: crypto.createHash('sha256').update(rawBody).digest('hex')
  })).toString('base64url');
  const signingInput = header + '.' + claims;
  const signature = crypto.createHmac('sha256', secret).update(signingInput).digest('base64url');
  return signingInput + '.' + signature;
}

function makeNetlifyBody(overrides = {}) {
  return JSON.stringify({
    payload: {
      id: 'netlify-submission-001',
      form_name: 'taina-diagnostic',
      data: {
        name: 'Synthetic Person',
        contact: 'synthetic@example.test',
        consent: 'yes',
        message: 'Synthetic request text',
        ...overrides
      }
    },
    created_at: '2026-11-27T10:00:00.000Z',
    site_url: 'https://example.test'
  });
}

function testNetlifyJwsAndSignedIntake() {
  const h = makeHarness('На рассмотрении', false);
  const rawBody = makeNetlifyBody();
  const signature = makeNetlifyJws(rawBody);
  const rawBodyBase64 = Buffer.from(rawBody, 'utf8').toString('base64');

  const verified = h.context.verifyNetlifyJws(signature, rawBodyBase64);
  assert.equal(verified.ok, true);
  assert.equal(verified.rawBody, rawBody);

  assert.equal(h.context.verifyNetlifyJws(signature + 'tampered', rawBodyBase64).ok, false);
  assert.equal(h.context.verifyNetlifyJws(signature, Buffer.from(rawBody + ' ').toString('base64')).ok, false);
  assert.equal(h.context.verifyNetlifyJws(signature, '').ok, false);
  assert.equal(h.context.verifyNetlifyJws('not-a-jws', rawBodyBase64).ok, false);

  const accepted = output(h.context.doPost({
    postData: {
      contents: JSON.stringify({
        token: 'synthetic-test-token',
        action: 'receiveSignedNetlifyLead',
        signature,
        rawBodyBase64
      })
    }
  }));
  assert.equal(accepted.ok, true);
  assert.equal(accepted.duplicate, false);
  assert.equal(accepted.id, '1');
  assert.equal(h.rows.length, 2);
  const headers = h.rows[0];
  const saved = h.rows[1];
  assert.equal(saved[headers.indexOf('Компания')], '—');
  assert.equal(saved[headers.indexOf('Контакт (ЛПР)')], 'Synthetic Person');
  assert.equal(saved[headers.indexOf('Канал связи')], 'Email: synthetic@example.test');
  assert.equal(saved[headers.indexOf('Комментарий')], 'Synthetic request text');
  assert.equal(saved[headers.indexOf('Согласие на обработку ПДн')], 'yes');
  assert.equal(saved[headers.indexOf('Netlify Submission ID')], 'netlify-submission-001');

  const duplicate = output(h.context.receiveSignedNetlifyLead({ signature, rawBodyBase64 }));
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.id, '1');
  assert.equal(h.rows.length, 2, 'the same signed event must not append a second row');

  const noConsentBody = makeNetlifyBody({ consent: 'no' });
  const noConsent = output(h.context.receiveSignedNetlifyLead({
    signature: makeNetlifyJws(noConsentBody),
    rawBodyBase64: Buffer.from(noConsentBody).toString('base64')
  }));
  assert.equal(noConsent.ok, false);
  assert.equal(noConsent.error, 'consent_required');
  assert.equal(h.rows.length, 2);

  const wrongFormBody = makeNetlifyBody({ consent: 'yes' }).replace('taina-diagnostic', 'other-form');
  const wrongForm = output(h.context.receiveSignedNetlifyLead({
    signature: makeNetlifyJws(wrongFormBody),
    rawBodyBase64: Buffer.from(wrongFormBody).toString('base64')
  }));
  assert.equal(wrongForm.ok, false);
  assert.equal(wrongForm.error, 'unexpected_form');
  assert.equal(h.rows.length, 2);

  const unsignedBypass = output(h.context.doPost({
    postData: {
      contents: JSON.stringify({
        token: 'synthetic-test-token',
        source: 'netlify',
        name: 'Should never be accepted'
      })
    }
  }));
  assert.equal(unsignedBypass.ok, false);
  assert.equal(unsignedBypass.error, 'signed_netlify_action_required');
  assert.equal(h.rows.length, 2);

  assert.equal(h.context.safeSheetText('=IMPORTXML("x")'), "'=IMPORTXML(\"x\")");
  assert.equal(h.context.safeSheetText('plain text'), 'plain text');
  assert.deepEqual(h.lockState(), { lockDepth: 0, lockReleases: 2 });
}

function testWorkflow1RequiresRawSignedBodyAndMinimizesTelegram() {
  const webhook = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'mini-crm', 'workflow-1-new-lead.json'), 'utf8'
  ));
  const webhookNode = webhook.nodes.find((node) => node.id === 'webhook-node');
  const codeNode = webhook.nodes.find((node) => node.id === 'normalize-node');
  const httpNode = webhook.nodes.find((node) => node.id === 'sheet-node');
  const successNode = webhook.nodes.find((node) => node.id === 'telegram-ok-node');
  const failureNode = webhook.nodes.find((node) => node.id === 'telegram-error-node');

  assert.equal(webhookNode.parameters.responseMode, 'responseNode');
  assert.equal(webhookNode.parameters.options.rawBody, true);
  assert.ok(codeNode.parameters.jsCode.includes('x-webhook-signature'));
  assert.ok(codeNode.parameters.jsCode.includes('getBinaryDataBuffer'));
  assert.ok(codeNode.parameters.jsCode.includes("toString('base64')"));
  assert.ok(!codeNode.parameters.jsCode.includes('item.binary.data.data'));
  assert.ok(httpNode.parameters.jsonBody.includes('$json'));
  assert.equal(httpNode.parameters.method, 'POST');
  assert.ok(successNode.parameters.text.includes('id'));
  assert.ok(!successNode.parameters.text.includes('email'));
  assert.ok(!successNode.parameters.text.includes('contact'));
  assert.ok(!successNode.parameters.text.includes('message }}'));
  assert.ok(!failureNode.parameters.text.includes('email'));
  assert.ok(webhook.nodes.some((node) => node.type === 'n8n-nodes-base.respondToWebhook'));
  assert.equal(webhook.connections['Проверить Netlify JWS и сохранить заявку'].main[0][0].node, 'Заявка принята?');
}

function testApprovalMessageBinding() {
  const h = makeHarness();
  const save = output(h.context.saveApprovalMessage('42', '123456', '9001'));
  assert.equal(save.ok, true);
  assert.equal(h.rows[1][2], '123456');
  assert.equal(h.rows[1][3], '9001');

  const repeated = output(h.context.saveApprovalMessage('42', '123456', '9001'));
  assert.equal(repeated.ok, true);
  assert.equal(repeated.already_saved, true);

  const replacement = output(h.context.saveApprovalMessage('42', '123456', '9002'));
  assert.equal(replacement.ok, false);
  assert.equal(replacement.error, 'approval_message_already_bound');

  const wrongChat = output(h.context.saveApprovalMessage('42', '999999', '9003'));
  assert.equal(wrongChat.ok, false);
  assert.equal(wrongChat.error, 'approval_chat_not_allowed');

  const invalidFields = output(h.context.saveApprovalMessage('42', '123456', 'not-a-message-id'));
  assert.equal(invalidFields.ok, false);
  assert.equal(invalidFields.error, 'invalid_approval_message_fields');
  assert.deepEqual(h.lockState(), { lockDepth: 0, lockReleases: 3 });
}

function testOwnerAndExactCardAuthorization() {
  const h = makeHarness();
  assert.equal(output(h.context.saveApprovalMessage('42', '123456', '9001')).ok, true);

  const wrongOwner = output(h.context.updateStatus('42', 'Одобрено', '888', '123456', '9001'));
  assert.equal(wrongOwner.ok, false);
  assert.equal(wrongOwner.error, 'approval_actor_not_allowed');

  const wrongChat = output(h.context.updateStatus('42', 'Одобрено', '777', '999999', '9001'));
  assert.equal(wrongChat.ok, false);
  assert.equal(wrongChat.error, 'approval_actor_not_allowed');

  const staleCard = output(h.context.updateStatus('42', 'Одобрено', '777', '123456', '9002'));
  assert.equal(staleCard.ok, false);
  assert.equal(staleCard.error, 'approval_card_mismatch');

  const arbitraryStatus = output(h.context.updateStatus('42', 'Оплачено', '777', '123456', '9001'));
  assert.equal(arbitraryStatus.ok, false);
  assert.equal(arbitraryStatus.error, 'invalid_approval_fields');

  assert.equal(h.rows[1][1], 'На рассмотрении', 'rejected callbacks must not mutate the lead');
}

function testAllowedTransitionAndIdempotency() {
  const h = makeHarness();
  assert.equal(output(h.context.saveApprovalMessage('42', '123456', '9001')).ok, true);

  const approved = output(h.context.updateStatus('42', 'Одобрено', '777', '123456', '9001'));
  assert.equal(approved.ok, true);
  assert.equal(approved.status, 'Одобрено');
  assert.equal(h.rows[1][1], 'Одобрено');

  const repeated = output(h.context.updateStatus('42', 'Одобрено', '777', '123456', '9001'));
  assert.equal(repeated.ok, true);
  assert.equal(repeated.already_applied, true);

  const oppositeDecision = output(h.context.updateStatus('42', 'Отклонено', '777', '123456', '9001'));
  assert.equal(oppositeDecision.ok, false);
  assert.equal(oppositeDecision.error, 'invalid_status_transition');
  assert.equal(h.rows[1][1], 'Одобрено');
  assert.deepEqual(h.lockState(), { lockDepth: 0, lockReleases: 4 });
}

function testGetRejectsAllActionsAndPostCarriesToken() {
  const h = makeHarness();
  assert.equal(output(h.context.saveApprovalMessage('42', '123456', '9001')).ok, true);

  const getResult = output(h.context.doGet({
    parameter: {
      action: 'updateStatus',
      token: 'should-not-be-read-from-query',
      id: '42',
      status: 'Одобрено'
    }
  }));
  assert.equal(getResult.ok, false);
  assert.equal(getResult.error, 'get_not_allowed_use_post_body');
  assert.equal(h.rows[1][1], 'На рассмотрении');

  const overdue = output(h.context.doPost({
    postData: {
      contents: JSON.stringify({ token: 'synthetic-test-token', action: 'getOverdue' })
    }
  }));
  assert.equal(overdue.ok, true);
  assert.equal(overdue.count, 0);

  const exists = output(h.context.doPost({
    postData: {
      contents: JSON.stringify({
        token: 'synthetic-test-token',
        action: 'checkExists',
        company: 'Missing synthetic company',
        site: 'https://example.test'
      })
    }
  }));
  assert.equal(exists.ok, true);
  assert.equal(exists.exists, false);
}

function testWorkflow2And3UsePostBodies() {
  const workflow2 = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'mini-crm', 'workflow-2-reminders.json'), 'utf8'
  ));
  const overdueNode = workflow2.nodes.find((node) => node.id === 'overdue-node');
  assert.equal(overdueNode.parameters.method, 'POST');
  assert.equal(overdueNode.parameters.sendBody, true);
  assert.ok(overdueNode.parameters.jsonBody.includes('getOverdue'));
  assert.ok(overdueNode.parameters.jsonBody.includes('YOUR_WEBHOOK_TOKEN'));
  assert.equal(overdueNode.parameters.sendQuery, undefined);

  const duplicateNode = workflow3.nodes.find((node) => node.id === 'check-exists-node');
  assert.equal(duplicateNode.parameters.method, 'POST');
  assert.equal(duplicateNode.parameters.sendBody, true);
  assert.ok(duplicateNode.parameters.jsonBody.includes('checkExists'));
  assert.ok(duplicateNode.parameters.jsonBody.includes('YOUR_WEBHOOK_TOKEN'));
  assert.equal(duplicateNode.parameters.sendQuery, undefined);
}

function testWorkflow4ValidationAndRouting() {
  const parseNode = workflow4.nodes.find((node) => node.id === 'parse-callback-node');
  const parser = new Function('$input', parseNode.parameters.jsCode);

  const valid = parser({
    first: () => ({
      json: {
        callback_query: {
          id: 'callback-1',
          data: 'approve:42',
          from: { id: 777 },
          message: {
            chat: { id: 123456, type: 'private' },
            message_id: 9001,
            text: 'Review card'
          }
        }
      }
    })
  })[0].json;
  assert.equal(valid.valid, true);
  assert.equal(valid.status, 'Одобрено');
  assert.equal(valid.approverId, '777');
  assert.equal(valid.chatId, '123456');
  assert.equal(valid.messageId, '9001');

  const groupCallback = parser({
    first: () => ({
      json: {
        callback_query: {
          id: 'callback-2',
          data: 'approve:42',
          from: { id: 777 },
          message: { chat: { id: -123, type: 'group' }, message_id: 9001, text: 'card' }
        }
      }
    })
  })[0].json;
  assert.equal(groupCallback.valid, false);

  const unknownAction = parser({
    first: () => ({
      json: {
        callback_query: {
          id: 'callback-3',
          data: 'maybe:42',
          from: { id: 777 },
          message: { chat: { id: 123456, type: 'private' }, message_id: 9001, text: 'card' }
        }
      }
    })
  })[0].json;
  assert.equal(unknownAction.valid, false);
  assert.equal(unknownAction.status, '');

  const updateNode = workflow4.nodes.find((node) => node.id === 'update-status-node');
  assert.equal(updateNode.parameters.method, 'POST');
  assert.ok(updateNode.parameters.jsonBody.includes('approverId'));
  assert.ok(updateNode.parameters.jsonBody.includes('messageId'));
  assert.ok(updateNode.parameters.jsonBody.includes('chatId'));

  assert.ok(workflow4.connections['Корректное нажатие?'].main[0][0].node === 'Обновить статус в таблице');
  assert.ok(workflow4.connections['Корректное нажатие?'].main[1][0].node === 'Отклонить некорректное нажатие');
  assert.ok(workflow4.connections['Статус обновлён?'].main[0][0].node === 'Подтвердить обработку кнопки');
}

function testWorkflow3StoresCardBeforeButtons() {
  const card = workflow3.nodes.find((node) => node.id === 'telegram-card-node');
  const save = workflow3.nodes.find((node) => node.id === 'save-approval-message-node');
  const attach = workflow3.nodes.find((node) => node.id === 'attach-approval-buttons-node');

  assert.ok(card);
  assert.ok(save);
  assert.ok(attach);
  assert.equal(card.parameters.replyMarkup, undefined, 'first Telegram send must have no keyboard');
  assert.equal(card.parameters.inlineKeyboard, undefined);
  assert.equal(card.onError, 'continueErrorOutput');
  assert.ok(save.parameters.jsonBody.includes('result.message_id'));
  assert.ok(save.parameters.jsonBody.includes('saveApprovalMessage'));
  assert.ok(attach.parameters.inlineKeyboard, 'buttons are attached only in a later operation');

  assert.equal(workflow3.connections['Отправить карточку лида'].main[0][0].node, 'Сохранить ID карточки');
  assert.equal(workflow3.connections['Сохранить ID карточки'].main[0][0].node, 'ID карточки сохранён?');
  assert.equal(workflow3.connections['ID карточки сохранён?'].main[0][0].node, 'Добавить кнопки после сохранения');
}

function testAllWorkflowExportsAreValidJson() {
  for (const relative of [
    '../mini-crm/workflow-1-new-lead.json',
    '../mini-crm/workflow-2-reminders.json',
    '../sales-engine/workflow-3-lead-finder.json',
    '../sales-engine/workflow-4-approval-handler.json'
  ]) {
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(__dirname, relative), 'utf8')));
  }
}

testNetlifyJwsAndSignedIntake();
testWorkflow1RequiresRawSignedBodyAndMinimizesTelegram();
testApprovalMessageBinding();
testOwnerAndExactCardAuthorization();
testAllowedTransitionAndIdempotency();
testGetRejectsAllActionsAndPostCarriesToken();
testWorkflow2And3UsePostBodies();
testWorkflow4ValidationAndRouting();
testWorkflow3StoresCardBeforeButtons();
testAllWorkflowExportsAreValidJson();

console.log('All n8n approval security tests passed.');
