// Human-like mouse-motion math — pure functions (no DOM, no chrome). Imported by the
// service worker, which performs the actual trusted CDP Input.dispatchMouseEvent. Lives
// here (not content/) because the path must be generated where it is dispatched, and the
// MV3 service worker is an ES module so it can import this directly.
//
// Bezier path + overshoot + Fitts-law timing adapted from ghost-cursor (Xetera), MIT License:
//   https://github.com/Xetera/ghost-cursor — Copyright (c) Xetera. Licensed under MIT.
// Reimplemented standalone (no bezier-js dependency) for the CDP/SW context.

const rand = (a, b) => a + Math.random() * (b - a);

// Eased progress 0→1 (slow-fast-slow) — used to time path steps so the cursor
// accelerates out and decelerates into the target rather than moving linearly.
export function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// Fitts's law: movement time grows with the index of difficulty log2(distance/width + 1),
// so a far/small target genuinely takes longer (a too-fast long move is a bot tell). ms.
export function fittsDuration(distance, width = 24) {
  const id = Math.log2(Math.max(1, distance) / Math.max(2, width) + 1);
  return 90 + 130 * id; // short hops ~120ms, long drags ~500–700ms
}

// A random press point inside the element rect (centre x,y + size w,h), kept paddingPct
// away from the edges — never dead-centre, never the very edge (ghost-cursor padding).
export function randomPointInRect(x, y, w, h, paddingPct = 0.2) {
  if (!(w > 0) || !(h > 0)) return { x, y };
  const px = (w * paddingPct) / 2, py = (h * paddingPct) / 2;
  return {
    x: x - w / 2 + px + Math.random() * (w - 2 * px),
    y: y - h / 2 + py + Math.random() * (h - 2 * py),
  };
}

// Cubic-Bezier path from→to with two control points biased perpendicular to the line, for
// a natural arc; samples `steps` points with tiny per-point jitter. With overshoot, aims a
// little past the target on longer moves (corrected afterwards by correctionPoints()).
export function bezierPath(from, to, opts = {}) {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  let target = to;
  if (opts.overshoot && dist > 60) {
    target = {
      x: to.x + (to.x - from.x) * 0.04 + rand(-12, 12),
      y: to.y + (to.y - from.y) * 0.04 + rand(-12, 12),
    };
  }
  const n = opts.steps || Math.max(12, Math.min(40, Math.round(dist / 12)));
  const mx = (from.x + target.x) / 2, my = (from.y + target.y) / 2;
  let nx = -(target.y - from.y), ny = target.x - from.x;
  const nlen = Math.hypot(nx, ny) || 1;
  nx /= nlen; ny /= nlen;
  const arc = rand(-1, 1) * Math.min(60, dist * 0.2);
  const c1 = { x: from.x + (mx - from.x) * 0.5 + nx * arc * 0.6, y: from.y + (my - from.y) * 0.5 + ny * arc * 0.6 };
  const c2 = { x: target.x + (mx - target.x) * 0.5 + nx * arc * 0.4, y: target.y + (my - target.y) * 0.5 + ny * arc * 0.4 };
  const points = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n, mt = 1 - t;
    const x = mt * mt * mt * from.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t * t * t * target.x;
    const y = mt * mt * mt * from.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t * t * t * target.y;
    points.push({ x: x + rand(-0.8, 0.8), y: y + rand(-0.8, 0.8) });
  }
  return { points, overshot: target !== to };
}

// 1–3 small corrective hops from an overshoot back onto the true target.
export function correctionPoints(to) {
  const hops = 1 + Math.floor(Math.random() * 3);
  const pts = [];
  for (let i = 1; i <= hops; i++) {
    const decay = 1 - i / (hops + 1);
    pts.push({ x: to.x + rand(-3, 3) * decay, y: to.y + rand(-3, 3) * decay });
  }
  pts.push({ x: to.x, y: to.y });
  return pts;
}
