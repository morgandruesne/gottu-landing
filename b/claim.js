import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';
import {
  classifyWebClaimFix,
  coarseFollowUpCopy,
  haversineMeters,
  webTooFarMode,
} from './claim-location.js';

const APTABASE_APP_KEY = 'A-EU-6490241678';
const aptabaseSession = `${Math.floor(Date.now() / 1000)}${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

function trackClaim(name, props) {
  if (typeof window.gottuTrack === 'function') {
    window.gottuTrack(name, props);
    return;
  }
  try {
    fetch('https://eu.aptabase.com/api/v0/event', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'App-Key': APTABASE_APP_KEY,
      },
      credentials: 'omit',
      body: JSON.stringify({
        timestamp: new Date().toISOString(),
        sessionId: aptabaseSession,
        eventName: name,
        systemProps: {
          locale: (navigator.language || 'fr').slice(0, 10),
          isDebug: false,
          appVersion: '',
          sdkVersion: 'aptabase-web@0.5.0',
        },
        props: props || {},
      }),
    }).catch(() => {});
  } catch {
    // Analytics must never break the claim.
  }
}

const CGU_VERSION = '2026-10';
const PRIVACY_VERSION = '2026-10';
const PROVIDER_KEY = 'gottu.claim.provider';
const CONSENT_KEY = 'gottu.claim.consent';
const VERIFY_HOLD_MS = 700;
const POSITION_WAIT_MS = 12000;

const STORE_CODES = new Set(['OK', 'RECENTLY_VISITED', 'ALREADY_VISITED']);

const COPY = {
  passwordShort: 'Le mot de passe doit faire au moins 8 caractères.',
  passwordLong: 'Le mot de passe est trop long.',
  needEmail: 'Indique ton e-mail.',
  appleFail: "Apple n'a pas pu ouvrir la connexion. Réessaie.",
  googleFail: "Google n'a pas pu ouvrir la connexion. Réessaie.",
  signupFail: "Le compte n'a pas pu être créé. Réessaie.",
  accountExists: 'Ce compte existe déjà. Connecte-toi.',
  needBoth: 'Indique ton e-mail et ton mot de passe.',
  badLogin: 'E-mail ou mot de passe incorrect.',
  badCode: 'Ce code ne marche pas. Réessaie.',
  cgu: 'Coche les CGU pour continuer.',
  invalidQr: "Ce QR n'est pas valide.",
  inactiveCafe: "Ce café n'est pas disponible.",
  consent: 'Accepte les conditions, puis réessaie.',
  rate: 'Réessaie dans un moment.',
  generic: "Réessaie, la visite n'a pas été enregistrée.",
  missingConfig: "Cette page n'est pas encore configurée.",
  resendFail: "Le code n'a pas pu être renvoyé. Réessaie.",
  resendOk: 'Code renvoyé.',
};

const config = window.GOTTU_CLAIM ?? {};
const token = new URLSearchParams(location.search).get('t')?.trim() ?? '';

const screens = Object.fromEntries(
  [...document.querySelectorAll('[data-screen]')].map((section) => [section.dataset.screen, section]),
);

const locating = document.querySelector('#locating');
const cguRow = document.querySelector('#cgu-row');
const cguInput = document.querySelector('#cgu');
const cguWarn = document.querySelector('#cgu-warn');
const authActions = document.querySelector('#auth-actions');
const welcomeError = document.querySelector('#welcome-error');
const emailForm = document.querySelector('#email-form');
const emailInput = document.querySelector('#email');
const passwordInput = document.querySelector('#password');
const emailError = document.querySelector('#email-error');
const emailEyebrow = document.querySelector('#email-eyebrow');
const codeEyebrow = document.querySelector('#code-eyebrow');
const codeEmail = document.querySelector('#code-email');
const codeGrid = document.querySelector('#code-grid');
const codeInput = document.querySelector('#otp');
const codeNote = document.querySelector('#code-note');
const codeGo = document.querySelector('#code-go');
const whyLead = document.querySelector('#why-lead');
const geoTitle = document.querySelector('#geo-title');
const farTitle = document.querySelector('#far-title');
const farText = document.querySelector('#far-text');
const farRetry = document.querySelector('#far-retry');
const blockedMessage = document.querySelector('#blocked-message');
const blockedRetry = document.querySelector('#blocked-retry');
const digitCells = [...codeGrid.querySelectorAll('.digit')];

let cafeName = '';
let cafeAddress = '';
let cafeLat = null;
let cafeLng = null;
let pendingEmail = '';
let busy = false;
let claiming = false;
let farMode = 'far';
let coarseAsks = 0;
let supabase = null;

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function reducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function upper(value) {
  return value.toLocaleUpperCase('fr-FR');
}

function utf8Size(value) {
  return new TextEncoder().encode(value).length;
}

function passwordError(password) {
  if (password.length < 8) return COPY.passwordShort;
  if (utf8Size(password) > 72) return COPY.passwordLong;
  return null;
}

function storeUrl(value) {
  if (typeof value !== 'string') return '';
  const url = value.trim();
  if (!url || url === '#') return '';
  return url;
}

function show(step) {
  document.body.dataset.step = step;
  for (const [name, section] of Object.entries(screens)) {
    section.hidden = name !== step;
  }
  locating.hidden = true;
  locating.classList.remove('run');
  window.scrollTo(0, 0);
}

function showLocating() {
  show('geo');
  locating.hidden = false;
  locating.classList.remove('run');
  void locating.offsetWidth;
  locating.classList.add('run');
}

function showBlocked(message, retry) {
  blockedMessage.textContent = message;
  blockedRetry.hidden = !retry;
  blockedRetry.onclick = retry || null;
  show('blocked');
}

function showFar(mode) {
  farMode = mode;
  if (mode === 'denied') {
    farTitle.textContent = 'POSITION REQUISE';
    farText.textContent = `Sans ta position, on ne peut pas confirmer que tu es chez ${cafeName}. Autorise-la dans les réglages du navigateur.`;
    farRetry.textContent = 'Réessayer';
  } else if (mode === 'coarse') {
    coarseAsks += 1;
    farTitle.textContent = 'POSITION APPROXIMATIVE';
    farText.textContent = coarseAsks > 1
      ? coarseFollowUpCopy(navigator.userAgent)
      : `Le navigateur n'a partagé qu'une zone d'environ 2 km. Pour confirmer que tu es chez ${cafeName}, autorise la position exacte.`;
    farRetry.textContent = coarseAsks > 1 ? 'Réessayer' : 'Autoriser la position exacte';
  } else if (mode === 'weak') {
    farTitle.textContent = 'SIGNAL GPS FAIBLE';
    farText.textContent = "Place-toi dehors ou près d'une fenêtre pour améliorer la réception, puis réessaie.";
    farRetry.textContent = 'Réessayer';
  } else {
    farTitle.textContent = 'TROP LOIN DU CAFÉ';
    farText.textContent = `Tu n'es pas assez près de ${cafeName}. Rapproche-toi à moins de 300 m et réessaie.`;
    farRetry.textContent = 'Réessayer';
  }
  show('far');
}

function applyCafe() {
  const cafeUp = upper(cafeName);
  const welcome = document.querySelector('[data-screen="welcome"]');
  if (welcome) welcome.dataset.cafe = cafeName;
  document.querySelectorAll('[data-cafe-up]').forEach((node) => {
    node.textContent = cafeUp;
  });
  emailEyebrow.textContent = `${cafeUp} · ÉTAPE 1/2`;
  codeEyebrow.textContent = `${cafeUp} · ÉTAPE 2/2`;
  geoTitle.textContent = `ES-TU BIEN CHEZ ${cafeUp} ?`;
  whyLead.textContent = `Ta position sert une seule fois, à confirmer que tu es bien chez ${cafeName}.`;
  const row = document.querySelector('[data-address-row]');
  const address = document.querySelector('[data-address]');
  if (cafeAddress) {
    address.textContent = cafeAddress;
    row.hidden = false;
  } else {
    address.textContent = '';
    row.hidden = true;
  }
}

function syncCgu() {
  const on = cguInput.checked;
  cguRow.classList.toggle('is-on', on);
  authActions.classList.toggle('is-ready', on);
  if (on) cguWarn.hidden = true;
}

function requireCgu() {
  if (cguInput.checked) return true;
  cguWarn.hidden = false;
  cguRow.classList.remove('shake');
  void cguRow.offsetWidth;
  cguRow.classList.add('shake');
  return false;
}

function remember(provider) {
  if (!requireCgu()) return false;
  sessionStorage.setItem(CONSENT_KEY, '1');
  sessionStorage.setItem(PROVIDER_KEY, provider);
  welcomeError.textContent = '';
  return true;
}

function methodLine(provider, email) {
  if (provider === 'apple') return "Dans l'app, connecte-toi avec Apple.";
  if (provider === 'google') return "Dans l'app, connecte-toi avec Google.";
  return `Dans l'app, connecte-toi avec ton e-mail ${email}.`;
}

function armAppLinks() {
  const href = token ? `gottu://b?t=${encodeURIComponent(token)}` : '';
  document.querySelectorAll('[data-open-app]').forEach((link) => {
    if (!href) {
      link.hidden = true;
      link.removeAttribute('href');
      return;
    }
    link.hidden = false;
    link.href = href;
  });
}

function drawQr() {
  const grid = document.querySelector('#qr-cells');
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < 121; i += 1) {
    const row = Math.floor(i / 11);
    const col = i % 11;
    const finder = (row < 3 && (col < 3 || col > 7)) || (row > 7 && col < 3);
    const on = finder
      ? !(row % 3 === 1 && col % 3 === 1) || (row === 1 && col === 1)
      : ((i * 37 + row * 11 + col * 7) % 5) > 1;
    const cell = document.createElement('span');
    if (on) cell.className = 'on';
    fragment.appendChild(cell);
  }
  grid.appendChild(fragment);
}

function renderDigits(value) {
  digitCells.forEach((cell, index) => {
    const char = value[index] ?? '';
    const label = cell.querySelector('b');
    const caret = cell.querySelector('.caret');
    const wasFilled = cell.classList.contains('filled');
    label.textContent = char;
    cell.classList.toggle('filled', Boolean(char));
    cell.classList.toggle('current', index === value.length);
    caret.hidden = index !== value.length;
    if (char && !wasFilled) {
      cell.classList.remove('pop');
      void cell.offsetWidth;
      cell.classList.add('pop');
    }
  });
  const ready = value.length === 6;
  codeGo.textContent = ready ? 'Valider' : 'Coller le code reçu';
  codeGo.classList.toggle('dark', ready);
  codeGo.classList.toggle('pulse', ready);
}

function currentCode() {
  return codeInput.value.replace(/\D/g, '').slice(0, 6);
}

function animateCount(node, target) {
  if (reducedMotion()) {
    node.textContent = String(target);
    return;
  }
  const start = performance.now();
  const duration = Math.min(1200, 400 + Math.abs(target) * 16);
  const tick = (now) => {
    const progress = Math.min(1, (now - start) / duration);
    if (progress >= 1) {
      node.textContent = String(target);
      return;
    }
    const eased = 1 - (1 - progress) ** 3;
    node.textContent = String(Math.round(target * eased));
    requestAnimationFrame(tick);
  };
  node.textContent = '0';
  requestAnimationFrame(tick);
}

function burst(layer) {
  if (!layer) return;
  layer.replaceChildren();
  if (reducedMotion()) return;
  const colors = ['#ffe5c0', '#a05f00', '#fff'];
  for (let i = 0; i < 30; i += 1) {
    const piece = document.createElement('span');
    piece.className = 'confetti';
    const size = 8 + (i % 4) * 3;
    piece.style.width = `${size}px`;
    piece.style.height = `${i % 2 ? size : 5}px`;
    piece.style.borderRadius = i % 5 === 0 ? '50%' : '2px';
    piece.style.background = colors[i % 3];
    layer.appendChild(piece);
    const angle = (i / 30) * Math.PI * 2 + Math.random() * 0.4;
    const distance = 90 + Math.random() * 150;
    const dx = Math.cos(angle) * distance;
    const dy = Math.sin(angle) * distance - 40;
    const rot = (Math.random() - 0.5) * 900;
    piece.animate(
      [
        { transform: 'translate(-50%, -50%) scale(0)', opacity: 1 },
        {
          transform: `translate(${dx}px, ${dy}px) scale(1) rotate(${rot / 2}deg)`,
          opacity: 1,
          offset: 0.45,
        },
        {
          transform: `translate(${dx * 1.15}px, ${dy + 220}px) scale(.9) rotate(${rot}deg)`,
          opacity: 0,
        },
      ],
      {
        duration: 1800 + Math.random() * 600,
        delay: Math.random() * 150,
        easing: 'cubic-bezier(.2,.7,.3,1)',
        fill: 'forwards',
      },
    );
  }
}

function fillParcours(root, items) {
  const card = root.querySelector('[data-parcours]');
  const list = root.querySelector('[data-parcours-list]');
  list.replaceChildren();
  if (!items.length) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  for (const item of items) {
    const block = document.createElement('div');
    block.className = 'path';
    const head = document.createElement('div');
    head.className = 'path-head';
    const name = document.createElement('span');
    name.className = 'path-name';
    name.textContent = upper(item.title);
    const count = document.createElement('span');
    count.className = 'path-count';
    count.textContent = `${item.visited} / ${item.total}`;
    head.append(name, count);
    const bar = document.createElement('div');
    bar.className = 'bar';
    const fill = document.createElement('span');
    const pct = Math.max(0, Math.min(100, (item.visited / item.total) * 100));
    fill.style.setProperty('--w', `${pct}%`);
    bar.append(fill);
    block.append(head, bar);
    list.append(block);
  }
}

function badgeName(item) {
  if (typeof item === 'string') return item.trim();
  if (item && typeof item.name === 'string') return item.name.trim();
  return '';
}

function fillBadges(root, badges) {
  const card = root.querySelector('[data-badges]');
  if (!Array.isArray(badges) || badges.length === 0) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const count = badges.length;
  root.querySelector('[data-badge-title]').textContent = count > 1
    ? `${count} BADGES T'ATTENDENT`
    : "1 BADGE T'ATTEND";
  const list = root.querySelector('[data-badge-names]');
  list.replaceChildren();
  for (const item of badges) {
    const name = badgeName(item);
    if (!name) continue;
    const li = document.createElement('li');
    li.textContent = name;
    list.append(li);
  }
}

function isIos() {
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function fillStores(root) {
  const link = root.querySelector('[data-download]');
  if (!link) return;
  const play = storeUrl(config.playStoreUrl);
  if (!isIos() && !play) {
    link.hidden = true;
    link.removeAttribute('href');
    return;
  }
  if (play) link.href = play;
  else link.removeAttribute('href');
  link.hidden = false;
}

function bindDownloadPrompt() {
  const soon = document.getElementById('soon');
  let soonLast = null;

  function openSoon(from) {
    if (!soon) return;
    soonLast = from || null;
    soon.hidden = false;
    const focus = soon.querySelector('[data-soon-focus]');
    if (focus) focus.focus();
  }

  function closeSoon() {
    if (!soon || soon.hidden) return;
    soon.hidden = true;
    if (soonLast && soonLast.focus) soonLast.focus();
  }

  document.addEventListener('click', function (event) {
    const el = event.target;
    if (!el || !el.closest) return;
    if (el.closest('[data-soon-close]')) {
      closeSoon();
      return;
    }
    const link = el.closest('[data-download]');
    if (!link) return;
    const screen = link.closest('[data-screen]');
    const props = {
      placement: 'claim',
      screen: screen ? screen.getAttribute('data-screen') || 'claim' : 'claim',
    };
    if (cafeName) props.cafe = cafeName.slice(0, 180);
    if (isIos()) {
      event.preventDefault();
      trackClaim('store_click', Object.assign({ store: 'ios_soon' }, props));
      openSoon(link);
      return;
    }
    trackClaim('store_click', Object.assign({ store: 'google_play' }, props));
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') closeSoon();
  });
}

function wholeCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count) || count < 1) return null;
  return Math.floor(count);
}

/** Same words as the app's visitPassageLabel. A repeat scan never reads as a first visit. */
function visitPassageLabel({ visitCount, isFirstVisit, alreadyCounted }) {
  const count = wholeCount(visitCount);
  if (alreadyCounted) {
    if (count != null && count >= 2) return `DÉJÀ VENU · ${count}e VISITE`;
    return 'DÉJÀ VENU';
  }
  if (isFirstVisit === true) return 'PREMIÈRE VISITE';
  if (count === 1 && isFirstVisit !== false) return 'PREMIÈRE VISITE';
  if (count != null && count >= 2) return `${count}e VISITE`;
  if (isFirstVisit === false) return 'DÉJÀ VENU';
  return null;
}

function paintVisitStatus(root, label) {
  const node = root.querySelector('[data-visit-status]');
  if (!node) return;
  if (!label) {
    node.hidden = true;
    node.textContent = '';
    return;
  }
  node.hidden = false;
  node.textContent = label;
}

function paintOutcome(root, { grains, badges, parcours, provider, email }) {
  fillParcours(root, parcours);
  fillBadges(root, badges);
  fillStores(root);
  root.querySelector('[data-method]').textContent = methodLine(provider, email);
  const pill = root.querySelector('[data-grains]');
  if (!pill) return null;
  const awarded = typeof grains === 'number' && Number.isFinite(grains);
  pill.hidden = !awarded;
  if (!awarded) return null;
  const node = pill.querySelector('[data-grains-n]');
  node.textContent = '0';
  return node;
}

function requireConfig() {
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    showBlocked(COPY.missingConfig, null);
    return null;
  }
  return createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { detectSessionInUrl: true, persistSession: true },
  });
}

async function readFunctionResult(data, error) {
  if (data?.code) return data;
  const response = error?.context;
  if (response && typeof response.json === 'function') {
    try {
      const body = await response.json();
      if (body?.code) return body;
    } catch {
      // fall through
    }
  }
  return { code: 'INTERNAL_ERROR' };
}

async function previewCafe(client) {
  const { data, error } = await client.functions.invoke('preview_badge_link', {
    body: { qr_token: token },
  });
  return readFunctionResult(data, error);
}

async function recordConsent(client, userId) {
  const now = new Date().toISOString();
  const { error } = await client.from('consents').insert({
    user_id: userId,
    cgu_version: CGU_VERSION,
    cgu_accepted_at: now,
    privacy_version: PRIVACY_VERSION,
    privacy_accepted_at: now,
  });
  if (!error || error.code === '23505') return;
  throw error;
}

function cafeDistance(position) {
  if (!Number.isFinite(cafeLat) || !Number.isFinite(cafeLng)) return null;
  return haversineMeters(
    { latitude: position.coords.latitude, longitude: position.coords.longitude },
    { latitude: cafeLat, longitude: cafeLng },
  );
}

function readPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('unsupported'));
      return;
    }

    let settled = false;
    let best = null;
    let watchId = 0;
    let timer = 0;

    const finish = (value, failed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (watchId) navigator.geolocation.clearWatch(watchId);
      if (failed) reject(value);
      else resolve(value);
    };

    timer = setTimeout(() => {
      if (best) finish(best, false);
      else finish(new Error('timeout'), true);
    }, POSITION_WAIT_MS);

    // accuracyMode asks Chrome for the precise-location upgrade prompt when
    // the site only has an approximate grant. Other browsers ignore it.
    watchId = navigator.geolocation.watchPosition(
      (position) => {
        const accuracy = position.coords.accuracy;
        const bestAccuracy = best?.coords.accuracy;
        if (
          !best ||
          (Number.isFinite(accuracy) &&
            (!Number.isFinite(bestAccuracy) || accuracy < bestAccuracy))
        ) {
          best = position;
        }
        const decision = classifyWebClaimFix({
          accuracyMeters: accuracy,
          distanceMeters: cafeDistance(position),
        });
        if (decision === 'send' || decision === 'far') finish(position, false);
      },
      (error) => {
        if (best) finish(best, false);
        else finish(error, true);
      },
      {
        enableHighAccuracy: true,
        accuracyMode: 'precise',
        timeout: POSITION_WAIT_MS,
        maximumAge: 0,
      },
    );
  });
}

async function loadParcours(client, userId, cafeId) {
  if (!userId || typeof cafeId !== 'string' || !cafeId) return [];
  try {
    const [paths, progress] = await Promise.all([
      client.from('parcours').select('id, title, cafe_order, status'),
      client.from('parcours_progress').select('parcours_id, visited_count, total_count').eq('user_id', userId),
    ]);
    if (paths.error || progress.error) return [];
    const byId = new Map((progress.data ?? []).map((row) => [row.parcours_id, row]));
    const items = [];
    for (const row of paths.data ?? []) {
      if (row.status !== 'active' && row.status !== 'preview') continue;
      const order = Array.isArray(row.cafe_order) ? row.cafe_order : [];
      if (!order.includes(cafeId)) continue;
      const prog = byId.get(row.id);
      const visited = Number(prog?.visited_count);
      const total = Number(prog?.total_count);
      if (!Number.isFinite(visited) || !Number.isFinite(total) || total <= 0) continue;
      if (typeof row.title !== 'string' || !row.title.trim()) continue;
      items.push({ title: row.title, visited, total });
    }
    return items;
  } catch {
    return [];
  }
}

function previewFailure(code) {
  if (code === 'INVALID_QR') return { message: COPY.invalidQr, retry: false };
  if (code === 'INACTIVE_CAFE') return { message: COPY.inactiveCafe, retry: false };
  if (code === 'RATE_LIMITED') return { message: COPY.rate, retry: true };
  return { message: COPY.generic, retry: true };
}

function claimFailure(result) {
  if (result.code === 'INVALID_QR') return { message: COPY.invalidQr, retry: null };
  if (result.code === 'INACTIVE_CAFE') return { message: COPY.inactiveCafe, retry: null };
  if (result.code === 'UNAUTHORIZED' && result.message === 'Consent required') {
    return { message: COPY.consent, retry: 'welcome' };
  }
  if (result.code === 'RATE_LIMITED') return { message: COPY.rate, retry: 'claim' };
  return { message: COPY.generic, retry: 'claim' };
}

async function claimVisit(provider) {
  if (claiming) return;
  claiming = true;
  showLocating();
  try {
    let position;
    try {
      position = await readPosition();
    } catch {
      showFar('denied');
      return;
    }

    const decision = classifyWebClaimFix({
      accuracyMeters: position.coords.accuracy,
      distanceMeters: cafeDistance(position),
    });
    if (decision === 'coarse' || decision === 'weak' || decision === 'far') {
      showFar(decision);
      return;
    }

    const { data: userData, error: userError } = await supabase.auth.getUser();
    const user = userData.user;
    if (userError || !user?.id) {
      show('welcome');
      return;
    }

    try {
      await recordConsent(supabase, user.id);
    } catch {
      showBlocked(COPY.generic, () => {
        void claimVisit(provider);
      });
      return;
    }

    const body = {
      qr_token: token,
      lat: position.coords.latitude,
      lng: position.coords.longitude,
    };
    if (Number.isFinite(position.coords.accuracy)) body.accuracy = position.coords.accuracy;

    const { data, error } = await supabase.functions.invoke('claim_badge_web', { body });
    const result = await readFunctionResult(data, error);

    if (STORE_CODES.has(result.code)) {
      const cafeId = typeof result.data?.cafe_id === 'string' ? result.data.cafe_id : '';
      const parcours = await loadParcours(supabase, user.id, cafeId);
      const email = user.email || pendingEmail || '';
      sessionStorage.removeItem(PROVIDER_KEY);
      sessionStorage.removeItem(CONSENT_KEY);
      const outcome = {
        badges: result.data?.unlocked_badges,
        parcours,
        provider,
        email,
      };
      const passage = visitPassageLabel({
        visitCount: result.data?.visit_count,
        isFirstVisit:
          result.data?.is_first_visit === true
            ? true
            : result.data?.is_first_visit === false
              ? false
              : null,
        alreadyCounted: result.code !== 'OK',
      });
      if (result.code === 'OK') {
        const grains = result.data?.grains_awarded;
        const grainsNode = paintOutcome(screens.done, { ...outcome, grains });
        paintVisitStatus(screens.done, passage);
        show('done');
        if (grainsNode) animateCount(grainsNode, grains);
        burst(screens.done.querySelector('[data-confetti]'));
      } else {
        paintOutcome(screens.already, outcome);
        paintVisitStatus(screens.already, passage);
        show('already');
      }
      return;
    }

    if (result.code === 'TOO_FAR') {
      showFar(webTooFarMode(position.coords.accuracy));
      return;
    }

    const failure = claimFailure(result);
    if (failure.retry === 'welcome') {
      showBlocked(failure.message, () => {
        sessionStorage.removeItem(CONSENT_KEY);
        cguInput.checked = false;
        syncCgu();
        show('welcome');
      });
      return;
    }
    showBlocked(failure.message, failure.retry ? () => { void claimVisit(provider); } : null);
  } finally {
    claiming = false;
  }
}

function openEmail() {
  if (!remember('email')) return;
  emailError.textContent = '';
  show('email');
  emailInput.focus();
}

async function signUp(event) {
  event.preventDefault();
  if (busy) return;
  const email = emailInput.value.trim();
  const password = passwordInput.value;
  const passwordProblem = passwordError(password);
  if (!email || passwordProblem) {
    emailError.textContent = passwordProblem ?? COPY.needEmail;
    return;
  }
  busy = true;
  emailError.textContent = '';
  try {
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) {
      emailError.textContent = COPY.signupFail;
      return;
    }
    if ((data.user?.identities?.length ?? 0) === 0) {
      emailError.textContent = COPY.accountExists;
      return;
    }
    pendingEmail = email;
    if (data.session) {
      show('why');
      return;
    }
    codeEmail.textContent = email;
    codeInput.value = '';
    renderDigits('');
    codeNote.textContent = '';
    show('code');
    codeInput.focus();
  } finally {
    busy = false;
  }
}

async function signIn() {
  if (busy) return;
  const email = emailInput.value.trim();
  const password = passwordInput.value;
  if (!email || !password) {
    emailError.textContent = COPY.needBoth;
    return;
  }
  busy = true;
  emailError.textContent = '';
  try {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      emailError.textContent = COPY.badLogin;
      return;
    }
    pendingEmail = email;
    show('why');
  } finally {
    busy = false;
  }
}

async function pasteCode() {
  let text = '';
  try {
    text = await navigator.clipboard.readText();
  } catch {
    return;
  }
  const digits = text.trim();
  if (!/^\d{6}$/.test(digits)) return;
  codeInput.value = digits;
  renderDigits(digits);
}

async function verifyCode() {
  if (busy) return;
  const otp = currentCode();
  if (otp.length !== 6) return;
  busy = true;
  codeNote.textContent = '';
  try {
    const { error } = await supabase.auth.verifyOtp({
      email: pendingEmail,
      token: otp,
      type: 'email',
    });
    if (error) {
      codeNote.textContent = COPY.badCode;
      return;
    }
    show('why');
  } finally {
    busy = false;
  }
}

async function resendCode() {
  if (busy || !pendingEmail) return;
  busy = true;
  codeNote.textContent = '';
  try {
    const { error } = await supabase.auth.resend({ type: 'signup', email: pendingEmail });
    codeNote.textContent = error ? COPY.resendFail : COPY.resendOk;
  } finally {
    busy = false;
  }
}

async function oauth(provider) {
  if (!supabase || !remember(provider) || busy) return;
  busy = true;
  const fail = provider === 'apple' ? COPY.appleFail : COPY.googleFail;
  try {
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: location.href },
    });
    if (error) welcomeError.textContent = fail;
  } catch {
    welcomeError.textContent = fail;
  } finally {
    busy = false;
  }
}

function bind() {
  cguRow.addEventListener('click', (event) => {
    if (event.target.closest('a')) return;
    if (event.target === cguInput) return;
    cguInput.checked = !cguInput.checked;
    syncCgu();
  });
  cguInput.addEventListener('change', syncCgu);
  cguInput.setAttribute('aria-labelledby', 'cgu-copy');

  document.querySelector('#apple').addEventListener('click', () => {
    void oauth('apple');
  });
  document.querySelector('#google').addEventListener('click', () => {
    void oauth('google');
  });
  document.querySelector('#email-go').addEventListener('click', openEmail);
  document.querySelector('#email-back').addEventListener('click', () => {
    show('welcome');
  });
  document.querySelector('#code-back').addEventListener('click', () => {
    show('email');
  });
  emailForm.addEventListener('submit', (event) => {
    void signUp(event);
  });
  document.querySelector('#email-in').addEventListener('click', () => {
    void signIn();
  });
  codeInput.addEventListener('input', () => {
    const next = currentCode();
    if (codeInput.value !== next) codeInput.value = next;
    renderDigits(next);
  });
  codeGrid.addEventListener('click', () => {
    codeInput.focus();
  });
  document.querySelector('#resend').addEventListener('click', () => {
    void resendCode();
  });
  codeGo.addEventListener('click', () => {
    if (currentCode().length < 6) {
      void pasteCode();
      return;
    }
    void verifyCode();
  });
  document.querySelector('#why-go').addEventListener('click', () => {
    show('geo');
  });
  document.querySelector('#geo-go').addEventListener('click', () => {
    const provider = sessionStorage.getItem(PROVIDER_KEY) || 'email';
    void claimVisit(provider);
  });
  farRetry.addEventListener('click', () => {
    if (farMode === 'coarse' || farMode === 'weak') {
      const provider = sessionStorage.getItem(PROVIDER_KEY) || 'email';
      void claimVisit(provider);
      return;
    }
    show('geo');
  });
}

async function start() {
  if (!token) {
    showBlocked(COPY.invalidQr, null);
    return;
  }

  supabase = requireConfig();
  if (!supabase) return;

  show('verify');
  const started = performance.now();
  let preview;
  try {
    preview = await previewCafe(supabase);
  } finally {
    const elapsed = performance.now() - started;
    if (elapsed < VERIFY_HOLD_MS) await wait(VERIFY_HOLD_MS - elapsed);
  }

  const name = preview.data?.name;
  if (preview.code !== 'OK' || typeof name !== 'string' || !name.trim()) {
    const failure = previewFailure(preview.code);
    showBlocked(failure.message, failure.retry ? () => { location.reload(); } : null);
    return;
  }

  cafeName = name.trim();
  const address = preview.data?.address;
  cafeAddress = typeof address === 'string' ? address.trim() : '';
  const latitude = Number(preview.data?.latitude);
  const longitude = Number(preview.data?.longitude);
  cafeLat = Number.isFinite(latitude) ? latitude : null;
  cafeLng = Number.isFinite(longitude) ? longitude : null;
  applyCafe();

  const { data: sessionData } = await supabase.auth.getSession();
  const provider = sessionStorage.getItem(PROVIDER_KEY);
  if (sessionData.session && sessionStorage.getItem(CONSENT_KEY) === '1' && provider) {
    show('why');
    return;
  }

  show('welcome');
}

drawQr();
armAppLinks();
bind();
bindDownloadPrompt();
renderDigits('');
start().catch(() => {
  showBlocked(COPY.generic, () => {
    location.reload();
  });
});
