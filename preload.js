const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // data
  getBible: () => ipcRenderer.invoke('bible:get'),
  getHeadings: () => ipcRenderer.invoke('headings:get'),
  getTodayPlan: () => ipcRenderer.invoke('plan:today'),
  getStats: () => ipcRenderer.invoke('stats:get'),
  getTodayStatus: () => ipcRenderer.invoke('today:status'),
  getChaptersReadToday: () => ipcRenderer.invoke('today:chapters'),
  getReadChapters: () => ipcRenderer.invoke('chapters:read'),
  markChaptersRead: (labels) => ipcRenderer.invoke('chapters:markRead', labels),
  unmarkChapters: (labels) => ipcRenderer.invoke('chapters:unmarkRead', labels),

  // actions
  logSession: (payload) => ipcRenderer.invoke('session:log', payload),
  markTodayComplete: () => ipcRenderer.invoke('today:complete'),
  resetProgress: () => ipcRenderer.invoke('progress:reset'),
  setPlanStart: (dateISO) => ipcRenderer.invoke('plan:setStart', dateISO),
  savePlan: (cfg) => ipcRenderer.invoke('plan:save', cfg),
  clearPlan: () => ipcRenderer.invoke('plan:clear'),

  // bookmarks
  toggleBookmark: (payload) => ipcRenderer.invoke('bookmark:toggle', payload),
  removeBookmark: (ref) => ipcRenderer.invoke('bookmark:remove', ref),
  getBookmarks: () => ipcRenderer.invoke('bookmark:list'),

  // events pushed from the main process (tray menu, etc.)
  onNavigate: (cb) => ipcRenderer.on('navigate', (_e, view) => cb(view)),
  onDataChanged: (cb) => ipcRenderer.on('data:changed', () => cb()),
});
