<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { SUPPORTED_LOCALES } from '@/i18n';
import { useLanguage } from '@/composables/useLanguage';
import CountryFlag from '@/components/common/CountryFlag.vue';

const { t } = useI18n();
const { locale, setAppLocale } = useLanguage();

const currentLocaleItem = computed(() => {
  return SUPPORTED_LOCALES.find(l => l.code === locale.value) || SUPPORTED_LOCALES[0];
});

function switchLocale(code) {
  setAppLocale(code);
}
</script>

<template>
  <div id="lang-select-btn" class="inline-block">
    <el-dropdown trigger="click" @command="switchLocale">
      <el-button circle :title="`${t('settings.langSetting')} (${locale})`">
        <CountryFlag :code="currentLocaleItem.code" :flag="currentLocaleItem.flag" size="medium" />
      </el-button>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item
            v-for="l in SUPPORTED_LOCALES"
            :key="l.code"
            :command="l.code"
            :class="{ 'lang-item-active': locale === l.code }"
          >
            <span class="inline-flex items-center gap-2">
              <CountryFlag :code="l.code" :flag="l.flag" size="small" />
              <span>{{ l.label }}</span>
            </span>
          </el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>
  </div>
</template>

<style scoped>
:global(.el-dropdown-menu__item.lang-item-active) {
  color: var(--el-color-primary);
  font-weight: 600;
}
</style>
