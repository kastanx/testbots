const { uIOhook, UiohookKey } = require('uiohook-napi');

console.log("Starting minimal hook test...");

uIOhook.on('keydown', (e) => {
    console.log('Keydown:', e.keycode);
});

uIOhook.on('mousedown', (e) => {
    console.log('Mousedown:', e.button, e.x, e.y);
});

uIOhook.start();
console.log("Hook started. Press keys or click.");
