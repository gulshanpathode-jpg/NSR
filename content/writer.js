/**
 * content/writer.js - Apply AI-suggested answers to the NSR DOM.
 *
 * Public API: window.NSR_WRITER.applyAnswer(question, aiItem)
 *   `question` is the extracted question object.
 *   `aiItem` is the API response item with aiAnswer / aiSelected / options.
 *
 * For radios and checkboxes we click element IDs (matches NSR's working strategy).
 * For text/textarea we use the native value setter so React-style frameworks see
 * the change.
 *
 * Returns { ok: true } or { ok: false, error: '...' }
 */

(() => {
  if (window.__NSR_WRITER_LOADED__) return;
  window.__NSR_WRITER_LOADED__ = true;

  function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function fireEvents(el, types = ['input', 'change']) {
    types.forEach((t) => el.dispatchEvent(new Event(t, { bubbles: true })));
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
  }

  /**
   * Apply a single answer.
   *
   * Strategy by input type:
   *   radio    - find the option where aiSelected === true and click its element
   *   checkbox - sync each checkbox to match its aiSelected flag
   *   text     - set value via native setter, fire input+change
   *   textarea - same as text
   *   select   - set value, fire change
   */
  async function applyAnswer(question, aiItem) {
    if (!question || !question.inputType) {
      return { ok: false, error: 'Missing question.inputType' };
    }

    const type = question.inputType;
    const ai = aiItem || {};

    try {
      switch (type) {
        case 'radio': {
          const aiOptions = ai.options || question.options || [];
          const target = aiOptions.find((o) => o.aiSelected === true)
                      || aiOptions.find((o) => o.selected === true);
          if (!target || !target.id) {
            return { ok: false, error: 'No target option for radio' };
          }
          const el = document.getElementById(target.id);
          if (!el) return { ok: false, error: `Radio element not found: ${target.id}` };
          el.click();
          await delay(150);
          return { ok: true, applied: target.label };
        }

        case 'checkbox': {
          const aiOptions = ai.options || question.options || [];
          for (const opt of aiOptions) {
            if (!opt.id) continue;
            const want = opt.aiSelected !== undefined ? opt.aiSelected : opt.selected;
            const el = document.getElementById(opt.id);
            if (!el) continue;
            if (Boolean(el.checked) !== Boolean(want)) {
              el.click();
              await delay(100);
            }
          }
          return { ok: true };
        }

        case 'text':
        case 'textarea': {
          const elId = ai.inputElementId || question.inputElementId;
          const newValue = ai.aiAnswer != null ? ai.aiAnswer : ai.answer;
          if (newValue == null || newValue === 'null') {
            return { ok: false, error: 'No AI answer' };
          }
          if (!elId) return { ok: false, error: 'No element id for text input' };
          const el = document.getElementById(elId);
          if (!el) return { ok: false, error: `Element not found: ${elId}` };
          setNativeValue(el, String(newValue));
          fireEvents(el);
          return { ok: true };
        }

        case 'select': {
          const elId = ai.inputElementId || question.inputElementId;
          const newValue = ai.aiAnswer != null ? ai.aiAnswer : ai.answer;
          if (!elId) return { ok: false, error: 'No element id for select' };
          const el = document.getElementById(elId);
          if (!el) return { ok: false, error: `Select not found: ${elId}` };
          el.value = String(newValue);
          fireEvents(el, ['change']);
          return { ok: true };
        }

        default:
          return { ok: false, error: `Unsupported inputType: ${type}` };
      }
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  /**
   * Revert a question back to its original answer.
   * `question` should have its captured original `answer` and (if applicable)
   * original `options[].selected` snapshot.
   */
  async function revertAnswer(question) {
    // Build a synthetic "ai item" that matches the *original* state so we can
    // reuse applyAnswer.
    const synthetic = {
      inputType: question.inputType,
      inputElementId: question.inputElementId,
      aiAnswer: question.answer,
      options: (question.options || []).map((o) => ({
        ...o,
        aiSelected: o.selected, // original selection is what we want
      })),
    };
    return applyAnswer(question, synthetic);
  }

  window.NSR_WRITER = { applyAnswer, revertAnswer };
  console.log('[NSR] Writer loaded');
})();
