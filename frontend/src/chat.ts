import { rgbToCss } from "./palette";
import { MAX_CHAT_LEN } from "./proto";

export interface ChatHandlers {
  // Returns true if the message was queued for send, false if it was
  // rate-limited on the client. The panel will shake the input on false.
  onSend: (text: string) => boolean;
}

export interface ChatPanel {
  appendMessage(
    author: string,
    text: string,
    color: number,
    isYou: boolean,
    avatarHtml?: string,
  ): void;
  appendSystem(text: string, avatarHtml?: string): void;
  appendCorrectGuess(author: string, color: number, avatarHtml?: string): void;
  appendCloseGuess(): void;
  appendSpoilerWarning(): void;
  setGuessMode(on: boolean): void;
  focus(): void;
  clear(): void;
}

const SEND_ICON = `
<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
  <path d="M3.4 20.4 22 12 3.4 3.6 3.4 10.2 17 12 3.4 13.8z"
        fill="currentColor"/>
</svg>`;

const CHECK_ICON = `
<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
  <path d="M5 12l5 5L20 7" fill="none" stroke="currentColor"
        stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export function mountChat(root: HTMLElement, handlers: ChatHandlers): ChatPanel {
  root.classList.add("chat");
  root.innerHTML = `
    <header class="chat-header">
      <h2>Chat</h2>
    </header>
    <div class="chat-scroll" role="log" aria-live="polite" aria-atomic="false">
      <div class="chat-empty">Quiet in here. Say something!</div>
    </div>
    <form class="chat-form" novalidate>
      <label class="sr-only" for="chat-input-field">Chat message</label>
      <input id="chat-input-field" class="chat-input" type="text"
             maxlength="${MAX_CHAT_LEN}" placeholder="Say something..."
             autocomplete="off" autocorrect="off" autocapitalize="sentences"
             enterkeyhint="send" />
      <button type="submit" class="chat-send" aria-label="Send" disabled>
        ${SEND_ICON}
      </button>
    </form>
  `;
  const scroll = root.querySelector<HTMLDivElement>(".chat-scroll")!;
  const empty = root.querySelector<HTMLDivElement>(".chat-empty")!;
  const form = root.querySelector<HTMLFormElement>(".chat-form")!;
  const input = root.querySelector<HTMLInputElement>(".chat-input")!;
  const send = root.querySelector<HTMLButtonElement>(".chat-send")!;

  let stickToBottom = true;
  let hasMessages = false;

  scroll.addEventListener("scroll", () => {
    const dist = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
    stickToBottom = dist < 40;
  });

  input.addEventListener("input", () => {
    send.disabled = input.value.trim().length === 0;
  });

  function append(node: HTMLElement): void {
    if (!hasMessages) {
      empty.remove();
      hasMessages = true;
    }
    const wasAtBottom = stickToBottom;
    scroll.appendChild(node);
    if (wasAtBottom) {
      // Scroll immediately so a typical text row sticks, then again on the
      // next two animation frames so async-rendered content (avatar SVGs,
      // emoji fonts, anything that grows the row after first layout) still
      // pins the bottom rather than leaving the new message half-off-screen.
      scroll.scrollTop = scroll.scrollHeight;
      requestAnimationFrame(() => {
        scroll.scrollTop = scroll.scrollHeight;
        requestAnimationFrame(() => {
          scroll.scrollTop = scroll.scrollHeight;
        });
      });
    }
  }

  function flashRateLimited(): void {
    input.classList.remove("chat-input--rate-limited");
    void input.offsetWidth;
    input.classList.add("chat-input--rate-limited");
  }

  function submit(): void {
    const text = input.value.trim();
    if (text.length === 0) return;
    const ok = handlers.onSend(text);
    if (!ok) {
      flashRateLimited();
      return;
    }
    input.value = "";
    send.disabled = true;
    input.focus();
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    submit();
  });

  return {
    appendMessage(author, text, color, isYou, avatarHtml) {
      const wrap = document.createElement("div");
      wrap.className = "chat-msg" + (isYou ? " chat-msg--you" : "");
      if (avatarHtml) {
        const av = document.createElement("span");
        av.className = "chat-avatar";
        av.innerHTML = avatarHtml;
        wrap.append(av);
      }
      const body = document.createElement("div");
      body.className = "chat-msg-body";
      const a = document.createElement("span");
      a.className = "chat-author";
      a.style.color = rgbToCss(color);
      a.textContent = author;
      const t = document.createElement("span");
      t.className = "chat-text";
      t.textContent = text;
      body.append(a, t);
      wrap.append(body);
      append(wrap);
    },
    appendSystem(text, avatarHtml) {
      const wrap = document.createElement("div");
      wrap.className = "chat-system";
      const pill = document.createElement("span");
      pill.className = "chat-pill";
      if (avatarHtml) {
        const av = document.createElement("span");
        av.className = "chat-pill-avatar";
        av.innerHTML = avatarHtml;
        pill.appendChild(av);
      }
      pill.appendChild(document.createTextNode(text));
      wrap.appendChild(pill);
      append(wrap);
    },
    appendCorrectGuess(author, color, avatarHtml) {
      const wrap = document.createElement("div");
      wrap.className = "chat-system";
      const pill = document.createElement("span");
      pill.className = "chat-pill chat-pill--correct";
      if (avatarHtml) {
        const av = document.createElement("span");
        av.className = "chat-pill-avatar";
        av.innerHTML = avatarHtml;
        pill.appendChild(av);
      } else {
        pill.innerHTML = CHECK_ICON;
      }
      const label = document.createElement("span");
      const a = document.createElement("strong");
      a.style.color = rgbToCss(color);
      a.textContent = author;
      label.append(a, document.createTextNode(" got it!"));
      pill.appendChild(label);
      wrap.appendChild(pill);
      append(wrap);
    },
    appendCloseGuess() {
      const wrap = document.createElement("div");
      wrap.className = "chat-system";
      const pill = document.createElement("span");
      pill.className = "chat-pill chat-pill--close";
      pill.textContent = "so close!";
      wrap.appendChild(pill);
      append(wrap);
    },
    appendSpoilerWarning() {
      const wrap = document.createElement("div");
      wrap.className = "chat-system";
      const pill = document.createElement("span");
      pill.className = "chat-pill chat-pill--spoiler";
      pill.textContent = "hey! don't spoil it - others are still guessing";
      wrap.appendChild(pill);
      append(wrap);
    },
    setGuessMode(on) {
      form.classList.toggle("chat-form--guessing", on);
      let badge = form.querySelector<HTMLElement>(".chat-guess-badge");
      if (on && !badge) {
        badge = document.createElement("span");
        badge.className = "chat-guess-badge";
        badge.textContent = "guessing";
        form.style.position = "relative";
        form.appendChild(badge);
      } else if (!on && badge) {
        badge.remove();
      }
      input.placeholder = on ? "What is it?" : "Say something...";
    },
    focus() {
      input.focus();
    },
    clear() {
      scroll.replaceChildren(empty);
      hasMessages = false;
      stickToBottom = true;
    },
  };
}
