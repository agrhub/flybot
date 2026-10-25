import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { nextTick } from 'vue';
import fs from 'node:fs';
import path from 'node:path';
import en from '@/locales/en.json';
import vi_ from '@/locales/vi.json';
import { PAGE_TOURS } from '@/utils/pageTours';

const sources = () => {
  const files = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      if (fs.statSync(file).isDirectory()) walk(file);
      else if (name.endsWith('.vue')) files.push(fs.readFileSync(file, 'utf8'));
    }
  };
  walk(path.resolve(__dirname, '../../src'));
  return files.join('\n');
};

describe('page tours', () => {
  it('every step has a title and a text in both languages, and no text is left over', () => {
    for (const messages of [en, vi_]) {
      for (const [page, steps] of Object.entries(PAGE_TOURS)) {
        for (const step of steps) {
          expect(messages.tour.pages[page]?.[step.key]?.title, `${page}.${step.key}`).toBeTruthy();
          expect(messages.tour.pages[page]?.[step.key]?.desc, `${page}.${step.key}`).toBeTruthy();
        }
        expect(Object.keys(messages.tour.pages[page]).sort()).toEqual(steps.map(s => s.key).sort());
      }
      expect(Object.keys(messages.tour.pages).sort()).toEqual(Object.keys(PAGE_TOURS).sort());
    }
  });

  it('every step points at an element some page marks with data-tour', () => {
    const code = sources();
    const missing = Object.values(PAGE_TOURS).flat()
      .filter(step => step.target)
      // The Sentinel tabs are marked in a loop: data-tour="`sentinel-tab-${tab.name}`"
      .filter(step => !code.includes(`data-tour="${step.target}"`) && !code.includes(`data-tour="\`${step.target.replace(/-[a-z]+$/, '-')}\${`))
      .map(step => step.target);
    expect(missing).toEqual([]);
  });

  it('every page with a tour shows its tour button', () => {
    const code = sources();
    for (const page of [...Object.keys(PAGE_TOURS), 'dashboard']) {
      expect(code.includes(`tour="${page}"`) || code.includes(`'${page}'`) || code.includes(`page="${page}"`), page).toBe(true);
    }
  });
});

describe('usePageTour', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens on the first visit once the app tour is over, and not again', async () => {
    const { useAppTour } = await import('@/composables/useAppTour');
    const { usePageTour } = await import('@/composables/usePageTour');
    const app = useAppTour();
    const tour = usePageTour('cameras');

    // First sign-in: the app tour comes first
    tour.startIfNew(100);
    vi.advanceTimersByTime(500);
    expect(tour.open.value).toBe(false);
    app.start();
    await nextTick();
    app.finish();
    await nextTick();
    vi.advanceTimersByTime(100);
    expect(tour.open.value).toBe(true);

    tour.finish();
    expect(tour.open.value).toBe(false);
    expect(localStorage.getItem('flybot_tour_cameras_done')).toBe('1');

    // Seen: the next visit does not open it, the button still does
    tour.startIfNew(100);
    vi.advanceTimersByTime(500);
    expect(tour.open.value).toBe(false);
    tour.start();
    expect(tour.open.value).toBe(true);
  });

  it('does not open when the page is left before it starts', async () => {
    localStorage.setItem('flybot_tour_done', '1');
    const { usePageTour } = await import('@/composables/usePageTour');
    const tour = usePageTour('reports');
    const cancel = tour.startIfNew(100);
    cancel();
    vi.advanceTimersByTime(500);
    expect(tour.open.value).toBe(false);
  });
});
