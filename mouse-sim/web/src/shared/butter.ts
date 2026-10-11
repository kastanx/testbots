// Second-order Butterworth low-pass, applied forwards and backwards, matching
// scipy.signal.sosfiltfilt(butter(2, fc, fs=fs, output="sos"), x, padtype="odd", padlen=padlen).

export function butter2(fc: number, fs: number): { b: [number, number, number]; a: [number, number] } {
  const K = Math.tan((Math.PI * fc) / fs);
  const norm = 1 / (1 + Math.SQRT2 * K + K * K);
  const b0 = K * K * norm;
  return {
    b: [b0, 2 * b0, b0],
    a: [2 * (K * K - 1) * norm, (1 - Math.SQRT2 * K + K * K) * norm],
  };
}

function filter(b: number[], a: number[], x: Float64Array, z1: number, z2: number): Float64Array {
  const y = new Float64Array(x.length);
  for (let n = 0; n < x.length; n++) {
    const yn = b[0] * x[n] + z1;
    z1 = b[1] * x[n] - a[0] * yn + z2;
    z2 = b[2] * x[n] - a[1] * yn;
    y[n] = yn;
  }
  return y;
}

/** Zero-phase filtering of one channel. */
export function filtfilt(x: ArrayLike<number>, fc: number, fs: number, padlen: number): Float64Array {
  const { b, a } = butter2(fc, fs);
  const n = x.length;
  const p = Math.min(padlen, n - 1);
  const ext = new Float64Array(n + 2 * p);
  for (let i = 0; i < p; i++) ext[i] = 2 * x[0] - x[p - i];
  for (let i = 0; i < n; i++) ext[p + i] = x[i];
  for (let i = 0; i < p; i++) ext[p + n + i] = 2 * x[n - 1] - x[n - 2 - i];
  // steady-state initial conditions for a unit input (lfilter_zi), scaled by the first sample
  const g = (b[0] + b[1] + b[2]) / (1 + a[0] + a[1]);
  const zi1 = g - b[0];
  const zi2 = b[2] - a[1] * g;
  const fwd = filter(b, a, ext, zi1 * ext[0], zi2 * ext[0]);
  fwd.reverse();
  const bwd = filter(b, a, fwd, zi1 * fwd[0], zi2 * fwd[0]);
  bwd.reverse();
  return bwd.slice(p, p + n);
}
