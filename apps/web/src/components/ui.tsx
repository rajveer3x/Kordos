import type { ComponentProps, ReactNode } from "react";
import {
  CircleAlert,
  CircleCheck,
  CircleMinus,
  TriangleAlert,
} from "lucide-react";

type ButtonProps = ComponentProps<"button"> & {
  variant?: "primary" | "secondary" | "quiet" | "icon";
};

export function Button({
  variant = "primary",
  type = "button",
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={["button", `button--${variant}`, className]
        .filter(Boolean)
        .join(" ")}
      {...props}
    />
  );
}

export function PageHeading({
  title,
  description,
  display = false,
}: {
  title: string;
  description?: string;
  display?: boolean;
}) {
  return (
    <div className="page-heading">
      <h1 className={display ? "page-title page-title--display" : "page-title"}>
        {title}
      </h1>
      {description && <p>{description}</p>}
    </div>
  );
}

const statusIcons = {
  neutral: CircleMinus,
  confirmed: CircleCheck,
  risk: TriangleAlert,
  critical: CircleAlert,
};

export type StatusTone = keyof typeof statusIcons;

export function StatusLabel({
  tone = "neutral",
  children,
  announce = false,
}: {
  tone?: StatusTone;
  children: ReactNode;
  announce?: boolean;
}) {
  const Icon = statusIcons[tone];

  return (
    <span
      className="status-label"
      data-tone={tone}
      role={announce ? "status" : undefined}
    >
      <Icon size={14} aria-hidden="true" />
      {children}
    </span>
  );
}

type AsyncStateProps =
  | { kind: "loading"; message: string }
  | { kind: "error"; message: string; retry?: () => void };

export function AsyncState(props: AsyncStateProps) {
  const loading = props.kind === "loading";

  return (
    <div className="async-state glass-panel">
      <p role={loading ? "status" : "alert"}>
        {loading ? (
          <span className="loading-mark" aria-hidden="true" />
        ) : (
          <CircleAlert size={18} aria-hidden="true" />
        )}
        {props.message}
      </p>
      {props.kind === "error" && props.retry && (
        <Button variant="secondary" onClick={props.retry}>
          Try again
        </Button>
      )}
    </div>
  );
}
