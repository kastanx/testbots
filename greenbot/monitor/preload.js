const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    getConfig: () => ipcRenderer.invoke('get-config'),
    setHz: (hz) => ipcRenderer.invoke('set-hz', hz),
    onTick: (cb) => ipcRenderer.on('tick', (_e, value) => cb(value))
});
