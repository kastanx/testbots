// Add variations of pixel C to archeology's calibration.
//
//   node add-c-archeology.js             -> 5s countdown, screenshot, pick the new variation(s)
//   node add-c-archeology.js --delay 0   -> capture immediately
//   node add-c-archeology.js --no-open   -> don't open a browser tab, just print the address
//
// C counts as present when ANY of its variations is present, and as missing
// (the button 1 tap's "C missing") only when all of them are. Each run adds
// the variations picked to the ones already saved - nothing is removed or
// changed: A, B, D, E, the saved C variations and all the settings stay exactly
// as they are. Recapture in the page as often as needed, e.g. once per look of C.
//
// Same picker as calibrate-archeology.js; this is calibrate-archeology.js --add C.

process.argv.splice(2, 0, "--add", "C");
require("./calibrate-archeology.js");
