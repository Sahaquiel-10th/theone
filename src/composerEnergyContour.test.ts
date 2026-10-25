import assert from 'node:assert/strict';
import test from 'node:test';
import { composerEnergyContour } from './composerEnergyContour';

type Point = [number, number];
type Command = { kind: string; values: number[] };

function readContour(path: string) {
  const tokens = path.match(/[MLCZ]|-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi) || [];
  const commands: Command[] = [], points: Point[] = [];
  let current: Point = [0, 0];
  for (let index = 0; index < tokens.length;) {
    const kind = tokens[index++], size = kind === 'C' ? 6 : kind === 'Z' ? 0 : 2;
    const values = tokens.slice(index, index + size).map(Number);
    index += size; commands.push({ kind, values });
    if (kind === 'M' || kind === 'L') current = [values[0], values[1]];
    if (kind === 'C') {
      const start = current;
      for (let sample = 1; sample <= 24; sample++) {
        const t = sample / 24, q = 1 - t;
        points.push([
          q ** 3 * start[0] + 3 * q ** 2 * t * values[0] + 3 * q * t ** 2 * values[2] + t ** 3 * values[4],
          q ** 3 * start[1] + 3 * q ** 2 * t * values[1] + 3 * q * t ** 2 * values[3] + t ** 3 * values[5],
        ]);
      }
      current = [values[4], values[5]];
    } else if (kind !== 'Z') points.push(current);
  }
  return { commands, points };
}

function checkBounded(path: string, width: number, height: number) {
  assert.doesNotMatch(path, /NaN|Infinity|undefined/);
  const { commands, points } = readContour(path), tolerance = Math.max(width, height) * 1e-10;
  assert.equal(commands.filter(command => command.kind === 'M').length, 1, 'Only one outer material boundary');
  assert.equal(commands.filter(command => command.kind === 'Z').length, 1);
  assert.equal(commands.at(-1)?.kind, 'Z');
  for (const { values } of commands) for (let i = 0; i < values.length; i += 2) {
    assert.ok(Number.isFinite(values[i]) && Number.isFinite(values[i + 1]));
    assert.ok(values[i] >= -tolerance && values[i] <= width + tolerance, `x=${values[i]} outside ${width}`);
    assert.ok(values[i + 1] >= -tolerance && values[i + 1] <= height + tolerance, `y=${values[i + 1]} outside ${height}`);
  }
  return { commands, points };
}

const cross = (a: Point, b: Point, c: Point) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function checkSimple(points: Point[]) {
  const distinct = points.filter((point, i) => !i || Math.hypot(point[0] - points[i - 1][0], point[1] - points[i - 1][1]) > 1e-8);
  if (Math.hypot(distinct.at(-1)![0] - distinct[0][0], distinct.at(-1)![1] - distinct[0][1]) < 1e-8) distinct.pop();
  for (let i = 0; i < distinct.length; i++) for (let j = i + 2; j < distinct.length; j++) {
    if (i === 0 && j === distinct.length - 1) continue;
    const a = distinct[i], b = distinct[(i + 1) % distinct.length], c = distinct[j], d = distinct[(j + 1) % distinct.length];
    assert.ok(!(cross(a, b, c) * cross(a, b, d) < -1e-10 && cross(c, d, a) * cross(c, d, b) < -1e-10), 'The outer contour must not cross itself');
  }
}

test('no feature header is one rounded input boundary, with no hidden internal seam', () => {
  const plain = composerEnergyContour({ width: 640, height: 92, headerWidth: 0, headerHeight: 0 });
  const { commands, points } = checkBounded(plain, 640, 92);
  checkSimple(points);
  assert.equal(commands.filter(command => command.kind === 'C').length, 4);
  assert.equal(composerEnergyContour({ width: 640, height: 92, headerWidth: 300, headerHeight: 0 }), plain);
  assert.equal(composerEnergyContour({ width: 640, height: 92, headerWidth: 0, headerHeight: 30 }), plain);
});

test('one-line and multi-line feature headers join the input at its measured top with a 40px soft shoulder', () => {
  for (const headerHeight of [36, 72, 118]) {
    const headerWidth = 310, width = 800, height = headerHeight + 80;
    const { commands, points } = checkBounded(composerEnergyContour({ width, height, headerWidth, headerHeight }), width, height);
    checkSimple(points);
    const shoulder = commands.find(command => command.kind === 'C')!.values;
    assert.equal(shoulder[1], 1, 'Departure tangent follows the header top');
    assert.equal(shoulder[3], headerHeight, 'Arrival tangent follows the input top');
    assert.equal(shoulder[4], headerWidth + 40);
    assert.equal(shoulder[5], headerHeight);
  }
});

test('a header approaching the full width loses its notch smoothly instead of folding its right edge', () => {
  const heights: number[] = [];
  for (const headerWidth of [570, 590, 605, 616, 617, 630, 640, 900]) {
    const { commands, points } = checkBounded(composerEnergyContour({ width: 640, height: 148, headerWidth, headerHeight: 64 }), 640, 148);
    checkSimple(points);
    const curve = commands.find(command => command.kind === 'C')!;
    heights.push(commands.filter(command => command.kind === 'C').length === 5 ? curve.values[5] : 1);
  }
  assert.equal(heights[0], 64);
  assert.equal(heights.at(-1), 1);
  assert.ok(heights.every((value, i) => !i || value <= heights[i - 1]));
});

test('narrow and shallow geometries remain closed, bounded, and free of crossed shoulders', () => {
  for (const [width, height] of [[2, 2], [8, 40], [40, 12], [60, 80], [110, 72], [300, 86]]) {
    for (const headerWidth of [width * .08, width * .45, width * .95, width * 2]) {
      for (const headerHeight of [height * .1, height * .7, height - 1.1]) {
        const { points } = checkBounded(composerEnergyContour({ width, height, headerWidth, headerHeight }), width, height);
        checkSimple(points);
      }
    }
  }
});

test('invalid dimensions produce no path; invalid headers or radii degrade to valid local geometry', () => {
  for (const invalid of [0, -1, NaN, Infinity, -Infinity]) {
    assert.equal(composerEnergyContour({ width: invalid, height: 80, headerWidth: 20, headerHeight: 30 }), '');
    assert.equal(composerEnergyContour({ width: 600, height: invalid, headerWidth: 20, headerHeight: 30 }), '');
  }
  const fallback = composerEnergyContour({ width: 600, height: 100, headerWidth: 0, headerHeight: 0 });
  for (const invalid of [-1, NaN, Infinity, -Infinity]) {
    assert.equal(composerEnergyContour({ width: 600, height: 100, headerWidth: invalid, headerHeight: 30 }), fallback);
    assert.equal(composerEnergyContour({ width: 600, height: 100, headerWidth: 200, headerHeight: invalid }), fallback);
  }
  for (const radius of [0, -30, NaN, Infinity, Number.MAX_VALUE]) {
    const { points } = checkBounded(composerEnergyContour({ width: 320, height: 128, headerWidth: 180, headerHeight: 48, radius }), 320, 128);
    checkSimple(points);
  }
  for (const width of [.00001, .1, 1, Number.MAX_VALUE]) {
    checkBounded(composerEnergyContour({ width, height: 80, headerWidth: width * .5, headerHeight: 40 }), width, 80);
  }
});
