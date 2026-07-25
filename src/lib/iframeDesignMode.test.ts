import assert from 'node:assert/strict';
import test from 'node:test';
import { hoverIframe, selectOptionIframe, stableDesignHash } from './iframeDesignMode';

test('stableDesignHash distinguishes selectors that collide under a 32-bit polynomial hash', () => {
  assert.notEqual(stableDesignHash('Aa'), stableDesignHash('BB'));
  assert.equal(stableDesignHash('#submit'), stableDesignHash('#submit'));
});

test('hoverIframe dispatches pointer-compatible mouse events', async () => {
  const events: string[] = [];
  class FakeMouseEvent {
    constructor(readonly type: string) {}
  }
  const target = {
    dispatchEvent(event: FakeMouseEvent) {
      events.push(event.type);
    },
  };
  const iframe = {
    contentDocument: {
      querySelector: () => target,
      elementFromPoint: () => null,
    },
    contentWindow: { MouseEvent: FakeMouseEvent },
  } as unknown as HTMLIFrameElement;

  await hoverIframe(iframe, 12, 34, '#account');

  assert.deepEqual(events, ['mouseover', 'mouseenter', 'mousemove']);
});

test('selectOptionIframe accepts an exact visible label and emits input events', async () => {
  const events: string[] = [];
  class FakeEvent {
    constructor(readonly type: string) {}
  }
  class FakeSelect {
    value = '';
    options = [
      { value: 'us', text: 'United States' },
      { value: 'ca', text: 'Canada' },
    ];

    dispatchEvent(event: FakeEvent) {
      events.push(event.type);
    }
  }
  const select = new FakeSelect();
  const iframe = {
    contentDocument: { querySelector: () => select },
    contentWindow: {
      Event: FakeEvent,
      HTMLSelectElement: FakeSelect,
    },
  } as unknown as HTMLIFrameElement;

  await selectOptionIframe(iframe, '#country', 'Canada');

  assert.equal(select.value, 'ca');
  assert.deepEqual(events, ['input', 'change']);
});
