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
  private address: string;
  private connection = new AbortController();
  get endpoint() {
    return this.address;
  }
  set endpoint(value: string) {
    this.connection.abort();
    this.connection = new AbortController();
    this.token = '';
    this.address = value;
  }
  token = '';
  username = '';
  password = '';
  constructor(endpoint = new URL('../rpc', location.href).href) {
    this.address = endpoint;
  }
  async call<T = any>(
    method: string,
    args: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const connection = this.connection;
    const endpoint = this.endpoint;
    const username = this.username,
      password = this.password;
    const current = () => {
      if (connection !== this.connection || connection.signal.aborted)
        throw new RpcError('Connection changed; request cancelled');
    };
    const deadline = requestDeadline(12000, signal, connection.signal);
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        current();
        const requestToken = this.token;
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'X-Transmission-Session-Id': requestToken,
        };
        if (username)
          headers.Authorization = `Basic ${btoa(unescape(encodeURIComponent(`${username}:${password}`)))}`;
        let response: Response;
        try {
          response = await fetch(endpoint, {
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
        current();
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
        current();
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
