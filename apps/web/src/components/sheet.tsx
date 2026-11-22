import { ArrowLeft, X } from "lucide-react";
import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { Button } from "./ui";

export function Sheet({
  title,
  opener,
  onDismiss,
  placement = "detail",
  children,
}: {
  title: string;
  opener?: HTMLElement;
  onDismiss: () => void;
  placement?: "detail" | "navigation";
  children: (dismiss: () => void) => ReactNode;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const dismissRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    dismissRef.current?.focus();
  }, []);

  function dismiss() {
    dialogRef.current?.close();
    if (opener?.isConnected && opener.getClientRects().length) {
      opener.focus({ preventScroll: true });
    } else {
      document.getElementById("main-content")?.focus({ preventScroll: true });
    }
    onDismiss();
  }

  return (
    <dialog
      ref={dialogRef}
      className={`sheet sheet--${placement}`}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
    >
      <div className="sheet__content">
        <header className="sheet__header">
          {placement === "navigation" ? (
            <>
              <h2 id={titleId}>{title}</h2>
              <Button
                variant="icon"
                aria-label="Close navigation"
                ref={dismissRef}
                onClick={dismiss}
              >
                <X size={20} aria-hidden="true" />
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="quiet"
                className="sheet__back"
                ref={dismissRef}
                onClick={dismiss}
              >
                <ArrowLeft size={17} aria-hidden="true" />
                Back
              </Button>
              <h2 id={titleId}>{title}</h2>
            </>
          )}
        </header>
        {children(dismiss)}
      </div>
    </dialog>
  );
}
