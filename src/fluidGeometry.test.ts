import test from 'node:test';
import assert from 'node:assert/strict';
import { bubbleBodyGeometry, childMetrics, createFluidGeometry, fluidMetrics, getBubbleBounds, getFluidLayout, mainRightAt } from './fluid/geometry';
import type { FluidLayout, FluidPhases } from './fluid/types';

type Point = readonly [number, number];

/** Flatten actual filled material paths, rather than counting overlapping subpaths. */
function polygons(path: string): Point[][] {
  const tokens = path.match(/[MCLZ]|-?\d+(?:\.\d+)?/g) ?? [];
  const result: Point[][] = [];
  let index = 0, x = 0, y = 0;
  let polygon: Point[] = [];
  const number = () => {
    const token = tokens[index++];
    assert.ok(token && !/[MCLZ]/.test(token), 'Missing path coordinate');
    const value = Number(token);
    assert.ok(Number.isFinite(value), 'Non-finite path coordinate');
    return value;
  };
  while (index < tokens.length) {
    const command = tokens[index++];
    if (command === 'M') { polygon = []; result.push(polygon); x = number(); y = number(); polygon.push([x, y]); }
    else if (command === 'L') { x = number(); y = number(); polygon.push([x, y]); }
    else if (command === 'C') {
      const x0 = x, y0 = y, cx1 = number(), cy1 = number(), cx2 = number(), cy2 = number(), x1 = number(), y1 = number();
      for (let i = 1; i <= 20; i++) {
        const t = i / 20, u = 1 - t;
        polygon.push([u*u*u*x0 + 3*u*u*t*cx1 + 3*u*t*t*cx2 + t*t*t*x1,
          u*u*u*y0 + 3*u*u*t*cy1 + 3*u*t*t*cy2 + t*t*t*y1]);
      }
      x = x1; y = y1;
    } else assert.equal(command, 'Z', 'Unexpected SVG path command');
  }
  return result;
}

function pathAt(layout: FluidLayout, phases: FluidPhases) {
  const path = createFluidGeometry(layout, phases);
  assert.doesNotMatch(path, /NaN|Infinity|undefined/);
  assert.ok(path.startsWith('M ') && path.endsWith('Z'));
  return path;
}

function componentCount(path: string, layout: FluidLayout) {
  const step = 3, width = Math.ceil(layout.width / step), height = Math.ceil(layout.height / step);
  const fill = new Uint8Array(width * height), seen = new Uint8Array(fill.length);
  const edges: [Point, Point][] = polygons(path).flatMap(poly => poly.map((point, i): [Point, Point] => [poly[(i + poly.length - 1) % poly.length], point]));
  for (let row = 0; row < height; row++) {
    const y = row * step + .5;
    const events: [number, number][] = [];
    for (const [a, b] of edges) {
      if (a[1] <= y && b[1] > y) events.push([a[0] + (y-a[1])*(b[0]-a[0])/(b[1]-a[1]), 1]);
      else if (b[1] <= y && a[1] > y) events.push([a[0] + (y-a[1])*(b[0]-a[0])/(b[1]-a[1]), -1]);
    }
    events.sort((a, b) => a[0] - b[0]);
    let winding = 0, last = 0;
    for (const [x, delta] of events) {
      if (winding) fill.fill(1, row*width + Math.max(0, Math.ceil((last-.5)/step)), row*width + Math.min(width, Math.ceil((x-.5)/step)));
      winding += delta; last = x;
    }
    assert.equal(winding, 0, 'Material path is open');
  }
  let components = 0;
  for (let i = 0; i < fill.length; i++) {
    if (!fill[i] || seen[i]) continue;
    let area = 0;
    const stack = [i]; seen[i] = 1;
    while (stack.length) {
      const cell = stack.pop(); assert.notEqual(cell, undefined);
      const k = cell!; area++;
      for (const neighbor of [k%width ? k-1 : -1, k%width < width-1 ? k+1 : -1, k-width, k+width]) {
        if (neighbor >= 0 && neighbor < fill.length && fill[neighbor] && !seen[neighbor]) { seen[neighbor] = 1; stack.push(neighbor); }
      }
    }
    if (area > 3) components++;
  }
  return components;
}

test('fluid children keep their full rounded rectangle dimensions and 32px corners at every exposed phase', () => {
  const layout = getFluidLayout(1158, 688);
  for (const kind of ['activity', 'local'] as const) {
    const bounds = getBubbleBounds(layout, kind);
    assert.equal(bounds.stableBody, true);
    const expected = bubbleBodyGeometry(bounds, .2);
    assert.ok(expected.startsWith(`M ${bounds.left+32.5} ${bounds.top+.5} L ${bounds.left+bounds.width-32.5} ${bounds.top+.5}`));
    for (const phase of [.001, .2, .5, .8, .94, 1]) {
      const body = childMetrics(bounds, phase, layout.width);
      assert.equal(bubbleBodyGeometry(bounds, phase), expected, `${kind}: outline changed at ${phase}`);
      assert.equal(body.q, 1, 'Stable outline interpolated through an ellipse');
      assert.ok(Math.abs((body.right - body.left) - (bounds.width - .5)) < 1e-9);
      assert.ok(Math.abs((body.bottom - body.top) - bounds.height) < 1e-9);
    }
  }
});

test('desktop geometry stays legal through independent, simultaneous and reversed fission across viewport sizes', () => {
  for (const width of [1000, 1024, 1158, 1390, 1600]) for (const height of [560, 600, 660, 688, 1008]) {
    const layout = getFluidLayout(width, height);
    for (let i = 0; i <= 100; i++) {
      const progress = i / 100;
      pathAt(layout, { activity: progress, local: 1-progress, sidebar: progress });
      pathAt(layout, { activity: progress, local: progress, sidebar: 1-progress });
    }
    for (const activity of [0, .5, .87, .94, 1]) for (const local of [0, .5, .87, .94, 1]) polygons(pathAt(layout, { activity, local }));
  }
});

test('the material stays connected before the seam separates, then has one independent body per open child', () => {
  const layout = getFluidLayout(1000, 660);
  assert.equal(componentCount(pathAt(layout, {}), layout), 1);
  assert.equal(componentCount(pathAt(layout, { activity: .5, local: .5 }), layout), 1);
  assert.equal(componentCount(pathAt(layout, { activity: 1 }), layout), 2);
  assert.equal(componentCount(pathAt(layout, { local: 1 }), layout), 2);
  assert.equal(componentCount(pathAt(layout, { activity: 1, local: 1 }), layout), 3);
});

test('opening either child leaves the main conversation safe bounds fixed and inside the parent material', () => {
  const layout = getFluidLayout(1158, 688), expected = { ...layout.mainContentBounds };
  for (const activity of [0, .25, .5, .87, 1]) for (const local of [0, .25, .5, .87, 1]) {
    const phases = { activity, local, sidebar: .7 };
    pathAt(layout, phases);
    assert.deepEqual(layout.mainContentBounds, expected);
    const metrics = fluidMetrics(layout, phases);
    for (let y = expected.top; y < expected.top + expected.height; y += 4) {
      assert.ok(mainRightAt(layout, metrics, y) > expected.left + expected.width,
        `Main conversation content lost its fixed safe area at ${activity}/${local}, y=${y}`);
    }
  }
});

test('reversing mid-fission reproduces the same material outline at the same phase', () => {
  const layout = getFluidLayout(1390, 1008);
  const seen = new Map<number, string>();
  for (const activity of [0, .2, .5, .72, .5, .31, .5, .72, .9, .94, 1, .94, .8, .5, .2, 0]) {
    const path = pathAt(layout, { activity, local: 1-activity });
    if (seen.has(activity)) assert.equal(path, seen.get(activity));
    seen.set(activity, path);
  }
});
