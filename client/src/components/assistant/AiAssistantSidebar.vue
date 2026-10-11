<template>
  <aside
    v-show="isAssistantOpen"
    id="smart-trap-assistant-sidebar"
    class="assistant-panel flex flex-col shrink-0 select-none"
    :class="isDesktop
      ? 'w-[420px] h-[100dvh] relative z-30'
      : 'assistant-panel--overlay fixed inset-y-0 right-0 w-full md:w-[420px] h-[100dvh] z-[2000]'"
  >
    <!-- Header -->
    <div class="assistant-header h-16 px-4 flex items-center justify-between gap-2 shrink-0">
      <!-- Title & live status -->
      <div class="flex items-center gap-2.5 min-w-0">
        <el-avatar :size="32" :icon="Monitor" shape="square" class="assistant-avatar shrink-0" />
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5 min-w-0">
            <span class="assistant-title truncate">{{ t('assistant.title') }}</span>
            <el-tag type="success" effect="light" size="small" class="font-mono">
              #{{ activeContext }}
            </el-tag>
          </div>
          <div class="flex items-center gap-1.5 mt-0.5 min-w-0">
            <span class="live-dot"></span>
            <span class="meta-text truncate">{{ t('assistant.subtitle') }}</span>
          </div>
        </div>
      </div>

      <!-- Action buttons -->
      <div class="flex items-center shrink-0">
        <el-tooltip :content="t('assistant.reset')" placement="bottom">
          <el-button text circle :icon="Refresh" @click="resetChat" />
        </el-tooltip>
        <el-tooltip :content="t('common.close')" placement="bottom">
          <el-button text circle :icon="Close" @click="closeAssistant" />
        </el-tooltip>
      </div>
    </div>

    <!-- Message stream -->
    <div ref="chatContainer" class="flex-1 p-4 overflow-y-auto space-y-4 custom-scrollbar select-text">
      <div
        v-for="(msg, idx) in messages"
        :key="idx"
        class="flex flex-col gap-1.5"
        :class="msg.role === 'user' ? 'items-end' : 'items-start'"
      >
        <!-- User bubble -->
        <div v-if="msg.role === 'user'" class="bubble bubble--user max-w-[85%]">
          {{ msg.content }}
        </div>

        <!-- Assistant bubble -->
        <div v-else class="max-w-[95%] w-full space-y-2">
          <div class="flex items-center gap-1.5">
            <el-avatar :size="20" :icon="ChatDotRound" class="assistant-avatar" />
            <span class="assistant-name">{{ t('assistant.title') }}</span>
          </div>

          <!-- Tool executions (if the agent ran tools) -->
          <el-collapse
            v-if="msg.toolExecutions && msg.toolExecutions.length > 0"
            class="tool-collapse select-none"
          >
            <el-collapse-item name="tools">
              <template #title>
                <span class="inline-flex items-center gap-1.5 meta-text">
                  <el-icon><Operation /></el-icon>
                  {{ t('assistant.toolExecutions', { count: msg.toolExecutions.length }) }}
                </span>
              </template>
              <div class="space-y-1.5">
                <div
                  v-for="(tool, tIdx) in msg.toolExecutions"
                  :key="tIdx"
                  class="tool-item"
                >
                  <div class="flex items-center justify-between gap-2">
                    <span class="tool-name font-mono truncate">{{ tool.name }}</span>
                    <el-tag
                      :type="tool.status === 'success' ? 'success' : 'danger'"
                      effect="light"
                      round
                      size="small"
                    >
                      {{ tool.status === 'success' ? t('common.success') : t('common.error') }}
                    </el-tag>
                  </div>
                  <div v-if="tool.result?.message" class="meta-text mt-1">
                    {{ tool.result.message }}
                  </div>
                </div>
              </div>
            </el-collapse-item>
          </el-collapse>

          <!-- Message text bubble -->
          <div class="bubble bubble--assistant">
            <div class="md-content" v-html="renderFormattedText(msg.content)"></div>
          </div>

          <!-- Dynamic suggestions from the agent -->
          <div
            v-if="msg.suggestions && msg.suggestions.length > 0"
            class="chip-row flex flex-wrap gap-1.5 pt-1"
          >
            <el-button
              v-for="(sug, sIdx) in msg.suggestions"
              :key="sIdx"
              type="primary"
              plain
              round
              size="small"
              :icon="MagicStick"
              :disabled="isThinking"
              @click="sendMessage(sug)"
            >
              {{ sug }}
            </el-button>
          </div>
        </div>
      </div>

      <!-- Thinking indicator -->
      <div v-if="isThinking" class="thinking flex items-center gap-2 pl-2">
        <el-icon class="is-loading"><Loading /></el-icon>
        <span>{{ t('assistant.thinking') }}</span>
      </div>
    </div>

    <!-- Suggestion chips carousel -->
    <div class="assistant-section px-3 py-2 shrink-0">
      <div class="chip-row flex items-center gap-1.5 overflow-x-auto pb-0.5 custom-scrollbar select-none">
        <el-button
          v-for="(chip, i) in activeChips"
          :key="i"
          round
          size="small"
          class="shrink-0"
          :disabled="isThinking"
          @click="sendMessage(chip)"
        >
          {{ chip }}
        </el-button>
      </div>
    </div>

    <!-- Input box -->
    <div class="assistant-section p-3 shrink-0">
      <form @submit.prevent="handleSend" class="flex items-center gap-2">
        <el-input
          v-model="inputQuery"
          :placeholder="t('assistant.inputPlaceholder')"
          :disabled="isThinking"
          class="flex-1"
        />
        <el-button
          type="primary"
          native-type="submit"
          :icon="Promotion"
          :disabled="!inputQuery.trim() || isThinking"
          :title="t('assistant.send')"
        />
      </form>
    </div>
  </aside>
</template>

<script setup>
import { useBreakpoints } from '@/composables/useBreakpoints';
import { ref, computed, nextTick, watch, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  Monitor,
  Refresh,
  Close,
  ChatDotRound,
  Operation,
  MagicStick,
  Loading,
  Promotion
} from '@element-plus/icons-vue';
import { useTheme } from '@/utils/theme';
import api from '@/services/api';

const props = defineProps({
  activeContext: {
    type: String,
    default: 'dashboard'
  },
  cameras: {
    type: Array,
    default: () => []
  },
  selectedCamera: {
    type: Object,
    default: null
  }
});

const emit = defineEmits(['navigate', 'select-camera']);

const { t } = useI18n();
const { isAssistantOpen, closeAssistant } = useTheme();
// Desktop: a column next to the page; tablet: panel over it; phone: full screen
const { isDesktop } = useBreakpoints();

const chatContainer = ref(null);
const inputQuery = ref('');
const isThinking = ref(false);
const sessionId = ref(`session_${Date.now()}`);

const messages = ref([
  {
    role: 'assistant',
    content: t('assistant.greeting')
  }
]);

const defaultChips = computed(() => [
  t('assistant.suggest1'),
  t('assistant.suggest2'),
  t('assistant.suggest3'),
  t('assistant.suggest4')
]);

const latestSuggestions = ref([]);

const activeChips = computed(() => {
  if (latestSuggestions.value && latestSuggestions.value.length > 0) {
    return latestSuggestions.value;
  }
  return defaultChips.value;
});

const scrollToBottom = () => {
  nextTick(() => {
    if (chatContainer.value) {
      chatContainer.value.scrollTop = chatContainer.value.scrollHeight;
    }
  });
};

watch(() => messages.value.length, scrollToBottom);

const resetChat = async () => {
  try {
    await api.clearChatSession(sessionId.value);
  } catch (e) {}
  latestSuggestions.value = [];
  messages.value = [
    {
      role: 'assistant',
      content: t('assistant.greeting')
    }
  ];
};

// Minimal markdown: bold, emphasis, inline code, line breaks (styled via .md-content in <style>)
// The reply can contain camera names and other user-written text: escape everything first,
// then apply the small markdown subset on the escaped string
const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const renderFormattedText = (raw) => {
  if (!raw) return '';
  return escapeHtml(raw)
    .replace(/\*\*(.*?)\*\*/g, '<strong class="md-strong">$1</strong>')
    .replace(/\*(.*?)\*/g, '<span class="md-em">$1</span>')
    .replace(/`([^`]+)`/g, '<code class="md-code">$1</code>')
    .replace(/\n/g, '<br/>');
};

const handleSend = () => {
  if (!inputQuery.value.trim() || isThinking.value) return;
  const q = inputQuery.value.trim();
  inputQuery.value = '';
  sendMessage(q);
};

const sendMessage = async (text) => {
  messages.value.push({ role: 'user', content: text });
  isThinking.value = true;
  scrollToBottom();

  let user = null;
  try { user = JSON.parse(localStorage.getItem('user')); } catch (e) {}

  const uiContext = {
    tab: props.activeContext,
    deviceSerial: props.selectedCamera?.deviceSerial || 'all'
  };

  try {
    const res = await api.chatWithAssistant(text, sessionId.value, uiContext, user?.id);
    if (res.data?.success) {
      const { reply, suggestions, navigate, toolExecutions } = res.data;

      messages.value.push({
        role: 'assistant',
        content: reply,
        toolExecutions: toolExecutions || [],
        suggestions: suggestions || []
      });

      if (suggestions && suggestions.length > 0) {
        latestSuggestions.value = suggestions;
      }

      // A page the agent opened (checked on the server): page, sub-tab, camera
      if (navigate?.tab) {
        if (navigate.deviceSerial) {
          const cam = props.cameras.find(c => c.deviceSerial === navigate.deviceSerial);
          if (cam) emit('select-camera', cam);
        }
        emit('navigate', { tab: navigate.tab, subTab: navigate.subTab });
      }
    } else {
      throw new Error(res.data?.message || 'No response received from AI Agent');
    }
  } catch (err) {
    console.warn('Agent chat API error:', err.message);
    messages.value.push({ role: 'assistant', content: t('assistant.unavailable') });
  } finally {
    isThinking.value = false;
    scrollToBottom();
  }
};

onMounted(() => {
  scrollToBottom();
});
</script>

<style scoped>
.assistant-panel--overlay {
  box-shadow: var(--el-box-shadow-dark);
  padding-bottom: env(safe-area-inset-bottom, 0px);
}

.assistant-panel {
  background-color: var(--el-bg-color-overlay);
  border-left: 1px solid var(--el-border-color);
  font-size: 14px;
}
.assistant-header {
  border-bottom: 1px solid var(--el-border-color);
  background-color: var(--el-bg-color);
}
.assistant-section {
  border-top: 1px solid var(--el-border-color);
  background-color: var(--el-bg-color);
}
.assistant-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.assistant-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--el-color-primary);
}
.assistant-avatar {
  background-color: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
}
.meta-text {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.live-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background-color: var(--el-color-success);
}

/* Chat bubbles */
.bubble {
  padding: 10px 14px;
  border-radius: 12px;
  font-size: 13px;
  line-height: 1.6;
  word-break: break-word;
}
.bubble--user {
  border-top-right-radius: 4px;
  background-color: var(--el-color-primary-light-9);
  border: 1px solid var(--el-color-primary-light-7);
  color: var(--el-text-color-primary);
}
.bubble--assistant {
  border-top-left-radius: 4px;
  background-color: var(--el-bg-color);
  border: 1px solid var(--el-border-color);
  color: var(--el-text-color-primary);
}

/* Markdown rendered through v-html */
.md-content :deep(.md-strong) {
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.md-content :deep(.md-em) {
  font-weight: 600;
  color: var(--el-color-primary);
}
.md-content :deep(.md-code) {
  padding: 1px 4px;
  border-radius: 4px;
  border: 1px solid var(--el-border-color);
  background-color: var(--el-fill-color-light);
  color: var(--el-color-primary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}

/* Tool executions */
.tool-collapse {
  border-radius: 8px;
  border: 1px solid var(--el-border-color);
  overflow: hidden;
}
.tool-collapse :deep(.el-collapse-item__header),
.tool-collapse :deep(.el-collapse-item__wrap) {
  padding: 0 10px;
  background-color: var(--el-bg-color);
}
.tool-collapse :deep(.el-collapse-item__header) {
  height: 36px;
  border-bottom: none;
}
.tool-collapse :deep(.el-collapse-item__content) {
  padding-bottom: 10px;
}
.tool-item {
  padding: 8px;
  border-radius: 6px;
  background-color: var(--el-fill-color-light);
}
.tool-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

/* Suggestion chips: rely on flex gap instead of Element's sibling margin */
.chip-row :deep(.el-button + .el-button) {
  margin-left: 0;
}

.thinking {
  font-size: 12px;
  color: var(--el-color-primary);
}
</style>
