browser.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== 'lookup') return undefined;
  return YtBpmLookup.lookupBpmFromTitle(message.title, message.channel, fetch).catch((e) => ({
    found: false,
    error: String(e),
    query: YtBpmLookup.parseTitle(message.title, message.channel),
  }));
});
