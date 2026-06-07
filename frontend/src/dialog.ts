// Custom confirm/prompt overlays. Replace the native blocking equivalents.

export interface ConfirmOpts {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export function showConfirm(opts: ConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => {
    const {
      title,
      message,
      confirmLabel = "Confirm",
      cancelLabel = "Cancel",
      destructive = false,
    } = opts;
    const overlay = document.createElement("div");
    overlay.className = "dialog";
    overlay.innerHTML = `
      <section class="dialog-card">
        <h1 class="dialog-title">${escapeHtml(title)}</h1>
        ${message ? `<p class="dialog-body">${escapeHtml(message)}</p>` : ""}
        <div class="dialog-actions">
          <button type="button" class="dialog-cancel" id="dialogCancel">
            ${escapeHtml(cancelLabel)}
          </button>
          <button type="button" class="dialog-confirm ${
            destructive ? "dialog-confirm--destructive" : ""
          }" id="dialogConfirm">
            ${escapeHtml(confirmLabel)}
          </button>
        </div>
      </section>
    `;
    document.body.appendChild(overlay);

    const cleanup = (result: boolean) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cleanup(false);
      // Enter confirms, unless the user has tabbed to Cancel (don't fire a
      // destructive action out from under a focused Cancel button).
      if (e.key === "Enter") {
        const onCancel =
          document.activeElement === overlay.querySelector("#dialogCancel");
        cleanup(!onCancel);
      }
    };
    document.addEventListener("keydown", onKey);
    overlay.querySelector("#dialogCancel")?.addEventListener("click", () =>
      cleanup(false),
    );
    overlay.querySelector("#dialogConfirm")?.addEventListener("click", () =>
      cleanup(true),
    );
    // Click backdrop to cancel.
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) cleanup(false);
    });
    overlay.querySelector<HTMLButtonElement>("#dialogConfirm")?.focus();
  });
}
