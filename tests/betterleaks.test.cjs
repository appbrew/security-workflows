const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runInNewContext } = require('node:vm');

// Test the trusted inline scripts themselves; never load scripts from the scanned repository.
const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/betterleaks.yml'), 'utf8');
function script(name) {
  return workflow.split('// BEGIN ' + name + '\n')[1].split('// END ' + name)[0]
    .replace(/^ {12}/gm, '');
}
const sha = 'a'.repeat(40);
const baseEnv = {
  GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'example/repository',
  GITHUB_RUN_ID: '200', GITHUB_RUN_ATTEMPT: '1', HEAD_SHA: sha,
};
const finding = {
  File: 'config/locales/admin.en.yml', RuleID: 'generic-password', StartLine: 573,
  Commit: sha, Fingerprint: 'UNTRUSTED_FINGERPRINT', Secret: 'SECRET_VALUE', Match: 'RAW_MATCH',
  Fragment: 'RAW_FRAGMENT', Description: 'UNTRUSTED_DESCRIPTION',
};
async function render(report, env = {}, malformed = false) {
  const outputs = {};
  const warnings = [];
  let summary;
  const fakeFs = {
    statSync() { if (report === undefined) throw new Error('Missing'); return { size: 1024 }; },
    readFileSync() { return malformed ? report : JSON.stringify(report); },
  };
  const core = {
    setOutput: (key, value) => { outputs[key] = value; },
    warning: (message) => warnings.push(message),
    summary: { addRaw(value) { summary = value; return this; }, async write() {} },
  };
  await runInNewContext('(async () => {\n' + script('report-renderer') + '\n})()', {
    require: (name) => name === 'node:fs' ? fakeFs : require(name), Buffer, core,
    process: { env: { ...baseEnv, RUNNER_TEMP: '/tmp/test', SCAN_OUTCOME: 'failure', SCAN_EXIT_CODE: '10', ...env } },
  });
  return { ...outputs, summary, warnings };
}

test('findings publish only location metadata and explain normal push', async () => {
  const result = await render([finding]);
  assert.equal(result.state, 'findings');
  assert.match(result.body, /config\/locales\/admin.en.yml:573/);
  assert.match(result.body, new RegExp(sha + ':config/locales/admin.en.yml:generic-password:573'));
  assert.match(result.body, /通常の push/);
  assert.match(result.body, /force-push は不要/);
  assert.match(result.body, /無効化・ローテーション/);
  for (const value of ['SECRET_VALUE', 'RAW_MATCH', 'RAW_FRAGMENT', 'UNTRUSTED_DESCRIPTION', 'UNTRUSTED_FINGERPRINT']) {
    assert.ok(!result.body.includes(value));
  }
  assert.equal(result.summary, result.body);
});

test('clean requires successful scanner and a valid empty report', async () => {
  assert.equal((await render([], { SCAN_OUTCOME: 'success', SCAN_EXIT_CODE: '0' })).state, 'clean');
  for (const [report, outcome, code] of [
    [undefined, 'skipped', ''], [[], 'failure', '1'], [[], 'failure', '10'],
    [[finding], 'failure', '1'], [[finding], 'success', '0'],
    [undefined, 'success', '0'], [{}, 'success', '0'],
  ]) {
    const result = await render(report, { SCAN_OUTCOME: outcome, SCAN_EXIT_CODE: code });
    assert.equal(result.state, 'error');
    assert.match(result.body, /検査を完了できませんでした/);
  }
  assert.equal((await render('SECRET_INVALID_JSON', {}, true)).state, 'error');
});

test('untrusted paths are escaped and malformed fields are rejected', async () => {
  const special = { ...finding, File: 'spec/<img src=x>`|[@everyone](x).yml' };
  const result = await render([special]);
  assert.equal(result.state, 'findings');
  assert.ok(!result.body.includes('<img'));
  assert.ok(!result.body.includes('@everyone'));
  assert.ok(!result.body.includes('[<code>spec/<'));
  assert.match(result.body, /%3Cimg%20src%3Dx%3E/);
  for (const replacement of [{ File: 'a\nb' }, { File: '../outside' }, { Commit: 'bad' }, { RuleID: '<tag>' }, { StartLine: 0 }]) {
    assert.equal((await render([{ ...finding, ...replacement }])).state, 'error');
  }
});

test('large result sets are bounded and explicitly marked as truncated', async () => {
  const result = await render(Array.from({ length: 100 }, (_, i) => ({ ...finding, File: 'file-' + i + '.yml' })));
  assert.match(result.body, /100 件/);
  assert.match(result.body, /先頭 50 件/);
  assert.ok(Buffer.byteLength(result.body) < 50000);
  const large = await render(Array.from({ length: 50 }, () => ({ ...finding, File: 'あ'.repeat(2000) })));
  assert.ok(Buffer.byteLength(large.body) < 50000);
});

const marker = '<!-- betterleaks-report:v1 -->';
function comment(id, run = '100', attempt = '1', user = { type: 'Bot', login: 'github-actions[bot]' }) {
  return { id, node_id: 'NODE_' + id, user, body: marker + '\n<!-- betterleaks-run:' + run + ':' + attempt + ' -->\nold' };
}
async function publish({ state = 'findings', comments = [], heads = [sha], closed = false, createFails = false, minimizeFails = false, env = {} } = {}) {
  const calls = [];
  const warnings = [];
  let headIndex = 0;
  const github = {
    rest: {
      pulls: { async get() { return { data: { state: closed ? 'closed' : 'open', head: { sha: heads[Math.min(headIndex++, heads.length - 1)] } } }; } },
      issues: {
        listComments() {},
        async createComment(args) { calls.push(['create', args]); if (createFails) throw new Error('Forbidden'); },
      },
    },
    async paginate() { return comments; },
    async graphql(query, args) { calls.push(['minimize', args]); if (minimizeFails) throw new Error('Forbidden'); },
  };
  await runInNewContext('(async () => {\n' + script('report-publisher') + '\n})()', {
    github, core: { warning: (message) => warnings.push(message) },
    context: { repo: { owner: 'example', repo: 'repository' }, payload: { pull_request: { number: 42, head: { sha } } } },
    process: { env: { ...baseEnv, REPORT_STATE: state, REPORT_BODY: 'safe report', ...env } },
  });
  return { calls, warnings };
}

test('new report is created before only our older bot comments are collapsed', async () => {
  const result = await publish({ comments: [comment(1), comment(2, '100', '1', { type: 'User', login: 'human' }),
    { ...comment(3), body: 'another workflow' }, comment(4, '100', '1', { type: 'Bot', login: 'other[bot]' })] });
  assert.deepEqual(result.calls.map(([name]) => name), ['create', 'minimize']);
  assert.equal(result.calls[1][1].id, 'NODE_1');
  assert.equal(result.calls[1][1].classifier, 'OUTDATED');
});

test('successful recheck folds previous reports as resolved without posting noise', async () => {
  const result = await publish({ state: 'clean', comments: [comment(1), comment(2)] });
  assert.deepEqual(result.calls.map(([name, args]) => [name, args.classifier]), [['minimize', 'RESOLVED'], ['minimize', 'RESOLVED']]);
});

test('execution error replaces old report but does not mark it resolved', async () => {
  const result = await publish({ state: 'error', comments: [comment(1)] });
  assert.equal(result.calls[0][0], 'create');
  assert.equal(result.calls[1][1].classifier, 'OUTDATED');
});

test('stale heads, closed PRs, newer reports and missing output cannot mutate comments', async () => {
  for (const args of [{ heads: ['old'] }, { heads: [sha, 'new'] }, { closed: true },
    { comments: [comment(1, '201')] }, { comments: [comment(1, '200', '2')] },
    { state: '' }, { env: { REPORT_BODY: '' } }]) {
    assert.equal((await publish(args)).calls.length, 0);
  }
});

test('retry does not duplicate same run and attempt; a rerun supersedes previous attempt', async () => {
  assert.equal((await publish({ comments: [comment(1, '200')] })).calls.length, 0);
  const result = await publish({ comments: [comment(1, '200')], env: { GITHUB_RUN_ATTEMPT: '2' } });
  assert.deepEqual(result.calls.map(([name]) => name), ['create', 'minimize']);
});

test('posting failure preserves the previous report and points to summary', async () => {
  const result = await publish({ comments: [comment(1)], createFails: true });
  assert.deepEqual(result.calls.map(([name]) => name), ['create']);
  assert.match(result.warnings[0], /Summary/);
  const failedMinimize = await publish({ comments: [comment(1)], minimizeFails: true });
  assert.equal(failedMinimize.warnings.length, 1);
});

test('scanner wrapper keeps findings and runtime errors failing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'betterleaks-wrapper-'));
  try {
    const command = workflow.split('          scan_status=0\n')[1].split('\n\n')[0].replace(/^ {10}/gm, '');
    fs.writeFileSync(path.join(dir, 'betterleaks'), '#!/bin/sh\nexit "$FAKE_SCAN_EXIT"\n', { mode: 0o755 });
    for (const code of [0, 10, 1]) {
      const output = path.join(dir, 'output-' + code);
      const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', 'scan_status=0\n' + command], {
        env: { ...process.env, RUNNER_TEMP: dir, GITHUB_OUTPUT: output, FAKE_SCAN_EXIT: String(code), BASE_SHA: 'base', HEAD_SHA: 'head' },
      });
      assert.equal(result.status, code, result.stderr?.toString());
      assert.equal(fs.readFileSync(output, 'utf8'), 'exit_code=' + code + '\n');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
