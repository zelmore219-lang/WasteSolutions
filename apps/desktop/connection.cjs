const fs = require('node:fs');
const path = require('node:path');
function validateTarget(value, development = false) {
  const url = new URL(String(value).trim());
  if (url.username || url.password) throw new Error('Use a server address without a username or password.');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(development && local && url.protocol === 'http:')) {
    throw new Error('Enter an HTTPS CoreWaste address.');
  }
  if (url.search || url.hash) throw new Error('Use a server address without query parameters or a fragment.');
  return url.href;
}
function readTarget(directory) {
  try { return JSON.parse(fs.readFileSync(path.join(directory, 'connection.json'), 'utf8')).url || ''; }
  catch { return ''; }
}
function saveTarget(directory, url) {
  fs.mkdirSync(directory, { recursive: true });
  const destination = path.join(directory, 'connection.json');
  fs.writeFileSync(destination + '.tmp', JSON.stringify({ url }), { mode: 0o600 });
  fs.renameSync(destination + '.tmp', destination);
}
module.exports = { validateTarget, readTarget, saveTarget };
