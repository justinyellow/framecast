// Recording happens in a Framecast tab (getDisplayMedia needs a page), so the extension just opens it.
const PATHS = { record: '/record', screenshot: '/screenshot', library: '/app' };

async function open(kind) {
  const { server } = await chrome.storage.sync.get('server');
  if (!server) return chrome.runtime.openOptionsPage();
  await chrome.windows.create({ url: `${server.replace(/\/$/, '')}${PATHS[kind]}`, type: 'popup', width: 900, height: 820 });
}

chrome.commands.onCommand.addListener(open);
chrome.runtime.onMessage.addListener((msg) => { if (PATHS[msg.open]) open(msg.open); });
