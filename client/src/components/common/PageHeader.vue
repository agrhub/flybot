<template>
  <div class="flex flex-wrap items-start justify-between gap-4 mb-6">
    <div class="min-w-0">
      <h1 class="page-header__title">{{ title }}</h1>
      <p v-if="subtitle" class="page-header__subtitle">{{ subtitle }}</p>
    </div>
    <div v-if="$slots.actions" class="flex flex-wrap items-center gap-2">
      <slot name="actions" />
    </div>
  </div>
</template>

<script setup>
// Standard page title row: title, optional subtitle, optional actions on the right
defineProps({
  title: { type: String, required: true },
  subtitle: { type: String, default: '' }
});
</script>

<style scoped>
.page-header__title {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
  line-height: 1.3;
  color: var(--el-text-color-primary);
}
.page-header__subtitle {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
</style>
