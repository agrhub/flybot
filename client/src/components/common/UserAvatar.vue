<template>
  <!-- The person's picture, or the first letter of their name or email -->
  <el-avatar :size="size" :src="src || undefined" :alt="label" class="user-avatar shrink-0">{{ initial }}</el-avatar>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  src: { type: String, default: '' },
  label: { type: String, default: '' },
  size: { type: Number, default: 28 },
});

const initial = computed(() => (props.label.trim().charAt(0) || '?').toUpperCase());
</script>

<style scoped>
.user-avatar {
  font-size: 12px;
  font-weight: 600;
  background-color: var(--el-color-primary-light-8);
  color: var(--el-color-primary);
}
</style>
