'use strict';

// Grab the TABLET's screen straight over adb and write it to a file.
//
// Not a PC screenshot: this is the device's own framebuffer, so it works with
// scrcpy closed, the window moved, or the PC screen locked - and the pixel
// coordinates you read off it are the ones `adb shell input tap` expects.
//
// A helper rather than a documented one-liner because PowerShell's `>` mangles
// binary streams: `adb exec-out screencap -p > x.png` silently writes a corrupt
// PNG on Windows.
//
//   node greenbot/repair/snap.js                 -> writes to the default path
//   node greenbot/repair/snap.js out.png
//   node greenbot/repair/snap.js --serial XYZ out.png

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
let serial = null;
const rest = [];
for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--serial') { serial = args[i + 1]; i += 1; } else rest.push(args[i]);
}

const dest = rest[0] || path.join(os.tmpdir(), 'greenbot-tablet.png');
const adbArgs = (serial ? ['-s', serial] : []).concat(['exec-out', 'screencap', '-p']);

execFile('adb', adbArgs, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 15000 },
    (err, stdout, stderr) => {
        if (err) {
            const text = stderr ? stderr.toString('utf8').trim() : String(err.message);
            console.error(`screencap failed: ${text || 'adb error'}`);
            process.exit(1);
        }
        if (!stdout || stdout.length < 1000) {
            console.error('screencap returned no image - is the device connected and unlocked?');
            process.exit(1);
        }
        // PNG magic, so a truncated or text response is caught here rather than
        // becoming an unreadable file three steps later.
        if (!(stdout[0] === 0x89 && stdout[1] === 0x50 && stdout[2] === 0x4e && stdout[3] === 0x47)) {
            console.error('screencap output is not a PNG');
            process.exit(1);
        }
        fs.writeFileSync(dest, stdout);
        console.log(dest);
        console.log(`${(stdout.length / 1024).toFixed(0)} KiB`);
    });
