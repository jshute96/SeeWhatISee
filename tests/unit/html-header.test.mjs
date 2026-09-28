// Unit tests for `src/capture/html-header.ts` — the Chrome-style
// `<!-- saved from url=(NNNN)... -->` comment on page HTML, and the
// doctype on selection HTML.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { addHtmlDoctype, addSavedFromComment } from '../../dist/capture/html-header.js';

test('inserts after the doctype with a zero-padded length', () => {
  assert.equal(
    addSavedFromComment('<!DOCTYPE html>\n<html></html>', 'https://www.google.com/'),
    '<!DOCTYPE html>\n<!-- saved from url=(0023)https://www.google.com/ -->\n<html></html>',
  );
});

test('adds a newline after a doctype that lacks one', () => {
  assert.equal(
    addSavedFromComment('<!doctype html><html></html>', 'https://a.b/'),
    '<!doctype html>\n<!-- saved from url=(0012)https://a.b/ -->\n<html></html>',
  );
});

test('goes at the top when there is no doctype', () => {
  assert.equal(
    addSavedFromComment('<html></html>', 'https://a.b/'),
    '<!-- saved from url=(0012)https://a.b/ -->\n<html></html>',
  );
});

test('escapes -- so the comment cannot end early', () => {
  const out = addSavedFromComment('<html></html>', 'https://a.b/x--y');
  assert.equal(out, '<!-- saved from url=(0020)https://a.b/x%2D%2Dy -->\n<html></html>');
});

test('no-op for an empty body or URL, or an existing comment', () => {
  assert.equal(addSavedFromComment('<html></html>', ''), '<html></html>');
  assert.equal(addSavedFromComment('', 'https://a.b/'), '');
  const saved = '<!DOCTYPE html>\n<!-- saved from url=(0012)https://a.b/ -->\n<html></html>';
  assert.equal(addSavedFromComment(saved, 'https://c.d/'), saved);
});

test('a comment elsewhere in the page does not suppress ours', () => {
  const html = '<html><head><!-- saved from url=(0012)https://x.y/ -->\n</head></html>';
  assert.equal(
    addSavedFromComment(html, 'https://a.b/'),
    '<!-- saved from url=(0012)https://a.b/ -->\n' + html,
  );
});

test('selection fragments get the page doctype, if any; blank stays blank', () => {
  const dt = '<!DOCTYPE html>';
  assert.equal(addHtmlDoctype('<p>hi</p>', dt), '<!DOCTYPE html>\n<p>hi</p>');
  assert.equal(addHtmlDoctype('<p>hi</p>', ''), '<p>hi</p>');
  const legacy = '<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd">';
  assert.equal(addHtmlDoctype('<p>hi</p>', legacy), `${legacy}\n<p>hi</p>`);
  assert.equal(addHtmlDoctype('', dt), '');
  assert.equal(addHtmlDoctype('  \n', dt), '  \n');
  assert.equal(addHtmlDoctype('<!doctype html><p>hi</p>', dt), '<!doctype html><p>hi</p>');
});
