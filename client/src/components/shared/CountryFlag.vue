<script setup>
import CountryFlag from '@/components/common/CountryFlag.vue';
defineProps({
  code: { type: String, default: '' },
  flag: { type: String, default: '' },
  size: { type: [String, Number], default: 'small' },
  square: { type: Boolean, default: false }
});
</script>

<template>
  <CountryFlag :code="code" :flag="flag" :size="size" :square="square" />
</template>
