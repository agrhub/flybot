// Test environment shims (vitest setupFiles).
//
// happy-dom's MutationObserver reports itself as a plain "[object Object]", so Vue's reactive()
// wraps it in a Proxy when a component keeps it in a ref (Element Plus table, key-render-helper)
// and its private fields become unreachable ("Cannot read private member #destroyed"). A browser's
// MutationObserver carries a toStringTag, which makes Vue leave it alone: give the test one too.
if (typeof MutationObserver !== 'undefined' && !MutationObserver.prototype[Symbol.toStringTag]) {
  Object.defineProperty(MutationObserver.prototype, Symbol.toStringTag, { value: 'MutationObserver' });
}
