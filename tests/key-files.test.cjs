const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runInNewContext } = require('node:vm');

// workflow 内のスクリプトそのものを、一時的な git リポジトリに対して動かす。
const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/betterleaks.yml'), 'utf8');
const script = workflow.split('// BEGIN key-file-check\n')[1].split('// END key-file-check')[0]
  .replace(/^ {12}/gm, '');

const gitEnv = {
  ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com',
};
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();
}
function write(dir, file, content = 'x') {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
}
function commit(dir, message) {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--allow-empty', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'key-files-'));
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, 'README.md');
  // 既存の鍵ファイルは、PR で触らない限り検出しない。
  write(dir, 'app/development.keystore');
  const base = commit(dir, 'base');
  git(dir, 'switch', '-q', '-c', 'feature');
  return { dir, base };
}

async function run(cwd, env) {
  const result = { failed: [], errors: [], warnings: [], summary: undefined };
  const core = {
    setFailed: (message) => result.failed.push(message),
    error: (message, properties) => result.errors.push({ message, properties }),
    warning: (message) => result.warnings.push(message),
    summary: { addRaw(value) { result.summary = value; return this; }, async write() {} },
  };
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    await runInNewContext('(async () => {\n' + script + '\n})()', {
      require, Buffer, core, process: { env: { ...gitEnv, ...env } },
    });
  } finally {
    process.chdir(previous);
  }
  return result;
}

test('no key files passes without output', async () => {
  const { dir, base } = repo();
  write(dir, 'src/app.rb');
  const head = commit(dir, 'normal change');
  const result = await run(dir, { BASE_SHA: base, HEAD_SHA: head });
  assert.deepEqual(result.failed, []);
  assert.equal(result.summary, undefined);
});

test('added, modified, renamed and later deleted key files fail', async () => {
  const { dir, base } = repo();
  write(dir, 'certs/push.p12');
  write(dir, 'android/release.JKS');
  write(dir, 'notes.txt');
  const added = commit(dir, 'add');
  write(dir, 'app/development.keystore', 'changed');
  const modified = commit(dir, 'modify');
  git(dir, 'mv', 'certs/push.p12', 'certs/apns.pfx');
  const renamed = commit(dir, 'rename');
  git(dir, 'rm', '-q', 'android/release.JKS');
  const head = commit(dir, 'delete');
  const result = await run(dir, { BASE_SHA: base, HEAD_SHA: head });
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0], /4 件/);
  assert.deepEqual(result.errors.map((error) => error.properties.file).sort(),
    ['android/release.JKS', 'app/development.keystore', 'certs/apns.pfx', 'certs/push.p12']);
  for (const entry of [added + ':certs/push.p12', added + ':android/release.JKS',
    modified + ':app/development.keystore', renamed + ':certs/apns.pfx']) {
    assert.ok(result.summary.includes(entry + ':binary-key-file:0'), entry);
  }
  assert.ok(!result.summary.includes('notes.txt'));
});

test('only exact per-commit entries in the ignore file exclude a finding', async () => {
  const { dir, base } = repo();
  write(dir, 'a.p12');
  write(dir, 'b.p12');
  const added = commit(dir, 'add');
  write(dir, '.betterleaksignore', [
    '# 開発用',
    added + ':a.p12:binary-key-file:0',
    'b.p12:binary-key-file:0',
  ].join('\n'));
  const head = commit(dir, 'ignore');
  const result = await run(dir, { BASE_SHA: base, HEAD_SHA: head });
  assert.deepEqual(result.errors.map((error) => error.properties.file), ['b.p12']);
  // パスだけの除外は受け付けない。同じパスで本物の鍵に差し替えられても検出するため。
  write(dir, '.betterleaksignore', added + ':a.p12:binary-key-file:0\n' + added + ':b.p12:binary-key-file:0\n');
  write(dir, 'b.p12', 'replaced');
  const replaced = commit(dir, 'replace');
  const again = await run(dir, { BASE_SHA: base, HEAD_SHA: replaced });
  assert.deepEqual(again.errors.map((error) => error.properties.file), ['b.p12']);
  assert.ok(again.summary.includes(replaced + ':b.p12:binary-key-file:0'));
});

test('falls back to .gitleaksignore like Betterleaks', async () => {
  const { dir, base } = repo();
  write(dir, 'a.jks');
  const added = commit(dir, 'add');
  write(dir, '.gitleaksignore', added + ':a.jks:binary-key-file:0\n');
  const head = commit(dir, 'ignore');
  assert.deepEqual((await run(dir, { BASE_SHA: base, HEAD_SHA: head })).failed, []);
});

test('merging the base branch does not report key files that are already there', async () => {
  const { dir, base } = repo();
  write(dir, 'src/app.rb');
  commit(dir, 'feature');
  git(dir, 'switch', '-q', 'main');
  write(dir, 'legacy.bks');
  const newBase = commit(dir, 'base adds key');
  git(dir, 'switch', '-q', 'feature');
  git(dir, 'merge', '-q', '--no-edit', 'main');
  const head = git(dir, 'rev-parse', 'HEAD');
  assert.notEqual(base, newBase);
  assert.deepEqual((await run(dir, { BASE_SHA: newBase, HEAD_SHA: head })).failed, []);
});

test('untrusted file names are escaped and invalid inputs fail closed', async () => {
  const { dir, base } = repo();
  write(dir, 'x/<img src=a>`|@everyone\n.p12');
  const head = commit(dir, 'add');
  const result = await run(dir, { BASE_SHA: base, HEAD_SHA: head });
  assert.equal(result.failed.length, 1);
  assert.ok(!result.summary.includes('<img'));
  assert.ok(!result.summary.includes('@everyone'));
  for (const env of [{ BASE_SHA: 'main', HEAD_SHA: head }, { BASE_SHA: base, HEAD_SHA: '' },
    { BASE_SHA: base, HEAD_SHA: 'f'.repeat(40) }]) {
    const invalid = await run(dir, env);
    assert.equal(invalid.failed.length, 1);
    assert.match(invalid.failed[0], /完了できませんでした/);
  }
  fs.symlinkSync('/etc/hosts', path.join(dir, '.betterleaksignore'));
  assert.match((await run(dir, { BASE_SHA: base, HEAD_SHA: head })).failed[0], /完了できませんでした/);
});

test('works in a blobless clone without fetching file contents', async () => {
  const { dir: source, base } = repo();
  write(source, 'a.keystore');
  write(source, 'big.txt', 'y'.repeat(100000));
  const head = commit(source, 'add');
  git(source, 'config', 'uploadpack.allowFilter', 'true');
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'key-files-clone-'));
  git(clone, 'clone', '-q', '--filter=blob:none', '--no-checkout', 'file://' + source, '.');
  git(clone, 'fetch', '-q', 'origin', 'feature');
  // リモートに取りに行けば失敗するようにしておく。
  git(clone, 'remote', 'set-url', 'origin', 'file:///nonexistent');
  const result = await run(clone, { BASE_SHA: base, HEAD_SHA: head });
  assert.deepEqual(result.errors.map((error) => error.properties.file), ['a.keystore']);
});
