const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    getConfig: () => ipcRenderer.invoke('get-config'),
    setHz: (hz) => ipcRenderer.invoke('set-hz', hz),
    setContentProtection: (on) => ipcRenderer.invoke('set-content-protection', on),
    onTick: (cb) => ipcRenderer.on('tick', (_e, value) => cb(value)),
    onEngineEvent: (cb) => ipcRenderer.on('engine', (_e, value) => cb(value)),
    onPick: (cb) => ipcRenderer.on('pick', (_e, value) => cb(value)),
    onMode: (cb) => ipcRenderer.on('mode', (_e, value) => cb(value)),
    run: {
        state: () => ipcRenderer.invoke('run:state'),
        start: (opts) => ipcRenderer.invoke('run:start', opts),
        stop: () => ipcRenderer.invoke('run:stop'),
        saveRoute: (patch) => ipcRenderer.invoke('route:save', patch),
        resetTimings: () => ipcRenderer.invoke('route:reset-timings'),
        armPick: () => ipcRenderer.invoke('pick:arm'),
        disarmPick: () => ipcRenderer.invoke('pick:disarm'),
        setAutoRepair: (on) => ipcRenderer.invoke('auto:set', on),
        autoStats: () => ipcRenderer.invoke('auto:stats'),
        telemetryStats: () => ipcRenderer.invoke('telemetry:stats'),
        setMode: (mode) => ipcRenderer.invoke('run:set-mode', mode),
        testBreak: (kind) => ipcRenderer.invoke('run:test-break', kind),
        dailyPlan: () => ipcRenderer.invoke('run:daily-plan'),
        testRepair: () => ipcRenderer.invoke('auto:test'),
        abortRepair: () => ipcRenderer.invoke('auto:abort')
    }
});
