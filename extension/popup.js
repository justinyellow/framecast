document.querySelectorAll('[data-open]').forEach((b) => {
  b.onclick = () => { chrome.runtime.sendMessage({ open: b.dataset.open }); window.close(); };
});
document.getElementById('opts').onclick = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
