/**
 * The background figure: isolines of a smooth height field.
 *
 * Not stripes. A contour bunches where the ground is steep and opens out
 * where it is flat, and that is the whole difference between a map and a
 * texture. So each line is the set of points where h(x, y) = c, solved for y
 * by iteration - which lets the gaps breathe without any two lines crossing.
 */
import { writeFileSync } from "node:fs";

const W = 1600;
const H = 1000;
const LINES = 21;
const STEP = 42;

/** Two hills in the field. The lines wrap them the way contours wrap terrain. */
const HILLS = [
  { x: 1180, y: 280, a: 150, s: 300 },
  { x: 560, y: 800, a: -130, s: 320 },
];

/** The wobble. Kept under a slope of 1 in y, or lines would fold into each other. */
function warp(x, y) {
  let g =
    88 * Math.sin(x / 470 + y / 560) +
    46 * Math.sin(x / 210 - y / 330 + 1.7) +
    22 * Math.sin((x + y) / 300 + 3.1);
  for (const hill of HILLS) {
    const dx = (x - hill.x) / hill.s;
    const dy = (y - hill.y) / hill.s;
    g += hill.a * Math.exp(-(dx * dx + dy * dy));
  }
  return g;
}

/** y such that y + warp(x, y) = c. Fixed point; the slope bound makes it settle. */
function solve(x, c) {
  let y = c;
  for (let i = 0; i < 24; i += 1) y = y - 0.55 * (y + warp(x, y) - c);
  return y;
}

const r = Math.round;

function pathFor(c) {
  const pts = [];
  for (let x = -60; x <= W + 60; x += STEP) pts.push([x, r(solve(x, c))]);

  // Smooth quadratics: every point after the first two costs two numbers,
  // because T reflects the control point it already has. At this spacing the
  // reflection tracks the curve, and the file is a third of the cubic one.
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  const mid = (a, b) => [r((a[0] + b[0]) / 2), r((a[1] + b[1]) / 2)];
  const m1 = mid(pts[0], pts[1]);
  d += `Q${pts[0][0]} ${pts[0][1]} ${m1[0]} ${m1[1]}`;
  for (let k = 1; k < pts.length - 1; k += 1) {
    const m = mid(pts[k], pts[k + 1]);
    d += `T${m[0]} ${m[1]}`;
  }
  d += `T${pts[pts.length - 1][0]} ${pts[pts.length - 1][1]}`;
  return d;
}

// Every fourth line heavier, which is what an index contour is on a real map -
// and what stops twenty-one parallel curves reading as corduroy.
const thin = [];
const thick = [];
for (let i = 0; i < LINES; i += 1) {
  const c = -180 + (i * (H + 400)) / (LINES - 1);
  // Single quotes here too. A double quote inside the attribute closes the
  // CSS string the whole data URI lives in, and the declaration is dropped
  // silently - the mask just never appears.
  (i % 4 === 0 ? thick : thin).push(`<path d='${pathFor(c)}'/>`);
}

// Single quotes throughout, so the whole thing drops into a CSS url("...")
// with only # and % needing to be escaped. encodeURIComponent would be
// correct and a quarter larger, and this blob is already the biggest thing
// in the stylesheet.
const svg =
  `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${W} ${H}' preserveAspectRatio='xMidYMid slice'>` +
  `<g fill='none' stroke='#000'>` +
  `<g stroke-width='1.1' opacity='.62'>${thin.join("")}</g>` +
  `<g stroke-width='2'>${thick.join("")}</g>` +
  `</g></svg>`;

const encoded = svg.replace(/%/g, "%25").replace(/#/g, "%23");
writeFileSync("/tmp/figure.svg", svg.replace(/'/g, '"'));
writeFileSync(
  "/tmp/figure.css",
  `  --figure-mask: url("data:image/svg+xml,${encoded}");\n`,
);
console.log("raw", svg.length, "css", encoded.length);
console.log("written to /tmp/figure.css - paste it into the :root block in styles.css");
