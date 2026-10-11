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
            <el-tag v-if="contextLabel" type="success" effect="light" size="small">
              {{ contextLabel }}
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
            v-if="msg.toolExecutions && msg.toolExecutions.length > 0 && !msg.streaming"
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
                    <span class="tool-name truncate">{{ toolLabel(tool.name) }}</span>
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

          <!-- Message text bubble (filled in as the answer streams) -->
          <div v-if="msg.content" class="bubble bubble--assistant">
            <div class="md-content" v-html="renderFormattedText(msg.content)"></div>
          </div>

          <!-- Result cards: photos, chart, comparison, report -->
          <div v-if="msg.cards && msg.cards.length" class="space-y-2">
            <AssistantCard
              v-for="(card, cIdx) in msg.cards"
              :key="cIdx"
              :card="card"
              :busy="deciding === `${msg.id}:${cIdx}`"
              @open="onCardOpen"
              @decide="(decision) => decide(msg, cIdx, decision)"
            />
          </div>

          <!-- Was this answer right? -->
          <div v-if="msg.id && !msg.streaming" class="feedback-row flex items-center gap-1">
            <el-tooltip :content="t('assistant.feedback.upHint')" placement="top">
              <el-button
                text
                size="small"
                :icon="CircleCheck"
                :type="msg.feedback?.rating === 'up' ? 'success' : undefined"
                @click="rate(msg, 'up')"
              >{{ t('assistant.feedback.up') }}</el-button>
            </el-tooltip>
            <el-tooltip :content="t('assistant.feedback.downHint')" placement="top">
              <el-button
                text
                size="small"
                :icon="CircleClose"
                :type="msg.feedback?.rating === 'down' ? 'danger' : undefined"
                @click="rate(msg, 'down')"
              >{{ t('assistant.feedback.down') }}</el-button>
            </el-tooltip>
          </div>

          <!-- Dynamic suggestions from the agent (latest answer only) -->
          <div
            v-if="msg.suggestions && msg.suggestions.length > 0 && idx === lastAssistantIndex && !isThinking"
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
      <div v-if="isThinking && (activeTool || !streamingMessage?.content)" class="thinking flex items-center gap-2 pl-2">
        <el-icon class="is-loading"><Loading /></el-icon>
        <span>{{ activeTool ? t('assistant.usingTool', { tool: toolLabel(activeTool) }) : t('assistant.thinking') }}</span>
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
import { renderMarkdown } from '@/utils/chatMarkdown';
import { useI18n } from 'vue-i18n';
import {
  Monitor,
  Refresh,
  Close,
  ChatDotRound,
  Operation,
  MagicStick,
  Loading,
  Promotion,
  CircleCheck,
  CircleClose
} from '@element-plus/icons-vue';
import AssistantCard from './AssistantCard.vue';
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

const { t, te } = useI18n();
// The page the assistant answers about, by its menu name
const contextLabel = computed(() => (te(`nav.${props.activeContext}`) ? t(`nav.${props.activeContext}`) : ''));
const { isAssistantOpen, closeAssistant, assistantQuestion } = useTheme();
// Desktop: a column next to the page; tablet: panel over it; phone: full screen
const { isDesktop } = useBreakpoints();

const chatContainer = ref(null);
const inputQuery = ref('');
const isThinking = ref(false);
// One conversation per signed-in user, kept across reloads (stored on the server for 7 days)
const storedUser = () => {
  try { return JSON.parse(localStorage.getItem('user')) || null; } catch { return null; }
};
const sessionKey = () => `flybot_chat_session:${storedUser()?.id || 'anon'}`;
const newSessionId = () => `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const readSessionId = () => {
  try { return localStorage.getItem(sessionKey()) || null; } catch { return null; }
};
const saveSessionId = (id) => {
  try { localStorage.setItem(sessionKey(), id); } catch { /* private mode: this tab only */ }
};
const sessionId = ref(readSessionId() || newSessionId());
saveSessionId(sessionId.value);
const activeTool = ref(null);
const streamingMessage = ref(null);
const toolLabel = (name) => (te(`assistant.tools.${name}`) ? t(`assistant.tools.${name}`) : name);
const lastAssistantIndex = computed(() => {
  for (let i = messages.value.length - 1; i >= 0; i--) if (messages.value[i].role === 'assistant') return i;
  return -1;
});

const greeting = () => ({ role: 'assistant', content: t('assistant.greeting') });
const messages = ref([greeting()]);

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

// A stored message as the panel shows it
const fromStored = (m) => ({
  id: m.id,
  role: m.role,
  content: m.content,
  cards: m.cards || [],
  suggestions: m.suggestions || [],
  feedback: m.feedback || null,
  toolExecutions: (m.tools || []).map(tool => ({ name: tool.name, status: tool.status, result: { message: tool.message } }))
});

// The conversation from before a reload
const loadHistory = async () => {
  try {
    const res = await api.getChatHistory(sessionId.value);
    const stored = res.data?.messages || [];
    if (stored.length) {
      messages.value = [greeting(), ...stored.map(fromStored)];
      const last = [...stored].reverse().find(m => m.role === 'assistant');
      if (last?.suggestions?.length) latestSuggestions.value = last.suggestions;
      scrollToBottom();
    }
  } catch {
    // An empty panel is fine
  }
};

const resetChat = async () => {
  try {
    await api.clearChatSession(sessionId.value);
  } catch (e) {}
  sessionId.value = newSessionId();
  saveSessionId(sessionId.value);
  latestSuggestions.value = [];
  messages.value = [greeting()];
};

const rate = async (msg, rating) => {
  const next = msg.feedback?.rating === rating ? null : rating;
  const before = msg.feedback;
  msg.feedback = next ? { rating: next } : null;
  try {
    await api.rateChatMessage(sessionId.value, msg.id, next);
  } catch {
    msg.feedback = before;
  }
};

// Confirm or cancel a change the assistant proposed; the server runs it from the stored card
const deciding = ref(null);
const decide = async (msg, index, decision) => {
  if (!msg.id || deciding.value) return;
  deciding.value = `${msg.id}:${index}`;
  const card = msg.cards[index];
  try {
    const res = await api.confirmChatAction(sessionId.value, msg.id, index, decision);
    card.state = res.data.state;
    card.result = '';
  } catch (err) {
    const data = err.response?.data || {};
    // Already handled elsewhere (another tab): show what the server has
    if (err.response?.status === 409) await loadHistory();
    else {
      card.state = data.state || card.state;
      card.result = data.message || t('assistant.unavailable');
    }
  } finally {
    deciding.value = null;
  }
};

// A question sent from elsewhere in the app (e.g. "Ask the assistant about this photo")
watch(assistantQuestion, (question) => {
  if (!question?.text || isThinking.value) return;
  sendMessage(question.text, { snapshotId: question.snapshotId });
  assistantQuestion.value = null;
});

// Opening a report from a card: on a phone the panel covers the page
const onCardOpen = () => {
  if (!isDesktop.value) closeAssistant();
};

// Replies are Markdown; the renderer escapes all text first (see utils/chatMarkdown)
const renderFormattedText = (raw) => renderMarkdown(raw);

const handleSend = () => {
  if (!inputQuery.value.trim() || isThinking.value) return;
  const q = inputQuery.value.trim();
  inputQuery.value = '';
  sendMessage(q);
};

const sendMessage = async (text, extraContext = {}) => {
  messages.value.push({ role: 'user', content: text });
  isThinking.value = true;
  activeTool.value = null;
  // Filled in as the answer streams
  messages.value.push({ role: 'assistant', content: '', streaming: true, cards: [], toolExecutions: [], suggestions: [] });
  const reply = messages.value[messages.value.length - 1];
  streamingMessage.value = reply;
  scrollToBottom();

  const uiContext = {
    tab: props.activeContext,
    deviceSerial: props.selectedCamera?.deviceSerial || 'all',
    ...(extraContext.snapshotId ? { snapshotId: extraContext.snapshotId } : {})
  };

  const onEvent = (type, data) => {
    if (type === 'turn') {
      // Text before a tool call was the model thinking aloud, not the answer
      reply.content = '';
    } else if (type === 'delta') {
      reply.content += data.text;
      scrollToBottom();
    } else if (type === 'tool') {
      activeTool.value = data.phase === 'start' ? data.name : null;
    }
  };

  try {
    let answer;
    try {
      answer = await api.chatWithAssistantStream(text, sessionId.value, uiContext, onEvent);
    } catch (err) {
      // No streaming here (an old proxy, a lost connection before anything came): ask once more in one piece
      if (!err.streamUnavailable || err.status === 429) throw err;
      const res = await api.chatWithAssistant(text, sessionId.value, uiContext);
      if (!res.data?.success) throw new Error(res.data?.message || 'No response received from AI Agent');
      answer = res.data;
    }
    const { suggestions, navigate } = answer;
    Object.assign(reply, {
      id: answer.messageId,
      content: answer.reply,
      cards: answer.cards || [],
      toolExecutions: answer.toolExecutions || [],
      suggestions: suggestions || [],
      feedback: null,
      streaming: false
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
  } catch (err) {
    console.warn('Agent chat API error:', err.message);
    Object.assign(reply, {
      content: err.status === 429 || err.response?.status === 429 ? t('assistant.tooMany') : (err.fromServer ? err.message : t('assistant.unavailable')),
      streaming: false
    });
  } finally {
    isThinking.value = false;
    activeTool.value = null;
    streamingMessage.value = null;
    scrollToBottom();
  }
};

onMounted(() => {
  scrollToBottom();
  loadHistory();
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

.feedback-row :deep(.el-button) {
  padding: 2px 6px;
  font-size: 12px;
}

/* Markdown rendered through v-html */
.md-content :deep(.md-strong) {
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.md-content :deep(.md-em) {
  font-style: italic;
}
.md-content :deep(.md-p) {
  margin: 0 0 8px;
}
.md-content :deep(.md-h) {
  margin: 12px 0 6px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.md-content :deep(.md-h1),
.md-content :deep(.md-h2) {
  font-size: 15px;
}
.md-content :deep(.md-h3),
.md-content :deep(.md-h4) {
  font-size: 14px;
}
.md-content > :deep(:first-child) {
  margin-top: 0;
}
.md-content > :deep(:last-child) {
  margin-bottom: 0;
}
.md-content :deep(.md-list) {
  margin: 0 0 8px;
  padding-left: 20px;
}
.md-content :deep(ul.md-list) {
  list-style: disc;
}
.md-content :deep(ul.md-list ul.md-list) {
  list-style: circle;
  margin: 4px 0 0;
}
.md-content :deep(ol.md-list) {
  list-style: decimal;
}
.md-content :deep(.md-list li) {
  margin: 2px 0;
}
.md-content :deep(.md-quote) {
  margin: 0 0 8px;
  padding: 4px 10px;
  border-left: 3px solid var(--el-color-primary-light-5);
  color: var(--el-text-color-regular);
}
.md-content :deep(.md-hr) {
  margin: 10px 0;
  border: none;
  border-top: 1px solid var(--el-border-color);
}
.md-content :deep(.md-table-wrap) {
  margin: 0 0 8px;
  overflow-x: auto;
}
.md-content :deep(.md-table) {
  border-collapse: collapse;
  font-size: 12px;
}
.md-content :deep(.md-table th),
.md-content :deep(.md-table td) {
  padding: 4px 8px;
  border: 1px solid var(--el-border-color);
  text-align: left;
}
.md-content :deep(.md-table th) {
  font-weight: 600;
  background-color: var(--el-fill-color-light);
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
