import { ref, computed, watch } from 'vue';
import { useAppTour } from './useAppTour';

// One tour per page (cameras, reports, ...): shown once per browser on the page's first visit, after the app
// tour; the tour button in the page header shows it again
const active = ref('');
const doneKey = (page) => `flybot_tour_${page}_done`;

const readDone = (page) => {
  try {
    return localStorage.getItem(doneKey(page)) === '1';
  } catch {
    return true;
  }
};

export function usePageTour(page) {
  const app = useAppTour();
  const open = computed(() => active.value === page);
  const start = () => {
    active.value = page;
  };
  const finish = () => {
    if (active.value === page) active.value = '';
    try {
      localStorage.setItem(doneKey(page), '1');
    } catch {
      // Private mode: the tour may show again next time
    }
  };
  // First visit only, once the app tour is over and the page has had a moment to show its controls.
  // Returns a function that cancels the wait (the page left first)
  const startIfNew = (delay = 1200) => {
    if (readDone(page)) return () => {};
    let timer = null;
    const stop = watch(
      () => app.open.value,
      (appOpen) => {
        clearTimeout(timer);
        if (appOpen || !app.isDone()) return;
        timer = setTimeout(() => {
          stop();
          start();
        }, delay);
      },
      { immediate: true }
    );
    return () => {
      stop();
      clearTimeout(timer);
    };
  };
  return { open, start, finish, startIfNew };
}
