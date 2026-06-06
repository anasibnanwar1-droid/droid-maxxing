import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { CdpClient, type CdpSocket } from './CdpClient.js';

class FakeSocket extends EventEmitter implements CdpSocket {
  readyState = 1;
  sent: unknown[] = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data) as unknown);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close');
  }
}

test('CdpClient matches responses by request id', async () => {
  const socket = new FakeSocket();
  const client = new CdpClient(() => socket);
  await client.connect('ws://test');

  const result = client.send<{ value: number }>('Runtime.evaluate', { expression: '1 + 1' });

  assert.deepEqual(socket.sent[0], { id: 1, method: 'Runtime.evaluate', params: { expression: '1 + 1' } });
  socket.emit('message', JSON.stringify({ id: 1, result: { value: 2 } }));
  assert.deepEqual(await result, { value: 2 });
});

test('CdpClient rejects CDP errors with method context', async () => {
  const socket = new FakeSocket();
  const client = new CdpClient(() => socket);
  await client.connect('ws://test');

  const result = client.send('Page.navigate', { url: 'bad' });
  socket.emit('message', JSON.stringify({ id: 1, error: { code: -1, message: 'navigation failed' } }));

  await assert.rejects(result, /CDP Page.navigate failed: navigation failed/);
});

test('CdpClient times out stuck requests', async () => {
  const socket = new FakeSocket();
  const client = new CdpClient(() => socket);
  await client.connect('ws://test');

  await assert.rejects(client.send('Runtime.evaluate', {}, 1), /timed out/);
});
