import { ref, watch } from 'vue';

const isDark = ref(localStorage.getItem('smart_trap_theme') !== 'light'); // Default to dark mode
const isAssistantOpen = ref(false);

export function useTheme() {
  const initTheme = () => {
    if (isDark.value) {
      document.documentElement.classList.add('dark');
      document.documentElement.classList.remove('light');
      document.body.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
      document.documentElement.classList.add('light');
      document.body.classList.remove('dark');
    }
  };

  const toggleTheme = () => {
    isDark.value = !isDark.value;
    localStorage.setItem('smart_trap_theme', isDark.value ? 'dark' : 'light');
    initTheme();
  };

  const toggleAssistant = () => {
    isAssistantOpen.value = !isAssistantOpen.value;
  };

  const closeAssistant = () => {
    isAssistantOpen.value = false;
  };

  const openAssistant = () => {
    isAssistantOpen.value = true;
  };

  // Watch and apply
  watch(isDark, () => {
    initTheme();
  });

  return {
    isDark,
    isAssistantOpen,
    initTheme,
    toggleTheme,
    toggleAssistant,
    closeAssistant,
    openAssistant
  };
}
