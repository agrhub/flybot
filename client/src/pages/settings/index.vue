<template>
  <el-card shadow="never" class="settings-shell max-w-7xl mx-auto" body-class="settings-shell__body">
    <div class="h-full flex flex-col md:flex-row overflow-hidden">
      <!-- Left settings navigation -->
      <aside class="settings-nav w-full md:w-64 shrink-0 flex flex-col overflow-y-auto custom-scrollbar">
        <div class="px-4 md:px-5 pt-4 md:pt-5 pb-3">
          <h1 class="settings-nav__title">{{ t('settings.title') }}</h1>
          <p v-if="!isMobile" class="settings-nav__desc">{{ t('settings.desc') }}</p>
          <!-- Phones: the section list is a dropdown, so the page content stays on screen -->
          <el-select v-if="isMobile" v-model="activeTab" class="w-full mt-3" size="large">
            <el-option-group v-for="group in mobileSections" :key="group.label" :label="group.label">
              <el-option v-for="item in group.items" :key="item.value" :label="item.label" :value="item.value" />
            </el-option-group>
          </el-select>
        </div>

        <el-menu
          v-if="!isMobile"
          :default-active="activeTab"
          class="settings-menu"
          @select="(key) => (activeTab = key)"
        >
          <el-menu-item-group :title="t('settings.account')">
            <el-menu-item index="profile">
              <el-icon><User /></el-icon>
              <span>{{ t('settings.profileTab') }}</span>
            </el-menu-item>
            <el-menu-item index="password">
              <el-icon><Lock /></el-icon>
              <span>{{ t('settings.passwordTab') }}</span>
            </el-menu-item>
            <el-menu-item index="sessions">
              <el-icon><Monitor /></el-icon>
              <span>{{ t('settings.sessionsTab') }}</span>
            </el-menu-item>
          </el-menu-item-group>

          <el-menu-item-group :title="t('settings.system')">
            <el-menu-item index="cameras">
              <el-icon><VideoCamera /></el-icon>
              <span>{{ t('settings.camerasTab') }}</span>
            </el-menu-item>
            <el-menu-item index="notifications">
              <el-icon><Bell /></el-icon>
              <span>{{ t('settings.notificationsTab') }}</span>
            </el-menu-item>
            <el-menu-item index="preferences">
              <el-icon><Brush /></el-icon>
              <span>{{ t('settings.preferencesTab') }}</span>
            </el-menu-item>
            <el-menu-item index="storage">
              <el-icon><Coin /></el-icon>
              <span>{{ t('settings.storageTab') }}</span>
            </el-menu-item>
          </el-menu-item-group>

          <el-menu-item-group v-if="isAdmin" :title="t('admin.group')">
            <el-menu-item index="adminUsers">
              <el-icon><UserFilled /></el-icon>
              <span>{{ t('admin.users.tab') }}</span>
            </el-menu-item>
            <el-menu-item index="adminCameras">
              <el-icon><Camera /></el-icon>
              <span>{{ t('admin.cameras.tab') }}</span>
            </el-menu-item>
            <el-menu-item index="adminSystem">
              <el-icon><Tools /></el-icon>
              <span>{{ t('admin.system.tab') }}</span>
            </el-menu-item>
            <el-menu-item index="adminAudit">
              <el-icon><Tickets /></el-icon>
              <span>{{ t('audit.tab') }}</span>
            </el-menu-item>
          </el-menu-item-group>

          <el-menu-item-group :title="t('settings.legal')">
            <el-menu-item index="legal">
              <el-icon><Document /></el-icon>
              <span>{{ t('settings.termsTab') }}</span>
            </el-menu-item>
          </el-menu-item-group>
        </el-menu>
      </aside>

      <!-- Right content area -->
      <main class="flex-1 min-w-0 p-4 md:p-8 overflow-y-auto custom-scrollbar">
        <!-- 1. Profile -->
        <div v-if="activeTab === 'profile'" class="max-w-2xl">
          <PageHeader :title="t('settings.profileTab')" :subtitle="t('settings.profileSub')" />

          <el-card shadow="never">
            <div class="flex items-center gap-4 mb-6">
              <el-avatar :size="64" shape="square" class="settings-avatar">
                {{ profileForm.name ? profileForm.name.charAt(0).toUpperCase() : 'U' }}
              </el-avatar>
              <div>
                <p class="settings-label">{{ t('settings.avatarLabel') }}</p>
                <p class="settings-meta mt-1">{{ t('settings.avatarHint') }}</p>
              </div>
            </div>

            <el-form label-position="top" @submit.prevent>
              <el-form-item :label="t('settings.fullName')">
                <el-input v-model="profileForm.name" :placeholder="t('settings.namePlaceholder')" />
              </el-form-item>
              <el-form-item :label="t('settings.email')">
                <el-input v-model="profileForm.email" disabled />
              </el-form-item>
              <el-form-item class="!mb-0">
                <el-button type="primary" :loading="savingProfile" @click="saveProfile">
                  {{ t('settings.saveProfile') }}
                </el-button>
              </el-form-item>
            </el-form>
          </el-card>
        </div>

        <!-- 2. Password -->
        <div v-else-if="activeTab === 'password'" class="max-w-2xl">
          <PageHeader :title="t('settings.passwordTab')" :subtitle="t('settings.passwordSub')" />

          <el-card shadow="never">
            <el-form label-position="top" @submit.prevent>
              <el-form-item :label="t('settings.currentPassword')">
                <el-input v-model="passwordForm.currentPassword" type="password" show-password />
              </el-form-item>
              <el-form-item :label="t('settings.newPassword')">
                <el-input
                  v-model="passwordForm.newPassword"
                  type="password"
                  show-password
                  :placeholder="t('settings.newPasswordHint')"
                />
              </el-form-item>
              <el-form-item :label="t('settings.confirmPassword')">
                <el-input
                  v-model="passwordForm.confirmPassword"
                  type="password"
                  show-password
                  :placeholder="t('settings.confirmPasswordHint')"
                />
              </el-form-item>
              <el-form-item class="!mb-0">
                <el-button type="primary" :loading="savingPassword" @click="changePassword">
                  {{ t('settings.updatePasswordBtn') }}
                </el-button>
              </el-form-item>
            </el-form>
          </el-card>
        </div>

        <!-- 3. Camera management -->
        <div v-else-if="activeTab === 'cameras'" class="max-w-5xl">
          <PageHeader :title="t('settings.camerasTitle')" :subtitle="t('settings.camerasSubtitle')">
            <template #actions>
              <el-button v-if="canManageCameras" type="primary" :icon="Plus" @click="openAddCameraModal">
                {{ t('settings.addCamera') }}
              </el-button>
            </template>
          </PageHeader>

          <el-card shadow="never">
            <el-empty v-if="cameras.length === 0" :description="canManageCameras ? t('settings.noCameras') : t('cameras.noSharedCameras')" />

            <template v-else>
              <!-- Phones: one card per camera instead of a wide table -->
              <div v-if="isMobile" class="flex flex-col gap-3">
                <div v-for="row in paginatedCameras" :key="row.deviceSerial" class="settings-cam-row">
                  <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0">
                      <p class="settings-label truncate">{{ row.deviceName }}</p>
                      <p class="settings-meta font-mono">{{ row.deviceSerial }}</p>
                    </div>
                    <el-tag :type="row.status === 1 ? 'success' : 'danger'" effect="light" round size="small" class="shrink-0">
                      {{ row.status === 1 ? t('common.online') : t('common.offline') }}
                    </el-tag>
                  </div>
                  <div class="flex flex-wrap items-center gap-1.5 mt-2">
                    <el-tag v-if="row.access === 'owner' || !row.access" type="success" effect="light" round size="small">{{ t('share.accessOwner') }}</el-tag>
                    <el-tag v-else :type="row.access === 'admin' ? 'warning' : 'info'" effect="light" round size="small">
                      {{ row.access === 'admin' ? t('share.accessAdmin') : t('share.accessShared') }}
                    </el-tag>
                    <el-tag v-if="row.canManage && row.sharedWith?.length" type="info" effect="plain" size="small">
                      {{ t('share.sharedCount', { count: row.sharedWith.length }) }}
                    </el-tag>
                    <el-tag v-if="row.isEncrypt === 1" type="warning" effect="light" round size="small">{{ t('settings.encryptedBadge') }}</el-tag>
                  </div>
                  <div class="flex items-center justify-between gap-2 mt-3">
                    <el-button size="small" type="primary" plain :icon="VideoPlay" @click="selectCameraAndGoToLive(row)">
                      {{ t('settings.viewLiveBtn') }}
                    </el-button>
                    <div v-if="row.canManage !== false" class="flex items-center gap-1">
                      <el-button size="small" circle :icon="Share" :title="t('share.button')" @click="openShareDialog(row)" />
                      <el-button size="small" circle :icon="Edit" :title="t('settings.editCamera')" @click="openEditCameraModal(row)" />
                      <el-button size="small" circle type="danger" plain :icon="Delete" :title="t('settings.deleteCamera')" @click="handleDeleteCamera(row)" />
                    </div>
                  </div>
                </div>
              </div>

              <el-table v-else :data="paginatedCameras" row-key="deviceSerial" style="width: 100%">
                <el-table-column width="76">
                  <template #default="{ row }">
                    <el-image
                      v-if="row.thumbnailUrl || row.picUrl"
                      :src="api.getImageUrl(row.thumbnailUrl || row.picUrl)"
                      :alt="row.deviceName"
                      fit="cover"
                      class="settings-thumb"
                    >
                      <template #error>
                        <div class="settings-thumb settings-thumb--empty">
                          <el-icon><VideoCamera /></el-icon>
                        </div>
                      </template>
                    </el-image>
                    <div v-else class="settings-thumb settings-thumb--empty">
                      <el-icon><VideoCamera /></el-icon>
                    </div>
                  </template>
                </el-table-column>

                <el-table-column :label="t('cameras.deviceName')" min-width="160">
                  <template #default="{ row }">
                    <span class="font-semibold">{{ row.deviceName }}</span>
                  </template>
                </el-table-column>

                <el-table-column :label="t('cameras.serialNumber')" min-width="150">
                  <template #default="{ row }">
                    <span class="font-mono">{{ row.deviceSerial }}</span>
                  </template>
                </el-table-column>

                <el-table-column :label="t('share.access')" min-width="170">
                  <template #default="{ row }">
                    <el-tag v-if="row.access === 'owner' || !row.access" type="success" effect="light" round size="small">
                      {{ t('share.accessOwner') }}
                    </el-tag>
                    <el-tooltip v-else :content="row.owner?.email || ''" placement="top" :disabled="!row.owner?.email">
                      <el-tag :type="row.access === 'admin' ? 'warning' : 'info'" effect="light" round size="small">
                        {{ row.access === 'admin' ? t('share.accessAdmin') : t('share.accessShared') }}
                      </el-tag>
                    </el-tooltip>
                    <el-tag
                      v-if="row.canManage && row.sharedWith?.length"
                      type="info"
                      effect="plain"
                      size="small"
                      class="ml-1"
                    >
                      {{ t('share.sharedCount', { count: row.sharedWith.length }) }}
                    </el-tag>
                  </template>
                </el-table-column>

                <el-table-column :label="t('cameras.validateCode')" min-width="120">
                  <template #default="{ row }">
                    <span class="font-mono">{{ row.validateCode || '--' }}</span>
                  </template>
                </el-table-column>

                <el-table-column :label="t('cameras.status')" width="110">
                  <template #default="{ row }">
                    <el-tag :type="row.status === 1 ? 'success' : 'danger'" effect="light" round size="small">
                      {{ row.status === 1 ? t('common.online') : t('common.offline') }}
                    </el-tag>
                  </template>
                </el-table-column>

                <el-table-column :label="t('settings.encryptionStatus')" width="140">
                  <template #default="{ row }">
                    <el-tag :type="row.isEncrypt === 1 ? 'warning' : 'info'" effect="light" round size="small">
                      {{ row.isEncrypt === 1 ? t('settings.encryptedBadge') : t('settings.unencryptedBadge') }}
                    </el-tag>
                  </template>
                </el-table-column>

                <el-table-column :label="t('common.actions')" width="240" align="right">
                  <template #default="{ row }">
                    <el-button link type="primary" :icon="VideoPlay" @click="selectCameraAndGoToLive(row)">
                      {{ t('settings.viewLiveBtn') }}
                    </el-button>
                    <template v-if="row.canManage !== false">
                      <el-tooltip :content="t('share.button')" placement="top">
                        <el-button link :icon="Share" @click="openShareDialog(row)" />
                      </el-tooltip>
                      <el-tooltip :content="t('settings.editCamera')" placement="top">
                        <el-button link :icon="Edit" @click="openEditCameraModal(row)" />
                      </el-tooltip>
                      <el-tooltip :content="t('settings.deleteCamera')" placement="top">
                        <el-button link type="danger" :icon="Delete" @click="handleDeleteCamera(row)" />
                      </el-tooltip>
                    </template>
                  </template>
                </el-table-column>
              </el-table>

              <div
                v-if="cameras.length > camPageSize"
                class="flex flex-wrap items-center justify-between gap-3 mt-4"
              >
                <span class="settings-meta">
                  {{ t('common.showing') }}
                  {{ (camPage - 1) * camPageSize + 1 }}-{{ Math.min(camPage * camPageSize, cameras.length) }}
                  {{ t('common.of') }} {{ cameras.length }}
                </span>
                <el-pagination
                  v-model:current-page="camPage"
                  :page-size="camPageSize"
                  :total="cameras.length"
                  layout="prev, pager, next"
                  background
                  size="small"
                />
              </div>
            </template>
          </el-card>
        </div>

        <!-- 4. Notifications -->
        <div v-else-if="activeTab === 'notifications'" class="max-w-3xl">
          <PageHeader :title="t('settings.notificationsTab')" :subtitle="t('settings.notificationsSub')" />

          <!-- Email alerts -->
          <el-card shadow="never" class="mb-4">
            <div class="flex items-start justify-between gap-4">
              <div class="min-w-0">
                <div class="flex items-center gap-2">
                  <span class="settings-section-title">{{ t('settings.emailAlerts') }}</span>
                  <el-tag v-if="authUser?.emailVerified" type="success" effect="light" round size="small">
                    {{ t('settings.emailVerifiedBadge') }}
                  </el-tag>
                </div>
                <p class="settings-body mt-1">{{ t('settings.emailAlertsDesc') }}</p>
                <p class="settings-meta mt-1">{{ authUser?.email }}</p>
              </div>
              <el-switch
                :model-value="emailAlertsEnabled"
                :loading="savingPrefs"
                @change="saveEmailAlerts"
              />
            </div>

            <el-alert
              v-if="authUser && authUser.emailVerified === false"
              type="warning"
              :closable="false"
              show-icon
              class="mt-4"
            >
              <template #title>
                <span>{{ t('settings.emailNotVerified') }}</span>
                <el-button link type="primary" class="ml-2" :loading="resending" @click="resendVerification">
                  {{ t('auth.resendVerification') }}
                </el-button>
              </template>
            </el-alert>
          </el-card>

          <!-- Telegram alerts -->
          <el-card shadow="never" class="mb-4" v-loading="loadingSystemInfo">
            <div class="flex items-start justify-between gap-4">
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="settings-label">{{ t('settings.telegram.title') }}</span>
                  <el-tag v-if="telegramConnected" type="success" effect="light" round size="small">
                    {{ authUser?.telegram?.username ? t('settings.telegram.connectedAs', { username: authUser.telegram.username }) : t('settings.telegram.connected') }}
                  </el-tag>
                </div>
                <p class="settings-meta mt-1">{{ t('settings.telegram.desc') }}</p>
              </div>
              <el-switch
                v-if="telegramConnected"
                :model-value="authUser?.notificationPrefs?.telegram !== false"
                :loading="savingPrefs"
                @change="saveTelegramAlerts"
              />
            </div>

            <el-alert
              v-if="systemInfo && !systemInfo.telegram?.enabled"
              type="info"
              :title="t('settings.telegram.notConfigured')"
              :closable="false"
              show-icon
              class="mt-3"
            />

            <template v-else-if="systemInfo">
              <div v-if="telegramConnected" class="flex flex-wrap gap-2 mt-3">
                <el-button :icon="Promotion" :loading="sendingTelegramTest" @click="sendTelegramTest">
                  {{ t('settings.telegram.sendTest') }}
                </el-button>
                <el-button type="danger" plain @click="unlinkTelegram">
                  {{ t('settings.telegram.disconnect') }}
                </el-button>
              </div>

              <div v-else class="mt-3 space-y-3">
                <el-button type="primary" :icon="ChatDotRound" :loading="linkingTelegram" @click="connectTelegram">
                  {{ t('settings.telegram.connect') }}
                </el-button>
                <el-alert
                  v-if="waitingForTelegram"
                  type="warning"
                  :title="t('settings.telegram.waiting', { bot: systemInfo.telegram.botUsername })"
                  :closable="false"
                  show-icon
                >
                  <el-button link type="primary" @click="refreshUser">{{ t('settings.telegram.checkNow') }}</el-button>
                </el-alert>
              </div>
            </template>
          </el-card>

          <!-- Push notifications on this device (installed app / browser) -->
          <PushNotificationsCard />

          <!-- Per-camera thresholds -->
          <el-card shadow="never">
            <template #header>
              <div class="settings-section-title">{{ t('settings.thresholdsTitle') }}</div>
              <p class="settings-meta mt-1">{{ t('settings.thresholdsDesc') }}</p>
            </template>

            <el-empty v-if="manageableCameras.length === 0" :description="t('settings.noCameras')" :image-size="80" />
            <div v-else>
              <template v-for="(cam, idx) in manageableCameras" :key="cam.deviceSerial">
                <el-divider v-if="idx > 0" class="!my-0" />
                <div class="py-3 flex flex-wrap items-center justify-between gap-3">
                  <div class="min-w-0">
                    <p class="settings-label truncate">{{ cam.deviceName }}</p>
                    <p class="settings-meta font-mono">{{ cam.deviceSerial }}</p>
                  </div>
                  <div class="flex items-center gap-2">
                    <el-input-number
                      :model-value="cam.alertThreshold || 15"
                      :min="1"
                      :max="10000"
                      :step="1"
                      step-strictly
                      size="small"
                      :disabled="savingThreshold === cam.deviceSerial"
                      @change="(value) => saveThreshold(cam, value)"
                    />
                    <span class="settings-meta">{{ t('settings.thresholdUnit') }}</span>
                  </div>
                </div>
              </template>
            </div>
          </el-card>
        </div>

        <!-- 5. Preferences (theme & language) -->
        <div v-else-if="activeTab === 'preferences'" class="max-w-2xl">
          <PageHeader :title="t('settings.preferencesTab')" :subtitle="t('settings.preferencesSub')" />

          <el-card shadow="never">
            <el-form label-position="top" @submit.prevent>
              <el-form-item :label="t('settings.themeSetting')">
                <el-radio-group
                  :model-value="isDark ? 'dark' : 'light'"
                  @change="(mode) => (mode === 'dark') !== isDark && toggleTheme()"
                >
                  <el-radio-button value="dark">
                    <span class="inline-flex items-center gap-1.5">
                      <el-icon><Moon /></el-icon>{{ t('settings.darkTheme') }}
                    </span>
                  </el-radio-button>
                  <el-radio-button value="light">
                    <span class="inline-flex items-center gap-1.5">
                      <el-icon><Sunny /></el-icon>{{ t('settings.lightTheme') }}
                    </span>
                  </el-radio-button>
                </el-radio-group>
              </el-form-item>

              <el-form-item :label="t('settings.langSetting')" class="!mb-0">
                <el-radio-group :model-value="locale" @change="(code) => setLocale(code)">
                  <el-radio-button v-for="l in supportedLocales" :key="l.code" :value="l.code">
                    {{ l.flag }} {{ l.label }}
                  </el-radio-button>
                </el-radio-group>
              </el-form-item>
            </el-form>
          </el-card>
        </div>

        <!-- 6. Storage & AI models -->
        <!-- Signed-in devices -->
        <div v-else-if="activeTab === 'sessions'" class="max-w-4xl">
          <PageHeader :title="t('settings.sessionsTab')" :subtitle="t('settings.sessionsSub')">
            <template #actions>
              <el-button type="danger" plain :icon="SwitchButton" :loading="revokingOthers" @click="handleRevokeOthers">
                {{ t('settings.signOutOthers') }}
              </el-button>
            </template>
          </PageHeader>

          <el-alert
            v-if="sessionsUntracked"
            type="info"
            :title="t('settings.sessionsUntracked')"
            :closable="false"
            show-icon
            class="mb-4"
          />

          <el-card shadow="never">
            <el-table v-loading="loadingSessions" :data="sessions" class="w-full">
              <template #empty>
                <el-empty :description="t('settings.noSessions')" :image-size="60" />
              </template>
              <el-table-column :label="t('settings.sessionDevice')" min-width="200">
                <template #default="{ row }">
                  <div class="flex items-center gap-2">
                    <el-icon><Monitor /></el-icon>
                    <span>{{ row.browser }} · {{ row.os }}</span>
                    <el-tag v-if="row.current" type="success" effect="light" round size="small">
                      {{ t('settings.thisDevice') }}
                    </el-tag>
                  </div>
                </template>
              </el-table-column>
              <el-table-column :label="t('settings.sessionIp')" prop="ip" min-width="130" />
              <el-table-column :label="t('settings.sessionLastActive')" min-width="140">
                <template #default="{ row }">{{ relativeTime(row.lastSeenAt) }}</template>
              </el-table-column>
              <el-table-column :label="t('settings.sessionSignedIn')" min-width="170">
                <template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template>
              </el-table-column>
              <el-table-column width="120" align="right">
                <template #default="{ row }">
                  <el-button link type="danger" @click="handleRevokeSession(row)">
                    {{ t('settings.signOut') }}
                  </el-button>
                </template>
              </el-table-column>
            </el-table>
          </el-card>
        </div>

        <div v-else-if="activeTab === 'storage'" class="max-w-2xl">
          <PageHeader :title="t('settings.storageTab')" :subtitle="t('settings.storageSub')" />

          <el-card shadow="never" v-loading="loadingSystemInfo">
            <el-descriptions :column="1" border>
              <el-descriptions-item :label="t('settings.storageBucket')">
                <span class="font-mono">{{ systemInfo?.storage.bucket || '--' }}</span>
              </el-descriptions-item>
              <el-descriptions-item :label="t('settings.storageRetention')">
                {{ systemInfo ? t('settings.retentionMonths', { months: systemInfo.storage.retentionMonths }) : '--' }}
              </el-descriptions-item>
              <el-descriptions-item :label="t('settings.storageModel')">
                <template v-if="systemInfo">
                  {{ t(`settings.aiProvider.${systemInfo.ai.provider}`) }}
                  <span v-if="systemInfo.ai.model" class="font-mono"> · {{ systemInfo.ai.model }}</span>
                </template>
                <template v-else>--</template>
              </el-descriptions-item>
              <el-descriptions-item :label="t('settings.usageSnapshots')">
                {{ systemInfo ? t('settings.usageSnapshotsValue', {
                  snapshots: systemInfo.usage.snapshots.toLocaleString(),
                  analyzed: systemInfo.usage.analyzed.toLocaleString(),
                  cameras: systemInfo.usage.cameras
                }) : '--' }}
              </el-descriptions-item>
              <el-descriptions-item :label="t('settings.usageOldest')">
                {{ systemInfo?.usage.oldestSnapshotAt ? formatDateTime(systemInfo.usage.oldestSnapshotAt) : '--' }}
              </el-descriptions-item>
            </el-descriptions>
          </el-card>
        </div>

        <!-- 7. Legal / terms -->
        <div v-else-if="activeTab === 'adminUsers' && isAdmin" class="max-w-6xl">
          <AdminUsersPanel />
        </div>
        <div v-else-if="activeTab === 'adminCameras' && isAdmin" class="max-w-6xl">
          <AdminCamerasPanel />
        </div>
        <div v-else-if="activeTab === 'adminSystem' && isAdmin" class="max-w-3xl">
          <SystemSettingsPanel />
        </div>
        <div v-else-if="activeTab === 'adminAudit' && isAdmin" class="max-w-6xl">
          <AuditLogPanel />
        </div>

        <div v-else-if="activeTab === 'legal'" class="max-w-2xl">
          <PageHeader :title="t('settings.termsTab')" :subtitle="t('settings.termsSub')" />

          <el-card shadow="never">
            <p class="settings-body">{{ t('settings.termsP1') }}</p>
            <p class="settings-body mt-3">{{ t('settings.termsP2') }}</p>
          </el-card>
        </div>
      </main>
    </div>

    <!-- Edit camera dialog -->
    <el-dialog
      v-model="editCameraDialogVisible"
      :title="t('settings.editCamera')"
      width="440px"
      append-to-body
    >
      <el-form label-position="top" @submit.prevent>
        <el-form-item :label="t('cameras.serialNumber')">
          <el-input :model-value="editForm.deviceSerial" disabled />
        </el-form-item>
        <el-form-item :label="t('cameras.deviceName')">
          <el-input
            v-model="editForm.deviceName"
            :placeholder="t('settings.deviceNamePlaceholder')"
            clearable
          />
        </el-form-item>
        <el-form-item :label="t('cameras.validateCode')">
          <el-input
            v-model="editForm.validateCode"
            :placeholder="t('settings.validateCodePlaceholder')"
            clearable
            show-password
          />
        </el-form-item>
        <el-form-item :label="t('settings.captureInterval')">
          <el-select v-model="editForm.captureIntervalMinutes" class="w-full">
            <el-option
              v-for="minutes in CAPTURE_INTERVALS"
              :key="minutes"
              :value="minutes"
              :label="t('cameras.schedule.every', { minutes })"
            />
          </el-select>
        </el-form-item>
        <el-form-item class="!mb-0">
          <div class="flex items-start justify-between gap-4 w-full">
            <div>
              <div class="text-sm">{{ t('settings.captureDaytimeOnly') }}</div>
              <div class="text-xs" style="color: var(--el-text-color-secondary)">{{ t('settings.captureDaytimeOnlyHint') }}</div>
            </div>
            <el-switch v-model="editForm.captureDaytimeOnly" />
          </div>
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="editCameraDialogVisible = false">
          {{ t('common.cancel') }}
        </el-button>
        <el-button type="primary" :loading="savingCamera" @click="handleSaveEditCamera">
          {{ t('common.save') }}
        </el-button>
      </template>
    </el-dialog>
    <CameraShareDialog v-model="shareDialogVisible" :camera="shareDialogCamera" @changed="loadCameras" />
  </el-card>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onUnmounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useTheme } from '@/utils/theme';
import { useCameras } from '@/composables/useCameras';
import api from '@/services/api';
import { ElNotification, ElMessageBox } from 'element-plus';
import { useAuth } from '@/composables/useAuth';
import { useBreakpoints } from '@/composables/useBreakpoints';
import { useLanguage } from '@/composables/useLanguage';
import PageHeader from '@/components/common/PageHeader.vue';
import CameraShareDialog from '@/components/cameras/CameraShareDialog.vue';
import AdminUsersPanel from '@/components/admin/AdminUsersPanel.vue';
import AdminCamerasPanel from '@/components/admin/AdminCamerasPanel.vue';
import SystemSettingsPanel from '@/components/admin/SystemSettingsPanel.vue';
import AuditLogPanel from '@/components/admin/AuditLogPanel.vue';
import PushNotificationsCard from '@/components/settings/PushNotificationsCard.vue';
import {
  User,
  Lock,
  VideoCamera,
  Bell,
  Brush,
  Coin,
  Document,
  Plus,
  VideoPlay,
  Edit,
  Delete,
  Moon,
  Sunny,
  Monitor,
  SwitchButton,
  Promotion,
  ChatDotRound,
  Share,
  UserFilled,
  Camera,
  Tools,
  Tickets
} from '@element-plus/icons-vue';
import { useNotifications } from '@/composables/useNotifications';

const route = useRoute();
const { t } = useI18n();
const { isDark, toggleTheme } = useTheme();
const { cameras, loadCameras, openAddCameraModal, selectCameraAndGoToLive } = useCameras();
const { user: authUser, setAuth, refreshUser, logout, isAdmin, canManageCameras } = useAuth();
const manageableCameras = computed(() => cameras.value.filter(c => c.canManage !== false));
const { isMobile } = useBreakpoints();
// Same sections as the side menu, for the phone dropdown
const mobileSections = computed(() => [
  { label: t('settings.account'), items: [
    { value: 'profile', label: t('settings.profileTab') },
    { value: 'password', label: t('settings.passwordTab') },
    { value: 'sessions', label: t('settings.sessionsTab') }
  ] },
  { label: t('settings.system'), items: [
    { value: 'cameras', label: t('settings.camerasTab') },
    { value: 'notifications', label: t('settings.notificationsTab') },
    { value: 'preferences', label: t('settings.preferencesTab') },
    { value: 'storage', label: t('settings.storageTab') }
  ] },
  ...(isAdmin.value ? [{ label: t('admin.group'), items: [
    { value: 'adminUsers', label: t('admin.users.tab') },
    { value: 'adminCameras', label: t('admin.cameras.tab') },
    { value: 'adminSystem', label: t('admin.system.tab') },
    { value: 'adminAudit', label: t('audit.tab') }
  ] }] : []),
  { label: t('settings.legal'), items: [{ value: 'legal', label: t('settings.termsTab') }] }
]);

// ---------- Camera sharing ----------
const shareDialogVisible = ref(false);
const shareDialogCamera = ref(null);
const openShareDialog = (cam) => {
  shareDialogCamera.value = cam;
  shareDialogVisible.value = true;
};
// Used by the language picker in the preferences tab
const { locale, locales: supportedLocales, setAppLocale: setLocale } = useLanguage();

const activeTab = ref(route.query.tab || 'profile');
// Topbar links switch tabs while already on this page
watch(() => route.query.tab, (tab) => {
  if (tab) activeTab.value = tab;
});

// ---------- Signed-in devices ----------
const { relativeTime } = useNotifications();
const sessions = ref([]);
const sessionsUntracked = ref(false);
const loadingSessions = ref(false);
const revokingOthers = ref(false);

const formatDateTime = (value) => new Date(value).toLocaleString(locale.value === 'vi' ? 'vi-VN' : 'en-US');

const loadSessions = async () => {
  loadingSessions.value = true;
  try {
    const res = await api.getSessions();
    sessions.value = res.data?.sessions || [];
    sessionsUntracked.value = !!res.data?.currentUntracked;
  } catch (err) {
    ElNotification({ title: t('common.error'), message: t('settings.saveFailed'), type: 'error' });
  } finally {
    loadingSessions.value = false;
  }
};

const handleRevokeSession = async (row) => {
  try {
    await ElMessageBox.confirm(
      row.current ? t('settings.signOutThisConfirm') : t('settings.signOutConfirm', { device: `${row.browser} · ${row.os}` }),
      t('settings.signOut'),
      { type: 'warning', confirmButtonText: t('settings.signOut'), cancelButtonText: t('common.cancel') }
    );
  } catch {
    return;
  }
  try {
    const res = await api.revokeSession(row.id);
    if (res.data?.signedOut) {
      logout();
      return;
    }
    ElNotification({ title: t('common.success'), message: t('settings.signedOutDevice'), type: 'success' });
    loadSessions();
  } catch (err) {
    ElNotification({ title: t('common.error'), message: err.response?.data?.message || t('settings.saveFailed'), type: 'error' });
  }
};

const handleRevokeOthers = async () => {
  try {
    await ElMessageBox.confirm(t('settings.signOutOthersConfirm'), t('settings.signOutOthers'), {
      type: 'warning',
      confirmButtonText: t('settings.signOutOthers'),
      cancelButtonText: t('common.cancel')
    });
  } catch {
    return;
  }
  revokingOthers.value = true;
  try {
    const res = await api.revokeOtherSessions();
    if (res.data?.token) setAuth(authUser.value, res.data.token);
    ElNotification({ title: t('common.success'), message: t('settings.signedOutOthers'), type: 'success' });
    loadSessions();
  } catch (err) {
    ElNotification({ title: t('common.error'), message: err.response?.data?.message || t('settings.saveFailed'), type: 'error' });
  } finally {
    revokingOthers.value = false;
  }
};

// ---------- Storage & AI (real values from the server) ----------
const systemInfo = ref(null);
const loadingSystemInfo = ref(false);
const loadSystemInfo = async () => {
  loadingSystemInfo.value = true;
  try {
    const res = await api.getSystemInfo();
    systemInfo.value = res.data?.info || null;
  } catch (err) {
    systemInfo.value = null;
  } finally {
    loadingSystemInfo.value = false;
  }
};

watch(activeTab, (tab) => {
  if (tab === 'sessions') loadSessions();
  if (tab === 'storage' || tab === 'notifications') loadSystemInfo();
}, { immediate: true });

// ---------- Telegram ----------
const telegramConnected = computed(() => !!authUser.value?.telegram?.connected);
const linkingTelegram = ref(false);
const waitingForTelegram = ref(false);
const sendingTelegramTest = ref(false);
let telegramPoll = null;
const TELEGRAM_POLL_MS = 3000;
const TELEGRAM_POLL_LIMIT_MS = 15 * 60 * 1000; // the link code expires after 15 minutes

const stopTelegramPoll = () => {
  if (telegramPoll) clearInterval(telegramPoll);
  telegramPoll = null;
  waitingForTelegram.value = false;
};

const connectTelegram = async () => {
  linkingTelegram.value = true;
  try {
    const res = await api.createTelegramLink();
    window.open(res.data.url, '_blank', 'noopener');
    // Wait for the user to press Start in Telegram, then the profile shows the link
    waitingForTelegram.value = true;
    const startedAt = Date.now();
    if (telegramPoll) clearInterval(telegramPoll);
    telegramPoll = setInterval(async () => {
      await refreshUser();
      if (telegramConnected.value) {
        stopTelegramPoll();
        ElNotification({ title: t('common.success'), message: t('settings.telegram.linked'), type: 'success' });
      } else if (Date.now() - startedAt > TELEGRAM_POLL_LIMIT_MS) {
        stopTelegramPoll();
      }
    }, TELEGRAM_POLL_MS);
  } catch (err) {
    ElNotification({ title: t('common.error'), message: err.response?.data?.message || t('settings.saveFailed'), type: 'error' });
  } finally {
    linkingTelegram.value = false;
  }
};

const unlinkTelegram = async () => {
  try {
    await ElMessageBox.confirm(t('settings.telegram.disconnectConfirm'), t('settings.telegram.disconnect'), {
      type: 'warning',
      confirmButtonText: t('settings.telegram.disconnect'),
      cancelButtonText: t('common.cancel')
    });
  } catch {
    return;
  }
  try {
    await api.unlinkTelegram();
    await refreshUser();
  } catch (err) {
    ElNotification({ title: t('common.error'), message: t('settings.saveFailed'), type: 'error' });
  }
};

const sendTelegramTest = async () => {
  sendingTelegramTest.value = true;
  try {
    await api.sendTelegramTest();
    ElNotification({ title: t('common.success'), message: t('settings.telegram.testSent'), type: 'success' });
  } catch (err) {
    if (err.response?.data?.code === 'TELEGRAM_BLOCKED') refreshUser();
    ElNotification({ title: t('common.error'), message: err.response?.data?.message || t('settings.saveFailed'), type: 'error' });
  } finally {
    sendingTelegramTest.value = false;
  }
};

const saveTelegramAlerts = async (enabled) => {
  savingPrefs.value = true;
  try {
    const res = await api.updateProfile({ notificationPrefs: { telegram: enabled } });
    if (res.data?.user) setAuth(res.data.user);
    ElNotification({ title: t('common.success'), message: t('settings.prefsSaved'), type: 'success' });
  } catch (err) {
    ElNotification({ title: t('common.error'), message: err.response?.data?.message || t('settings.saveFailed'), type: 'error' });
  } finally {
    savingPrefs.value = false;
  }
};

onUnmounted(stopTelegramPoll);

// Notifications tab state
const savingPrefs = ref(false);
const savingThreshold = ref(null);
const resending = ref(false);
const emailAlertsEnabled = computed(() => authUser.value?.notificationPrefs?.email !== false);

const saveEmailAlerts = async (enabled) => {
  savingPrefs.value = true;
  try {
    const res = await api.updateProfile({ notificationPrefs: { email: enabled } });
    if (res.data?.user) setAuth(res.data.user);
    ElNotification({ title: t('common.success'), message: t('settings.prefsSaved'), type: 'success' });
  } catch (err) {
    ElNotification({ title: t('common.error'), message: err.response?.data?.message || t('settings.saveFailed'), type: 'error' });
  } finally {
    savingPrefs.value = false;
  }
};

const saveThreshold = async (cam, value) => {
  if (!Number.isInteger(value) || value < 1 || value === cam.alertThreshold) return;
  savingThreshold.value = cam.deviceSerial;
  try {
    await api.updateCamera(cam.deviceSerial, { alertThreshold: value });
    cam.alertThreshold = value;
    ElNotification({ title: t('common.success'), message: t('settings.thresholdSaved'), type: 'success', duration: 2000 });
  } catch (err) {
    ElNotification({ title: t('common.error'), message: err.response?.data?.message || t('settings.saveFailed'), type: 'error' });
  } finally {
    savingThreshold.value = null;
  }
};

const resendVerification = async () => {
  resending.value = true;
  try {
    const res = await api.resendVerification();
    if (res.data?.alreadyVerified) {
      refreshUser();
      return;
    }
    ElNotification({ title: t('common.success'), message: t('auth.verificationSent'), type: 'success' });
  } catch (err) {
    ElNotification({ title: t('common.error'), message: err.response?.data?.message || t('settings.saveFailed'), type: 'error' });
  } finally {
    resending.value = false;
  }
};
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
// Must match the server's allowed values (server/src/services/captureSchedule.js)
const CAPTURE_INTERVALS = [15, 30, 60, 120];

const editForm = reactive({
  captureIntervalMinutes: 30,
  captureDaytimeOnly: false,
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
      ElNotification({ title: t('common.error'), message: res.data?.message || t('settings.saveFailed'), type: 'error' });
    }
  } catch (err) {
    ElNotification({ title: t('common.error'), message: t('settings.saveFailed'), type: 'error' });
  } finally {
    savingProfile.value = false;
  }
};

const changePassword = async () => {
  if (!passwordForm.currentPassword || !passwordForm.newPassword) {
    ElNotification({ title: t('common.error'), message: t('settings.passwordFieldsRequired'), type: 'warning' });
    return;
  }
  if (passwordForm.newPassword !== passwordForm.confirmPassword) {
    ElNotification({ title: t('common.error'), message: t('auth.passwordMismatch'), type: 'error' });
    return;
  }
  if (passwordForm.newPassword.length < 6) {
    ElNotification({ title: t('common.error'), message: t('auth.passwordTooShort'), type: 'error' });
    return;
  }

  try {
    const user = JSON.parse(localStorage.getItem('user')) || {};
    if (!user.id) return;

    savingPassword.value = true;
    const res = await api.changePassword(user.id, passwordForm.currentPassword, passwordForm.newPassword);
    if (res.data?.success) {
      // Other sessions were signed out; keep this one with the fresh token
      if (res.data.token) setAuth(authUser.value, res.data.token);
      ElNotification({ title: t('common.success'), message: t('settings.passwordChanged'), type: 'success' });
      passwordForm.currentPassword = '';
      passwordForm.newPassword = '';
      passwordForm.confirmPassword = '';
    } else {
      ElNotification({ title: t('common.error'), message: res.data?.message || t('settings.saveFailed'), type: 'error' });
    }
  } catch (err) {
    ElNotification({ title: t('common.error'), message: err.response?.data?.message || t('settings.saveFailed'), type: 'error' });
  } finally {
    savingPassword.value = false;
  }
};

const openEditCameraModal = (cam) => {
  editForm.deviceSerial = cam.deviceSerial;
  editForm.deviceName = cam.deviceName || '';
  editForm.validateCode = cam.validateCode || '';
  editForm.captureIntervalMinutes = cam.captureIntervalMinutes || 30;
  editForm.captureDaytimeOnly = !!cam.captureDaytimeOnly;
  editCameraDialogVisible.value = true;
};

const handleSaveEditCamera = async () => {
  try {
    const user = JSON.parse(localStorage.getItem('user')) || {};
    savingCamera.value = true;
    const res = await api.updateCamera(user.id, editForm.deviceSerial, {
      deviceName: editForm.deviceName,
      validateCode: editForm.validateCode,
      captureIntervalMinutes: editForm.captureIntervalMinutes,
      captureDaytimeOnly: editForm.captureDaytimeOnly
    });
    if (res.data?.success) {
      ElNotification({ title: t('common.success'), message: t('settings.cameraUpdated'), type: 'success' });
      editCameraDialogVisible.value = false;
      await loadCameras();
    } else {
      ElNotification({ title: t('common.error'), message: res.data?.message || t('settings.saveFailed'), type: 'error' });
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
      ElNotification({ title: t('common.error'), message: res.data?.message || t('settings.saveFailed'), type: 'error' });
    }
  } catch (e) {
    // cancelled or error
  }
};
</script>

<style scoped>
.settings-shell {
  height: 100%;
  flex: 1;
  width: 100%;
  overflow: hidden;
}
.settings-shell :deep(.settings-shell__body) {
  height: 100%;
  padding: 0;
}
.settings-nav {
  border-bottom: 1px solid var(--el-border-color);
  background-color: var(--el-bg-color);
}
@media (min-width: 768px) {
  .settings-nav {
    border-bottom: none;
    border-right: 1px solid var(--el-border-color);
  }
}
.settings-nav__title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.settings-nav__desc {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}
.settings-menu {
  border-right: none;
  background-color: transparent;
}
.settings-section-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.settings-label {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.settings-body {
  margin: 0;
  font-size: 14px;
  line-height: 1.6;
  color: var(--el-text-color-regular);
}
.settings-meta {
  margin: 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.settings-avatar {
  font-size: 22px;
  font-weight: 600;
  background-color: var(--el-color-primary);
  color: var(--el-color-white);
}
.settings-cam-row {
  padding: 12px 14px;
  border: 1px solid var(--el-border-color);
  border-radius: var(--el-border-radius-base);
  background-color: var(--el-bg-color-overlay);
}
.settings-thumb {
  width: 48px;
  height: 48px;
  border-radius: 8px;
  display: block;
}
.settings-thumb--empty {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  background-color: var(--el-fill-color-light);
  color: var(--el-text-color-secondary);
}
</style>
