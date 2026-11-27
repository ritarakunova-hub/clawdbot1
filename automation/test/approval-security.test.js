const assert = require('node:assert/strict');
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

function makeHarness(initialStatus = 'На рассмотрении') {
  const headers = [
    'ID',
    'Статус',
    'Telegram Chat ID',
    'Telegram Message ID'
  ];
  const rows = [
    headers,
    [42, initialStatus, '', '']
  ];
  const scriptProperties = {
    WEBHOOK_TOKEN: 'synthetic-test-token',
    TELEGRAM_APPROVER_USER_ID: '777',
    TELEGRAM_CHAT_ID: '123456'
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
      formatDate(date, _timezone, pattern) {
        if (pattern === 'yyyy-MM-dd') return date.toISOString().slice(0, 10);
        return date.toISOString();
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

function testGetCannotMutateStatus() {
  const h = makeHarness();
  assert.equal(output(h.context.saveApprovalMessage('42', '123456', '9001')).ok, true);
  const result = output(h.context.doGet({
    parameter: {
      action: 'updateStatus',
      token: 'synthetic-test-token',
      id: '42',
      status: 'Одобрено'
    }
  }));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'status_update_requires_post');
  assert.equal(h.rows[1][1], 'На рассмотрении');
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

testApprovalMessageBinding();
testOwnerAndExactCardAuthorization();
testAllowedTransitionAndIdempotency();
testGetCannotMutateStatus();
testWorkflow4ValidationAndRouting();
testWorkflow3StoresCardBeforeButtons();
testAllWorkflowExportsAreValidJson();

console.log('All n8n approval security tests passed.');
