// Add variations of pixel B to archeology's calibration.
//
//   node add-b-archeology.js             -> 5s countdown, screenshot, pick the new variation(s)
//   node add-b-archeology.js --delay 0   -> capture immediately
//   node add-b-archeology.js --no-open   -> don't open a browser tab, just print the address
//
// B counts as present when ANY of its variations is present. Each run adds the
// variations picked to the ones already saved - nothing is removed or changed:
// A, C, D, E, the saved B variations and all the settings stay exactly as they
// are. Recapture in the page as often as needed, e.g. once per look of B.
//
// Same picker as calibrate-archeology.js; this is calibrate-archeology.js --add B.

process.argv.splice(2, 0, "--add", "B");
require("./calibrate-archeology.js");
