export function createRpcCall(host, { interval = 20, retryDelay = 100, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const urgent = [], normal = [];
  let running = 0, background = 0, pumping = false;
  let startGate = Promise.resolve(), hasStarted = false;
  function reserveStart() {
    const ready = startGate.then(async () => {
      if (hasStarted) await sleep(interval);
      hasStarted = true;
    });
    startGate = ready.catch(() => {});
    return ready;
  }
  async function invoke(method, args, limited = true) {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (limited) await reserveStart();
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
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (running < 4 && (urgent.length || (background < 3 && normal.length))) {
        const priority = urgent.length > 0;
        const item = (priority ? urgent : normal).shift();
        running++; if (!priority) background++;
        // Space request starts, not completions. Slow library reads cannot
        // occupy the slot reserved for persistence and unsaved-change state.
        invoke(item.method, item.args).then(item.resolve, item.reject).finally(() => {
          running--; if (!priority) background--; pump();
        });
      }
    } finally { pumping = false; }
  }
  return (method, args = {}) => {
    // Content chunks are explicitly exempt in the host; section maps and writes are not.
    if (method === 'library.getBookContent') return invoke(method, args, false);
    return new Promise((resolve, reject) => {
      const priority = method.startsWith('storage.') || method === 'ui.setUnsavedChanges';
      (priority ? urgent : normal).push({ method, args, resolve, reject });
      pump();
    });
  };
}
