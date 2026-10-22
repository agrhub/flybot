import { describe, it, expect } from 'vitest';
import { approximateRadius, locationText } from '@/utils/location';

const t = (key, params) => ({ 'camosDevice.locationCell': `4G cell, ±${params?.m} m`, 'camosDevice.locationCellNoRadius': '4G cell' })[key];

describe('locationText', () => {
  it('shows a GPS fix as is, older firmware without source too', () => {
    expect(locationText({ lat: 10.123456, lng: 106.5, source: 'gps', accuracyM: 6 }, t)).toBe('10.12346, 106.50000');
    expect(locationText({ lat: 10.1, lng: 106.5 }, t)).toBe('10.10000, 106.50000');
  });

  it('marks a cell estimate as approximate, with its radius when known', () => {
    expect(locationText({ lat: 10.1, lng: 106.5, source: 'cell', accuracyM: 550 }, t)).toBe('≈ 10.10000, 106.50000 (4G cell, ±550 m)');
    expect(locationText({ lat: 10.1, lng: 106.5, source: 'cell' }, t)).toBe('≈ 10.10000, 106.50000 (4G cell)');
  });

  it('is empty without coordinates', () => {
    expect(locationText(null, t)).toBe('');
  });
});

describe('approximateRadius', () => {
  const cell = { lat: 10.1, lng: 106.5, source: 'cell', accuracyM: 550 };
  it('is the radius while the map position is the cell estimate', () => {
    expect(approximateRadius({ latitude: 10.1, longitude: 106.5, device: { location: cell } })).toBe(550);
  });

  it('is 0 for a position set by hand or a GPS fix', () => {
    expect(approximateRadius({ latitude: 10.2, longitude: 106.5, device: { location: cell } })).toBe(0);
    expect(approximateRadius({ latitude: 10.1, longitude: 106.5, device: { location: { ...cell, source: 'gps' } } })).toBe(0);
  });
});
