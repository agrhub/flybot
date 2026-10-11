import { ref, watch } from 'vue';

const clone = (value) => JSON.parse(JSON.stringify(value));

/**
 * A widget's own filter state. It starts from the page filters (`defaults()`, a getter) plus the
 * widget's own extras, and goes back to the page filters whenever those change.
 * Returns a ref for v-model on WidgetFilter.
 */
export function useWidgetFilter(defaults, extras = {}) {
  const state = ref({ ...clone(extras), ...clone(defaults()) });
  watch(defaults, (value) => {
    state.value = { ...state.value, ...clone(value) };
  }, { deep: true });
  return state;
}
