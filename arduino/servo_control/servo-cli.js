// Command-line control for the ServoCtl servo firmware, built on servo.js.
//
//   node servo-cli.js                         interactive console (HELP, JOG, EXIT)
//   node servo-cli.js A 90                    run commands and exit (servo 1)
//   node servo-cli.js "2:M 0 800; 2:W"        servo 2
//   node servo-cli.js --script moves.txt      run a file of commands
//   node servo-cli.js --list                  show serial ports
//   node servo-cli.js --port COM5 ...         use a specific port
//
// Exit code: 0 = every command answered OK, 1 = one answered ERR, 2 = connection problem.

const fs = require("fs");
const readline = require("readline");
const { ServoBoard, ServoError, listPorts } = require("./servo");

const USAGE = `Usage: node servo-cli.js [--port COMx] [--script FILE | --list | COMMANDS]

  COMMANDS   firmware commands, sent exactly as written. "2:" in front picks servo 2,
             "*:" all servos (X, OFF, ON, C, H, W). Separate several commands with ";"
             and quote them, e.g.  node servo-cli.js "M 0 800; 2:M 180 800; *:W"
  (none)     interactive console. Extras there and in scripts:
             JOG (arrow-key control), SLEEP <ms>, EXIT. "#" starts a comment.

Firmware commands: send HELP, or see README.md.`;

const tty = process.stdout.isTTY;
const paint = (code) => (text) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);
const red = paint(31);
const cyan = paint(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LINK_ERRORS = ["CLOSED", "TIMEOUT", "RESTARTED"];
let exitCode = 0;
const fail = (code) => { exitCode = Math.max(exitCode, code); };

function parseArgs(argv) {
  const opts = { port: undefined, script: undefined, list: false, help: false, words: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") opts.port = argv[++i];
    else if (a === "--script") opts.script = argv[++i];
    else if (a === "--list") opts.list = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else opts.words.push(a);
  }
  return opts;
}

// Sends one firmware command and prints its reply. Ctrl+C while it runs stops every servo.
async function runDevice(board, cmd) {
  const onInterrupt = () => board.stop().catch(() => {});
  process.on("SIGINT", onInterrupt);
  try {
    const text = await board.send(cmd);
    console.log(text ? `OK ${text}` : "OK");
    return true;
  } catch (err) {
    if (!(err instanceof ServoError)) throw err;
    console.log(red(err.reply || `ERR ${err.message}`));
    fail(LINK_ERRORS.includes(err.code) ? 2 : 1);
    return false;
  } finally {
    process.off("SIGINT", onInterrupt);
  }
}

// Arrow keys drive a servo until Esc; number keys switch servos. Keys pressed while a reply
// is pending are dropped, so holding a key down can't pile up a backlog of moves.
async function jog(board) {
  if (!process.stdin.isTTY) {
    console.log(red("JOG needs an interactive terminal."));
    return;
  }
  let servo = board.servo(1);
  let limits = await servo.limits();
  const commands = () => ({
    left: "STEP -1", right: "STEP 1", down: "STEP -10", up: "STEP 10",
    home: `A ${limits.lo}`, end: `A ${limits.hi}`, space: "C", h: "H", r: "OFF", o: "ON",
  });
  const show = (text, paint = (t) => t) =>
    process.stdout.write(`\r${paint(`[servo ${servo.n}] ${text}`.padEnd(78))}`);
  console.log(cyan(`JOG: Left/Right 1 deg, Down/Up 10 deg, Home/End limits, Space center, ` +
                   `H home, R relax, O on, 1-${board.count} pick servo, Esc done`));
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  show("ready");
  await new Promise((resolve) => {
    let busy = false;
    const onKey = async (str, key = {}) => {
      if (["escape", "return", "q"].includes(key.name) || (key.ctrl && key.name === "c")) {
        process.stdin.off("keypress", onKey);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write("\n");
        resolve();
        return;
      }
      if (busy) return;
      const pick = Number(str);
      const cmd = commands()[key.name];
      if (!(pick >= 1 && pick <= board.count) && !cmd) return;
      busy = true;
      try {
        if (pick >= 1 && pick <= board.count) {
          servo = board.servo(pick);
          limits = await servo.limits();
          show(`selected (pin ${servo.pin})`);
        } else {
          show(`OK ${await servo.send(cmd)}`);
        }
      } catch (err) {
        show(err.reply || `ERR ${err.message}`, red);
      } finally {
        busy = false;
      }
    };
    process.stdin.on("keypress", onKey);
  });
}

// Runs one input line: commands separated by ";", "#" starts a comment.
// Returns false when the caller should stop: EXIT, or any failure outside the console.
async function runLine(board, text, interactive) {
  for (const part of text.split("#")[0].split(";")) {
    const cmd = part.trim();
    if (!cmd) continue;
    const [word, ...args] = cmd.split(/\s+/);
    const upper = word.toUpperCase();
    if (upper === "EXIT" || upper === "QUIT") return false;
    if (upper === "JOG") {
      await jog(board);
      continue;
    }
    if (upper === "SLEEP") {
      const ms = Number(args[0]);
      if (args.length === 1 && Number.isFinite(ms) && ms >= 0) {
        await sleep(ms);
        continue;
      }
      console.log(red("ERR use SLEEP <ms>"));
      fail(1);
      if (interactive) continue;
      return false;
    }
    if (!(await runDevice(board, cmd)) && !interactive) return false;
  }
  return true;
}

async function runStream(board, input) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!(await runLine(board, line, false))) {
      rl.close();
      break;
    }
  }
}

// One readline interface per prompt, closed while the command runs, so JOG and Ctrl+C
// get the keyboard to themselves.
async function interactiveConsole(board) {
  const servos = board.servos.map((s) => `servo ${s.n} on pin ${s.pin}`).join(", ");
  console.log(cyan(`Connected to ServoCtl ${board.version} on ${board.path}: ${servos}.\n` +
                   `"2:" in front of a command picks servo 2. HELP lists commands, ` +
                   "JOG = arrow keys, EXIT quits."));
  let history = [];
  for (;;) {
    const rl = readline.createInterface({
      input: process.stdin, output: process.stdout, history, historySize: 200,
    });
    const line = await new Promise((resolve) => {
      rl.on("close", () => resolve(null));
      rl.on("SIGINT", () => rl.close());
      rl.question("servo> ", resolve);
    });
    history = rl.history;
    rl.close();
    if (line === null || !(await runLine(board, line, true))) return;
  }
}

// Output piped into something that stops reading early (e.g. `| more`): just exit.
process.stdout.on("error", (err) => {
  if (err.code === "EPIPE") process.exit(exitCode);
  throw err;
});

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  if (opts.list) {
    for (const p of await listPorts()) {
      console.log(`${p.path.padEnd(7)} ${p.arduino ? "Arduino " : "        "} ${p.name}`);
    }
    return;
  }

  let board;
  try {
    board = await ServoBoard.open({ port: opts.port });
  } catch (err) {
    console.error(red(err.message));
    process.exit(2);
  }
  board.on("info", (line) => console.log(cyan(line)));
  board.on("restart", () => console.log(red(
    "The Arduino restarted (servos drawing too much power?) - they went to their home angles.")));
  board.on("disconnect", () => console.error(red(`Lost connection to ${board.path}.`)));

  try {
    if (opts.script) await runStream(board, fs.createReadStream(opts.script));
    else if (opts.words.length) await runLine(board, opts.words.join(" "), false);
    else if (process.stdin.isTTY) await interactiveConsole(board);
    else await runStream(board, process.stdin);
  } finally {
    await board.close();
  }
  process.exit(exitCode);
})().catch((err) => {
  console.error(red(err.message));
  process.exit(2);
});
