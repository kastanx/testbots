const { spawn } = require('child_process');
const { mouse, Point, Button } = require('@nut-tree-fork/nut-js');
const fs = require('fs');
const readline = require('readline');
const { ReplayHumanizer } = require('./humanizer');

let recording = false;
let replaying = false;
let paused = false;
let events = [];
let startTime = 0;
let replayIndex = 0;
let swiftProcess = null;
let playlist = []; // Array of recording objects to play
let playlistMode = false;

const RECORDINGS_FILE = 'recordings.json';

console.log("Click Recorder CLI (Global Hotkeys)");
console.log("------------------");
console.log("Press 'r' to start recording (Global)");
console.log("Press 's' to stop recording (Global)");
console.log("Press 'p' to play/pause/resume (Global)");
console.log("Press 'Space' to record click (Global)");
console.log("Press 'q' to save recording (Global)");
console.log("Press 'l' to load recordings (Global)");
console.log("Press Ctrl+C in terminal to quit");
console.log("------------------");

// Helper to sleep
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let isAskingForInput = false;

// Helper for user input
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Legacy randomizePosition kept for reference; replay now uses ReplayHumanizer.
// function randomizePosition(x, y, radius) { ... }

function askQuestion(query) {
    isAskingForInput = true;
    return new Promise(resolve => rl.question(query, (ans) => {
        isAskingForInput = false;
        resolve(ans);
    }));
}

function loadAllRecordings() {
    if (fs.existsSync(RECORDINGS_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(RECORDINGS_FILE, 'utf8'));
        } catch (e) {
            console.error("Error reading recordings file:", e);
            return [];
        }
    }
    return [];
}

function saveRecordingToFile(name, events) {
    const recordings = loadAllRecordings();
    const newRecording = {
        id: Date.now().toString(),
        name: name,
        events: events
    };
    recordings.push(newRecording);
    fs.writeFileSync(RECORDINGS_FILE, JSON.stringify(recordings, null, 2));
    console.log(`Recording '${name}' saved!`);
}

function startSwiftMonitor() {
    console.log("Spawning Swift input monitor...");
    swiftProcess = spawn('./recorder');
    
    swiftProcess.stdout.on('data', async (data) => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
            const cmd = line.trim();
            if (!cmd) continue;
            
            // Ignore Swift commands if we are asking for user input in terminal
            if (isAskingForInput) return;
            
            if (cmd === 'r') {
                if (!recording && !replaying) {
                    console.log("Recording started... Press Space to record clicks.");
                    recording = true;
                    events = [];
                    startTime = Date.now();
                    playlistMode = false; // Reset playlist mode
                } else {
                    console.log("Ignored 'r': busy");
                }
            } else if (cmd === 's') {
                if (recording) {
                    console.log(`Recording stopped. Captured ${events.length} clicks.`);
                    recording = false;
                } else {
                    console.log("Ignored 's': not recording");
                }
            } else if (cmd === 'p') {
                console.log("DEBUG: 'p' received. PlaylistMode:", playlistMode, "PlaylistLength:", playlist.length);
                if (recording) {
                    console.log("Cannot play while recording. Press 's' to stop first.");
                } else if (playlistMode && playlist.length > 0) {
                    if (!replaying) {
                        startPlaylistReplay();
                    } else {
                        paused = !paused;
                        console.log(paused ? "Paused" : "Resuming...");
                    }
                } else if (events.length === 0) {
                    console.log("No recording found. Press 'r' to record or 'l' to load.");
                } else if (!replaying) {
                    startReplay(events);
                } else {
                    paused = !paused;
                    console.log(paused ? "Paused" : "Resuming...");
                }
            } else if (cmd === 'space') {
                if (recording) {
                    try {
                        const pos = await mouse.getPosition();
                        const timeOffset = Date.now() - startTime;
                        events.push({
                            x: pos.x,
                            y: pos.y,
                            time: timeOffset,
                            button: 0
                        });
                        console.log(`Recorded click at (${pos.x}, ${pos.y}) time: ${timeOffset}ms`);
                    } catch (err) {
                        console.error("Error getting mouse position:", err);
                    }
                }
            } else if (cmd === 'q') {
                if (events.length > 0 && !recording && !replaying) {
                    const name = await askQuestion("Enter name for this recording: ");
                    saveRecordingToFile(name, events);
                } else {
                    console.log("Cannot save: No recording, or currently busy.");
                }
            } else if (cmd === 'l') {
                if (!recording && !replaying) {
                    const recordings = loadAllRecordings();
                    if (recordings.length === 0) {
                        console.log("No saved recordings found.");
                    } else {
                        console.log("Available recordings:");
                        recordings.forEach((rec, index) => {
                            console.log(`${index + 1}. ${rec.name} (${rec.events.length} clicks)`);
                        });
                        
                        const answer = await askQuestion("Enter IDs to load (comma separated, e.g. 1,3): ");
                        const indices = answer.split(',').map(s => parseInt(s.trim()) - 1).filter(i => !isNaN(i) && i >= 0 && i < recordings.length);
                        
                        if (indices.length > 0) {
                            playlist = indices.map(i => recordings[i]);
                            playlistMode = true;
                            console.log(`Loaded ${playlist.length} recordings into playlist. Press 'p' to play randomly.`);
                        } else {
                            console.log("No valid recordings selected.");
                        }
                    }
                }
            } else if (cmd === 'READY') {
                console.log("System Ready. Global hotkeys active.");
            } else if (cmd.startsWith("WARNING")) {
                console.warn(cmd);
            } else {
                console.log(`Swift: ${cmd}`);
            }
        }
    });

    swiftProcess.stderr.on('data', (data) => {
        console.error(`Swift Error: ${data}`);
    });

    swiftProcess.on('close', (code) => {
        console.log(`Swift monitor exited with code ${code}`);
        process.exit(0);
    });
}

async function askSessionSetup() {
    const humanize = await askQuestion("Humanize replay? (y/n, default y): ");
    const useHumanizer = humanize.trim().toLowerCase() !== 'n';
    const durAnswer = await askQuestion("Session duration in minutes (default 120): ");
    const durationMin = parseInt(durAnswer, 10) > 0 ? parseInt(durAnswer, 10) : 120;
    return { useHumanizer, durationMin };
}

async function startReplay(currentEvents) {
    const { useHumanizer, durationMin } = await askSessionSetup();

    replaying = true;
    paused = false;

    // Hard stop after the planned duration
    setTimeout(() => {
        console.log(`\nSession time limit reached (${durationMin}min). Exiting.`);
        process.exit(0);
    }, durationMin * 60_000);

    if (useHumanizer) {
        const humanizer = new ReplayHumanizer({
            profileOverrides: { plannedDurationMinutes: durationMin }
        });
        const p = humanizer.profile;
        console.log(
            `Starting humanized replay (${durationMin}min) | seed: ${humanizer.seed} ` +
            `| style: ${p.tempoStyle} | maxFatigue: ${p.maxFatigue.toFixed(3)}`
        );

        while (replaying) {
            const plan = humanizer.plan(currentEvents);
            const elapsed = (humanizer.sessionElapsed / 60000).toFixed(1);
            console.log(`Loop ${humanizer.loopCount} | session elapsed: ${elapsed}min`);

            await executePlan(plan, currentEvents.length, humanizer);

            if (!replaying) break;

            // Brief inter-loop gap
            await sleep(800 + Math.random() * 400);

            while (paused) await sleep(100);
        }
    } else {
        console.log(`Starting raw replay (${durationMin}min, no humanization)...`);
        let loopCount = 0;

        while (replaying) {
            loopCount++;
            console.log(`Loop ${loopCount}`);

            await executeRaw(currentEvents);

            if (!replaying) break;
            while (paused) await sleep(100);
        }
    }

    replaying = false;
}

async function startPlaylistReplay() {
    const { useHumanizer, durationMin } = await askSessionSetup();

    replaying = true;
    paused = false;

    // Hard stop after the planned duration
    setTimeout(() => {
        console.log(`\nSession time limit reached (${durationMin}min). Exiting.`);
        process.exit(0);
    }, durationMin * 60_000);

    if (useHumanizer) {
        const humanizer = new ReplayHumanizer({
            profileOverrides: { plannedDurationMinutes: durationMin }
        });
        const p = humanizer.profile;
        console.log(
            `Starting humanized playlist (${durationMin}min) | seed: ${humanizer.seed} ` +
            `| style: ${p.tempoStyle} | maxFatigue: ${p.maxFatigue.toFixed(3)}`
        );

        while (replaying) {
            const randomIndex = Math.floor(Math.random() * playlist.length);
            const rec = playlist[randomIndex];

            const plan = humanizer.plan(rec.events);
            const elapsed = (humanizer.sessionElapsed / 60000).toFixed(1);
            console.log(`Loop ${humanizer.loopCount} (${rec.name}) | session elapsed: ${elapsed}min`);

            await executePlan(plan, rec.events.length, humanizer);

            if (!replaying) break;

            // Brief inter-recording gap
            await sleep(800 + Math.random() * 400);

            while (paused) await sleep(100);
        }
    } else {
        console.log(`Starting raw playlist (${durationMin}min, no humanization)...`);
        let loopCount = 0;

        while (replaying) {
            loopCount++;
            const randomIndex = Math.floor(Math.random() * playlist.length);
            const rec = playlist[randomIndex];
            console.log(`Loop ${loopCount} (${rec.name})`);

            await executeRaw(rec.events);

            if (!replaying) break;
            while (paused) await sleep(100);
        }
    }
}

/**
 * Execute raw events with no humanization — exact original timing and positions.
 */
async function executeRaw(rawEvents) {
    for (let i = 0; i < rawEvents.length; i++) {
        if (!replaying) return;
        if (paused) { await sleep(100); i--; continue; }

        const event = rawEvents[i];
        const prevTime = i > 0 ? rawEvents[i - 1].time : 0;
        const waitTime = event.time - prevTime;

        if (waitTime > 0) await sleep(waitTime);

        while (paused) await sleep(100);
        if (!replaying) return;

        try {
            await mouse.setPosition(new Point(event.x, event.y));
            await mouse.click(Button.LEFT);
            console.log(`  Click ${i + 1}/${rawEvents.length} (${event.x}, ${event.y}) wait=${waitTime}ms`);
        } catch (err) {
            console.error("Error performing click:", err);
        }
    }
}

/**
 * Execute a humanised action plan.
 * Pauses can trigger between any two clicks (mid-loop).
 *
 * @param {Array}            plan
 * @param {number}           totalCount
 * @param {ReplayHumanizer}  [humanizer] – if provided, pause checks happen per click
 */
async function executePlan(plan, totalCount, humanizer) {
    let localIndex = 0;

    while (replaying && localIndex < plan.length) {
        if (paused) {
            await sleep(100);
            continue;
        }

        const action = plan[localIndex];

        // --- Wait (humanised delta) ---
        if (action.waitMs > 0) {
            await sleep(Math.round(action.waitMs));
        }

        while (paused) await sleep(100);
        if (!replaying) return;

        // --- Pre-hesitation imperfection ---
        if (action.imperfection && action.imperfection.type === 'pre-hesitation') {
            await sleep(Math.round(action.imperfection.delayMs));
        }

        try {
            await mouse.setPosition(new Point(Math.round(action.x), Math.round(action.y)));

            // --- Delayed-commit imperfection ---
            if (action.imperfection && action.imperfection.type === 'delayed-commit') {
                await sleep(Math.round(action.imperfection.delayMs));
            }

            await mouse.click(Button.LEFT);

            const tag = action.meta.hesitating ? ' [hesitation]' : '';
            const impTag = action.imperfection ? ` [${action.imperfection.type}]` : '';
            console.log(
                `Click ${localIndex + 1}/${totalCount} ` +
                `(${Math.round(action.x)}, ${Math.round(action.y)}) ` +
                `wait=${Math.round(action.waitMs)}ms ` +
                `fatigue=${action.meta.fatigue.toFixed(2)}${tag}${impTag}`
            );

        } catch (err) {
            console.error("Error performing click:", err);
        }

        // --- Check for a natural pause between clicks ---
        if (humanizer) {
            const pause = humanizer.checkPause();
            if (pause.shouldPause) {
                const pauseSec = (pause.durationMs / 1000).toFixed(1);
                console.log(`  ☕ ${pause.type} pause (${pauseSec}s) after click ${localIndex + 1}...`);
                await sleep(Math.round(pause.durationMs));
            }
        }

        localIndex++;
    }
}

startSwiftMonitor();
