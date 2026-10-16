import { reactive } from 'vue';

/**
 * The upgrade dialog (components/plans/UpgradeDialog.vue, mounted once in the app layout):
 * opened by the API client when the server answers 403 UPGRADE_REQUIRED, or by a button
 * ("Ask for an upgrade" on the usage card or the pricing page). `detail` is the server's
 * answer ({ limit, used, max, plan, message }) or what the button wants ({ targetPlan, type }).
 */
const state = reactive({ open: false, detail: null });

export function openUpgradeDialog(detail = {}) {
  state.detail = detail || {};
  state.open = true;
}

export function closeUpgradeDialog() {
  state.open = false;
}

export function useUpgrade() {
  return { state, openUpgradeDialog, closeUpgradeDialog };
}

export default useUpgrade;
