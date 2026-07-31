const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    getState: () => ipcRenderer.invoke('get-state'),
    getSources: () => ipcRenderer.invoke('get-sources'),
    selectSource: (id) => ipcRenderer.invoke('select-source', id),
    saveFrame: (buf) => ipcRenderer.invoke('save-frame', buf),
    openDataset: () => ipcRenderer.invoke('open-dataset'),
    reportCapture: (info) => ipcRenderer.invoke('report-capture', info),
    onState: (cb) => {
        const handler = (_e, state) => cb(state);
        ipcRenderer.on('state', handler);
        return () => ipcRenderer.removeListener('state', handler);
    },
    isSelfTest: () => ipcRenderer.invoke('is-selftest'),

    // Mode + bbox editor. All disk access stays in main; the renderer only ever
    // sees a data: URL and plain box objects.
    getMode: () => ipcRenderer.invoke('get-mode'),
    setMode: (mode) => ipcRenderer.invoke('set-mode', mode),
    labelPickFolder: () => ipcRenderer.invoke('label-pick-folder'),
    labelScanFolder: (dir) => ipcRenderer.invoke('label-scan-folder', dir),
    labelReadImage: (imagePath) => ipcRenderer.invoke('label-read-image', imagePath),
    labelReadBoxes: (imagePath) => ipcRenderer.invoke('label-read-boxes', imagePath),
    labelWriteBoxes: (imagePath, boxes) => ipcRenderer.invoke('label-write-boxes', imagePath, boxes)
});
