import { reactive } from 'vue';

/**
 * The checkout dialog (components/plans/CheckoutDialog.vue, mounted once in the app layout):
 * pay for a plan online. `options`: { planCode, interval?, addonCameras?, upgradeRequestId? }
 * (an upgrade request approved for online payment fixes the plan and the add-ons).
 */
const state = reactive({ open: false, options: null });

export function openCheckout(options = {}) {
  state.options = { ...options };
  state.open = true;
}

export function closeCheckout() {
  state.open = false;
}

export function useCheckout() {
  return { state, openCheckout, closeCheckout };
}

export default useCheckout;
