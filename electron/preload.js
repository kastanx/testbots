const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

const on = (channel) => (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('api', {
    recordings: {
        list: () => invoke('recordings:list'),
        create: (name, events) => invoke('recordings:create', name, events),
        update: (id, patch) => invoke('recordings:update', id, patch),
        remove: (id) => invoke('recordings:delete', id),
        duplicate: (id) => invoke('recordings:duplicate', id),
        reveal: () => invoke('recordings:reveal'),
        path: () => invoke('recordings:path')
    },
    monitorStatus: () => invoke('monitor:status'),
    screenSize: () => invoke('screen:size'),
    cursor: () => invoke('cursor:get'),
    record: {
        start: () => invoke('record:start'),
        stop: () => invoke('record:stop')
    },
    play: {
        start: (playlist, options) => invoke('play:start', playlist, options),
        stop: () => invoke('play:stop'),
        pause: (paused) => invoke('play:pause', paused)
    },
    setHotkeysEnabled: (enabled) => invoke('hotkeys:enabled', enabled),
    confirm: (options) => invoke('app:confirm', options),

    onRecordState: on('record:state'),
    onPlayEvent: on('play:event'),
    onMonitorState: on('monitor:state'),
    onMonitorInfo: on('monitor:info'),
    onHotkeyPlay: on('hotkey:play'),
    onError: on('app:error')
});
