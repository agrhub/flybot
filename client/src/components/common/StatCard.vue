<template>
  <el-card shadow="never" class="stat-card" :body-style="{ padding: '18px 20px' }">
    <div class="flex items-start justify-between gap-3">
      <span class="stat-card__label">{{ label }}</span>
      <el-icon v-if="icon" :size="18" class="stat-card__icon" :class="`is-${type}`">
        <component :is="icon" />
      </el-icon>
    </div>
    <div class="flex items-baseline gap-1.5 mt-2 min-w-0">
      <span class="stat-card__value truncate" :class="`is-${type}`">
        <slot name="value">{{ value }}</slot>
      </span>
      <span v-if="unit" class="stat-card__unit">{{ unit }}</span>
    </div>
    <div v-if="description || $slots.footer" class="stat-card__footer">
      <slot name="footer">{{ description }}</slot>
    </div>
  </el-card>
</template>

<script setup>
// Key metric tile: label + icon, big value with unit, optional description/footer
defineProps({
  label: { type: String, required: true },
  value: { type: [String, Number], default: '--' },
  unit: { type: String, default: '' },
  description: { type: String, default: '' },
  // An icon component from @element-plus/icons-vue
  icon: { type: [Object, Function], default: null },
  // Colors the value/icon: default | primary | success | warning | danger
  type: { type: String, default: 'default' }
});
</script>

<style scoped>
.stat-card {
  height: 100%;
}
.stat-card__label {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.stat-card__value {
  font-size: 26px;
  font-weight: 600;
  line-height: 1.2;
  color: var(--el-text-color-primary);
}
.stat-card__unit {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.stat-card__footer {
  margin-top: 8px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.stat-card__icon {
  color: var(--el-text-color-secondary);
}
.is-primary { color: var(--el-color-primary); }
.is-success { color: var(--el-color-success); }
.is-warning { color: var(--el-color-warning); }
.is-danger { color: var(--el-color-danger); }
</style>
