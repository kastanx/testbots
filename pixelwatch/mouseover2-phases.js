// The fill/dump phases of mouseover2.js, without any screen, network or timer:
// fed one reading at a time, it says when to click what. Kept apart so it can
// be tested on made-up inventories, reading by reading.
//
//   const phases = new Phases(timings);
//   const d = phases.step(now, occupied, aPresent, nothingToDump);   // every reading
//   if (d.act) { ...click d.act...; if it was clicked: phases.clicked(now); }
//
// nothingToDump: pixels B and C both missing. timings: { fullAt, dumpEarlyAt,
// emptyBelow, fillingQuiet, emptyingQuiet, wispWait, craterWait }, the last
// four [lowest, highest] ms. step() returns { act, phase, why, alert }: act is
// null, "wisp" or "crater"; phase is "fill" or "dump"; why says what it saw;
// alert marks a state worth logging although nothing is clicked. A click that
// can't be made (no target in view) simply comes up again on the next reading
// - only clicked() starts the wait for it to take effect.
//
//   filling   full, or pixel A appears          -> crater, and dumping
//             items still coming in             -> nothing
//             none for fillingQuiet:
//               dumpEarlyAt or more occupied    -> crater, and dumping
//               fewer                           -> wisp
//   dumping   nothing to dump (B and C gone)    -> wisp, and filling
//             items still going out             -> nothing
//             none for emptyingQuiet:
//               fewer than emptyBelow left      -> wisp, and filling
//               more left                       -> crater again
//
// With nothing to dump nothing goes to the crater, however full it is: a full
// inventory then just waits.
//
// After a click nothing more is clicked until the inventory moves the right
// way - up after a wisp, down after the crater - or wispWait / craterWait
// passes without that (a failed click: it's made again). That covers the walk
// there, so a target isn't clicked twice on the way. Each range is drawn anew:
// the quiet spells after every item that comes in or goes out (and at the
// start), the waits at every click.
//
// Full, emptied and nothing to dump have to show on two readings in a row,
// and pixel A has to be present on two readings in a row after being missing,
// so one misread can't start or end a trip to the crater. Pixel A present from
// the start, or still present after dumping, hasn't appeared and doesn't
// count.

const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;

class Phases {
  // rand(lo, hi): a number between the two - Math.random unless a test passes
  // its own.
  constructor(timings, rand = (lo, hi) => lo + Math.random() * (hi - lo)) {
    this.o = timings;
    this.rand = rand;
    this.phase = null;     // "fill" or "dump", from the first reading on
    this.count = null;     // the last reading
    this.prev = null;      // the reading before it
    this.lastUp = 0;       // when an item was last added (the caller's clock, ms)
    this.lastDown = 0;     // when one was last removed
    this.fillQuiet = 0;    // this quiet spell's length while filling, drawn at lastUp
    this.dumpQuiet = 0;    // and while dumping, drawn at lastDown
    this.aRun = 0;         // pixel A present on this many readings in a row
    this.nothingRun = 0;   // nothing to dump on this many readings in a row
    this.pending = null;   // when the click still waiting to take effect was made
    this.wait = 0;         // how long that click gets
  }

  draw([lo, hi]) {
    return this.rand(lo, hi);
  }

  say(act, why, alert = false) {
    return { act, phase: this.phase, why, alert };
  }

  step(now, count, a, nothing = false) {
    const o = this.o;
    if (this.phase === null) {
      // It may be harvesting or dumping already: watch for a quiet spell
      // before the first click.
      this.phase = (count >= o.fullAt || a) && !nothing ? "dump" : "fill";
      this.count = this.prev = count;
      this.lastUp = this.lastDown = now;
      this.fillQuiet = this.draw(o.fillingQuiet);
      this.dumpQuiet = this.draw(o.emptyingQuiet);
      this.aRun = a ? 2 : 0;
      this.nothingRun = nothing ? 2 : 0;
      const quiet = this.phase === "dump" ? this.dumpQuiet : this.fillQuiet;
      return this.say(null, `started at ${count} occupied${a ? ", pixel A present" : ""}` +
                            `${nothing ? ", nothing to dump" : ""} - ` +
                            `${this.phase === "dump" ? "dumping" : "filling"}, watching ${secs(quiet)} first`);
    }

    if (count > this.count) {
      this.lastUp = now;
      this.fillQuiet = this.draw(o.fillingQuiet);
    }
    if (count < this.count) {
      this.lastDown = now;
      this.dumpQuiet = this.draw(o.emptyingQuiet);
    }
    this.prev = this.count;
    this.count = count;
    this.aRun = a ? this.aRun + 1 : 0;
    this.nothingRun = nothing ? this.nothingRun + 1 : 0;
    const appeared = this.aRun === 2;
    const empty = this.nothingRun >= 2;
    const full = count >= o.fullAt && this.prev >= o.fullAt;
    const emptied = count < o.emptyBelow && this.prev < o.emptyBelow;

    if (this.phase === "fill") {
      if ((full || appeared) && !empty) {
        this.phase = "dump";
        this.pending = null;
        return this.say("crater", full ? `full (${count} occupied) - dumping` : "pixel A appeared - dumping");
      }
      if (full) return this.say(null, `full (${count} occupied), but B and C are gone - nothing to dump; waiting`, true);
      if (this.pending !== null) {
        if (this.lastUp > this.pending) {
          this.pending = null;   // items are coming in: the click worked
        } else if (now - this.pending < this.wait) {
          return this.say(null, `waiting for filling to start after the wisp click (${secs(now - this.pending)} of ${secs(this.wait)})`);
        } else {
          this.pending = null;
          return this.say("wisp", `nothing added in ${secs(this.wait)} since the wisp click - clicking a wisp again`);
        }
      }
      if (now - this.lastUp < this.fillQuiet) return this.say(null, "filling");
      if (count >= o.dumpEarlyAt && !empty) {
        this.phase = "dump";
        return this.say("crater", `filling stopped at ${count} occupied (${o.dumpEarlyAt}+, nothing added for ` +
                                  `${secs(now - this.lastUp)}) - dumping instead of a new wisp`);
      }
      return this.say("wisp", `filling stopped at ${count} occupied (nothing added for ${secs(now - this.lastUp)}) - clicking a wisp`);
    }

    if (empty) {
      this.phase = "fill";
      this.pending = null;
      return this.say("wisp", `B and C are gone - nothing left to dump (${count} occupied) - filling`);
    }
    if (this.pending !== null) {
      if (this.lastDown > this.pending) {
        this.pending = null;     // items are going out: the click worked
      } else if (now - this.pending < this.wait) {
        return this.say(null, `waiting for dumping to start after the crater click (${secs(now - this.pending)} of ${secs(this.wait)})`);
      } else {
        this.pending = null;
        return this.say("crater", `nothing removed in ${secs(this.wait)} since the crater click - clicking it again`);
      }
    }
    if (now - this.lastDown < this.dumpQuiet) return this.say(null, "dumping");
    if (emptied) {
      this.phase = "fill";
      return this.say("wisp", `emptied (${count} occupied, nothing removed for ${secs(now - this.lastDown)}) - filling`);
    }
    return this.say("crater", `dumping stopped at ${count} occupied - clicking the crater again`);
  }

  // The click step() asked for was made at `now`: wait for it to take effect,
  // for a fresh draw of the wisp or crater wait.
  clicked(now) {
    this.pending = now;
    this.wait = this.draw(this.phase === "fill" ? this.o.wispWait : this.o.craterWait);
  }
}

module.exports = { Phases };
