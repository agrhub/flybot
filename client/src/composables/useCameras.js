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
  validateCode: ''
});

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
    isAddCameraOpen.value = true;
  };

  const closeAddCameraModal = () => {
    isAddCameraOpen.value = false;
  };

  const submitAddCamera = async () => {
    const serial = newCameraForm.deviceSerial?.trim();
    const code = newCameraForm.validateCode?.trim();
    if (!serial || !code) {
      ElNotification({
        title: t('common.error'),
        message: 'Please enter both Serial Number and Verification Code!',
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
      const res = await api.addCamera(serial, code);
      if (res.data?.success) {
        ElNotification({
          title: t('common.success'),
          message: res.data.message || 'Camera added successfully!',
          type: 'success'
        });
        isAddCameraOpen.value = false;
        await loadCameras();
        const newlyAdded = cameras.value.find(c => c.deviceSerial === serial);
        if (newlyAdded) {
          selectedCamera.value = newlyAdded;
        }
        return true;
      } else {
        ElNotification({
          title: t('common.error'),
          message: res.data?.message || 'Failed to add camera.',
          type: 'error'
        });
        return false;
      }
    } catch (err) {
      ElNotification({
        title: t('common.error'),
        message: 'Error sending add device request.',
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
    loadCameras,
    selectCamera,
    selectCameraAndGoToLive,
    openAddCameraModal,
    closeAddCameraModal,
    submitAddCamera
  };
}
