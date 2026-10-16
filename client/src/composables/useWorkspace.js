import { ref } from 'vue';
import api from '@/services/api';
import { useAuth } from '@/composables/useAuth';

/**
 * The workspaces this person can switch between (personal, organizations) and the current one.
 * The choice is kept on this device (localStorage "workspaceId", sent as X-Workspace-Id) and on
 * the account (PUT /api/workspaces/current); switching reloads the page so every list follows.
 */
const workspaces = ref([]);
const loaded = ref(false);

export function useWorkspace() {
  const { user, refreshUser } = useAuth();

  const load = async () => {
    try {
      const res = await api.getWorkspaces();
      workspaces.value = res.data?.workspaces || [];
    } catch {
      workspaces.value = [];
    }
    loaded.value = true;
    return workspaces.value;
  };

  const switchTo = async (workspaceId, { reload = true } = {}) => {
    await api.setCurrentWorkspace(workspaceId);
    try {
      localStorage.setItem('workspaceId', workspaceId);
    } catch {
      // storage blocked: the account's saved choice still applies
    }
    await refreshUser();
    if (reload && typeof window !== 'undefined') window.location.reload();
  };

  return { workspaces, loaded, load, switchTo, current: () => user.value?.workspace || null };
}

export default useWorkspace;
