import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = [];
let behaviour = () => Promise.resolve({ data: {} });
vi.mock('@/services/api', () => ({
  default: {
    createTreatment: vi.fn((body) => { calls.push(['treatment', body]); return behaviour(body); }),
    addMaintenance: vi.fn((body) => { calls.push(['maintenance', body]); return behaviour(body); })
  }
}));

localStorage.setItem('user', JSON.stringify({ id: 'u1' }));
const { enqueue, flush, removeItem, useOutbox, newClientId, isNetworkError } = await import('@/composables/useOutbox');
const offline = () => Promise.reject(Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' }));
const refused = () => Promise.reject({ response: { status: 404, data: { message: 'Camera not found or you cannot manage it.' } } });

describe('field work recorded without signal', () => {
  beforeEach(() => {
    calls.length = 0;
    behaviour = () => Promise.resolve({ data: {} });
    for (const item of useOutbox().items.value) removeItem(item.id);
  });

  it('waits on the device, per person, and is sent in order once online', async () => {
    enqueue('treatment', { clientId: 'aaaaaaaa-1', product: 'Radiant' }, 'Spray · Radiant');
    enqueue('maintenance', { clientId: 'bbbbbbbb-2', type: 'card_replaced', at: '2026-10-13T01:00:00Z' }, 'Card');
    expect(JSON.parse(localStorage.getItem('flybot_outbox_u1')).length).toBe(2);
    expect(useOutbox().pending.value.length).toBe(2);

    expect(await flush()).toBe(2);
    expect(calls.map(([kind, body]) => [kind, body.clientId])).toEqual([['treatment', 'aaaaaaaa-1'], ['maintenance', 'bbbbbbbb-2']]);
    expect(useOutbox().items.value).toEqual([]);
  });

  it('still offline: nothing is lost and the next items are not tried', async () => {
    enqueue('treatment', { clientId: 'cccccccc-3' }, 'A');
    enqueue('treatment', { clientId: 'dddddddd-4' }, 'B');
    behaviour = offline;
    expect(await flush()).toBe(0);
    expect(calls.length).toBe(1);
    expect(useOutbox().pending.value.map((i) => i.id)).toEqual(['cccccccc-3', 'dddddddd-4']);
  });

  it('a refusal is kept with its reason and does not block the rest', async () => {
    enqueue('maintenance', { clientId: 'eeeeeeee-5' }, 'Card · Trap A1');
    enqueue('treatment', { clientId: 'ffffffff-6' }, 'Spray');
    behaviour = (body) => (body.clientId === 'eeeeeeee-5' ? refused() : Promise.resolve({ data: {} }));
    expect(await flush()).toBe(1);
    const { failed, pending } = useOutbox();
    expect(pending.value).toEqual([]);
    expect(failed.value.map((i) => [i.id, i.error])).toEqual([['eeeeeeee-5', 'Camera not found or you cannot manage it.']]);
    // A refused item is not sent again by itself
    calls.length = 0;
    await flush();
    expect(calls).toEqual([]);
  });

  it('helpers: ids are unique, network errors are told from refusals', () => {
    expect(newClientId()).not.toBe(newClientId());
    expect(newClientId()).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    expect(isNetworkError({ code: 'ERR_NETWORK' })).toBe(true);
    expect(isNetworkError({ response: { status: 400 } })).toBe(false);
    expect(isNetworkError({ code: 'ERR_CANCELED' })).toBe(false);
  });
});
