const { spawn } = require('child_process');
const { mouse, Point, Button } = require('@nut-tree-fork/nut-js');
const fs = require('fs');
const readline = require('readline');

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

function randomizePosition(x, y, radius) {
    const angle = Math.random() * Math.PI * 2;
    const distance = Math.random() * radius;
    const offsetX = Math.cos(angle) * distance;
    const offsetY = Math.sin(angle) * distance;
    return {
        x: x + offsetX,
        y: y + offsetY
    };
}

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

async function startReplay(currentEvents) {
    console.log("Starting replay...");
    replaying = true;
    paused = false;
    replayIndex = 0;
    
    // Use local variable for events to avoid confusion
    const activeEvents = currentEvents;

    while (replaying) {
        if (paused) {
            await sleep(100);
            continue;
        }

        if (replayIndex >= activeEvents.length) {
            console.log("Replay finished.");
            break; 
        }

        const event = activeEvents[replayIndex];
        const prevTime = replayIndex > 0 ? activeEvents[replayIndex - 1].time : 0;
        const waitTime = event.time - prevTime;

        if (waitTime > 0) {
             await sleep(waitTime);
        }
        
        while (paused) {
            await sleep(100);
        }
        
        if (!replaying) break;

        try {
            const randPos = randomizePosition(event.x, event.y, 2);
            await mouse.setPosition(new Point(randPos.x, randPos.y));
            await mouse.click(Button.LEFT);
            console.log(`Replayed click ${replayIndex + 1}/${activeEvents.length} at (${event.x}, ${event.y}) -> Randomized: (${randPos.x.toFixed(0)}, ${randPos.y.toFixed(0)})`);
        } catch (err) {
            console.error("Error performing click:", err);
        }

        replayIndex++;
    }
    replaying = false;
}

async function startPlaylistReplay() {
    console.log("Starting Playlist Replay (Random Order)...");
    replaying = true;
    paused = false;
    
    while (replaying) {
        // Pick random recording
        const randomIndex = Math.floor(Math.random() * playlist.length);
        const recording = playlist[randomIndex];
        console.log(`Playing recording: ${recording.name}`);
        
        // Play it (reuse startReplay logic but we need to wait for it)
        // We can't reuse startReplay directly because it sets global 'replaying' to false at end
        // Let's refactor startReplay to be awaitable and not manage global state fully?
        // Or just inline the logic here or call a helper.
        
        // Actually, let's just call a helper that plays one set of events.
        await playEvents(recording.events);
        
        if (!replaying) break;
        
        console.log("Set finished. Waiting 1s before next set...");
        await sleep(1000);
        
        while (paused) {
            await sleep(100);
        }
    }
}

async function playEvents(eventsToPlay) {
    let localIndex = 0;
    while (replaying && localIndex < eventsToPlay.length) {
        if (paused) {
            await sleep(100);
            continue;
        }
        
        const event = eventsToPlay[localIndex];
        const prevTime = localIndex > 0 ? eventsToPlay[localIndex - 1].time : 0;
        const waitTime = event.time - prevTime;

        if (waitTime > 0) await sleep(waitTime);
        
        while (paused) await sleep(100);
        if (!replaying) return;

        try {
            const randPos = randomizePosition(event.x, event.y, 2);
            await mouse.setPosition(new Point(randPos.x, randPos.y));
            await mouse.click(Button.LEFT);
            console.log(`Click (${event.x}, ${event.y}) -> Randomized: (${randPos.x.toFixed(0)}, ${randPos.y.toFixed(0)})`);
        } catch (err) { console.error(err); }
        
        localIndex++;
    }
}

startSwiftMonitor();
