const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // data
  getBible: () => ipcRenderer.invoke('bible:get'),
  getHeadings: () => ipcRenderer.invoke('headings:get'),
  getVersions: () => ipcRenderer.invoke('version:get'),
  setVersion: (id) => ipcRenderer.invoke('version:set', id),
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

  // AI helper
  aiStatus: () => ipcRenderer.invoke('ai:status'),
  aiSetProvider: (provider) => ipcRenderer.invoke('ai:setProvider', provider),
  aiSetOllamaModel: (model) => ipcRenderer.invoke('ai:setOllamaModel', model),
  aiSetKey: (key) => ipcRenderer.invoke('ai:setKey', key),
  aiClearKey: () => ipcRenderer.invoke('ai:clearKey'),
  aiExplain: (payload) => ipcRenderer.invoke('ai:explain', payload),
  aiAsk: (payload) => ipcRenderer.invoke('ai:ask', payload),
  aiPlan: (prompt) => ipcRenderer.invoke('ai:plan', prompt),

  // events pushed from the main process (tray menu, etc.)
  onNavigate: (cb) => ipcRenderer.on('navigate', (_e, view) => cb(view)),
  onDataChanged: (cb) => ipcRenderer.on('data:changed', () => cb()),
});
