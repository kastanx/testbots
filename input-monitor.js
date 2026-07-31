// Shared global-hotkey monitor.
//
// Spawns the platform's input watcher and turns its stdout token stream into
// events. Both the CLI (recorder.js) and the Electron app use this.
//
//   - Windows: recorder-win.ps1  (GetAsyncKeyState polling, no native deps)
//   - macOS:   ./recorder        (compiled from recorder.swift, CGEventTap)
//
// Both write one token per line: READY, r, s, p, space, q, l

const { spawn } = require('child_process');
const path = require('path');
const EventEmitter = require('events');

const TOKENS = new Set(['r', 's', 'p', 'space', 'q', 'l']);
const ROOT = __dirname;

function spawnMonitorProcess() {
    if (process.platform === 'win32') {
        return spawn('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy', 'Bypass',
            '-File', path.join(ROOT, 'recorder-win.ps1'),
            '-ParentPid', String(process.pid)
        ], { windowsHide: true });
    }

    if (process.platform === 'darwin') {
        return spawn(path.join(ROOT, 'recorder'));
    }

    return null;
}

/**
 * Emits:
 *   'ready'            monitor is watching the keyboard
 *   'key'   (token)    one of r | s | p | space | q | l
 *   'info'  (line)     DEBUG/WARNING or any other chatter from the monitor
 *   'error' (message)
 *   'close' (code)
 */
class InputMonitor extends EventEmitter {
    constructor() {
        super();
        this.proc = null;
        // While false, keys are swallowed. Used when the user is typing into a
        // prompt or a text field, so hotkeys don't fire on every character.
        this.enabled = true;
    }

    get running() {
        return this.proc !== null;
    }

    start() {
        if (this.proc) return;

        this.proc = spawnMonitorProcess();
        if (!this.proc) {
            this.emit('error', `Unsupported platform: ${process.platform}. No input monitor available.`);
            return;
        }

        this.proc.on('error', (err) => this.emit('error', err.message));

        this.proc.stdout.on('data', (data) => {
            for (const line of data.toString().split('\n')) {
                const token = line.trim();
                if (!token) continue;

                if (token === 'READY') {
                    this.emit('ready');
                } else if (TOKENS.has(token)) {
                    if (this.enabled) this.emit('key', token);
                } else {
                    this.emit('info', token);
                }
            }
        });

        this.proc.stderr.on('data', (data) => this.emit('error', data.toString().trim()));

        this.proc.on('close', (code) => {
            this.proc = null;
            this.emit('close', code);
        });
    }

    stop() {
        if (this.proc && !this.proc.killed) {
            this.proc.kill();
        }
        this.proc = null;
    }
}

module.exports = { InputMonitor, TOKENS };
