import { ref, reactive } from 'vue';
import { useRouter } from 'vue-router';
import api from '@/services/api';
import { ElNotification } from 'element-plus';
import { useI18n } from 'vue-i18n';

// Singleton shared state
const cameras = ref([]);
const selectedCamera = ref(null);
const loadingCameras = ref(false);

const isAddCameraOpen = ref(false);
const addingCamera = ref(false);
const newCameraForm = reactive({
  deviceSerial: '',
  validateCode: '',
  trapKind: 'sticky',
  // ezviz (EZVIZ Open Platform) or camos (ESP32 trap camera on AWS IoT Core)
  platform: 'ezviz'
});
// What a newly added CamOS camera needs typed into its portal (shown once, in the add dialog)
const provisioning = ref(null);

export function useCameras() {
  const router = useRouter();
  const { t } = useI18n();

  const loadCameras = async () => {
    let user = null;
    try {
      user = JSON.parse(localStorage.getItem('user'));
    } catch (e) {
      user = null;
    }

    if (!user || !user.id) {
      if (router) router.push('/auth/login');
      return;
    }

    loadingCameras.value = true;
    try {
      const res = await api.getCameras();
      if (res.data?.success) {
        cameras.value = res.data.cameras || [];
        if (!selectedCamera.value && cameras.value.length > 0) {
          selectedCamera.value = cameras.value[0];
        } else if (selectedCamera.value) {
          const found = cameras.value.find(c => c.deviceSerial === selectedCamera.value.deviceSerial);
          if (found) {
            selectedCamera.value = found;
          } else if (cameras.value.length > 0) {
            selectedCamera.value = cameras.value[0];
          }
        }
      }
    } catch (err) {
      console.error('Failed to load cameras', err);
    } finally {
      loadingCameras.value = false;
    }
  };

  const selectCamera = (camera) => {
    selectedCamera.value = camera;
  };

  const selectCameraAndGoToLive = (camera) => {
    selectedCamera.value = camera;
    if (router) router.push('/cameras');
  };

  const openAddCameraModal = () => {
    newCameraForm.deviceSerial = '';
    newCameraForm.validateCode = '';
    newCameraForm.trapKind = 'sticky';
    newCameraForm.platform = 'ezviz';
    provisioning.value = null;
    isAddCameraOpen.value = true;
  };

  const closeAddCameraModal = () => {
    isAddCameraOpen.value = false;
  };

  // The claim answers of a self-registered CamOS camera, in the same words as the /claim page
  const claimErrorText = (err) => {
    if (newCameraForm.platform !== 'camos') return '';
    const data = err.response?.data || {};
    if (data.code === 'NOT_FOUND') return t('claim.errors.notFound');
    if (data.code === 'LOCKED') return t('claim.errors.locked');
    if (data.code === 'NO_WORKSPACE') return t('claim.errors.noWorkspace');
    if (data.code === 'LIMIT_REACHED' || data.code === 'UPGRADE_REQUIRED') return t('claim.errors.limit', { limit: data.max ?? data.limit ?? 3 });
    return '';
  };

  const submitAddCamera = async () => {
    const serial = newCameraForm.deviceSerial?.trim();
    const code = newCameraForm.validateCode?.trim();
    if (!serial || !code) {
      ElNotification({
        title: t('common.error'),
        message: t('cameras.addRequired'),
        type: 'warning'
      });
      return false;
    }

    let user = null;
    try {
      user = JSON.parse(localStorage.getItem('user'));
    } catch (e) {
      user = null;
    }
    if (!user?.id) return false;

    addingCamera.value = true;
    try {
      const res = await api.createCamera({ deviceSerial: serial, validateCode: code, trapKind: newCameraForm.trapKind, platform: newCameraForm.platform });
      if (res.data?.success) {
        // A CamOS camera that registered itself was claimed (no provisioning token to show)
        // CamOS: claimed (it had registered itself), or pending (an ESP32 camera that joins when it registers)
        const claimed = newCameraForm.platform === 'camos' && !res.data.provisioning && !res.data.pending;
        ElNotification({
          title: t('common.success'),
          message: res.data.pending ? t('cameras.pendingNote') : claimed ? t('cameras.claimedNote') : t('cameras.added'),
          type: 'success'
        });
        // A CamOS camera: the dialog stays open with the provisioning token for the camera's portal
        if (res.data.provisioning) provisioning.value = { ...res.data.provisioning, deviceSerial: serial };
        else isAddCameraOpen.value = false;
        await loadCameras();
        const newlyAdded = cameras.value.find(c => c.deviceSerial === serial);
        if (newlyAdded) {
          selectedCamera.value = newlyAdded;
        }
        return true;
      } else {
        ElNotification({
          title: t('common.error'),
          message: res.data?.message || t('cameras.addFailed'),
          type: 'error'
        });
        return false;
      }
    } catch (err) {
      ElNotification({
        title: t('common.error'),
        message: claimErrorText(err) || err.response?.data?.message || t('cameras.addRequestFailed'),
        type: 'error'
      });
      return false;
    } finally {
      addingCamera.value = false;
    }
  };

  return {
    cameras,
    selectedCamera,
    loadingCameras,
    isAddCameraOpen,
    addingCamera,
    newCameraForm,
    provisioning,
    loadCameras,
    selectCamera,
    selectCameraAndGoToLive,
    openAddCameraModal,
    closeAddCameraModal,
    submitAddCamera
  };
}
