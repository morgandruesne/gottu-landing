import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';

const CGU_VERSION = '2026-10';
const PRIVACY_VERSION = '2026-10';
const PROVIDER_KEY = 'gottu.claim.provider';
const CONSENT_KEY = 'gottu.claim.consent';

const STORE_CODES = new Set(['OK', 'RECENTLY_VISITED', 'ALREADY_VISITED']);

const BLOCKED_COPY = {
  INVALID_QR: "Ce QR n'est pas valide.",
  INACTIVE_CAFE: "Ce café n'est pas disponible.",
  LOCATION_REQUIRED: 'Active la localisation et réessaie.',
  TOO_FAR: "Tu n'es pas assez près du café.",
  INTERNAL_ERROR: "Réessaie, la visite n'a pas été enregistrée.",
  BAD_REQUEST: "Réessaie, la visite n'a pas été enregistrée.",
  RATE_LIMITED: 'Réessaie dans un moment.',
};

const title = document.querySelector('#title');
const lead = document.querySelector('#lead');
const panel = document.querySelector('#panel');
const openApp = document.querySelector('#open-app');

const config = window.GOTTU_CLAIM ?? {};
const token = new URLSearchParams(location.search).get('t')?.trim() ?? '';

function methodLabel(provider) {
  if (provider === 'apple') return 'Apple';
  if (provider === 'google') return 'Google';
  return 'e-mail';
}

function showAppLink(visible) {
  if (!token) {
    openApp.classList.add('hidden');
    return;
  }
  openApp.href = `gottu://b?t=${encodeURIComponent(token)}`;
  openApp.classList.toggle('hidden', !visible);
}

function setBlocked(message, retry) {
  title.textContent = 'Visite non enregistrée';
  lead.textContent = message;
  panel.classList.remove('hidden');
  panel.innerHTML = retry
    ? '<button class="primary" type="button" id="retry">Réessayer</button>'
    : '';
  showAppLink(true);
  document.querySelector('#retry')?.addEventListener('click', retry);
}

function storeLinks() {
  const links = [];
  if (config.appStoreUrl) {
    links.push(`<a class="secondary store" href="${config.appStoreUrl}">Télécharger sur l'App Store</a>`);
  }
  if (config.playStoreUrl) {
    links.push(`<a class="secondary store" href="${config.playStoreUrl}">Télécharger sur le Play Store</a>`);
  }
  return links.join('');
}

function showSuccess(code, provider) {
  const method = methodLabel(provider);
  const recorded = code === 'OK';
  title.textContent = recorded ? 'Visite enregistrée' : 'Tu as déjà badgé ici';
  lead.textContent = recorded
    ? `Dans l'app, connecte-toi avec ${method}.`
    : `Dans l'app, connecte-toi avec ${method} pour voir ta carte.`;
  panel.classList.remove('hidden');
  panel.innerHTML = storeLinks();
  showAppLink(false);
}

function utf8Size(value) {
  return new TextEncoder().encode(value).length;
}

function passwordError(password) {
  if (password.length < 8) return 'Le mot de passe doit faire au moins 8 caractères.';
  if (utf8Size(password) > 72) return 'Le mot de passe est trop long.';
  return null;
}

function requireConfig() {
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    setBlocked('Cette page n’est pas encore configurée.', null);
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

async function previewCafe(supabase) {
  const { data, error } = await supabase.functions.invoke('preview_badge_link', {
    body: { qr_token: token },
  });
  return readFunctionResult(data, error);
}

async function recordConsent(supabase, userId) {
  const now = new Date().toISOString();
  const { error } = await supabase.from('consents').insert({
    user_id: userId,
    cgu_version: CGU_VERSION,
    cgu_accepted_at: now,
    privacy_version: PRIVACY_VERSION,
    privacy_accepted_at: now,
  });
  if (!error || error.code === '23505') return;
  throw error;
}

function readPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('unsupported'));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 12000,
      maximumAge: 0,
    });
  });
}

async function claimVisit(supabase, provider) {
  title.textContent = 'Enregistrement…';
  lead.textContent = 'On vérifie que tu es au café.';
  panel.classList.add('hidden');
  showAppLink(false);

  let position;
  try {
    position = await readPosition();
  } catch {
    setBlocked(BLOCKED_COPY.LOCATION_REQUIRED, () => {
      void claimVisit(supabase, provider);
    });
    return;
  }

  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) {
    renderAuth(supabase, null);
    return;
  }

  try {
    await recordConsent(supabase, userId);
  } catch {
    setBlocked(BLOCKED_COPY.INTERNAL_ERROR, () => {
      void claimVisit(supabase, provider);
    });
    return;
  }

  const { data, error } = await supabase.functions.invoke('claim_badge_web', {
    body: {
      qr_token: token,
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      ...(Number.isFinite(position.coords.accuracy) ? { accuracy: position.coords.accuracy } : {}),
    },
  });
  const result = await readFunctionResult(data, error);

  if (STORE_CODES.has(result.code)) {
    sessionStorage.removeItem(PROVIDER_KEY);
    sessionStorage.removeItem(CONSENT_KEY);
    showSuccess(result.code, provider);
    return;
  }

  const message =
    result.code === 'UNAUTHORIZED' && result.message === 'Consent required'
      ? 'Accepte les conditions, puis réessaie.'
      : (BLOCKED_COPY[result.code] ?? BLOCKED_COPY.INTERNAL_ERROR);

  const canRetry = result.code !== 'INVALID_QR' && result.code !== 'INACTIVE_CAFE';
  setBlocked(message, canRetry ? () => { void claimVisit(supabase, provider); } : null);
}

function renderAuth(supabase, cafeName) {
  title.textContent = cafeName ? `Tu es chez ${cafeName}` : 'Garder cette visite';
  lead.textContent = 'Crée ton compte ici. La visite est enregistrée avant le téléchargement.';
  panel.classList.remove('hidden');
  panel.innerHTML = `
    <label class="check">
      <input id="consent" type="checkbox">
      <span>J'accepte les <a class="inline" href="/cgu.html">CGU</a> et la <a class="inline" href="/confidentialite.html">politique de confidentialité</a>.</span>
    </label>
    <p class="alert hidden" id="form-error"></p>
    <button class="primary" type="button" id="apple">Continuer avec Apple</button>
    <button class="secondary" type="button" id="google">Continuer avec Google</button>
    <label for="email">E-mail</label>
    <input id="email" type="email" autocomplete="email" inputmode="email">
    <label for="password">Mot de passe</label>
    <input id="password" type="password" autocomplete="new-password">
    <button class="primary" type="button" id="email-new">Créer le compte</button>
    <button class="ghost" type="button" id="email-in">J'ai déjà un compte</button>
    <div id="otp-box" class="hidden">
      <label for="otp">Code à 6 chiffres</label>
      <input id="otp" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6">
      <button class="primary" type="button" id="otp-go">Valider le code</button>
    </div>
  `;
  showAppLink(true);

  const errorLine = panel.querySelector('#form-error');
  const showError = (message) => {
    errorLine.textContent = message;
    errorLine.classList.remove('hidden');
  };

  const consentChecked = () => panel.querySelector('#consent').checked;

  const remember = (provider) => {
    if (!consentChecked()) {
      showError('Accepte les conditions pour garder cette visite.');
      return false;
    }
    sessionStorage.setItem(CONSENT_KEY, '1');
    sessionStorage.setItem(PROVIDER_KEY, provider);
    return true;
  };

  panel.querySelector('#apple').addEventListener('click', async () => {
    if (!remember('apple')) return;
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'apple',
      options: { redirectTo: location.href },
    });
    if (error) showError("Apple n'a pas pu ouvrir la connexion. Réessaie.");
  });

  panel.querySelector('#google').addEventListener('click', async () => {
    if (!remember('google')) return;
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: location.href },
    });
    if (error) showError("Google n'a pas pu ouvrir la connexion. Réessaie.");
  });

  panel.querySelector('#email-new').addEventListener('click', async () => {
    if (!remember('email')) return;
    const email = panel.querySelector('#email').value.trim();
    const password = panel.querySelector('#password').value;
    const passwordProblem = passwordError(password);
    if (!email || passwordProblem) {
      showError(passwordProblem ?? 'Indique ton e-mail.');
      return;
    }
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) {
      showError("Le compte n'a pas pu être créé. Réessaie.");
      return;
    }
    if ((data.user?.identities?.length ?? 0) === 0) {
      showError('Ce compte existe déjà. Connecte-toi.');
      return;
    }
    if (data.session) {
      await claimVisit(supabase, 'email');
      return;
    }
    panel.querySelector('#otp-box').classList.remove('hidden');
    showError('Entre le code reçu par e-mail.');
  });

  panel.querySelector('#email-in').addEventListener('click', async () => {
    if (!remember('email')) return;
    const email = panel.querySelector('#email').value.trim();
    const password = panel.querySelector('#password').value;
    if (!email || !password) {
      showError('Indique ton e-mail et ton mot de passe.');
      return;
    }
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      showError('E-mail ou mot de passe incorrect.');
      return;
    }
    await claimVisit(supabase, 'email');
  });

  panel.querySelector('#otp-go').addEventListener('click', async () => {
    const email = panel.querySelector('#email').value.trim();
    const otp = panel.querySelector('#otp').value.trim();
    const { error } = await supabase.auth.verifyOtp({ email, token: otp, type: 'email' });
    if (error) {
      showError('Ce code ne marche pas. Réessaie.');
      return;
    }
    await claimVisit(supabase, 'email');
  });
}

async function start() {
  if (!token) {
    setBlocked(BLOCKED_COPY.INVALID_QR, null);
    return;
  }

  const supabase = requireConfig();
  if (!supabase) return;

  const preview = await previewCafe(supabase);
  if (preview.code === 'INVALID_QR' || preview.code === 'INACTIVE_CAFE') {
    setBlocked(BLOCKED_COPY[preview.code], null);
    return;
  }
  if (preview.code !== 'OK' || !preview.data?.name) {
    setBlocked(BLOCKED_COPY[preview.code] ?? BLOCKED_COPY.INTERNAL_ERROR, () => {
      location.reload();
    });
    return;
  }

  const { data: sessionData } = await supabase.auth.getSession();
  const provider = sessionStorage.getItem(PROVIDER_KEY);
  if (sessionData.session && sessionStorage.getItem(CONSENT_KEY) === '1' && provider) {
    title.textContent = `Tu es chez ${preview.data.name}`;
    await claimVisit(supabase, provider);
    return;
  }

  renderAuth(supabase, preview.data.name);
}

start().catch(() => {
  setBlocked(BLOCKED_COPY.INTERNAL_ERROR, () => {
    location.reload();
  });
});
