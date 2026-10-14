<template>
  <!-- Change against the period before: fewer flies is good news -->
  <span v-if="pct === null || pct === undefined" class="change-none">--</span>
  <el-tag v-else :type="type" effect="light" round size="small">{{ pct > 0 ? '+' : '' }}{{ pct }}%</el-tag>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  pct: { type: Number, default: null }
});
const type = computed(() => (props.pct <= -10 ? 'success' : props.pct >= 10 ? 'danger' : 'info'));
</script>

<style scoped>
.change-none {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
