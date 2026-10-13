<template>
  <div class="flex flex-col items-start gap-0.5">
    <el-tooltip :content="t(`share.statusHint.${status}`)" placement="top">
      <el-tag :type="TAG[status] || 'warning'" effect="light" round size="small">{{ t(`share.statusLabel.${status}`) }}</el-tag>
    </el-tooltip>
    <!-- The invitee has an account but no confirmed email: send the confirmation again -->
    <el-button v-if="status === 'unverified'" link type="primary" size="small" :loading="sending" @click="remind">
      {{ t('share.remind') }}
    </el-button>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage } from 'element-plus';
import api from '@/services/api';

const props = defineProps({
  status: { type: String, required: true },
  email: { type: String, required: true },
});

const TAG = { active: 'success', pending: 'warning', unverified: 'info' };

const { t } = useI18n();
const sending = ref(false);

const remind = async () => {
  sending.value = true;
  try {
    await api.remindInvitee(props.email);
    ElMessage.success(t('share.reminded', { email: props.email }));
  } catch (err) {
    ElMessage.error(err.response?.data?.message || t('common.error'));
  } finally {
    sending.value = false;
  }
};
</script>
