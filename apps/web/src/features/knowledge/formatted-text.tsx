import { type ReactNode, useRef } from "react";
import { Link } from "react-router";
import { Button } from "../../components/ui";
import {
  idSchema,
  passageAnchorSchema,
  type PassageAnchor,
} from "@kordos/contracts";

function inline(text: string, offset: number, projectBase: string) {
  const tokens =
    /\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|\x60([^\x60\n]+)\x60|\[([^\]\n]+)\]\(task:([a-f0-9-]{36})\)/gi;
  const parts: ReactNode[] = [];
  const fragment = (start: number, value: ReactNode) => (
    <span key={start} data-source-offset={offset + start}>
      {value}
    </span>
  );
  let index = 0;
  for (const match of text.matchAll(tokens)) {
    const start = match.index;
    const [raw, bold, emphasis, code, label, task] = match;
    if (start > index) parts.push(fragment(index, text.slice(index, start)));
    if (bold) parts.push(fragment(start + 2, <strong>{bold}</strong>));
    else if (emphasis) parts.push(fragment(start + 1, <em>{emphasis}</em>));
    else if (code) parts.push(fragment(start + 1, <code>{code}</code>));
    else if (task && idSchema.safeParse(task).success)
      parts.push(
        fragment(
          start + 1,
          <Link to={projectBase + "/work/" + task}>{label}</Link>,
        ),
      );
    else parts.push(fragment(start, raw));
    index = start + raw.length;
  }
  if (index < text.length) parts.push(fragment(index, text.slice(index)));
  return parts;
}

// Rendering constructs React elements from a small formatting grammar. Workspace text never becomes HTML.
export function FormattedText({
  content,
  projectBase,
  revision,
  onSelection,
}: {
  content: string;
  projectBase: string;
  revision?: number;
  onSelection?: (anchor?: PassageAnchor) => void;
}) {
  const reader = useRef<HTMLDivElement>(null);
  function capture() {
    const selection = window.getSelection();
    if (
      !selection ||
      selection.isCollapsed ||
      !selection.rangeCount ||
      !revision ||
      !onSelection
    )
      return;
    const range = selection.getRangeAt(0);
    function position(node: Node, offset: number) {
      if (node.nodeType !== Node.TEXT_NODE || !reader.current?.contains(node))
        return;
      const token = node.parentElement?.closest<HTMLElement>(
        "[data-source-offset]",
      );
      if (token) return Number(token.dataset.sourceOffset) + offset;
    }
    const start = position(range.startContainer, range.startOffset);
    const end = position(range.endContainer, range.endOffset);
    if (start !== undefined && end !== undefined)
      onSelection(anchorBetween(content, revision, start, end));
  }

  const lines = [];
  let offset = 0;
  for (const line of content.split("\n")) {
    const heading = /^(#{1,3}) /.exec(line);
    const bullet = line.startsWith("- ");
    const prefix = heading?.[0].length ?? (bullet ? 2 : 0);
    const segments = inline(line.slice(prefix), offset + prefix, projectBase);
    lines.push({ offset, heading: heading?.[1]?.length, bullet, segments });
    offset += line.length + 1;
  }

  const blocks: ReactNode[] = [];
  let list: ReactNode[] = [];
  let listOffset = 0;
  function flushList() {
    if (list.length) blocks.push(<ul key={listOffset}>{list}</ul>);
    list = [];
  }
  for (const line of lines) {
    if (line.bullet) {
      if (!list.length) listOffset = line.offset;
      list.push(<li key={line.offset}>{line.segments}</li>);
      continue;
    }
    flushList();
    const Element =
      line.heading === 1
        ? "h3"
        : line.heading === 2
          ? "h4"
          : line.heading
            ? "h5"
            : "p";
    blocks.push(
      <Element key={line.offset}>
        {line.segments.length ? line.segments : <br />}
      </Element>,
    );
  }
  flushList();
  return (
    <div
      className="knowledge-rich"
      ref={reader}
      onPointerUp={onSelection ? capture : undefined}
    >
      {blocks}
    </div>
  );
}

export function anchorBetween(
  content: string,
  revision: number,
  start: number,
  end: number,
) {
  // PostgreSQL stores offsets in Unicode code points. Browser selection uses UTF-16.
  const result = passageAnchorSchema.safeParse({
    revision,
    start: Array.from(content.slice(0, start)).length,
    end: Array.from(content.slice(0, end)).length,
  });
  return result.success ? result.data : undefined;
}

export function RichEditor({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const editor = useRef<HTMLTextAreaElement>(null);
  function insert(prefix: string, suffix = "", placeholder = "text") {
    const area = editor.current;
    if (!area) return;
    const { selectionStart: start, selectionEnd: end } = area;
    const selection = value.slice(start, end) || placeholder;
    const next =
      value.slice(0, start) + prefix + selection + suffix + value.slice(end);
    if (next.length > 80000) return;
    onChange(next);
    requestAnimationFrame(() => {
      area.focus();
      area.setSelectionRange(
        start + prefix.length,
        start + prefix.length + selection.length,
      );
    });
  }
  return (
    <div className="knowledge-editor">
      <div
        className="knowledge-actions"
        role="group"
        aria-label="Text formatting"
      >
        <Button
          variant="secondary"
          disabled={disabled}
          onClick={() => insert("**", "**")}
        >
          Bold
        </Button>
        <Button
          variant="secondary"
          disabled={disabled}
          onClick={() => insert("*", "*")}
        >
          Italic
        </Button>
        <Button
          variant="secondary"
          disabled={disabled}
          onClick={() => insert("\n## ", "\n", "Heading")}
        >
          Heading
        </Button>
        <Button
          variant="secondary"
          disabled={disabled}
          onClick={() => insert("\n- ", "\n", "List item")}
        >
          List item
        </Button>
        <Button
          variant="secondary"
          disabled={disabled}
          onClick={() => insert("\x60", "\x60")}
        >
          Code
        </Button>
        <Button
          variant="secondary"
          disabled={disabled}
          onClick={() => insert("[", "](task:paste-task-id)", "Task title")}
        >
          Task link
        </Button>
      </div>
      <label>
        Document text
        <textarea
          ref={editor}
          rows={10}
          maxLength={80000}
          value={value}
          readOnly={disabled}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      </label>
      <p className="planning-help">
        For a task link, replace paste-task-id with the ID at the end of its
        project task URL.
      </p>
    </div>
  );
}
