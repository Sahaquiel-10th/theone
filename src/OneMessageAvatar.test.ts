import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OneMessageAvatar } from './OneMessageAvatar';

test('ONE message avatar uses the real project mark with no interactive or animated eye markup', () => {
  const html = renderToStaticMarkup(createElement(OneMessageAvatar));
  assert.equal((html.match(/<img\b/g) ?? []).length, 1);
  assert.match(html, /class="one-message-avatar"/);
  assert.match(html, /src="\/one-mark\.svg"/);
  assert.match(html, /width="44" height="44"/);
  assert.match(html, /alt="" aria-hidden="true"/);
  assert.match(html, /draggable="false"/);
  assert.doesNotMatch(html, /one-eye|mood-|<button|<a\b|tabindex|style=|on(?:click|pointer|mouse)/i);
});

test('the same static mark can identify ONE when no adjacent author label exists', () => {
  const html = renderToStaticMarkup(createElement(OneMessageAvatar, { decorative: false, className: 'message-author-mark' }));
  assert.match(html, /class="one-message-avatar message-author-mark"/);
  assert.match(html, /alt="ONE"/);
  assert.doesNotMatch(html, /aria-hidden|role="button"|tabindex/);
});

test('the logo asset and responsive avatar remain static, with 44px desktop and 40px mobile tiles', () => {
  const svg = readFileSync(new URL('../public/one-mark.svg', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./one-message-avatar.css', import.meta.url), 'utf8');
  const component = readFileSync(new URL('./OneMessageAvatar.tsx', import.meta.url), 'utf8');
  assert.match(svg, /viewBox="0 0 64 64"/);
  assert.doesNotMatch(svg, /<(?:animate|animateTransform|set|script|style|foreignObject)\b|@keyframes|\b(?:animation|transition)\s*:|\bon\w+\s*=/i);
  assert.match(css, /width:\s*44px/); assert.match(css, /height:\s*44px/); assert.match(css, /border-radius:\s*8px/);
  assert.match(css, /@media\s*\(max-width:\s*600px\)[\s\S]*width:\s*40px[\s\S]*height:\s*40px[\s\S]*border-radius:\s*6px/);
  assert.match(css, /animation:\s*none\s*!important/);
  assert.match(css, /transition:\s*none\s*!important/);
  assert.match(css, /pointer-events:\s*none/);
  assert.doesNotMatch(css, /:hover|:active|@keyframes|cursor:\s*pointer/);
  assert.doesNotMatch(component, /OneEye|useEffect|useState|addEventListener|requestAnimationFrame|setInterval|setTimeout/);
});
