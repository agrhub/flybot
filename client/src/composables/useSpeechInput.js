import { ref, onBeforeUnmount } from 'vue';

/**
 * Speech to text with the browser's own recognizer (Chrome, Edge, Safari), for saying a field log
 * entry instead of typing it. The words fill the text box as they are recognized; nothing is sent
 * until the user presses Send. Chrome and Edge do the recognition on their maker's servers.
 */
export function useSpeechInput() {
  const Recognition = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
  const supported = !!Recognition;
  const listening = ref(false);
  let recognizer = null;

  /**
   * @param language 'vi' | 'en'
   * @param onText   (text, final) for each recognized phrase (interim ones too)
   * @param onError  (code) 'denied' | 'no-speech' | 'failed'
   */
  const start = ({ language, onText, onError }) => {
    if (!supported || listening.value) return;
    recognizer = new Recognition();
    recognizer.lang = language === 'en' ? 'en-US' : 'vi-VN';
    recognizer.interimResults = true;
    recognizer.continuous = false;
    recognizer.onresult = (event) => {
      const text = [...event.results].map((r) => r[0].transcript).join('');
      onText(text.trim(), event.results[event.results.length - 1].isFinal);
    };
    recognizer.onerror = (event) => {
      const code = event.error === 'not-allowed' || event.error === 'service-not-allowed' ? 'denied' : event.error === 'no-speech' ? 'no-speech' : event.error === 'aborted' ? null : 'failed';
      if (code) onError?.(code);
    };
    recognizer.onend = () => { listening.value = false; };
    listening.value = true;
    try {
      recognizer.start();
    } catch {
      listening.value = false;
      onError?.('failed');
    }
  };

  const stop = () => {
    recognizer?.stop();
    listening.value = false;
  };

  onBeforeUnmount(() => recognizer?.abort());

  return { supported, listening, start, stop };
}
