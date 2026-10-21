import test from 'node:test';
import assert from 'node:assert/strict';
import { plugin, waitFor, createFakeOtzaria, createStorage } from './page-harness.mjs';

async function openReport({ hasEmail = true, response = 'sent', failure = false } = {}) {
  const host = createFakeOtzaria(), storage = createStorage(), reports = [];
  const page = await plugin({ host, storage, sdkOverrides: {
    'feedback.hasReporterEmail': () => hasEmail,
    'feedback.report': args => {
      reports.push(structuredClone(args));
      if (failure) throw Object.assign(new Error('שגיאת שרת לבדיקת QA'), { code: 'error.internal' });
      return response;
    }
  } });
  await waitFor(() => page.rpcCalls.some(({ method }) => method === 'reader.getCurrentState'), 'initialization reached tabs');
  page.el('nav-report').click();
  await waitFor(() => page.rpcCalls.some(({ method }) => method === 'feedback.hasReporterEmail') && !page.el('refresh').disabled, 'report email availability checked');
  return { page, host, reports };
}
const fill = page => {
  page.el('report-details').value = 'תיאור תקלה למפתח בלבד';
  page.el('report-type').value = 'bug';
  for (const handler of page.el('report-details').handlers.input ?? []) handler({ target: page.el('report-details') });
};

for (const response of ['sent', 'queued']) {
  test(`QA: developer feedback ${response} uses feedback.report and clears acknowledged details`, async () => {
    const { page, host, reports } = await openReport({ response });
    fill(page);
    page.el('report-email').value = 'stale-optional@example.com';
    page.el('report-send').click();
    await waitFor(() => reports.length === 1 && !page.el('report-details').disabled, `${response} response handled`);
    assert.equal(reports[0].details, 'תיאור תקלה למפתח בלבד');
    assert.equal(reports[0].reportType, 'bug');
    assert.equal(Object.hasOwn(reports[0], 'reporterEmail'), false, 'saved host email takes precedence over a stale optional field');
    assert.equal(page.el('report-details').value, '');
    assert.equal(host.submissions.size, 0);
    assert.equal(page.rpcCalls.filter(({ method }) => method === 'feedback.submitBookCorrection').length, 0);
    assert.equal(page.rpcCalls.filter(({ method }) => method === 'feedback.sendEmail').length, 0);
    assert.equal(page.rpcCalls.filter(({ method }) => method === 'ui.showConfirm').length, 0, 'feedback.report owns the host confirmation');
    assert.equal(page.el('report-email-area').hidden, true);
    assert.match(page.el('status').textContent, /הדיווח למפתח/);
    fill(page);
    assert.equal(page.el('status').textContent, '', 'new draft does not retain an earlier delivery status');
  });
}

test('QA: cancelling the host confirmation retains developer report wording', async () => {
  const { page, host, reports } = await openReport({ response: 'cancelled' });
  fill(page);
  page.el('report-send').click();
  await waitFor(() => reports.length === 1 && !page.el('report-details').disabled, 'cancelled response handled');
  assert.equal(page.el('report-details').value, 'תיאור תקלה למפתח בלבד');
  assert.equal(host.submissions.size, 0);
  assert.match(page.el('status').textContent, /בוטלה/);
  page.el('nav-work').click();
  assert.equal(page.el('status').textContent, '', 'another screen does not retain the cancelled report status');
});

test('QA: developer reporting failure retains wording and allows retry', async () => {
  const { page, host, reports } = await openReport({ failure: true });
  fill(page);
  page.el('report-send').click();
  await waitFor(() => reports.length === 1 && /שגיאת שרת לבדיקת QA/.test(page.el('status').textContent) && !page.el('report-details').disabled, 'report failure displayed');
  assert.equal(page.el('report-details').value, 'תיאור תקלה למפתח בלבד');
  assert.equal(page.el('report-details').disabled, false);
  assert.equal(host.submissions.size, 0);
});

test('QA: missing saved reporter email shows optional address and passes it only to developer feedback', async () => {
  const { page, reports } = await openReport({ hasEmail: false });
  assert.equal(page.el('report-email-area').hidden, false);
  fill(page);
  page.el('report-email').value = 'qa@example.com';
  page.el('report-send').click();
  await waitFor(() => reports.length === 1 && !page.el('report-details').disabled, 'optional email submitted');
  assert.equal(reports[0].reporterEmail, 'qa@example.com');
});

test('QA: blank developer details are rejected without calling either submission API', async () => {
  const { page, reports } = await openReport();
  page.el('report-details').value = '  \n ';
  page.el('report-type').value = 'bug';
  page.el('report-send').click();
  await waitFor(() => /תיאור|תוכן|פרט/.test(page.el('status').textContent) && !page.el('report-details').disabled, 'blank details validation');
  assert.equal(reports.length, 0);
  assert.equal(page.rpcCalls.filter(({ method }) => method === 'feedback.submitBookCorrection').length, 0);
});

test('QA: object email availability is supported alongside the actual boolean SDK result', async () => {
  for (const hasEmail of [true, false]) {
    const { page } = await openReport({ hasEmail: { hasEmail } });
    assert.equal(page.el('report-email-area').hidden, hasEmail);
  }
});

test('QA: report fields stay locked while the host confirmation or delivery is pending', async () => {
  let finish;
  const response = new Promise(resolve => { finish = resolve; });
  const { page, reports } = await openReport({ hasEmail: false, response });
  fill(page);
  page.el('report-email').value = 'qa@example.com';
  page.el('report-send').click();
  await waitFor(() => reports.length === 1, 'host report awaiting decision');
  assert.equal(page.el('report-details').disabled, true);
  assert.equal(page.el('report-email').disabled, true);
  assert.equal(page.el('report-send').disabled, true);
  finish('sent');
  await waitFor(() => !page.el('report-details').disabled, 'report fields released');
  assert.equal(page.el('report-details').disabled, false);
  assert.equal(page.el('report-email').disabled, false);
  assert.equal(page.el('report-details').value, '');
});

test('QA: navigating away from developer reporting preserves its draft without sending', async () => {
  const { page, reports } = await openReport();
  fill(page);
  page.el('nav-work').click();
  await waitFor(() => page.el('screen-report').hidden, 'report screen hidden');
  page.el('nav-report').click();
  await waitFor(() => !page.el('screen-report').hidden, 'report screen reopened');
  assert.equal(page.el('report-details').value, 'תיאור תקלה למפתח בלבד');
  assert.equal(reports.length, 0);
  assert.equal(page.rpcCalls.filter(({ method }) => method === 'feedback.submitBookCorrection').length, 0);
});
