import { handleStaticApiRequest } from './staticBackend';

let forceStaticMode = false;

function isKnownStaticOrigin(): boolean {
  if (typeof window === 'undefined') return false;
  const { hostname, protocol } = window.location;
  return hostname.endsWith('.github.io') || protocol === 'file:';
}

export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  if (!input.startsWith('/api/')) {
    return window.fetch(input, init);
  }

  if (forceStaticMode || isKnownStaticOrigin()) {
    return handleStaticApiRequest(input, init);
  }

  try {
    const res = await window.fetch(input, init);
    const contentType = (res.headers.get('content-type') || '').toLowerCase();

    // Static hosts (GitHub Pages, Netlify, Vercel static, Vite preview) return HTML or 404/405 without JSON on /api/*
    const looksLikeStaticHost =
      contentType.includes('text/html') ||
      ((res.status === 404 || res.status === 405 || res.status === 501) &&
        !contentType.includes('application/json'));

    if (looksLikeStaticHost) {
      forceStaticMode = true;
      return handleStaticApiRequest(input, init);
    }

    return res;
  } catch {
    // Offline / static preview without backend server
    forceStaticMode = true;
    return handleStaticApiRequest(input, init);
  }
}
