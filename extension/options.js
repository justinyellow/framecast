const input = document.getElementById('server');
chrome.storage.sync.get('server').then(({ server }) => { input.value = server || ''; });
document.getElementById('save').onclick = async () => {
  const v = input.value.trim().replace(/\/$/, '');
  if (!/^https?:\/\//.test(v)) { document.getElementById('msg').textContent = 'Enter a full URL'; return; }
  await chrome.storage.sync.set({ server: v });
  document.getElementById('msg').textContent = 'Saved';
};
