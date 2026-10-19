import { describe, it, expect } from 'vitest';
import { farmsOf, filterDensity, pageOf } from '@/utils/densityList';

const list = [
  { deviceSerial: 'SIM-CAIBE-1', deviceName: 'SIM · Cái Bè mango 1', farmId: 'f1', farmName: 'Cái Bè mango orchard', status: 1, trapKind: 'sticky' },
  { deviceSerial: 'SIM-CAIBE-2', deviceName: 'SIM · Cái Bè mango 2', farmId: 'f1', farmName: 'Cái Bè mango orchard', status: 1, trapKind: 'lure' },
  { deviceSerial: 'SIM-LUCNGAN-2', deviceName: 'SIM · Lục Ngạn lychee 2', farmId: 'f2', farmName: 'Lục Ngạn lychee orchard', status: 0, trapKind: 'lure' },
  { deviceSerial: 'BE4089629', deviceName: 'Lure trap A', farmId: null, status: 1, trapKind: 'lure' }
];

describe('density list', () => {
  it('lists the farms once, by name', () => {
    expect(farmsOf(list)).toEqual([{ id: 'f1', name: 'Cái Bè mango orchard' }, { id: 'f2', name: 'Lục Ngạn lychee orchard' }]);
  });

  it('filters by search (name or serial), farm, status and trap kind, together', () => {
    expect(filterDensity(list, { search: 'lychee' }).map(c => c.deviceSerial)).toEqual(['SIM-LUCNGAN-2']);
    expect(filterDensity(list, { search: 'be4089' }).map(c => c.deviceSerial)).toEqual(['BE4089629']);
    expect(filterDensity(list, { farm: 'f1' })).toHaveLength(2);
    expect(filterDensity(list, { status: 'offline' }).map(c => c.deviceSerial)).toEqual(['SIM-LUCNGAN-2']);
    expect(filterDensity(list, { kind: 'lure', status: 'online' }).map(c => c.deviceSerial)).toEqual(['SIM-CAIBE-2', 'BE4089629']);
    expect(filterDensity(list, {})).toHaveLength(4);
  });

  it('pages', () => {
    expect(pageOf(list, 1, 3)).toHaveLength(3);
    expect(pageOf(list, 2, 3).map(c => c.deviceSerial)).toEqual(['BE4089629']);
  });
});
