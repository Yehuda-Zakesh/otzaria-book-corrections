export function createRpcCall(host, { interval = 20, retryDelay = 100, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  let queue = Promise.resolve();
  async function invoke(method, args) {
    for (let attempt = 0; attempt < 4; attempt++) {
      let result;
      try { result = await host.call(method, args); }
      catch (error) {
        if (error.code !== 'error.rate_limited' && error.message !== 'Rate limit exceeded') throw error;
        result = { success: false, error: { code: 'error.rate_limited' } };
      }
      if (result.success) return result.data;
      const code = result.error?.code?.replace(/^error\./, '');
      if (code === 'rate_limited' && attempt < 3) { await sleep(retryDelay * (attempt + 1)); continue; }
      const error = new Error(code === 'permission_denied'
        ? 'חסרה הרשאה לתוסף. הפעילו אותה בניהול התוספים.'
        : code === 'rate_limited' ? 'אוצריא מגבילה זמנית את קצב הבקשות. נסו שוב בעוד רגע.'
        : result.error?.message ?? 'הפעולה נכשלה.');
      error.code = result.error?.code;
      throw error;
    }
  }
  return (method, args = {}) => {
    // Content chunks are explicitly exempt in the host; section maps and writes are not.
    if (method === 'library.getBookContent') return invoke(method, args);
    const request = queue.catch(() => {}).then(() => invoke(method, args));
    queue = request.catch(() => {}).then(() => sleep(interval));
    return request;
  };
}
