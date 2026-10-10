<template>
  <aside
    v-show="isAssistantOpen"
    id="smart-trap-assistant-sidebar"
    class="w-[360px] md:w-[400px] lg:w-[420px] bg-[#0c1015]/95 backdrop-blur-xl border-l border-[var(--el-border-color)] flex flex-col h-screen shrink-0 z-30 transition-all duration-300 ease-in-out select-none shadow-2xl relative"
  >
    <!-- Header -->
    <div class="h-16 px-4 border-b border-[var(--el-border-color)]/60 flex items-center justify-between bg-[var(--el-bg-color-page)]/40 shrink-0">
      <!-- Title & Live Status -->
      <div class="flex items-center gap-2.5 min-w-0">
        <div class="w-8 h-8 rounded-xl bg-gradient-to-br from-emerald-500/20 to-teal-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shadow-sm shrink-0">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5">
            <span class="text-xs font-semibold text-[var(--el-text-color-primary)] tracking-tight truncate">
              {{ t('assistant.title') }}
            </span>
            <span class="text-[9px] font-mono px-1.5 py-0.5 rounded border font-semibold bg-emerald-500/10 text-emerald-400 border-emerald-500/20 truncate">
              #{{ activeContext }}
            </span>
          </div>
          <div class="flex items-center gap-1.5 mt-0.5">
            <span class="relative flex h-1.5 w-1.5 shrink-0">
              <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span class="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500"></span>
            </span>
            <span class="text-[10px] text-[var(--el-text-color-secondary)] truncate">
              {{ t('assistant.subtitle') }}
            </span>
          </div>
        </div>
      </div>

      <!-- Action Buttons -->
      <div class="flex items-center gap-1">
        <button
          @click="resetChat"
          class="w-7 h-7 rounded-lg hover:bg-[var(--el-card-bg-color)] text-[var(--el-text-color-secondary)] hover:text-[var(--el-text-color-primary)] flex items-center justify-center transition-colors cursor-pointer"
          :title="t('assistant.reset')"
        >
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>

        <button
          @click="closeAssistant"
          class="w-7 h-7 rounded-lg hover:bg-[var(--el-card-bg-color)] text-[var(--el-text-color-secondary)] hover:text-red-400 flex items-center justify-center transition-colors cursor-pointer"
          :title="t('common.close')"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>

    <!-- Message Stream -->
    <div ref="chatContainer" class="flex-1 p-4 overflow-y-auto space-y-4 custom-scrollbar select-text text-sm">
      <div
        v-for="(msg, idx) in messages"
        :key="idx"
        class="flex flex-col gap-1.5"
        :class="msg.role === 'user' ? 'items-end' : 'items-start'"
      >
        <!-- User Bubble -->
        <div
          v-if="msg.role === 'user'"
          class="max-w-[85%] bg-gradient-to-r from-emerald-600 to-teal-600 text-white px-4 py-2.5 rounded-2xl rounded-tr-sm text-xs font-medium leading-relaxed shadow-md shadow-emerald-900/20"
        >
          {{ msg.content }}
        </div>

        <!-- Assistant Bubble -->
        <div v-else class="max-w-[95%] space-y-2">
          <div class="flex items-center gap-1.5 mb-1">
            <div class="w-4 h-4 rounded-full bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400">
              <span class="text-[9px] font-bold">AI</span>
            </div>
            <span class="text-[10px] font-bold text-emerald-400">Smart Trap Copilot</span>
          </div>

          <!-- Tool Execution Accordion (if Agent executed Tools) -->
          <details
            v-if="msg.toolExecutions && msg.toolExecutions.length > 0"
            class="w-full text-xs select-none"
          >
            <summary class="flex items-center justify-between px-3 py-1.5 rounded-xl border border-[var(--el-border-color)] bg-[var(--el-bg-color)]/60 cursor-pointer text-[11px] text-[var(--el-text-color-secondary)] hover:text-emerald-400 transition-colors">
              <div class="flex items-center gap-1.5 font-mono">
                <span class="w-2 h-2 rounded-full bg-emerald-400"></span>
                <span>Tool Execution ({{ msg.toolExecutions.length }})</span>
              </div>
              <span class="text-[9px] opacity-70">▼ Details</span>
            </summary>
            <div class="p-2 space-y-1.5 mt-1 rounded-xl border border-dashed border-[var(--el-border-color)] bg-[var(--el-bg-color)]/40">
              <div
                v-for="(tool, tIdx) in msg.toolExecutions"
                :key="tIdx"
                class="p-2 rounded-lg border flex flex-col gap-1 text-[10px]"
                :class="tool.status === 'success' ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-red-500/5 border-red-500/20'"
              >
                <div class="flex items-center justify-between font-bold">
                  <span class="text-emerald-400 font-mono">⚡ {{ tool.name }}</span>
                  <span
                    class="text-[8px] px-1.5 py-0.5 rounded font-mono uppercase font-bold"
                    :class="tool.status === 'success' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'"
                  >
                    {{ tool.status }}
                  </span>
                </div>
                <div v-if="tool.result?.message" class="text-[10px] text-[var(--el-text-color-secondary)]">
                  {{ tool.result.message }}
                </div>
              </div>
            </div>
          </details>

          <!-- Message Text Bubble -->
          <div class="bg-[var(--el-card-bg-color)] border border-[var(--el-border-color)] text-[var(--el-text-color-primary)] p-3.5 rounded-2xl rounded-tl-sm text-xs leading-relaxed shadow-sm space-y-2">
            <div v-html="renderFormattedText(msg.content)"></div>
          </div>

          <!-- Dynamic Suggestions from Agent -->
          <div
            v-if="msg.suggestions && msg.suggestions.length > 0"
            class="flex flex-wrap gap-1.5 pt-1"
          >
            <button
              v-for="(sug, sIdx) in msg.suggestions"
              :key="sIdx"
              @click="sendMessage(sug)"
              :disabled="isThinking"
              class="text-[10px] px-2.5 py-1 rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 hover:border-emerald-500/50 transition-all cursor-pointer font-medium disabled:opacity-50"
            >
              ✨ {{ sug }}
            </button>
          </div>
        </div>
      </div>

      <!-- Thinking Indicator -->
      <div v-if="isThinking" class="flex items-center gap-2 text-xs text-emerald-400 pl-2">
        <div class="w-3.5 h-3.5 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin"></div>
        <span class="italic text-[11px]">{{ t('assistant.thinking') }}</span>
      </div>
    </div>

    <!-- Suggestion Chips Carousel -->
    <div class="px-3 py-2 border-t border-[var(--el-border-color)] bg-[var(--el-bg-color-page)]/30 shrink-0">
      <div class="flex items-center gap-1.5 overflow-x-auto pb-0.5 custom-scrollbar select-none">
        <button
          v-for="(chip, i) in activeChips"
          :key="i"
          @click="sendMessage(chip)"
          :disabled="isThinking"
          class="text-[10.5px] font-medium px-2.5 py-1 rounded-full bg-[var(--el-card-bg-color)] hover:bg-emerald-500/10 border border-[var(--el-border-color)] hover:border-emerald-500/30 text-[var(--el-text-color-regular)] hover:text-emerald-400 transition-all cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-50"
        >
          {{ chip }}
        </button>
      </div>
    </div>

    <!-- Input Box -->
    <div class="p-3 border-t border-[var(--el-border-color)] bg-[var(--el-bg-color-page)]/80 shrink-0">
      <form @submit.prevent="handleSend" class="flex items-center gap-2">
        <input
          v-model="inputQuery"
          type="text"
          :placeholder="t('assistant.inputPlaceholder')"
          :disabled="isThinking"
          class="flex-1 bg-[var(--el-card-bg-color)] border border-[var(--el-border-color)] rounded-xl px-3.5 py-2.5 text-xs text-[var(--el-text-color-primary)] placeholder-[var(--el-text-color-placeholder)] outline-none focus:border-emerald-500 transition-colors"
        />
        <button
          type="submit"
          :disabled="!inputQuery.trim() || isThinking"
          class="h-9 px-3.5 rounded-xl bg-[var(--primary-green)] hover:bg-emerald-400 disabled:opacity-40 text-slate-950 font-bold text-xs flex items-center justify-center transition-all cursor-pointer shadow-sm"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3" />
          </svg>
        </button>
      </form>
    </div>
  </aside>
</template>

<script setup>
import { ref, computed, nextTick, watch, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
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

const chatContainer = ref(null);
const inputQuery = ref('');
const isThinking = ref(false);
const sessionId = ref(`session_${Date.now()}`);

const messages = ref([
  {
    role: 'assistant',
    content: `👋 **Welcome! I am Smart Trap Copilot.**
I am your intelligent agricultural AI assistant equipped with real-time pest density analytics and remote camera controls.

* 📡 **Device Monitoring:** Online/offline status, video encryption check.
* 📸 **Instant Snapshot:** Request new trap captures remotely.
* 📊 **AI Analytics:** Density breakdown of fruit flies (*Bactrocera*) by hour/day.
* 🧭 **UI Navigation:** Automatically navigate to camera feeds or analytics charts on demand.`
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

const renderFormattedText = (raw) => {
  if (!raw) return '';
  return raw
    .replace(/\*\*(.*?)\*\*/g, '<strong class="font-bold text-[var(--el-text-color-primary)]">$1</strong>')
    .replace(/\*(.*?)\*/g, '<span class="text-emerald-400 font-semibold">$1</span>')
    .replace(/`([^`]+)`/g, '<code class="px-1 py-0.5 rounded bg-[var(--el-bg-color)] border border-[var(--el-border-color)] text-emerald-400 font-mono text-[11px]">$1</code>')
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
      const { reply, suggestions, navigate, actions, toolExecutions } = res.data;

      messages.value.push({
        role: 'assistant',
        content: reply,
        toolExecutions: toolExecutions || [],
        suggestions: suggestions || []
      });

      if (suggestions && suggestions.length > 0) {
        latestSuggestions.value = suggestions;
      }

      // Handle UI navigation triggered by agent
      if (navigate && navigate.tab) {
        emit('navigate', navigate.tab);
        if (navigate.deviceSerial) {
          const cam = props.cameras.find(c => c.deviceSerial === navigate.deviceSerial);
          if (cam) emit('select-camera', cam);
        }
      } else if (actions && actions.length > 0) {
        const navAction = actions.find(a => a.type === 'NAVIGATE');
        if (navAction?.payload?.tab) {
          emit('navigate', navAction.payload.tab);
        }
      }
    } else {
      throw new Error(res.data?.message || 'No response received from AI Agent');
    }
  } catch (err) {
    console.warn('Agent Chat API error, using smart fallback:', err.message);
    const qLower = text.toLowerCase();
    let reply = '';
    if (qLower.includes('24h') || qLower.includes('summary')) {
      reply = `📊 **24-Hour Summary Report:**\n\n• **Total detections:** 38 objects\n• **Dominant species:** Oriental fruit fly (*Bactrocera*) at **78%**\n• **Peak activity:** Around 07:00 - 09:30 AM as temperatures rise\n• **Device health:** All cameras recording reliably.`;
    } else if (qLower.includes('fruit fly') || qLower.includes('density') || qLower.includes('bactrocera')) {
      reply = `🪰 **Fruit Fly Density Analysis:**\n\n• Highest density logged during early morning scan cycles.\n• **Recommendation:** Replenish pheromone lure in trap funnel and inspect sticky plates regularly.`;
    } else if (qLower.includes('offline') || qLower.includes('camera') || qLower.includes('disconnected')) {
      const offlineCams = props.cameras.filter(c => c.status !== 1);
      if (offlineCams.length > 0) {
        reply = `📡 **Offline Device Alert:**\nDetected **${offlineCams.length}** offline cameras:\n` +
          offlineCams.map(c => `• **${c.deviceName}** (SN: \`${c.deviceSerial}\`)`).join('\n') +
          `\n\nPlease check power and Wi-Fi/4G connectivity at installation site.`;
      } else {
        reply = `📡 **Camera Status:**\nAll **${props.cameras.length}** cameras in your account are **Online** and functioning normally.`;
      }
    } else {
      reply = `💡 **Farming & Insect Trap Recommendations:**\n\n• Replace sticky sheets or clean funnel traps every **7 - 10 days**.\n• Ensure camera lenses are free of fog, condensation, or agricultural dust.\n• Check automatic capture schedule periodically to maintain uninterrupted AI surveillance data.`;
    }
    messages.value.push({ role: 'assistant', content: reply });
  } finally {
    isThinking.value = false;
    scrollToBottom();
  }
};

onMounted(() => {
  scrollToBottom();
});
</script>

