import { expect, test } from 'bun:test';
import { Transmission } from '../../src/lib/rpc';

test('switching endpoint cancels old mutations before a session retry or stale response', async () => {
  const original = globalThis.fetch;
  const requests: string[] = [];
  let resolve!: (response: Response) => void;
  globalThis.fetch = (async (url) => {
    requests.push(String(url));
    return new Promise<Response>((done) => {
      resolve = done;
    });
  }) as typeof fetch;
  try {
    const rpc = new Transmission('http://old.test/rpc');
    const request = rpc.call('torrent-remove', { ids: [1], 'delete-local-data': true });
    const rejected = request.catch((error: Error) => error);
    rpc.endpoint = 'http://new.test/rpc';
    resolve(
      new Response('', { status: 409, headers: { 'X-Transmission-Session-Id': 'old-token' } }),
    );
    expect(await rejected).toBeInstanceOf(Error);
    expect(requests).toEqual(['http://old.test/rpc']);
    expect(rpc.token).toBe('');
    const read = rpc.call('session-get');
    const stale = read.catch((error: Error) => error);
    rpc.endpoint = 'http://third.test/rpc';
    resolve(Response.json({ result: 'success', arguments: { old: true } }));
    expect(await stale).toBeInstanceOf(Error);
  } finally {
    globalThis.fetch = original;
  }
});

test('409 negotiation, token reuse, and session rotation preserve RPC arguments', async () => {
  const original = globalThis.fetch;
  const requests: any[] = [];
  let round = 0;
  globalThis.fetch = (async (_url: any, init: any) => {
    requests.push(init);
    round++;
    if (round === 1)
      return new Response('', { status: 409, headers: { 'X-Transmission-Session-Id': 'first' } });
    if (round === 3)
      return new Response('', { status: 409, headers: { 'X-Transmission-Session-Id': 'rotated' } });
    return Response.json({ result: 'success', arguments: { ok: true } });
  }) as unknown as typeof fetch;
  try {
    const rpc = new Transmission('http://example.test/transmission/rpc');
    expect(await rpc.call('torrent-set', { ids: [9], downloadLimited: false })).toEqual({
      ok: true,
    });
    await rpc.call('session-get');
    expect(requests[1].headers['X-Transmission-Session-Id']).toBe('first');
    expect(requests[3].headers['X-Transmission-Session-Id']).toBe('rotated');
    expect(JSON.parse(requests[1].body).arguments.ids).toEqual([9]);
  } finally {
    globalThis.fetch = original;
  }
});
test('forbidden responses explain whitelist failures', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response('', { status: 403 })) as unknown as typeof fetch;
  try {
    await expect(new Transmission('http://example.test/rpc').call('session-get')).rejects.toThrow(
      'whitelist',
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('concurrent startup handshakes accept a token already learned by another request', async () => {
  const original = globalThis.fetch;
  let initial = 0;
  let release!: () => void;
  const bothStarted = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalThis.fetch = (async (_url: any, init: any) => {
    if (!init.headers['X-Transmission-Session-Id']) {
      if (++initial === 2) release();
      await bothStarted;
      return new Response('', {
        status: 409,
        headers: { 'X-Transmission-Session-Id': 'shared-session' },
      });
    }
    return Response.json({ result: 'success', arguments: { ok: true } });
  }) as typeof fetch;
  try {
    const rpc = new Transmission('http://example.test/rpc');
    expect(await Promise.all([rpc.call('torrent-get'), rpc.call('session-stats')])).toEqual([
      { ok: true },
      { ok: true },
    ]);
    expect(initial).toBe(2);
  } finally {
    globalThis.fetch = original;
  }
});
