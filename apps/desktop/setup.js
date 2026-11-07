const field = document.getElementById('server');
const message = document.getElementById('message');
message.textContent = new URLSearchParams(location.search).get('message') || '';
window.corewasteConnection.read().then(({ url }) => { field.value = url; }).catch(() => { message.textContent = 'Could not read connection settings.'; });
document.getElementById('connection').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = document.getElementById('connect');
  button.disabled = true;
  message.textContent = 'Connecting…';
  try {
    const result = await window.corewasteConnection.connect(field.value);
    if (!result.ok) message.textContent = result.message;
  } catch { message.textContent = 'Could not save the connection. Please try again.'; }
  finally { button.disabled = false; }
});
