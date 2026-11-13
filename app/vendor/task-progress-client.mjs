// Embedded in the generated page so progress also works when opened offline.
export function progressClient() {
  const API = 'http://127.0.0.1:19008/api/task-progress', KEY = 'goals:task-progress:pending';
  let pending = {}, busy = false, browserSaved = true;
  const notice = document.createElement('p'); notice.className = 'gr-progress-notice'; notice.setAttribute('role', 'status');
  document.querySelector('section#now')?.prepend(notice);
  try { pending = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch {}
  function paint(task, status) {
    for (const el of document.querySelectorAll('[data-task]')) {
      if (el.dataset.task !== task) continue;
      el.dataset.progress = status;
      el.querySelector('.gr-progress-label').textContent = status === 'done' ? 'Done' : status === 'started' ? 'In progress' : '';
      el.querySelector('[data-status="started"]').disabled = status === 'started';
      el.querySelector('[data-status="done"]').disabled = status === 'done';
      el.querySelector('[data-status="todo"]').hidden = status === 'todo';
    }
  }
  function arrange() {
    for (const list of document.querySelectorAll('.gr-cards:not(.gr-completed-list)')) {
      const cards = [...list.querySelectorAll(':scope > .gr-card, :scope > .gr-done-group .gr-card')];
      if (!cards.some(c => c.dataset.task)) continue;
      let group = list.querySelector(':scope > .gr-done-group');
      if (!group) {
        group = document.createElement('li'); group.className = 'gr-done-group';
        group.innerHTML = '<details><summary>Done tasks</summary><ul class="gr-cards gr-completed-list"></ul></details>';
        list.append(group);
      }
      cards.filter(c => c.dataset.progress !== 'done').sort((a,b) => +a.dataset.order - +b.dataset.order).forEach(c => list.insertBefore(c, group));
      const done = cards.filter(c => c.dataset.progress === 'done');
      done.forEach(c => group.querySelector('ul').append(c));
      group.hidden = !done.length;
    }
  }
  for (const [task, status] of Object.entries(pending)) paint(task, status);
  arrange();
  async function sync() {
    if (busy || !Object.keys(pending).length) return;
    busy = true;
    let failed = false;
    try {
      for (const [task, status] of Object.entries(pending)) {
        const response = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task, status }), signal: AbortSignal.timeout(70000) });
        if (!response.ok) throw new Error('Save refused');
        const result = await response.json();
        if (pending[task] === status) delete pending[task];
        try { localStorage.setItem(KEY, JSON.stringify(pending)); browserSaved = true; } catch {}
        notice.textContent = result.rebuilt ? 'Saved and page rebuilt.' : 'Saved, updates within the hour.';
      }
    } catch { failed = true; notice.textContent = browserSaved ? 'Saved in this browser, updates within the hour when connected. Keep this page open to retry.' : 'Not saved yet. Browser storage and the helper are unavailable. Keep this page open to retry.'; }
    finally { busy = false; if (!failed && Object.keys(pending).length) void sync(); }
  }
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-status]'); if (!button) return;
    const task = button.closest('[data-task]').dataset.task, status = button.dataset.status;
    pending[task] = status;
    try { localStorage.setItem(KEY, JSON.stringify(pending)); browserSaved = true; }
    catch { browserSaved = false; }
    paint(task, status); arrange();
    if (status === 'done') button.closest('.gr-done-group')?.querySelector('summary')?.focus();
    if (status === 'todo') button.closest('[data-task]').querySelector('[data-status="started"]').focus();
    notice.textContent = 'Saving...'; void sync();
  });
  window.addEventListener('online', sync);
  setInterval(sync, 30000);
  void sync();
}
