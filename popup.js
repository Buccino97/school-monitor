const $ = id => document.getElementById(id);
async function load() {
  const c = await chrome.storage.local.get(['serverUrl', 'roomCode', 'studentName']);
  $('server').value = c.serverUrl || '';
  $('room').value = c.roomCode || '';
  $('name').value = c.studentName || '';
}
 $('save').onclick = async () => {
  await chrome.storage.local.set({
    serverUrl: $('server').value.trim().replace(/\/+$/, ''),
    roomCode: $('room').value.trim().toUpperCase(),
    studentName: $('name').value.trim()
  });
  chrome.runtime.reload();
  window.close();
};
 $('hand').onclick = () => {
  chrome.runtime.sendMessage({ target: 'background', type: 'raise_hand' });
  $('status').textContent = 'Mano alzata!';
};
load();
