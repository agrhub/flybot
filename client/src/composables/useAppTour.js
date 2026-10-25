import { ref } from 'vue';

// Shown once per browser on the first visit; "Quick tour" in the profile menu shows it again
const DONE_KEY = 'flybot_tour_done';
const open = ref(false);

const readDone = () => {
  try {
    return localStorage.getItem(DONE_KEY) === '1';
  } catch {
    return true;
  }
};

export function useAppTour() {
  const start = () => {
    open.value = true;
  };
  const finish = () => {
    open.value = false;
    try {
      localStorage.setItem(DONE_KEY, '1');
    } catch {
      // Private mode: the tour may show again next time
    }
  };
  // First visit only
  const startIfNew = () => {
    if (!readDone()) start();
  };
  return { open, start, finish, startIfNew, isDone: readDone };
}
