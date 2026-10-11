export class ApiError extends Error {
  constructor(readonly status: number, readonly detail: unknown) {
    super(`HTTP ${status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  }
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  if (!res.ok) {
    const detail = body && typeof body === 'object' && 'detail' in body ? (body as { detail: unknown }).detail : body;
    throw new ApiError(res.status, detail);
  }
  return body as T;
}

export async function getJson<T>(url: string): Promise<T> {
  return parse<T>(await fetch(url, { cache: 'no-store' }));
}

/** POST a JSON body; pass a string to send pre-serialised JSON. */
export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return parse<T>(res);
}
