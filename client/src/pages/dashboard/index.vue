<template>
  <div class="space-y-7 w-full max-w-7xl mx-auto pb-12 select-none">
    <!-- Welcome Hero Banner -->
    <section class="bg-[var(--el-card-bg-color)] border border-[var(--el-border-color)] text-[var(--el-text-color-primary)] rounded-[28px] p-7 md:p-8 relative overflow-hidden shadow-soft">
      <div class="absolute -right-12 -top-12 w-64 h-64 bg-[var(--primary-green)]/10 blur-[60px] rounded-full pointer-events-none"></div>
      <div class="relative flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div>
          <div class="flex items-center gap-2 mb-2">
            <span class="text-[var(--el-text-color-secondary)] text-xs font-semibold uppercase tracking-wider">
              {{ t('dashboard.welcome') }} 👋, {{ userName }}
            </span>
            <span class="w-1.5 h-1.5 rounded-full bg-[var(--primary-green)] ring-2 ring-[var(--primary-green)]/30"></span>
          </div>
          <h2 class="text-xl md:text-2xl lg:text-3xl font-light tracking-tight text-[var(--el-text-color-primary)]">
            {{ t('dashboard.title') }}
          </h2>
        </div>

        <div class="flex flex-wrap items-center gap-6">
          <div class="text-left md:text-right">
            <div class="text-2xl md:text-3xl font-extrabold tracking-tight text-[var(--el-text-color-primary)]">
              {{ onlineCount }}<span class="text-sm font-normal text-[var(--el-text-color-secondary)]">/{{ cameras.length }}</span>
            </div>
            <p class="text-[var(--primary-green)] text-xs font-bold mt-0.5">{{ t('dashboard.activeCameras') }}</p>
          </div>

          <div class="h-10 w-[1px] bg-[var(--el-border-color)] hidden sm:block"></div>

          <div class="text-left md:text-right">
            <div class="text-2xl md:text-3xl font-extrabold tracking-tight text-amber-400">
              {{ overviewData.peakRealtimeInsects }}
            </div>
            <p class="text-[var(--el-text-color-secondary)] text-xs font-medium mt-0.5">
              {{ t('dashboard.hotspotPeak') }}
            </p>
          </div>

          <div class="h-10 w-[1px] bg-[var(--el-border-color)] hidden sm:block"></div>

          <div class="text-left md:text-right">
            <div class="text-2xl md:text-3xl font-extrabold tracking-tight text-emerald-400">
              {{ overviewData.totalRealtimeInsects }}
            </div>
            <p class="text-[var(--el-text-color-secondary)] text-xs font-medium mt-0.5">
              {{ t('dashboard.realtimeTotal') }}
            </p>
          </div>
        </div>
      </div>
    </section>

    <!-- Key Metrics Cards (Row 1) -->
    <section class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
      <!-- Card 1: Điểm Nóng Realtime (Peak Camera) -->
      <div class="bg-[var(--el-card-bg-color)] border border-[var(--el-border-color)] rounded-3xl p-6 shadow-soft hover:shadow-md transition-all">
        <div class="flex items-center justify-between mb-4">
          <span class="text-[var(--el-text-color-secondary)] text-xs font-bold uppercase tracking-wider">
            {{ t('dashboard.hotspotPeak') }}
          </span>
          <div class="w-8 h-8 rounded-xl bg-amber-500/10 text-amber-400 flex items-center justify-center">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
        </div>
        <div class="text-3xl font-extrabold tracking-tight text-amber-400">
          {{ overviewData.peakRealtimeInsects }} <span class="text-xs font-normal text-slate-400">{{ t('dashboard.individualsUnit') }}</span>
        </div>
        <div class="mt-3 flex items-center gap-1.5 text-xs text-amber-400 font-semibold truncate">
          <span class="w-2 h-2 rounded-full bg-amber-400 animate-pulse"></span>
          <span class="truncate">{{ overviewData.peakCamera?.deviceName || '--' }}</span>
        </div>
      </div>

      <!-- Card 2: Tổng Côn Trùng Realtime Toàn Vườn -->
      <div class="bg-[var(--el-card-bg-color)] border border-[var(--el-border-color)] rounded-3xl p-6 shadow-soft hover:shadow-md transition-all">
        <div class="flex items-center justify-between mb-4">
          <span class="text-[var(--el-text-color-secondary)] text-xs font-bold uppercase tracking-wider">
            {{ t('dashboard.realtimeTotal') }}
          </span>
          <div class="w-8 h-8 rounded-xl bg-emerald-500/10 text-emerald-400 flex items-center justify-center">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
          </div>
        </div>
        <div class="text-3xl font-extrabold tracking-tight text-[var(--el-text-color-primary)]">
          {{ overviewData.totalRealtimeInsects }} <span class="text-xs font-normal text-slate-400">{{ t('dashboard.fruitFlyUnit') }}</span>
        </div>
        <div class="mt-3 flex items-center gap-1.5 text-xs text-[var(--primary-green)] font-semibold">
          <span>{{ t('dashboard.avgPerTrap', { count: (overviewData.totalRealtimeInsects / (cameras.length || 1)).toFixed(1) }) }}</span>
        </div>
      </div>

      <!-- Card 3: Trực Tuyến Camera -->
      <div class="bg-[var(--el-card-bg-color)] border border-[var(--el-border-color)] rounded-3xl p-6 shadow-soft hover:shadow-md transition-all">
        <div class="flex items-center justify-between mb-4">
          <span class="text-[var(--el-text-color-secondary)] text-xs font-bold uppercase tracking-wider">
            {{ t('dashboard.activeCameras') }}
          </span>
          <div class="w-8 h-8 rounded-xl bg-blue-500/10 text-blue-400 flex items-center justify-center">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          </div>
        </div>
        <div class="text-3xl font-extrabold tracking-tight text-[var(--el-text-color-primary)]">
          {{ onlineCount }}/{{ cameras.length }}
        </div>
        <div class="mt-3 flex items-center gap-1.5 text-xs text-blue-400 font-semibold">
          <span class="w-2 h-2 rounded-full bg-blue-400"></span>
          <span>{{ cameras.length > 0 ? Math.round((onlineCount / cameras.length) * 100) : 0 }}% {{ t('dashboard.onlinePct') }}</span>
        </div>
      </div>

      <!-- Card 4: Mức Độ Nguy Cơ Bùng Phát (AI Outbreak Risk Index) -->
      <div class="bg-[var(--el-card-bg-color)] border border-[var(--el-border-color)] rounded-3xl p-6 shadow-soft hover:shadow-md transition-all">
        <div class="flex items-center justify-between mb-4">
          <span class="text-[var(--el-text-color-secondary)] text-xs font-bold uppercase tracking-wider">
            {{ t('dashboard.riskIndex') }}
          </span>
          <div class="w-8 h-8 rounded-xl bg-red-500/10 text-red-400 flex items-center justify-center">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
        </div>
        <div class="text-2xl font-extrabold tracking-tight" :class="riskColorClass">
          {{ riskLabel }}
        </div>
        <div class="mt-3 flex items-center gap-1.5 text-xs text-slate-400 font-semibold">
          <span>AI Gemini Copilot</span>
        </div>
      </div>
    </section>

    <!-- Realtime Column Chart & Historical Min/Max/Avg (Row 2) -->
    <section class="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <!-- Left (2 cols): Realtime Column Bar Chart per Camera -->
      <div class="lg:col-span-2 bg-[var(--el-card-bg-color)] border border-[var(--el-border-color)] rounded-3xl p-6 md:p-7 shadow-soft">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
          <div>
            <h3 class="font-bold text-base text-[var(--el-text-color-primary)]">
              {{ t('dashboard.realtimeByCamera') }}
            </h3>
            <p class="text-xs text-[var(--el-text-color-secondary)] mt-0.5">
              {{ t('dashboard.realtimeByCameraDesc') }}
            </p>
          </div>
          <div class="flex items-center gap-2 text-xs text-slate-400">
            <span class="w-2.5 h-2.5 rounded-full bg-red-400"></span>
            <span>{{ t('dashboard.alertThreshold') }}</span>
          </div>
        </div>

        <!-- Column Chart Bars Visualizer -->
        <div class="space-y-4 pt-2">
          <div
            v-for="cam in (overviewData.cameraRealtimeList || [])"
            :key="cam.deviceSerial"
            @click="emit('select-camera', cam)"
            class="group p-3.5 rounded-2xl bg-[var(--el-bg-color)] hover:bg-[var(--el-bg-color)]/80 border border-[var(--el-border-color)] transition-all cursor-pointer"
          >
            <div class="flex items-center justify-between text-xs mb-2">
              <div class="flex items-center gap-2 font-bold text-[var(--el-text-color-primary)]">
                <span class="w-2 h-2 rounded-full" :class="cam.status ? 'bg-emerald-400' : 'bg-slate-400'"></span>
                <span class="group-hover:text-[var(--primary-green)] transition-colors">{{ cam.deviceName || cam.deviceSerial }}</span>
                <span class="text-[10px] text-slate-400 font-mono">({{ cam.deviceSerial }})</span>
              </div>
              <div class="font-extrabold text-sm" :class="cam.currentCount >= 16 ? 'text-red-400' : (cam.currentCount >= 5 ? 'text-amber-400' : 'text-emerald-400')">
                {{ cam.currentCount }} <span class="text-xs font-normal text-slate-400">{{ t('dashboard.insectsShort') }}</span>
              </div>
            </div>

            <!-- Progress bar representing density -->
            <div class="h-3 w-full bg-slate-800/40 rounded-full overflow-hidden p-0.5">
              <div
                class="h-full rounded-full transition-all duration-700"
                :class="cam.currentCount >= 16 ? 'bg-gradient-to-r from-amber-500 to-red-500' : (cam.currentCount >= 5 ? 'bg-amber-400' : 'bg-emerald-400')"
                :style="{ width: `${Math.min(100, Math.max(8, (cam.currentCount / 40) * 100))}%` }"
              ></div>
            </div>

            <div class="flex items-center justify-between text-[10px] text-slate-400 mt-1.5">
              <span>{{ cam.locationAddress || 'Orchard Field' }}</span>
              <span class="font-semibold" :class="cam.currentCount >= 16 ? 'text-red-400' : (cam.currentCount >= 5 ? 'text-amber-400' : 'text-emerald-400')">
                {{ cam.currentCount >= 16 ? t('dashboard.pestHotspot') : (cam.currentCount >= 5 ? t('dashboard.moderateLevel') : t('dashboard.wellControlled')) }}
              </span>
            </div>
          </div>

          <div v-if="!overviewData.cameraRealtimeList?.length" class="py-12 text-center text-xs text-slate-400 italic">
            {{ t('dashboard.noRealtimeData') }}
          </div>
        </div>
      </div>

      <!-- Right (1 col): Min / Max / Avg Statistics Widget -->
      <div class="bg-[var(--el-card-bg-color)] border border-[var(--el-border-color)] rounded-3xl p-6 md:p-7 shadow-soft flex flex-col justify-between">
        <div>
          <div class="flex items-center justify-between mb-4">
            <div>
              <h3 class="font-bold text-base text-[var(--el-text-color-primary)]">
                {{ t('dashboard.minMaxAvgTitle') }}
              </h3>
              <p class="text-[11px] text-[var(--el-text-color-secondary)] mt-0.5">
                {{ t('dashboard.minMaxAvgDesc') }}
              </p>
            </div>
          </div>

          <!-- Period Toggle Tabs -->
          <div class="grid grid-cols-3 bg-[var(--el-bg-color)] p-1 rounded-2xl border border-[var(--el-border-color)] mb-6 text-center">
            <button
              v-for="p in periodOptions"
              :key="p.key"
              @click="selectedPeriod = p.key"
              class="py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer"
              :class="selectedPeriod === p.key
                ? 'bg-[var(--el-card-bg-color)] text-[var(--primary-green)] shadow-sm'
                : 'text-[var(--el-text-color-secondary)] hover:text-[var(--el-text-color-primary)]'"
            >
              {{ p.label }}
            </button>
          </div>

          <!-- Stats Grid -->
          <div class="grid grid-cols-2 gap-4">
            <!-- Min Tile -->
            <div class="bg-[var(--el-bg-color)] p-4 rounded-2xl border border-[var(--el-border-color)]">
              <span class="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                {{ t('dashboard.statMin') }}
              </span>
              <div class="text-2xl font-black text-emerald-400 mt-1">
                {{ currentPeriodStats.min }}
              </div>
              <span class="text-[10px] text-slate-400">{{ t('dashboard.individualsPerScan') }}</span>
            </div>

            <!-- Max Tile -->
            <div class="bg-[var(--el-bg-color)] p-4 rounded-2xl border border-[var(--el-border-color)]">
              <span class="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                {{ t('dashboard.statMax') }}
              </span>
              <div class="text-2xl font-black text-red-400 mt-1">
                {{ currentPeriodStats.max }}
              </div>
              <span class="text-[10px] text-slate-400">{{ t('dashboard.peakRecorded') }}</span>
            </div>

            <!-- Avg Tile -->
            <div class="bg-[var(--el-bg-color)] p-4 rounded-2xl border border-[var(--el-border-color)]">
              <span class="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                {{ t('dashboard.statAvg') }}
              </span>
              <div class="text-2xl font-black text-blue-400 mt-1">
                {{ currentPeriodStats.avg }}
              </div>
              <span class="text-[10px] text-slate-400">{{ t('dashboard.cycleAverage') }}</span>
            </div>

            <!-- Scans Tile -->
            <div class="bg-[var(--el-bg-color)] p-4 rounded-2xl border border-[var(--el-border-color)]">
              <span class="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                {{ t('dashboard.statScans') }}
              </span>
              <div class="text-2xl font-black text-[var(--el-text-color-primary)] mt-1">
                {{ currentPeriodStats.totalScans }}
              </div>
              <span class="text-[10px] text-slate-400">{{ t('dashboard.aiProcessedRuns') }}</span>
            </div>
          </div>
        </div>

        <div class="mt-6 pt-4 border-t border-[var(--el-border-color)]/60 text-[11px] text-slate-400 flex items-center justify-between">
          <span>{{ t('dashboard.dominantSpeciesLabel') }}</span>
          <span class="font-bold text-[var(--primary-green)] truncate">{{ formatSpeciesDisplay(overviewData.topSpecies) }}</span>
        </div>
      </div>
    </section>

    <!-- AI Agricultural Copilot: Deep Diagnosis & IPM Recommendations (Row 3, Requirement #5) -->
    <section class="bg-gradient-to-br from-[var(--el-card-bg-color)] via-[var(--el-card-bg-color)] to-emerald-950/20 border border-[var(--el-border-color)] rounded-[32px] p-6 md:p-8 shadow-soft relative overflow-hidden">
      <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-6 border-b border-[var(--el-border-color)]">
        <div>
          <div class="flex items-center gap-2 mb-1.5">
            <span class="px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 text-[11px] font-extrabold uppercase border border-emerald-500/20 flex items-center gap-1.5">
              <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping"></span>
              {{ t('dashboard.aiCopilotAgentBadge') }}
            </span>
          </div>
          <h3 class="font-extrabold text-lg text-[var(--el-text-color-primary)]">
            {{ t('dashboard.aiAgentTitle') }}
          </h3>
          <p class="text-xs text-[var(--el-text-color-secondary)] mt-0.5">
            {{ t('dashboard.aiAgentSubtitle') }}
          </p>
        </div>

        <button
          @click="runDeepDiagnosis"
          :disabled="loadingDiagnosis || cameras.length === 0"
          class="flex items-center gap-2 px-4 py-2.5 bg-[var(--primary-green)] hover:bg-emerald-400 text-slate-950 rounded-2xl text-xs font-bold transition-all shadow-md shadow-emerald-500/20 cursor-pointer disabled:opacity-60"
        >
          <svg v-if="!loadingDiagnosis" class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
          </svg>
          <div v-else class="w-4 h-4 border-2 border-slate-900 border-t-transparent rounded-full animate-spin"></div>
          <span>{{ loadingDiagnosis ? t('dashboard.runningDiagnosis') : t('dashboard.runDiagnosis') }}</span>
        </button>
      </div>

      <!-- If 0 cameras added, display friendly empty prompt instead of fake plans -->
      <div v-if="cameras.length === 0" class="py-12 text-center text-xs text-slate-400 italic">
        {{ t('dashboard.noCamerasCopilotPrompt') }}
      </div>

      <!-- Diagnosis Content Grid -->
      <div v-else-if="diagnosisResult" class="mt-6 space-y-6">
        <!-- 7-Day Forecast Trajectory Chart -->
        <div class="bg-[var(--el-bg-color)]/70 p-5 rounded-2xl border border-[var(--el-border-color)]">
          <div class="flex items-center justify-between mb-4">
            <h4 class="font-bold text-xs text-[var(--el-text-color-primary)] flex items-center gap-2">
              <svg class="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
              </svg>
              <span>{{ t('dashboard.trajectoryTitle') }}</span>
            </h4>
            <span class="text-[11px] font-semibold text-slate-400">
              {{ t('dashboard.modelConfidence') }} {{ diagnosisResult.forecast?.confidence || '95.8%' }}
            </span>
          </div>

          <!-- Forecast Bars -->
          <div class="grid grid-cols-7 gap-2 h-28 items-end pt-4 pb-1">
            <div
              v-for="(day, i) in (diagnosisResult.forecast?.days || [])"
              :key="i"
              class="flex flex-col items-center gap-1.5 h-full justify-end group"
            >
              <span class="text-[10px] font-bold text-slate-400 group-hover:text-white transition-colors">
                {{ day.projectedCount }}
              </span>
              <div
                class="w-full rounded-t-lg transition-all"
                :class="day.projectedCount >= 20 ? 'bg-red-500/80' : (day.projectedCount >= 6 ? 'bg-amber-400/80' : 'bg-emerald-400/80')"
                :style="{ height: `${Math.min(100, Math.max(15, (day.projectedCount / 40) * 100))}%` }"
              ></div>
              <span class="text-[10px] font-mono text-slate-400">{{ day.date }}</span>
            </div>
          </div>
        </div>

        <!-- 4 Prescriptive Recommendations Grid -->
        <div>
          <h4 class="font-bold text-xs uppercase tracking-wider text-[var(--el-text-color-secondary)] mb-3">
            {{ t('dashboard.recommendationsTitle') }}
          </h4>

          <div v-if="!diagnosisResult.recommendations?.length" class="py-6 text-center text-xs text-emerald-400 italic bg-[var(--el-bg-color)]/40 rounded-2xl border border-[var(--el-border-color)]">
            {{ t('dashboard.systemSafePrompt') }}
          </div>

          <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div
              v-for="rec in (diagnosisResult.recommendations || [])"
              :key="rec.id"
              class="bg-[var(--el-bg-color)]/60 hover:bg-[var(--el-bg-color)] p-4 rounded-2xl border border-[var(--el-border-color)] transition-all flex flex-col justify-between"
            >
              <div>
                <div class="flex items-center justify-between mb-2">
                  <span class="text-[10px] font-extrabold px-2 py-0.5 rounded-full" :class="(rec.urgency === 'Khẩn cấp' || rec.urgencyEn === 'Urgent') ? 'bg-red-500/15 text-red-400 border border-red-500/30' : 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'">
                    {{ getUrgencyLabel(rec) }}
                  </span>
                  <span class="text-[10px] font-mono text-slate-400">{{ getMethodLabel(rec) }}</span>
                </div>
                <h5 class="font-bold text-xs text-[var(--el-text-color-primary)] mb-1">
                  {{ getTitleLabel(rec) }}
                </h5>
                <p class="text-[11px] text-[var(--el-text-color-secondary)] leading-relaxed">
                  {{ getDescLabel(rec) }}
                </p>
              </div>
              <div class="mt-3 pt-2 border-t border-[var(--el-border-color)]/40 text-[10px] text-slate-400 flex items-center justify-between">
                <span>{{ t('dashboard.appliedZone') }}</span>
                <span class="font-semibold text-slate-300 truncate">{{ getTargetZoneLabel(rec) }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Camera Surveillance Roster (Row 4) -->
    <section class="bg-[var(--el-card-bg-color)] border border-[var(--el-border-color)] rounded-3xl p-7 shadow-soft">
      <div class="flex items-center justify-between mb-6">
        <div>
          <h3 class="font-extrabold text-base text-[var(--el-text-color-primary)]">
            {{ t('dashboard.cameraRoster') }}
          </h3>
          <p class="text-xs text-[var(--el-text-color-secondary)] mt-0.5">
            {{ t('dashboard.cameraRosterSubtitle') }}
          </p>
        </div>

        <button
          @click="router.push('/cameras')"
          class="text-xs font-bold text-[var(--primary-green)] hover:underline flex items-center gap-1 cursor-pointer"
        >
          <span>{{ t('dashboard.viewAll') }}</span>
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      <div v-if="cameras.length === 0" class="py-12 text-center text-xs text-slate-400 italic">
        {{ t('dashboard.noCamerasPrompt') }}
      </div>

      <div v-else class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <div
          v-for="cam in cameras"
          :key="cam.deviceSerial"
          @click="selectCameraAndGoToLive(cam)"
          class="p-5 rounded-2xl border border-[var(--el-border-color)] bg-[var(--el-bg-color)] hover:border-[var(--primary-green)]/60 hover:shadow-md transition-all cursor-pointer group"
        >
          <div class="flex items-start justify-between">
            <div class="truncate">
              <div class="flex items-center gap-2">
                <span
                  class="w-2.5 h-2.5 rounded-full shrink-0"
                  :class="cam.status === 1 ? 'bg-emerald-400 ring-2 ring-emerald-500/20' : 'bg-red-400'"
                ></span>
                <h4 class="font-bold text-sm text-[var(--el-text-color-primary)] truncate group-hover:text-[var(--primary-green)] transition-colors">
                  {{ cam.deviceName || 'Camera' }}
                </h4>
              </div>
              <p class="text-[11px] font-mono text-[var(--el-text-color-secondary)] mt-1 truncate">
                SN: {{ cam.deviceSerial }}
              </p>
            </div>

            <span
              class="text-[10px] font-bold px-2 py-0.5 rounded-full border shrink-0"
              :class="cam.status === 1
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                : 'bg-red-500/10 text-red-400 border-red-500/20'"
            >
              {{ cam.status === 1 ? t('common.online') : t('common.offline') }}
            </span>
          </div>

          <div class="mt-4 pt-3 border-t border-[var(--el-border-color)]/60 flex items-center justify-between text-[11px] text-[var(--el-text-color-secondary)]">
            <span class="truncate max-w-[150px]">{{ cam.locationAddress || 'Orchard Field' }}</span>
            <span class="text-[var(--primary-green)] font-semibold flex items-center gap-1 group-hover:translate-x-1 transition-transform">
              {{ t('dashboard.watchStream') }}
              <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3" />
              </svg>
            </span>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useCameras } from '@/composables/useCameras';
import api from '@/services/api';
import { ElNotification } from 'element-plus';

const router = useRouter();
const { t, locale } = useI18n();
const { cameras, selectCameraAndGoToLive } = useCameras();

const formatSpeciesDisplay = (topSpecies) => {
  if (!topSpecies || topSpecies === '--') return '--';
  if (locale.value === 'en') {
    return topSpecies.replace(/ruồi vàng/gi, 'Fruit fly').replace(/bọ/gi, 'Bug');
  }
  return topSpecies;
};

const getUrgencyLabel = (rec) => {
  if (locale.value === 'en') return rec.urgencyEn || rec.urgency || 'Normal';
  return rec.urgency || 'Bình thường';
};

const getMethodLabel = (rec) => {
  if (locale.value === 'en') return rec.methodEn || rec.method || '';
  return rec.method || '';
};

const getTitleLabel = (rec) => {
  if (locale.value === 'en') return rec.titleEn || rec.title || '';
  return rec.title || '';
};

const getDescLabel = (rec) => {
  if (locale.value === 'en') return rec.descEn || rec.desc || '';
  return rec.desc || '';
};

const getTargetZoneLabel = (rec) => {
  if (locale.value === 'en') return rec.targetZoneEn || rec.targetZone || '';
  return rec.targetZone || '';
};

const user = computed(() => {
  try {
    return JSON.parse(localStorage.getItem('user')) || {};
  } catch (e) {
    return {};
  }
});

const userName = computed(() => user.value.name || user.value.email?.split('@')[0] || 'Admin');

const onlineCount = computed(() => {
  return cameras.value.filter(c => c.status === 1).length;
});

const loadingOverview = ref(false);
const overviewData = ref({
  peakRealtimeInsects: 0,
  peakCamera: null,
  totalRealtimeInsects: 0,
  cameraRealtimeList: [],
  overallRisk: 'low',
  historicalStats: {
    day: { min: 0, max: 0, avg: 0, totalScans: 0 },
    week: { min: 0, max: 0, avg: 0, totalScans: 0 },
    month: { min: 0, max: 0, avg: 0, totalScans: 0 }
  },
  totalSnapshots: 0,
  last24hCount: 0,
  topSpecies: 'ruồi vàng (Bactrocera) (100%)',
  trend7Days: []
});

const selectedPeriod = ref('day'); // 'day' | 'week' | 'month'
const periodOptions = computed(() => [
  { key: 'day', label: t('dashboard.periodDay') },
  { key: 'week', label: t('dashboard.periodWeek') },
  { key: 'month', label: t('dashboard.periodMonth') }
]);

const currentPeriodStats = computed(() => {
  const stats = overviewData.value.historicalStats || {};
  return stats[selectedPeriod.value] || { min: 0, max: 0, avg: 0, totalScans: 0 };
});

const riskLabel = computed(() => {
  const risk = overviewData.value.overallRisk;
  if (risk === 'high') return t('dashboard.outbreakRiskHigh') || 'Cảnh báo: Nguy cơ cao';
  if (risk === 'moderate') return t('dashboard.outbreakRiskModerate') || 'Trung bình: Cần theo dõi';
  return t('dashboard.outbreakRiskLow') || 'An toàn: Kiểm soát tốt';
});

const riskColorClass = computed(() => {
  const risk = overviewData.value.overallRisk;
  if (risk === 'high') return 'text-red-400';
  if (risk === 'moderate') return 'text-amber-400';
  return 'text-emerald-400';
});

// AI Copilot Diagnosis state
const loadingDiagnosis = ref(false);
const diagnosisResult = ref(null);

const runDeepDiagnosis = async () => {
  loadingDiagnosis.value = true;
  try {
    const res = await api.getAiDiagnosis({ timeRange: '7d' });
    if (res.data?.success && res.data.diagnosis) {
      diagnosisResult.value = res.data.diagnosis;
      ElNotification({
        title: 'AI Copilot',
        message: 'Đã hoàn tất phân tích chẩn đoán chuyên sâu và dự báo dịch hại 7 ngày!',
        type: 'success'
      });
    }
  } catch (err) {
    console.error('Diagnosis error:', err);
    ElNotification({
      title: t('common.error'),
      message: 'Không thể chạy chẩn đoán AI: ' + err.message,
      type: 'error'
    });
  } finally {
    loadingDiagnosis.value = false;
  }
};

const loadOverview = async () => {
  loadingOverview.value = true;
  try {
    const res = await api.getAiOverview();
    if (res.data?.success && res.data.overview) {
      overviewData.value = res.data.overview;
    }
  } catch (err) {
    console.error('Failed to load AI overview:', err);
  } finally {
    loadingOverview.value = false;
  }
};

onMounted(async () => {
  await loadOverview();
  await runDeepDiagnosis();
});
</script>
