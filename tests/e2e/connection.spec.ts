import { expect, test } from '@playwright/test';

for (const rejectOld of [false, true]) {
  test(`connection switch ignores an old poll's ${rejectOld ? 'failure' : 'response'}`, async ({
    page,
  }) => {
    await page.route(/\/rpc$/, (route) =>
      route.fulfill({
        json: { result: 'success', arguments: { torrents: [], downloadSpeed: 0, uploadSpeed: 0 } },
      }),
    );
    await page.goto('/');
    const result = await page.evaluate(async (rejectOld) => {
      const path = '/src/lib/client.svelte.ts';
      const { Client } = await import(path);
      const client = new Client();
      client.changeConnection('http://old.test/rpc', '', '');
      client.loadCapabilities = client.loadHistory = async () => {};
      let finish!: (value: unknown) => void;
      let fail!: (reason: Error) => void;
      client.rpc.call = async (method: string) => {
        if (method === 'torrent-get') {
          if (client.rpc.endpoint.includes('old.test'))
            return new Promise((resolve, reject) => {
              finish = resolve;
              fail = reject;
            });
          return { torrents: [{ id: 1, name: 'New server', hashString: 'b'.repeat(40) }] };
        }
        return {};
      };
      client.selected = [1];
      const old = client.poll();
      client.changeConnection('http://new.test/rpc', '', '');
      await client.poll(true);
      if (rejectOld) fail(new Error('Old connection failed'));
      else finish({ torrents: [{ id: 1, name: 'Old server', hashString: 'a'.repeat(40) }] });
      await old;
      return {
        name: client.torrents[0]?.name,
        online: client.online,
        selected: [...client.selected],
        error: client.error,
      };
    }, rejectOld);
    expect(result).toEqual({ name: 'New server', online: true, selected: [], error: '' });
  });
}
