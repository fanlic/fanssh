import type { SVGProps } from "react";

export type IconName =
  | "term"
  | "search"
  | "plus"
  | "import"
  | "export"
  | "chev"
  | "folder"
  | "file"
  | "link"
  | "up"
  | "down"
  | "transfer"
  | "refresh"
  | "x"
  | "gear"
  | "split"
  | "more"
  | "check"
  | "info"
  | "alert"
  | "xcircle"
  | "plug"
  | "lock"
  | "clock"
  | "spark"
  | "copy"
  | "play"
  | "trash"
  | "edit";

const PATHS: Record<IconName, JSX.Element> = {
  term: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M4.5 6l2 2-2 2M8.5 10h3" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4" />
      <path d="M10 10l3 3" />
    </>
  ),
  plus: <path d="M8 3v10M3 8h10" />,
  import: <path d="M8 2v7M5 6l3 3 3-3M3 12v1.5h10V12" />,
  export: <path d="M8 10V3M5 6l3-3 3 3M3 12v1.5h10V12" />,
  chev: <path d="M4 6l4 4 4-4" />,
  folder: (
    <path d="M2 4.5A1.5 1.5 0 013.5 3h3L8 4.5h4.5A1.5 1.5 0 0114 6v6a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12V4.5z" />
  ),
  file: (
    <>
      <path d="M9 2H4.5A1.5 1.5 0 003 3.5v9A1.5 1.5 0 004.5 14h7a1.5 1.5 0 001.5-1.5V6L9 2z" />
      <path d="M9 2v4h4" />
    </>
  ),
  link: (
    <path d="M6.8 9.2l2.4-2.4M6.2 4.8l1-1a2.7 2.7 0 013.8 3.8l-1 1M9.8 11.2l-1 1a2.7 2.7 0 01-3.8-3.8l1-1" />
  ),
  up: <path d="M8 13V4M4.5 7.5L8 4l3.5 3.5" />,
  down: <path d="M8 3v9M4.5 8.5L8 12l3.5-3.5" />,
  transfer: <path d="M5 13V3M2.5 5.5L5 3l2.5 2.5M11 3v10M8.5 10.5L11 13l2.5-2.5" />,
  refresh: <path d="M13 8a5 5 0 11-1.5-3.5M13 2.5V6H9.5" />,
  x: <path d="M4 4l8 8M12 4l-8 8" />,
  gear: (
    <>
      <path d="M5.6 3.84l.51-2.42h3.78l.51 2.42 2.36-.77 1.89 3.27L12.8 8l1.85 1.66-1.89 3.27-2.36-.77-.51 2.42H6.11l-.51-2.42-2.36.77-1.89-3.27L3.2 8 1.35 6.34l1.89-3.27z" />
      <circle cx="8" cy="8" r="1.9" />
    </>
  ),
  split: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1" />
      <path d="M8 3v10" />
    </>
  ),
  more: <path d="M3.2 8h.1M8 8h.1M12.8 8h.1" strokeWidth="2.4" />,
  check: <path d="M3 8.5l3.5 3.5L13 4.5" />,
  info: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7.2v4M8 4.8h.01" />
    </>
  ),
  alert: (
    <>
      <path d="M8 2L14 13H2L8 2z" />
      <path d="M8 6v3.5M8 11.5h.01" />
    </>
  ),
  xcircle: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M6 6l4 4M10 6l-4 4" />
    </>
  ),
  plug: <path d="M6 2v4M10 2v4M4 6h8v2a4 4 0 01-4 4 4 4 0 01-4-4V6zM8 12v2" />,
  lock: (
    <>
      <rect x="3.5" y="7" width="9" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 015 0v2" />
    </>
  ),
  clock: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 4.5V8l2.5 1.5" />
    </>
  ),
  spark: <path d="M8 1.5l1.6 4.4L14 7.5 9.6 9 8 14.5 6.4 9 2 7.5l4.4-1.6L8 1.5z" />,
  copy: (
    <>
      <rect x="5" y="5" width="8" height="8" rx="1" />
      <path d="M3 10V4a1 1 0 011-1h6" />
    </>
  ),
  play: <path d="M5 3l8 5-8 5V3z" />,
  trash: <path d="M3 4h10M6 4V3h4v1M4.5 4l.5 9h6l.5-9M6.5 7v3M9.5 7v3" />,
  edit: <path d="M3 13h2l7-7-2-2-7 7v2zM9 4l2 2" />,
};

interface Props extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 16, className, ...rest }: Props) {
  return (
    <svg
      className={className ? `ic ${className}` : "ic"}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}
