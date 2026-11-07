const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateTarget, readTarget, saveTarget } = require('../connection.cjs');
test('packaged client requires HTTPS without embedded credentials or URL tokens', () => {
  assert.equal(validateTarget(' https://corewaste.example/office '), 'https://corewaste.example/office');
  for (const target of ['http://corewaste.example', 'http://localhost:5173', 'file:///etc/passwd', 'javascript:alert(1)', 'https://user:password@example.com', 'https://example.com/?token=secret', 'https://example.com/#token', 'invalid']) {
    assert.throws(() => validateTarget(target), undefined, target);
  }
  assert.equal(validateTarget('http://localhost:5173/office', true), 'http://localhost:5173/office');
  assert.throws(() => validateTarget('http://corewaste.example', true));
  assert.throws(() => validateTarget('http://localhost.evil.example', true));
});
test('connection persists locally, missing or malformed settings return setup', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'corewaste-connection-'));
  try {
    assert.equal(readTarget(directory), '');
    saveTarget(directory, 'https://corewaste.example/office');
    assert.equal(readTarget(directory), 'https://corewaste.example/office');
    saveTarget(directory, 'https://other.example/office');
    assert.equal(readTarget(directory), 'https://other.example/office');
    fs.writeFileSync(path.join(directory, 'connection.json'), '{bad json');
    assert.equal(readTarget(directory), '');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
