import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyWebClaimFix,
  coarseFollowUpCopy,
  webTooFarMode,
} from './claim-location.js';

test('a 2 km fix is the approximate grant, even at the counter', () => {
  assert.equal(
    classifyWebClaimFix({ accuracyMeters: 2000, distanceMeters: 20 }),
    'coarse',
  );
});

test('a blurry fix at the counter is sent', () => {
  assert.equal(
    classifyWebClaimFix({ accuracyMeters: 400, distanceMeters: 40 }),
    'send',
  );
});

test('a blurry fix whose circle still covers the cafe is sent', () => {
  assert.equal(
    classifyWebClaimFix({ accuracyMeters: 400, distanceMeters: 500 }),
    'send',
  );
});

test('without a cafe distance, a blurry fix is still sent', () => {
  assert.equal(
    classifyWebClaimFix({ accuracyMeters: 400, distanceMeters: null }),
    'send',
  );
});

test('a blurry fix that cannot reach the cafe is weak, not far', () => {
  assert.equal(
    classifyWebClaimFix({ accuracyMeters: 400, distanceMeters: 900 }),
    'weak',
  );
});

test('a fine fix outside the radius is far', () => {
  assert.equal(
    classifyWebClaimFix({ accuracyMeters: 40, distanceMeters: 800 }),
    'far',
  );
});

test('a fine fix just outside still goes to the server when the circle covers the cafe', () => {
  assert.equal(
    classifyWebClaimFix({ accuracyMeters: 80, distanceMeters: 340 }),
    'send',
  );
});

test('a server rejection of a blurry fix stays a weak-gps screen', () => {
  assert.equal(webTooFarMode(400), 'weak');
  assert.equal(webTooFarMode(40), 'far');
});

test('the second approximate hint names Chrome only in Chrome', () => {
  assert.match(coarseFollowUpCopy('Mozilla/5.0 Chrome/128.0.0.0'), /Dans Chrome/);
  assert.doesNotMatch(
    coarseFollowUpCopy('Mozilla/5.0 Version/17.0 Mobile/15E148 Safari/604.1'),
    /Chrome/,
  );
  assert.match(
    coarseFollowUpCopy('Mozilla/5.0 Version/17.0 Mobile/15E148 Safari/604.1'),
    /réglages de localisation du navigateur/,
  );
});
