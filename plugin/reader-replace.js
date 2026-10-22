import { planReplacements } from './find-replace.js';

// The native API supplies the field text only when its button is clicked.
// It cannot add an input or rename the native search field. Keep both phases
// explicit, bound to the exact book/tab/session, and require final confirmation.
export function createReaderReplacement({ call, controller, loader, confirm, notify,
  now = () => Date.now(), lifetime = 120000 }) {
  let remembered = null, active = null, generation = 0;
  const cancelled = new Map();
  function cancelQueued(sessionId) {
    cancelled.set(sessionId, remembered);
    if (cancelled.size > 50) cancelled.delete(cancelled.keys().next().value);
  }
  async function context() {
    const state = await call('reader.getCurrentState');
    const tab = state?.openTabs?.find(tab => tab.tabId === state.currentTabId);
    const result = { tabId: state?.currentTabId, bookUid: state?.bookUid ?? tab?.bookUid,
      bookId: state?.currentBookId ?? tab?.bookId ?? '',
      type: state?.currentType ?? tab?.type, correctionSessionId: state?.currentCorrectionSessionId ?? tab?.correctionSessionId };
    if (!result.tabId || !result.bookUid || result.type !== 'text') {
      throw new Error('חיפוש והחלפה זמינים רק בספר טקסט פתוח ומזוהה.');
    }
    return result;
  }
  const same = (a, b) => a.tabId === b.tabId && a.bookUid === b.bookUid;
  async function end(sessionId) { await call('search.endFieldSession', { sessionId }).catch(() => {}); }
  return {
    async invoked(event) {
      if (event?.actionId !== 'replace-in-book' || event.field !== 'inBook') return;
      if (cancelled.has(event.sessionId)) {
        if (remembered === cancelled.get(event.sessionId)) remembered = null;
        cancelled.delete(event.sessionId);
        await end(event.sessionId); notify('מצב ההחלפה בוטל. התחילו מחדש עם הטקסט לחיפוש.'); return;
      }
      const token = ++generation;
      active = { sessionId: event.sessionId, phase: remembered ? 'apply' : 'remember' };
      const check = () => { if (token !== generation) throw new Error('הפעולה בוטלה כי שדה החיפוש השתנה או נסגר.'); };
      try {
        const current = await context(); check();
        if (!remembered) {
          if (typeof event.text !== 'string' || !event.text.trim() || event.text.length > 500 || /[\r\n]/.test(event.text)) {
            throw new Error('כתבו בתיבת החיפוש מילה או ביטוי מדויק לחיפוש (עד 500 תווים), ולחצו על הכפתור.');
          }
          const snapshot = current.correctionSessionId ? await controller.inspect(current.correctionSessionId) : await controller.begin(current.tabId);
          check();
          remembered = { ...current, sessionId: snapshot.sessionId, query: event.text, at: now(), fieldSessionId: event.sessionId };
          await call('search.setFieldActionState', { sessionId: event.sessionId, state: 'active',
            tooltip: 'בחרו את כל הטקסט בשדה, כתבו את החלופה ולחצו שוב. לחיצה בלי עריכה מבטלת.' }).catch(error => {
              if (error?.code !== 'error.not_found') throw error; // User already started typing the alternative.
            });
          notify(`נשמר החיפוש המדויק „${event.text}” בספר „${snapshot.bookId}”. כעת בחרו את כל הטקסט בתיבת החיפוש, הקלידו את החלופה ולחצו שוב על כפתור ההחלפה. שדה החיפוש עדיין משמש גם לחיפוש הרגיל. להחלפה במחיקה אפשר להשאיר אותו ריק.`);
          return;
        }
        const request = remembered; remembered = null;
        if (!same(current, request) || current.correctionSessionId !== request.sessionId || now() - request.at > lifetime) {
          throw new Error('הספר, הלשונית או סשן העריכה השתנו, או שחלף זמן ההמתנה. התחילו מחדש עם הטקסט לחיפוש.');
        }
        if (typeof event.text !== 'string') throw new Error('לא התקבל טקסט חלופי משדה החיפוש.');
        await call('search.setFieldActionState', { sessionId: event.sessionId, state: 'busy', tooltip: 'מכין תצוגת החלפה לאישור' });
        const snapshot = await controller.inspect(request.sessionId);
        const book = await loader.load(snapshot);
        const latest = await controller.inspect(request.sessionId); check();
        const plan = planReplacements(book, latest, { query: request.query, replacement: event.text, wholeWords: true });
        if (!plan.occurrences) { notify('לא נמצאו התאמות מדויקות להחלפה. לא נעשה שינוי.'); return; }
        if (!same(await context(), request)) throw new Error('הספר או הלשונית השתנו. לא נעשה שינוי.');
        check();
        if (!await confirm('החלפת כל ההתאמות בספר', `להחליף ${plan.occurrences} התאמות ב־${plan.previews.length} פסקאות בספר „${plan.bookId}”?\n\nחיפוש מדויק של מילים שלמות: ${plan.query.slice(0, 200)}\nהחלפה: ${event.text ? event.text.slice(0, 200) : '(מחיקה)'}\n\nהנוסח יעודכן בטיוטת הקורא בלבד. דיווחים לא יישלחו.`)) {
          notify('ההחלפה בוטלה. לא נעשה שינוי.'); return;
        }
        check();
        if (!same(await context(), request)) throw new Error('הספר או הלשונית השתנו בזמן האישור. לא נעשה שינוי.');
        check();
        const result = await controller.applyReplacements(plan);
        notify(`${plan.occurrences} החלפות הוחלו בקורא${result.saved ? ' ונשמרו בתוסף' : ' וממתינות לשמירת הטיוטה באוצריא'}. לא נשלחו דיווחים.`);
      } catch (error) {
        remembered = null; loader.clear();
        throw error;
      } finally {
        if (!remembered) { await end(event.sessionId); if (active?.sessionId === event.sessionId) active = null; }
      }
    },
    async stop(event) {
      if (active?.sessionId !== event?.sessionId) {
        if (event?.actionId === 'replace-in-book' && event.sessionId) { cancelQueued(event.sessionId); await end(event.sessionId); }
        return;
      }
      remembered = null; active = null; generation++;
      await end(event.sessionId); notify('מצב ההחלפה בוטל. לא נעשה שינוי.');
    },
    ended(event) {
      if (active?.sessionId !== event?.sessionId) {
        if (event?.actionId === 'replace-in-book' && event.sessionId && event.reason !== 'plugin') cancelQueued(event.sessionId);
        return;
      }
      // Typing the alternative ends phase one's native field session. Retain
      // only the remembered search; the next click creates a new native lease.
      if (event.reason === 'edited' && active.phase === 'remember') { active = null; return; }
      remembered = null; active = null; generation++;
    }
  };
}
