import { getSetting } from './db.js';

/**
 * PocketID / OpenID Connect Helper Module
 * Checks SQLite settings table first, falling back to process.env
 */

async function discoverEndpoints(issuerUrl) {
  const cleanIssuer = issuerUrl.replace(/\/+$/, '');
  const wellKnownUrl = `${cleanIssuer}/.well-known/openid-configuration`;

  try {
    const res = await fetch(wellKnownUrl, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const discovery = await res.json();
      return {
        authorization_endpoint: discovery.authorization_endpoint,
        token_endpoint: discovery.token_endpoint,
        userinfo_endpoint: discovery.userinfo_endpoint
      };
    }
  } catch (e) {
    console.warn('[OIDC Discovery Warning] Fallback to standard PocketID paths:', e.message);
  }

  return {
    authorization_endpoint: `${cleanIssuer}/authorize`,
    token_endpoint: `${cleanIssuer}/token`,
    userinfo_endpoint: `${cleanIssuer}/userinfo`
  };
}

export async function getOidcAuthUrl(hostHeader) {
  const enabled = getSetting('oidc_enabled', process.env.OIDC_ENABLED || 'false');
  if (enabled !== 'true' && enabled !== true && enabled !== '1') {
    return { error: 'OIDC authentication is currently disabled. Log in with password, open ⚙️ Settings & Alerts, and enable PocketID OIDC.' };
  }

  const issuer = getSetting('oidc_issuer', process.env.OIDC_ISSUER || '');
  const clientId = getSetting('oidc_client_id', process.env.OIDC_CLIENT_ID || '');
  const redirectUriSetting = getSetting('oidc_redirect_uri', process.env.OIDC_REDIRECT_URI || '');

  if (!issuer) {
    return { error: 'Missing PocketID Issuer URL. Please configure OIDC Issuer URL in Admin ⚙️ Settings.' };
  }
  if (!clientId) {
    return { error: 'Missing PocketID Client ID. Please configure OIDC Client ID in Admin ⚙️ Settings.' };
  }

  const protocol = hostHeader && hostHeader.includes('localhost') ? 'http' : 'https';
  const redirectUri = redirectUriSetting || `${protocol}://${hostHeader}/api/v1/auth/oidc/callback`;

  const endpoints = await discoverEndpoints(issuer);
  const state = Math.random().toString(36).substring(2, 15);

  const authUrl = new URL(endpoints.authorization_endpoint);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid profile email');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);

  return { url: authUrl.toString(), state, redirectUri };
}

export async function processOidcCallback(code, hostHeader) {
  const issuer = getSetting('oidc_issuer', process.env.OIDC_ISSUER || '');
  const clientId = getSetting('oidc_client_id', process.env.OIDC_CLIENT_ID || '');
  const clientSecret = getSetting('oidc_client_secret', process.env.OIDC_CLIENT_SECRET || '');
  const redirectUriSetting = getSetting('oidc_redirect_uri', process.env.OIDC_REDIRECT_URI || '');

  if (!issuer || !clientId || !code) {
    throw new Error('Missing OIDC configuration or authorization code');
  }

  const protocol = hostHeader && hostHeader.includes('localhost') ? 'http' : 'https';
  const redirectUri = redirectUriSetting || `${protocol}://${hostHeader}/api/v1/auth/oidc/callback`;

  const endpoints = await discoverEndpoints(issuer);

  const bodyParams = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret
  });

  const tokenRes = await fetch(endpoints.token_endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json'
    },
    body: bodyParams.toString()
  });

  if (!tokenRes.ok) {
    const errorText = await tokenRes.text();
    throw new Error(`Token exchange failed (${tokenRes.status}): ${errorText}`);
  }

  const tokens = await tokenRes.json();
  const accessToken = tokens.access_token;

  if (!accessToken) {
    throw new Error('No access_token returned by PocketID provider');
  }

  // Fetch User Info
  let user = { username: 'Admin' };
  if (endpoints.userinfo_endpoint) {
    try {
      const userRes = await fetch(endpoints.userinfo_endpoint, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      if (userRes.ok) {
        user = await userRes.json();
      }
    } catch (e) {
      console.warn('[OIDC Userinfo Error]', e.message);
    }
  }

  return { tokens, user };
}
