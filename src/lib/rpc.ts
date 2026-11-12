import { requestDeadline } from './deadline';

export class RpcError extends Error {
  constructor(
    message: string,
    public status = 0,
  ) {
    super(message);
  }
}
export class Transmission {
  endpoint: string;
  token = '';
  username = '';
  password = '';
  constructor(endpoint = new URL('../rpc', location.href).href) {
    this.endpoint = endpoint;
  }
  async call<T = any>(
    method: string,
    args: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const deadline = requestDeadline(12000, signal);
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const requestToken = this.token;
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'X-Transmission-Session-Id': requestToken,
        };
        if (this.username)
          headers.Authorization = `Basic ${btoa(unescape(encodeURIComponent(`${this.username}:${this.password}`)))}`;
        let response: Response;
        try {
          response = await fetch(this.endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify({ method, arguments: args }),
            credentials: 'same-origin',
            signal: deadline.signal,
          });
        } catch (error) {
          if (signal?.aborted) throw error;
          throw new RpcError('Cannot reach Transmission. Check the address and connection.');
        }
        if (response.status === 409) {
          const next = response.headers.get('X-Transmission-Session-Id');
          if (!next || next === requestToken)
            throw new RpcError('Cannot negotiate an RPC session. Check proxy headers.', 409);
          this.token = next;
          continue;
        }
        if (!response.ok)
          throw new RpcError(
            response.status === 401
              ? 'Authentication required. Open connection settings.'
              : response.status === 403
                ? 'Access denied. Check Transmission’s RPC whitelist.'
                : `Transmission returned HTTP ${response.status}.`,
            response.status,
          );
        const result = await response.json();
        if (result.result !== 'success')
          throw new RpcError(result.result || 'Unexpected RPC response');
        return result.arguments as T;
      }
      throw new RpcError('RPC session changed repeatedly. Please reconnect.');
    } finally {
      deadline.dispose();
    }
  }
}
