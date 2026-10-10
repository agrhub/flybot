<script setup>
import { computed } from 'vue';
import { SUPPORTED_LOCALES } from '@/i18n';
import { useLanguage } from '@/composables/useLanguage';
import CountryFlag from '@/components/common/CountryFlag.vue';

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
      <button
        class="flex h-9 w-9 items-center justify-center rounded-xl text-base hover:bg-[var(--el-bg-color)] transition-colors border border-[var(--el-border-color)] bg-[var(--el-card-bg-color)] cursor-pointer shadow-sm"
        :title="`Language (${locale})`"
      >
        <CountryFlag :code="currentLocaleItem.code" :flag="currentLocaleItem.flag" size="medium" />
      </button>
      <template #dropdown>
        <el-dropdown-menu class="!rounded-2xl !p-1.5 !border-[var(--el-border-color)] !bg-[var(--el-card-bg-color)]">
          <el-dropdown-item
            v-for="l in SUPPORTED_LOCALES"
            :key="l.code"
            :command="l.code"
            :class="{ '!font-bold !text-[var(--primary-green)]': locale === l.code }"
            class="!rounded-xl !py-2 !px-3 flex items-center gap-2"
          >
            <CountryFlag :code="l.code" :flag="l.flag" size="small" class="mr-2" />
            <span class="text-xs">{{ l.label }}</span>
          </el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>
  </div>
</template>
