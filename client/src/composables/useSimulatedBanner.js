import { ref } from 'vue';

/**
 * The simulated-data banner can fold into a "Simulated" tag in the top bar (and open again from it), remembered per
 * browser. The data stays marked either way: trap names, tags and the top-bar tag.
 */
const KEY = 'flybot.simulatedBanner.collapsed';

const read = () => {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
};
const collapsed = ref(read());
// False while a page shows only real items (e.g. a real camera's own page): no banner and no tag there
const inView = ref(true);

const save = (value) => {
  collapsed.value = value;
  try { localStorage.setItem(KEY, value ? '1' : '0'); } catch { /* private mode: only this page view */ }
};

export function useSimulatedBanner() {
  return {
    collapsed,
    collapse: () => save(true),
    expand: () => save(false),
    inView,
    /** A page that shows one item says whether it is simulated; reset to true when it closes. */
    setInView: (value) => { inView.value = value !== false; },
  };
}
