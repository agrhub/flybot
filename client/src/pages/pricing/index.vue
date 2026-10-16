<template>
  <div class="pricing w-full max-w-6xl mx-auto flex flex-col gap-4">
    <PageHeader :title="t('plans.title')" :subtitle="t('plans.subtitle')" />

    <el-alert v-if="!pricing" type="info" :closable="false" show-icon :title="t('plans.b2bHint')" />

    <div v-else class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <el-card v-for="plan in plans" :key="plan.code" shadow="never" class="pricing-card" :class="{ 'is-current': plan.code === currentCode }" :data-test="`plan-${plan.code}`">
        <div class="flex items-center justify-between gap-2">
          <h3 class="pricing-card__name">{{ plan.name }}</h3>
          <el-tag v-if="plan.code === currentCode" type="success" effect="dark" round size="small">{{ t('plans.current') }}</el-tag>
        </div>
        <p class="pricing-card__price">{{ plan.priceNote || (plan.code === 'free' ? t('plans.free') : t('plans.contact')) }}</p>
        <p v-if="plan.description" class="pricing-card__desc">{{ plan.description }}</p>
        <ul class="pricing-card__list">
          <li>{{ plan.maxCameras ? t('plans.list.cameras', { n: plan.maxCameras }) : t('plans.list.camerasUnlimited') }}</li>
          <li>{{ t('plans.list.snapshots', { n: plan.snapshotsPerDay }) }}</li>
          <li>{{ t('plans.list.retention', { n: plan.retentionDays }) }}</li>
          <li>{{ plan.deepAnalysisPerMonth ? t('plans.list.deep', { n: plan.deepAnalysisPerMonth }) : t('plans.list.deepNone') }}</li>
          <li>{{ t('plans.list.live', { n: plan.liveMinutesPerRequest }) }}</li>
          <li>{{ plan.maxMembers ? t('plans.list.members', { n: plan.maxMembers }) : t('plans.list.membersUnlimited') }}</li>
          <li v-for="f in ['telegram', 'pdfReports', 'apiAndWebhooks']" :key="f" :class="{ 'is-off': !plan.features[f] }">{{ t(`plans.features.${f}`) }}</li>
        </ul>
        <el-button v-if="plan.code !== 'free' && plan.code !== currentCode && signedIn" type="primary" class="w-full mt-2" :data-test="`plan-ask-${plan.code}`" @click="openUpgradeDialog({ targetPlan: plan.code })">{{ t('upgrade.ask') }}</el-button>
      </el-card>

      <!-- Hybrid: an organization (business, cooperative) is arranged with the admin -->
      <el-card v-if="appMode === 'hybrid'" shadow="never" class="pricing-card pricing-card--org" data-test="plan-organization">
        <h3 class="pricing-card__name">{{ t('plans.orgCard.title') }}</h3>
        <p class="pricing-card__price">{{ t('plans.contact') }}</p>
        <p class="pricing-card__desc">{{ t('plans.orgCard.desc') }}</p>
        <el-button v-if="signedIn" type="primary" plain class="w-full mt-2" data-test="plan-ask-organization" @click="openUpgradeDialog({ type: 'organization' })">{{ t('plans.orgCard.ask') }}</el-button>
      </el-card>
    </div>

    <UsageCard v-if="signedIn && pricing" />
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import PageHeader from '@/components/common/PageHeader.vue';
import UsageCard from '@/components/plans/UsageCard.vue';
import api from '@/services/api';
import { useAuth } from '@/composables/useAuth';
import { openUpgradeDialog } from '@/composables/useUpgrade';

/** Plans for the current workspace (APP_MODE b2c / hybrid; hidden in b2b). */
const { t } = useI18n();
const { user } = useAuth();

const plans = ref([]);
const pricing = ref(true);
const appMode = ref('hybrid');
const signedIn = computed(() => !!user.value?.id);
const currentCode = computed(() => user.value?.plan?.code || 'free');

onMounted(async () => {
  try {
    const res = await api.getPlans();
    plans.value = res.data?.plans || [];
    pricing.value = res.data?.pricing !== false;
    appMode.value = res.data?.appMode || 'hybrid';
  } catch {
    plans.value = [];
  }
});
</script>

<style scoped>
.pricing-card {
  display: flex;
  flex-direction: column;
}
.pricing-card.is-current {
  border-color: var(--el-color-success);
}
.pricing-card__name {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
}
.pricing-card__price {
  margin: 6px 0 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--el-color-primary);
}
.pricing-card__desc {
  margin: 8px 0 0;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.pricing-card__list {
  margin: 12px 0 0;
  padding-left: 18px;
  font-size: 13px;
  line-height: 1.8;
}
.pricing-card__list .is-off {
  color: var(--el-text-color-placeholder);
  text-decoration: line-through;
}
</style>
