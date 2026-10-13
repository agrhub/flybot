import { ref, computed } from 'vue';

// Same edges as Tailwind md / xl: phone < 768 <= tablet < 1280 <= desktop
const TABLET_MIN = 768;
const DESKTOP_MIN = 1280;

// Singleton, updated by matchMedia (no resize polling)
const width = ref(typeof window !== 'undefined' ? window.innerWidth : DESKTOP_MIN);

if (typeof window !== 'undefined' && window.matchMedia) {
  for (const query of [`(min-width: ${TABLET_MIN}px)`, `(min-width: ${DESKTOP_MIN}px)`]) {
    window.matchMedia(query).addEventListener('change', () => {
      width.value = window.innerWidth;
    });
  }
}

export function useBreakpoints() {
  const isMobile = computed(() => width.value < TABLET_MIN);
  const isTablet = computed(() => width.value >= TABLET_MIN && width.value < DESKTOP_MIN);
  const isDesktop = computed(() => width.value >= DESKTOP_MIN);
  return { width, isMobile, isTablet, isDesktop };
}

export default useBreakpoints;
