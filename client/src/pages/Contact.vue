<script setup>
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage } from 'element-plus';
import { CircleCheck, Promotion, User, Message, PriceTag } from '@element-plus/icons-vue';

const { t } = useI18n();

const form = ref({
  name: '',
  email: '',
  subject: '',
  message: ''
});

const isSent = ref(false);
const isLoading = ref(false);

const handleSubmit = async () => {
  if (!form.value.name || !form.value.email || !form.value.message) {
    ElMessage.error(t('common.error') + ': Please fill all required fields');
    return;
  }
  isLoading.value = true;
  await new Promise(r => setTimeout(r, 700));
  isLoading.value = false;
  isSent.value = true;
  ElMessage.success(t('contact.successTitle'));
};
</script>

<template>
  <div id="contact-page" class="min-h-screen bg-[var(--el-bg-color-page)] text-[var(--el-text-color-primary)] py-16 px-6">
    <div class="max-w-xl mx-auto space-y-8">
      <div class="text-center md:text-left">
        <span class="text-xs font-bold uppercase tracking-widest text-[#3ecf8e] block mb-2">{{ t('nav.contact') }}</span>
        <h1 class="text-3xl sm:text-4xl font-extrabold tracking-tight text-[var(--el-text-color-primary)]">{{ t('contact.title') }}</h1>
        <p class="text-sm text-[var(--el-text-color-secondary)] mt-2 leading-relaxed">{{ t('contact.subtitle') }}</p>
      </div>

      <!-- Success Confirmation Card -->
      <el-card v-if="isSent" shadow="never" class="text-center p-8 !border !border-[var(--el-border-color)] !bg-[var(--el-card-bg-color)] !rounded-2xl">
        <el-icon class="text-5xl text-[#3ecf8e] mb-4"><CircleCheck /></el-icon>
        <h3 class="text-xl font-bold text-[var(--el-text-color-primary)] mb-2">{{ t('contact.successTitle') }}</h3>
        <p class="text-xs sm:text-sm text-[var(--el-text-color-secondary)] max-w-sm mx-auto leading-relaxed">{{ t('contact.successMsg') }}</p>
        <div class="mt-6">
          <button
            @click="isSent = false"
            class="px-5 py-2 rounded-xl text-xs font-bold uppercase tracking-wider bg-[var(--el-bg-color)] hover:bg-[#3ecf8e] hover:text-[#002112] text-[var(--el-text-color-primary)] transition-all cursor-pointer border border-[var(--el-border-color)]"
          >
            Send Another Inquiry
          </button>
        </div>
      </el-card>

      <!-- Contact Form -->
      <el-form v-else label-position="top" @submit.prevent="handleSubmit" class="space-y-4">
        <el-form-item :label="t('contact.nameLabel')" required>
          <el-input
            id="contact-name"
            v-model="form.name"
            :placeholder="t('contact.namePlaceholder')"
            :prefix-icon="User"
            size="large"
            class="!rounded-xl"
          />
        </el-form-item>

        <el-form-item :label="t('contact.emailLabel')" required>
          <el-input
            id="contact-email"
            v-model="form.email"
            type="email"
            :placeholder="t('contact.emailPlaceholder')"
            :prefix-icon="Message"
            size="large"
            class="!rounded-xl"
          />
        </el-form-item>

        <el-form-item :label="t('contact.subjectLabel')">
          <el-input
            id="contact-subject"
            v-model="form.subject"
            :placeholder="t('contact.subjectPlaceholder')"
            :prefix-icon="PriceTag"
            size="large"
            class="!rounded-xl"
          />
        </el-form-item>

        <el-form-item :label="t('contact.messageLabel')" required>
          <el-input
            id="contact-message"
            v-model="form.message"
            type="textarea"
            :rows="5"
            :placeholder="t('contact.messagePlaceholder')"
            class="!rounded-xl"
          />
        </el-form-item>

        <button
          id="contact-submit-btn"
          type="button"
          :disabled="isLoading"
          class="w-full h-11 font-bold text-xs uppercase tracking-wider bg-[#3ecf8e] text-[#002112] rounded-xl hover:bg-white hover:text-black transition-all flex items-center justify-center gap-2 shadow-md cursor-pointer disabled:opacity-50"
          @click="handleSubmit"
        >
          <el-icon><Promotion /></el-icon>
          <span>{{ isLoading ? t('common.loading') : t('contact.sendBtn') }}</span>
        </button>
      </el-form>
    </div>
  </div>
</template>
