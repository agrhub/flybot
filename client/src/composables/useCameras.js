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
  // 'ezviz' or 'camos' (FlyBot AI camera)
  provider: 'ezviz'
});
// AI camera just added, waiting to be put on the network: { deviceSerial, provision }
const cameraSetup = ref(null);

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
    newCameraForm.provider = 'ezviz';
    cameraSetup.value = null;
    isAddCameraOpen.value = true;
  };

  const closeAddCameraModal = () => {
    isAddCameraOpen.value = false;
    cameraSetup.value = null;
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
      const res = await api.createCamera({ deviceSerial: serial, validateCode: code, trapKind: newCameraForm.trapKind, provider: newCameraForm.provider });
      if (res.data?.success) {
        ElNotification({
          title: t('common.success'),
          message: t('cameras.added'),
          type: 'success'
        });
        if (res.data.provision) {
          // AI camera: the dialog goes on with putting it on the network
          cameraSetup.value = { deviceSerial: serial, provision: res.data.provision };
        } else {
          isAddCameraOpen.value = false;
        }
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
        message: err.response?.data?.message || t('cameras.addRequestFailed'),
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
    cameraSetup,
    loadCameras,
    selectCamera,
    selectCameraAndGoToLive,
    openAddCameraModal,
    closeAddCameraModal,
    submitAddCamera
  };
}
