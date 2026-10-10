<template>
  <div class="h-full flex-1 flex flex-col md:flex-row overflow-hidden font-sans border border-[var(--el-border-color)] rounded-[28px] bg-[var(--el-card-bg-color)] shadow-soft max-w-7xl mx-auto select-none">
    <!-- Left Sticky Sidebar Settings Navigation (matches Shine app) -->
    <aside class="w-full md:w-64 border-b md:border-b-0 md:border-r border-[var(--el-border-color)] bg-[var(--el-bg-color)] flex flex-col p-6 space-y-6 shrink-0 select-none overflow-y-auto custom-scrollbar">
      <div class="space-y-1">
        <h1 class="text-xl font-black tracking-tight text-[var(--el-text-color-primary)]">
          {{ t('settings.title') }}
        </h1>
        <p class="text-xs text-[var(--el-text-color-secondary)]">
          {{ t('settings.desc') }}
        </p>
      </div>

      <!-- Account Group -->
      <div class="space-y-2">
        <h3 class="text-[10px] font-bold uppercase tracking-widest text-[var(--el-text-color-secondary)]">
          {{ t('settings.account') }}
        </h3>
        <nav class="space-y-1">
          <button
            @click="activeTab = 'profile'"
            class="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-semibold transition-all cursor-pointer text-left"
            :class="activeTab === 'profile'
              ? 'bg-[var(--primary-green)] text-slate-950 font-bold shadow-md shadow-emerald-500/20'
              : 'text-[var(--el-text-color-secondary)] hover:bg-[var(--el-card-bg-color)] hover:text-[var(--el-text-color-primary)]'"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
            <span>{{ t('settings.profileTab') }}</span>
          </button>

          <button
            @click="activeTab = 'password'"
            class="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-semibold transition-all cursor-pointer text-left"
            :class="activeTab === 'password'
              ? 'bg-[var(--primary-green)] text-slate-950 font-bold shadow-md shadow-emerald-500/20'
              : 'text-[var(--el-text-color-secondary)] hover:bg-[var(--el-card-bg-color)] hover:text-[var(--el-text-color-primary)]'"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            <span>{{ t('settings.passwordTab') }}</span>
          </button>
        </nav>
      </div>

      <!-- System Group -->
      <div class="space-y-2 pt-3 border-t border-[var(--el-border-color)]/60">
        <h3 class="text-[10px] font-bold uppercase tracking-widest text-[var(--el-text-color-secondary)]">
          {{ t('settings.system') }}
        </h3>
        <nav class="space-y-1">
          <!-- Camera Management Tab -->
          <button
            @click="activeTab = 'cameras'"
            class="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-semibold transition-all cursor-pointer text-left"
            :class="activeTab === 'cameras'
              ? 'bg-[var(--primary-green)] text-slate-950 font-bold shadow-md shadow-emerald-500/20'
              : 'text-[var(--el-text-color-secondary)] hover:bg-[var(--el-card-bg-color)] hover:text-[var(--el-text-color-primary)]'"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            <span>{{ t('settings.camerasTab') }}</span>
          </button>

          <button
            @click="activeTab = 'preferences'"
            class="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-semibold transition-all cursor-pointer text-left"
            :class="activeTab === 'preferences'
              ? 'bg-[var(--primary-green)] text-slate-950 font-bold shadow-md shadow-emerald-500/20'
              : 'text-[var(--el-text-color-secondary)] hover:bg-[var(--el-card-bg-color)] hover:text-[var(--el-text-color-primary)]'"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            </svg>
            <span>{{ t('settings.preferencesTab') }}</span>
          </button>

          <button
            @click="activeTab = 'storage'"
            class="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-semibold transition-all cursor-pointer text-left"
            :class="activeTab === 'storage'
              ? 'bg-[var(--primary-green)] text-slate-950 font-bold shadow-md shadow-emerald-500/20'
              : 'text-[var(--el-text-color-secondary)] hover:bg-[var(--el-card-bg-color)] hover:text-[var(--el-text-color-primary)]'"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
            </svg>
            <span>{{ t('settings.storageTab') }}</span>
          </button>
        </nav>
      </div>

      <!-- Legal Group -->
      <div class="space-y-2 pt-3 border-t border-[var(--el-border-color)]/60">
        <h3 class="text-[10px] font-bold uppercase tracking-widest text-[var(--el-text-color-secondary)]">
          {{ t('settings.legal') }}
        </h3>
        <nav class="space-y-1">
          <button
            @click="activeTab = 'legal'"
            class="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-semibold transition-all cursor-pointer text-left"
            :class="activeTab === 'legal'
              ? 'bg-[var(--primary-green)] text-slate-950 font-bold shadow-md shadow-emerald-500/20'
              : 'text-[var(--el-text-color-secondary)] hover:bg-[var(--el-card-bg-color)] hover:text-[var(--el-text-color-primary)]'"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <span>{{ t('settings.termsTab') }}</span>
          </button>
        </nav>
      </div>
    </aside>

    <!-- Right Content Area -->
    <main class="flex-1 p-6 md:p-10 overflow-y-auto custom-scrollbar space-y-6">
      <!-- 1. Profile Settings Tab -->
      <div v-if="activeTab === 'profile'" class="space-y-6 max-w-2xl">
        <div>
          <h2 class="text-2xl font-bold tracking-tight text-[var(--el-text-color-primary)]">
            {{ t('settings.profileTab') }}
          </h2>
          <p class="text-xs text-[var(--el-text-color-secondary)] mt-1">
            {{ t('settings.profileSub') }}
          </p>
        </div>

        <div class="space-y-6 bg-[var(--el-bg-color)]/50 border border-[var(--el-border-color)] rounded-2xl p-6">
          <div class="flex items-center gap-5">
            <div class="w-16 h-16 rounded-2xl bg-[var(--primary-green)] text-slate-950 flex items-center justify-center font-bold text-xl shadow-md">
              {{ profileForm.name ? profileForm.name.charAt(0).toUpperCase() : 'U' }}
            </div>
            <div>
              <p class="text-xs font-bold text-[var(--el-text-color-primary)]">{{ t('settings.avatarLabel') }}</p>
              <p class="text-[11px] text-[var(--el-text-color-secondary)] mt-0.5">{{ t('settings.avatarHint') }}</p>
            </div>
          </div>

          <div class="space-y-4">
            <div>
              <label class="block text-xs font-bold text-[var(--el-text-color-secondary)] mb-1.5">{{ t('settings.fullName') }}</label>
              <el-input v-model="profileForm.name" :placeholder="t('settings.namePlaceholder')" size="large" />
            </div>

            <div>
              <label class="block text-xs font-bold text-[var(--el-text-color-secondary)] mb-1.5">{{ t('settings.email') }}</label>
              <el-input v-model="profileForm.email" disabled size="large" />
            </div>

            <div class="pt-2">
              <button
                @click="saveProfile"
                :disabled="savingProfile"
                class="px-5 py-2.5 rounded-xl bg-[var(--primary-green)] hover:bg-emerald-400 text-slate-950 text-xs font-bold transition-all shadow-md cursor-pointer disabled:opacity-50"
              >
                <span>{{ savingProfile ? t('common.loading') : t('settings.saveProfile') }}</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- 2. Password Change Tab -->
      <div v-else-if="activeTab === 'password'" class="space-y-6 max-w-2xl">
        <div>
          <h2 class="text-2xl font-bold tracking-tight text-[var(--el-text-color-primary)]">
            {{ t('settings.passwordTab') }}
          </h2>
          <p class="text-xs text-[var(--el-text-color-secondary)] mt-1">
            {{ t('settings.passwordSub') }}
          </p>
        </div>

        <div class="space-y-4 bg-[var(--el-bg-color)]/50 border border-[var(--el-border-color)] rounded-2xl p-6">
          <div>
            <label class="block text-xs font-bold text-[var(--el-text-color-secondary)] mb-1.5">{{ t('settings.currentPassword') }}</label>
            <el-input v-model="passwordForm.currentPassword" type="password" show-password size="large" />
          </div>

          <div>
            <label class="block text-xs font-bold text-[var(--el-text-color-secondary)] mb-1.5">{{ t('settings.newPassword') }}</label>
            <el-input v-model="passwordForm.newPassword" type="password" show-password :placeholder="t('settings.newPasswordHint')" size="large" />
          </div>

          <div>
            <label class="block text-xs font-bold text-[var(--el-text-color-secondary)] mb-1.5">{{ t('settings.confirmPassword') }}</label>
            <el-input v-model="passwordForm.confirmPassword" type="password" show-password :placeholder="t('settings.confirmPasswordHint')" size="large" />
          </div>

          <div class="pt-2">
            <button
              @click="changePassword"
              :disabled="savingPassword"
              class="px-5 py-2.5 rounded-xl bg-[var(--primary-green)] hover:bg-emerald-400 text-slate-950 text-xs font-bold transition-all shadow-md cursor-pointer disabled:opacity-50"
            >
              <span>{{ savingPassword ? t('common.loading') : t('settings.updatePasswordBtn') }}</span>
            </button>
          </div>
        </div>
      </div>

      <!-- 3. Camera Management Tab (NEW) -->
      <div v-else-if="activeTab === 'cameras'" class="space-y-6 max-w-4xl">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 class="text-2xl font-bold tracking-tight text-[var(--el-text-color-primary)]">
              {{ t('settings.camerasTitle') }}
            </h2>
            <p class="text-xs text-[var(--el-text-color-secondary)] mt-1">
              {{ t('settings.camerasSubtitle') }}
            </p>
          </div>

          <button
            @click="emit('open-add-camera')"
            class="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[var(--primary-green)] text-slate-950 text-xs font-bold shadow-md shadow-emerald-500/20 hover:opacity-95 cursor-pointer shrink-0"
          >
            <span>+ {{ t('settings.addCamera') }}</span>
          </button>
        </div>

        <!-- Cameras List -->
        <div v-if="cameras.length === 0" class="p-16 text-center bg-[var(--el-bg-color)]/50 border border-[var(--el-border-color)] rounded-2xl">
          <p class="text-xs font-medium text-[var(--el-text-color-secondary)]">{{ t('settings.noCameras') }}</p>
        </div>

        <div v-else class="space-y-3">
          <div
            v-for="cam in paginatedCameras"
            :key="cam.deviceSerial"
            class="p-4 rounded-2xl bg-[var(--el-bg-color)]/50 border border-[var(--el-border-color)] flex flex-col md:flex-row md:items-center justify-between gap-4 transition-all hover:border-[var(--primary-green)]/40"
          >
            <!-- Camera Info -->
            <div class="flex items-center gap-3.5">
              <div
                class="w-12 h-12 rounded-xl overflow-hidden shrink-0 border border-[var(--el-border-color)] bg-slate-900/60 flex items-center justify-center relative shadow-sm"
              >
                <img
                  v-if="cam.thumbnailUrl || cam.picUrl"
                  :src="api.getImageUrl(cam.thumbnailUrl || cam.picUrl)"
                  :alt="cam.deviceName"
                  class="w-full h-full object-cover"
                  @error="(e) => e.target.style.display = 'none'"
                />
                <svg v-else class="w-5 h-5" :class="cam.status === 1 ? 'text-emerald-400' : 'text-red-400'" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
                <span
                  class="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-[var(--el-card-bg-color)] z-10"
                  :class="cam.status === 1 ? 'bg-emerald-500' : 'bg-red-500'"
                ></span>
              </div>

              <div>
                <div class="flex items-center gap-2">
                  <h4 class="font-bold text-sm text-[var(--el-text-color-primary)]">
                    {{ cam.deviceName }}
                  </h4>
                  <span
                    class="text-[9px] font-bold px-2 py-0.5 rounded-full border"
                    :class="cam.status === 1 ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-red-500/10 text-red-400 border-red-500/20'"
                  >
                    {{ cam.status === 1 ? t('common.online') : t('common.offline') }}
                  </span>
                  <span
                    class="text-[9px] font-bold px-2 py-0.5 rounded-full border"
                    :class="cam.isEncrypt === 1 ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' : 'bg-slate-500/10 text-slate-400 border-slate-500/20'"
                  >
                    {{ cam.isEncrypt === 1 ? t('settings.encryptedBadge') : t('settings.unencryptedBadge') }}
                  </span>
                </div>

                <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[var(--el-text-color-secondary)] mt-1">
                  <span>SN: <strong class="font-mono text-[var(--el-text-color-primary)]">{{ cam.deviceSerial }}</strong></span>
                  <span>{{ t('cameras.validateCode') }}: <strong class="font-mono text-[var(--el-text-color-primary)]">{{ cam.validateCode || '--' }}</strong></span>
                </div>
              </div>
            </div>

            <!-- Actions -->
            <div class="flex items-center gap-2 shrink-0">
              <!-- View Live -->
              <button
                @click="selectCameraAndGoToLive(cam)"
                class="px-3 py-1.5 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 text-xs font-bold border border-emerald-500/30 transition-all cursor-pointer flex items-center gap-1"
                :title="t('settings.viewLiveBtn')"
              >
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span>{{ t('settings.viewLiveBtn') }}</span>
              </button>

              <!-- Edit Camera -->
              <button
                @click="openEditCameraModal(cam)"
                class="px-3 py-1.5 rounded-xl bg-[var(--el-card-bg-color)] hover:bg-[var(--el-border-color)] text-[var(--el-text-color-primary)] text-xs font-bold border border-[var(--el-border-color)] transition-all cursor-pointer flex items-center gap-1 shadow-sm"
                :title="t('settings.editCamera')"
              >
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
                <span>{{ t('settings.editCamera') }}</span>
              </button>

              <!-- Delete Camera -->
              <button
                @click="handleDeleteCamera(cam)"
                class="p-2 rounded-xl bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30 transition-all cursor-pointer"
                :title="t('settings.deleteCamera')"
              >
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </div>
          </div>

          <!-- Pagination Bar for Cameras in Settings -->
          <div
            v-if="cameras.length > camPageSize"
            class="flex items-center justify-between p-3 rounded-xl bg-[var(--el-bg-color)]/50 border border-[var(--el-border-color)] text-xs text-[var(--el-text-color-secondary)]"
          >
            <div>
              {{ t('common.showing') }}
              <span class="font-bold text-[var(--el-text-color-primary)] font-mono">
                {{ (camPage - 1) * camPageSize + 1 }}-{{ Math.min(camPage * camPageSize, cameras.length) }}
              </span>
              {{ t('common.of') }}
              <span class="font-bold text-[var(--el-text-color-primary)] font-mono">
                {{ cameras.length }}
              </span>
            </div>

            <div class="flex items-center gap-1.5">
              <button
                @click="camPage--"
                :disabled="camPage <= 1"
                class="px-2.5 py-1 rounded-lg bg-[var(--el-card-bg-color)] border border-[var(--el-border-color)] text-[var(--el-text-color-primary)] disabled:opacity-40 cursor-pointer hover:border-[var(--primary-green)] transition-all"
                :title="t('common.prevPage')"
              >
                &lt;
              </button>
              <span class="px-2 font-mono font-bold text-[var(--el-text-color-primary)]">{{ camPage }} / {{ totalCamPages }}</span>
              <button
                @click="camPage++"
                :disabled="camPage >= totalCamPages"
                class="px-2.5 py-1 rounded-lg bg-[var(--el-card-bg-color)] border border-[var(--el-border-color)] text-[var(--el-text-color-primary)] disabled:opacity-40 cursor-pointer hover:border-[var(--primary-green)] transition-all"
                :title="t('common.nextPage')"
              >
                &gt;
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- 4. Preferences (Theme & Language) Tab -->
      <div v-else-if="activeTab === 'preferences'" class="space-y-6 max-w-2xl">
        <div>
          <h2 class="text-2xl font-bold tracking-tight text-[var(--el-text-color-primary)]">
            {{ t('settings.preferencesTab') }}
          </h2>
          <p class="text-xs text-[var(--el-text-color-secondary)] mt-1">
            {{ t('settings.preferencesSub') }}
          </p>
        </div>

        <div class="space-y-6 bg-[var(--el-bg-color)]/50 border border-[var(--el-border-color)] rounded-2xl p-6">
          <div>
            <label class="block text-xs font-bold text-[var(--el-text-color-secondary)] mb-2">{{ t('settings.themeSetting') }}</label>
            <div class="grid grid-cols-2 gap-3">
              <button
                @click="!isDark && toggleTheme()"
                class="p-4 rounded-xl border flex items-center justify-between transition-all cursor-pointer"
                :class="isDark ? 'border-[var(--primary-green)] bg-[var(--primary-green)]/10 text-[var(--primary-green)]' : 'border-[var(--el-border-color)] bg-[var(--el-card-bg-color)] text-[var(--el-text-color-regular)]'"
              >
                <span class="text-xs font-bold">{{ t('settings.darkTheme') }}</span>
                <span v-if="isDark" class="text-xs font-bold">✓ {{ t('settings.currentTheme') }}</span>
              </button>

              <button
                @click="isDark && toggleTheme()"
                class="p-4 rounded-xl border flex items-center justify-between transition-all cursor-pointer"
                :class="!isDark ? 'border-[var(--primary-green)] bg-[var(--primary-green)]/10 text-[var(--primary-green)]' : 'border-[var(--el-border-color)] bg-[var(--el-card-bg-color)] text-[var(--el-text-color-regular)]'"
              >
                <span class="text-xs font-bold">{{ t('settings.lightTheme') }}</span>
                <span v-if="!isDark" class="text-xs font-bold">✓ {{ t('settings.currentTheme') }}</span>
              </button>
            </div>
          </div>

          <div>
            <label class="block text-xs font-bold text-[var(--el-text-color-secondary)] mb-2">{{ t('settings.langSetting') }}</label>
            <div class="grid grid-cols-2 gap-3">
              <button
                v-for="l in supportedLocales"
                :key="l.code"
                @click="setLocale(l.code)"
                class="p-4 rounded-xl border flex items-center justify-between transition-all cursor-pointer"
                :class="locale === l.code ? 'border-[var(--primary-green)] bg-[var(--primary-green)]/10 text-[var(--primary-green)]' : 'border-[var(--el-border-color)] bg-[var(--el-card-bg-color)] text-[var(--el-text-color-regular)]'"
              >
                <span class="text-xs font-bold">{{ l.flag }} {{ l.label }}</span>
                <span v-if="locale === l.code" class="text-xs font-bold">✓ {{ t('settings.currentTheme') }}</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- 5. Storage & AI Models Tab -->
      <div v-else-if="activeTab === 'storage'" class="space-y-6 max-w-2xl">
        <div>
          <h2 class="text-2xl font-bold tracking-tight text-[var(--el-text-color-primary)]">
            {{ t('settings.storageTab') }}
          </h2>
          <p class="text-xs text-[var(--el-text-color-secondary)] mt-1">
            {{ t('settings.storageSub') }}
          </p>
        </div>

        <div class="space-y-4 bg-[var(--el-bg-color)]/50 border border-[var(--el-border-color)] rounded-2xl p-6 text-xs text-[var(--el-text-color-secondary)]">
          <div class="flex justify-between items-center py-2 border-b border-[var(--el-border-color)]">
            <span>S3 Bucket MinIO</span>
            <span class="font-mono font-bold text-[var(--el-text-color-primary)]">agrhub-storage / camos-data</span>
          </div>

          <div class="flex justify-between items-center py-2 border-b border-[var(--el-border-color)]">
            <span>{{ t('settings.storageModel') }}</span>
            <span class="font-mono font-bold text-[var(--primary-green)]">Gemini 2.5 Flash + Roboflow Trap AI</span>
          </div>

          <div class="flex justify-between items-center py-2 border-b border-[var(--el-border-color)]">
            <span>{{ t('settings.storageRetention') }}</span>
            <span class="font-bold text-[var(--el-text-color-primary)]">{{ t('settings.storageMonths') }}</span>
          </div>
        </div>
      </div>

      <!-- 6. Legal / Terms Tab -->
      <div v-else-if="activeTab === 'legal'" class="space-y-6 max-w-2xl">
        <div>
          <h2 class="text-2xl font-bold tracking-tight text-[var(--el-text-color-primary)]">
            {{ t('settings.termsTab') }}
          </h2>
          <p class="text-xs text-[var(--el-text-color-secondary)] mt-1">
            {{ t('settings.termsSub') }}
          </p>
        </div>

        <div class="bg-[var(--el-bg-color)] border border-[var(--el-border-color)] rounded-2xl p-6 text-xs text-[var(--el-text-color-secondary)] leading-relaxed space-y-3">
          <p>
            {{ t('settings.termsP1') }}
          </p>
          <p>
            {{ t('settings.termsP2') }}
          </p>
        </div>
      </div>
    </main>

    <!-- Edit Camera Dialog Modal -->
    <el-dialog
      v-model="editCameraDialogVisible"
      :title="t('settings.editCamera')"
      width="440px"
      append-to-body
      class="rounded-3xl"
    >
      <div class="space-y-4 pt-1">
        <div>
          <label class="block text-xs font-bold text-[var(--el-text-color-secondary)] mb-1.5">{{ t('cameras.serialNumber') }}</label>
          <el-input :model-value="editForm.deviceSerial" disabled size="large" />
        </div>

        <div>
          <label class="block text-xs font-bold text-[var(--el-text-color-secondary)] mb-1.5">{{ t('cameras.deviceName') }}</label>
          <el-input
            v-model="editForm.deviceName"
            :placeholder="t('settings.deviceNamePlaceholder')"
            size="large"
            clearable
          />
        </div>

        <div>
          <label class="block text-xs font-bold text-[var(--el-text-color-secondary)] mb-1.5">{{ t('cameras.validateCode') }}</label>
          <el-input
            v-model="editForm.validateCode"
            :placeholder="t('settings.validateCodePlaceholder')"
            size="large"
            clearable
            show-password
          />
        </div>
      </div>

      <template #footer>
        <div class="flex justify-end gap-2 pt-2">
          <el-button @click="editCameraDialogVisible = false" size="default">
            {{ t('common.cancel') }}
          </el-button>
          <el-button
            type="primary"
            :loading="savingCamera"
            @click="handleSaveEditCamera"
            size="default"
            class="!font-bold !rounded-xl"
          >
            {{ t('common.save') }}
          </el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useTheme } from '@/utils/theme';
import { useCameras } from '@/composables/useCameras';
import api from '@/services/api';
import { ElNotification, ElMessageBox } from 'element-plus';

const route = useRoute();
const { t } = useI18n();
const { isDark, toggleTheme } = useTheme();
const { cameras, loadCameras, openAddCameraModal, selectCameraAndGoToLive } = useCameras();

const activeTab = ref(route.query.tab || 'profile');
const savingProfile = ref(false);
const savingPassword = ref(false);

const profileForm = reactive({
  name: '',
  email: ''
});

const passwordForm = reactive({
  currentPassword: '',
  newPassword: '',
  confirmPassword: ''
});

// Edit Camera modal state
const editCameraDialogVisible = ref(false);
const savingCamera = ref(false);
const editForm = reactive({
  deviceSerial: '',
  deviceName: '',
  validateCode: ''
});

// Camera list pagination state
const camPage = ref(1);
const camPageSize = ref(5);
const totalCamPages = computed(() => Math.ceil(cameras.value.length / camPageSize.value) || 1);
const paginatedCameras = computed(() => {
  const start = (camPage.value - 1) * camPageSize.value;
  return cameras.value.slice(start, start + camPageSize.value);
});

onMounted(() => {
  try {
    const user = JSON.parse(localStorage.getItem('user')) || {};
    profileForm.name = user.name || user.email?.split('@')[0] || '';
    profileForm.email = user.email || '';
  } catch (e) {}
});

const saveProfile = async () => {
  try {
    const user = JSON.parse(localStorage.getItem('user')) || {};
    if (!user.id) return;

    savingProfile.value = true;
    const res = await api.updateProfile(user.id, { name: profileForm.name });
    if (res.data?.success) {
      localStorage.setItem('user', JSON.stringify(res.data.user));
      ElNotification({ title: t('common.success'), message: t('settings.saveProfile') + ' ✓', type: 'success' });
    } else {
      ElNotification({ title: t('common.error'), message: res.data?.message || 'Error saving profile', type: 'error' });
    }
  } catch (err) {
    ElNotification({ title: t('common.error'), message: 'Error saving profile.', type: 'error' });
  } finally {
    savingProfile.value = false;
  }
};

const changePassword = async () => {
  if (!passwordForm.currentPassword || !passwordForm.newPassword) {
    ElNotification({ title: t('common.error'), message: 'Please fill in all password fields!', type: 'warning' });
    return;
  }
  if (passwordForm.newPassword !== passwordForm.confirmPassword) {
    ElNotification({ title: t('common.error'), message: 'Password confirmation does not match!', type: 'error' });
    return;
  }
  if (passwordForm.newPassword.length < 6) {
    ElNotification({ title: t('common.error'), message: 'New password must be at least 6 characters!', type: 'error' });
    return;
  }

  try {
    const user = JSON.parse(localStorage.getItem('user')) || {};
    if (!user.id) return;

    savingPassword.value = true;
    const res = await api.changePassword(user.id, passwordForm.currentPassword, passwordForm.newPassword);
    if (res.data?.success) {
      ElNotification({ title: t('common.success'), message: t('settings.updatePasswordBtn') + ' ✓', type: 'success' });
      passwordForm.currentPassword = '';
      passwordForm.newPassword = '';
      passwordForm.confirmPassword = '';
    } else {
      ElNotification({ title: t('common.error'), message: res.data?.message || 'Failed to change password.', type: 'error' });
    }
  } catch (err) {
    ElNotification({ title: t('common.error'), message: err.response?.data?.message || 'Error changing password.', type: 'error' });
  } finally {
    savingPassword.value = false;
  }
};

const openEditCameraModal = (cam) => {
  editForm.deviceSerial = cam.deviceSerial;
  editForm.deviceName = cam.deviceName || '';
  editForm.validateCode = cam.validateCode || '';
  editCameraDialogVisible.value = true;
};

const handleSaveEditCamera = async () => {
  try {
    const user = JSON.parse(localStorage.getItem('user')) || {};
    savingCamera.value = true;
    const res = await api.updateCamera(user.id, editForm.deviceSerial, {
      deviceName: editForm.deviceName,
      validateCode: editForm.validateCode
    });
    if (res.data?.success) {
      ElNotification({ title: t('common.success'), message: t('settings.cameraUpdated'), type: 'success' });
      editCameraDialogVisible.value = false;
      await loadCameras();
    } else {
      ElNotification({ title: t('common.error'), message: res.data?.message || 'Failed to update camera', type: 'error' });
    }
  } catch (err) {
    ElNotification({ title: t('common.error'), message: err.message, type: 'error' });
  } finally {
    savingCamera.value = false;
  }
};

const handleDeleteCamera = async (cam) => {
  try {
    await ElMessageBox.confirm(
      `${t('settings.deleteCameraConfirm')} (${cam.deviceName} - ${cam.deviceSerial})`,
      t('settings.deleteCamera'),
      {
        confirmButtonText: t('common.delete'),
        cancelButtonText: t('common.cancel'),
        type: 'warning'
      }
    );

    const user = JSON.parse(localStorage.getItem('user')) || {};
    const res = await api.deleteCamera(user.id, cam.deviceSerial);
    if (res.data?.success) {
      ElNotification({ title: t('common.success'), message: t('settings.cameraDeleted'), type: 'success' });
      await loadCameras();
    } else {
      ElNotification({ title: t('common.error'), message: res.data?.message || 'Failed to remove camera', type: 'error' });
    }
  } catch (e) {
    // cancelled or error
  }
};
</script>
