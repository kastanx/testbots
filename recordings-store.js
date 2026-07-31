// Read/write recordings.json.
//
// On-disk format is unchanged and shared with the CLI:
//   [{ id, name, events: [{ x, y, time, button }] }]
// `time` is a cumulative offset in ms from the start of the recording.

const fs = require('fs');
const path = require('path');

const RECORDINGS_FILE = path.join(__dirname, 'recordings.json');

function loadAll() {
    if (!fs.existsSync(RECORDINGS_FILE)) return [];
    try {
        const parsed = JSON.parse(fs.readFileSync(RECORDINGS_FILE, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        throw new Error(`Could not read ${RECORDINGS_FILE}: ${e.message}`);
    }
}

// Write via a temp file + rename so a crash mid-write can't truncate the real
// recordings, and keep a .bak of the previous contents.
function saveAll(recordings) {
    const json = JSON.stringify(recordings, null, 2);
    const tmp = RECORDINGS_FILE + '.tmp';

    fs.writeFileSync(tmp, json);
    if (fs.existsSync(RECORDINGS_FILE)) {
        fs.copyFileSync(RECORDINGS_FILE, RECORDINGS_FILE + '.bak');
    }
    fs.renameSync(tmp, RECORDINGS_FILE);
}

// Coerce the fields we rely on, but pass through anything else untouched —
// some existing recordings carry extra per-event flags (e.g. `randomize`).
function normaliseEvents(events) {
    return (Array.isArray(events) ? events : []).map((e) => {
        const { x, y, time, button, ...extra } = e;
        return {
            x: Math.round(Number(x) || 0),
            y: Math.round(Number(y) || 0),
            time: Math.max(0, Math.round(Number(time) || 0)),
            button: Number(button) || 0,
            ...extra
        };
    });
}

function nextId() {
    return Date.now().toString();
}

function create(name, events) {
    const recordings = loadAll();
    const recording = {
        id: nextId(),
        name: name || 'Untitled',
        events: normaliseEvents(events)
    };
    recordings.push(recording);
    saveAll(recordings);
    return recording;
}

function update(id, { name, events }) {
    const recordings = loadAll();
    const index = recordings.findIndex((r) => r.id === id);
    if (index === -1) throw new Error(`No recording with id ${id}`);

    if (typeof name === 'string' && name.trim()) recordings[index].name = name.trim();
    if (events) recordings[index].events = normaliseEvents(events);

    saveAll(recordings);
    return recordings[index];
}

function remove(id) {
    const recordings = loadAll().filter((r) => r.id !== id);
    saveAll(recordings);
    return recordings;
}

function duplicate(id) {
    const recordings = loadAll();
    const source = recordings.find((r) => r.id === id);
    if (!source) throw new Error(`No recording with id ${id}`);

    const copy = {
        id: nextId(),
        name: `${source.name} copy`,
        events: normaliseEvents(source.events)
    };
    recordings.push(copy);
    saveAll(recordings);
    return copy;
}

module.exports = {
    RECORDINGS_FILE,
    loadAll,
    saveAll,
    create,
    update,
    remove,
    duplicate,
    normaliseEvents
};
